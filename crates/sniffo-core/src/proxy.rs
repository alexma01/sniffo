//! MITM proxy engine: captures every flow and publishes change events.

use crate::{
    ca::RootCa,
    flow::{Flow, FlowId, FlowState, FlowSummary, Headers, Message, headers_from, now_ms},
    rules::{Plan, Rules},
};
use bytes::{Bytes, BytesMut};
use http_body_util::{BodyExt, BodyDataStream};
use hudsucker::{
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
    certificate_authority::RcgenAuthority,
    futures::Stream,
    hyper::{HeaderMap, Method, Request, Response, StatusCode, Uri, header::{HeaderName, HeaderValue}},
    rustls::{ClientConfig, RootCertStore, crypto::aws_lc_rs, pki_types::{CertificateDer, pem::PemObject}},
    tokio_tungstenite::Connector,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex, RwLock, atomic::{AtomicU64, Ordering}},
    task::{Context, Poll, ready},
    time::Duration,
};
use tokio::{net::TcpListener, sync::{broadcast, oneshot}, task::JoinHandle, time::Sleep};

/// Bodies above this size are forwarded intact but stored truncated.
pub const MAX_STORED_BODY: usize = 32 * 1024 * 1024;
/// Oldest unpinned flows are evicted past this count to bound memory.
pub const MAX_FLOWS: usize = 50_000;
/// A forgotten breakpoint lets the message through unmodified after this long.
pub const BREAKPOINT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SslProxying {
    pub enabled: bool,
    /// Host wildcards to decrypt (`*`, `*.example.com`, `api.example.com`).
    pub include: Vec<String>,
    /// Host wildcards always tunnelled untouched (wins over `include`).
    pub exclude: Vec<String>,
}

impl Default for SslProxying {
    fn default() -> Self {
        Self { enabled: true, include: vec!["*".into()], exclude: vec![] }
    }
}

impl SslProxying {
    pub fn should_decrypt(&self, host: &str) -> bool {
        self.enabled
            && self.include.iter().any(|p| wildcard(p, host))
            && !self.exclude.iter().any(|p| wildcard(p, host))
    }
}

/// Case-insensitive glob where `*` matches any run of characters.
pub fn wildcard(pattern: &str, text: &str) -> bool {
    let (p, t) = (pattern.to_ascii_lowercase(), text.to_ascii_lowercase());
    let (p, t) = (p.as_bytes(), t.as_bytes());
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == b'*')
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "lowercase")]
pub enum FlowEvent {
    Upsert(FlowSummary),
    Removed(Vec<FlowId>),
    Cleared,
    Breakpoint(BreakpointHit),
}

/// Editable view of a request or response held at a breakpoint.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Editable {
    pub method: String,
    pub url: String,
    pub status: u16,
    pub headers: Headers,
    /// Decoded text body; `None` when binary. Sending back `None` keeps the original bytes.
    pub body: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BreakpointHit {
    pub id: FlowId,
    pub response: bool,
    pub message: Editable,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", content = "message", rename_all = "lowercase")]
pub enum Decision {
    Continue(Editable),
    Abort,
}

struct Inner {
    flows: RwLock<BTreeMap<FlowId, Flow>>,
    next_id: AtomicU64,
    events: broadcast::Sender<FlowEvent>,
    ssl: RwLock<SslProxying>,
    rules: RwLock<Arc<Rules>>,
    paused: Mutex<HashMap<FlowId, (BreakpointHit, oneshot::Sender<Decision>)>>,
}

impl Inner {
    fn update(&self, id: FlowId, f: impl FnOnce(&mut Flow)) {
        let summary = {
            let mut flows = self.flows.write().unwrap();
            let Some(flow) = flows.get_mut(&id) else { return };
            f(flow);
            flow.summary()
        };
        let _ = self.events.send(FlowEvent::Upsert(summary));
    }

    /// Holds the caller until the UI decides (or the timeout lets it through unchanged).
    async fn pause(&self, id: FlowId, response: bool, message: Editable) -> Decision {
        let (tx, rx) = oneshot::channel();
        let hit = BreakpointHit { id, response, message: message.clone() };
        self.paused.lock().unwrap().insert(id, (hit.clone(), tx));
        self.update(id, |f| f.state = FlowState::Paused);
        let _ = self.events.send(FlowEvent::Breakpoint(hit));
        let decision = tokio::time::timeout(BREAKPOINT_TIMEOUT, rx).await;
        self.paused.lock().unwrap().remove(&id);
        self.update(id, |f| f.state = FlowState::Pending);
        match decision {
            Ok(Ok(d)) => d,
            _ => Decision::Continue(message),
        }
    }
}

/// Shared handle to captured traffic and settings; cheap to clone.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                flows: RwLock::default(),
                next_id: AtomicU64::new(1),
                events: broadcast::channel(4096).0,
                ssl: RwLock::default(),
                rules: RwLock::default(),
                paused: Mutex::default(),
            }),
        }
    }
}

#[derive(Default)]
pub struct StartOptions {
    /// Extra PEM roots trusted for upstream TLS (self-signed dev servers, tests).
    pub extra_upstream_roots: Vec<String>,
}

impl Engine {
    pub fn subscribe(&self) -> broadcast::Receiver<FlowEvent> {
        self.inner.events.subscribe()
    }

    pub fn summaries(&self) -> Vec<FlowSummary> {
        self.inner.flows.read().unwrap().values().map(Flow::summary).collect()
    }

    pub fn flow(&self, id: FlowId) -> Option<Flow> {
        self.inner.flows.read().unwrap().get(&id).cloned()
    }

    /// Removes all unpinned flows.
    pub fn clear(&self) {
        let mut flows = self.inner.flows.write().unwrap();
        if flows.values().any(|f| f.pinned) {
            let ids: Vec<_> = flows.values().filter(|f| !f.pinned).map(|f| f.id).collect();
            flows.retain(|_, f| f.pinned);
            let _ = self.inner.events.send(FlowEvent::Removed(ids));
        } else {
            flows.clear();
            let _ = self.inner.events.send(FlowEvent::Cleared);
        }
    }

    pub fn remove(&self, ids: &[FlowId]) {
        let mut flows = self.inner.flows.write().unwrap();
        for id in ids {
            flows.remove(id);
        }
        let _ = self.inner.events.send(FlowEvent::Removed(ids.to_vec()));
    }

    pub fn set_pinned(&self, id: FlowId, pinned: bool) {
        self.inner.update(id, |f| f.pinned = pinned);
    }

    /// Ids of flows whose URL, headers or text bodies contain `query` (case-insensitive).
    pub fn search(&self, query: &str) -> Vec<FlowId> {
        let q = query.to_lowercase();
        self.inner.flows.read().unwrap().values().filter(|f| f.contains(&q)).map(|f| f.id).collect()
    }

    pub fn ssl_proxying(&self) -> SslProxying {
        self.inner.ssl.read().unwrap().clone()
    }

    pub fn set_ssl_proxying(&self, ssl: SslProxying) {
        *self.inner.ssl.write().unwrap() = ssl;
    }

    pub fn rules(&self) -> Rules {
        (**self.inner.rules.read().unwrap()).clone()
    }

    pub fn set_rules(&self, rules: Rules) {
        *self.inner.rules.write().unwrap() = Arc::new(rules);
    }

    /// Flows currently held at a breakpoint.
    pub fn breakpoints(&self) -> Vec<BreakpointHit> {
        self.inner.paused.lock().unwrap().values().map(|(h, _)| h.clone()).collect()
    }

    /// Releases a paused flow. Returns false if it was no longer paused.
    pub fn resume(&self, id: FlowId, decision: Decision) -> bool {
        let Some((_, tx)) = self.inner.paused.lock().unwrap().remove(&id) else { return false };
        tx.send(decision).is_ok()
    }

    pub async fn start(&self, listener: TcpListener, ca: &RootCa, opts: StartOptions) -> Result<ProxyHandle, String> {
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        let authority = RcgenAuthority::new(ca.issuer().map_err(|e| e.to_string())?, 1_000, aws_lc_rs::default_provider());

        // OS trust store first (corporate TLS inspection CAs live there), webpki as fallback.
        let mut roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let native = rustls_native_certs::load_native_certs();
        for e in &native.errors {
            tracing::warn!("system root store: {e}");
        }
        roots.add_parsable_certificates(native.certs);
        for pem in &opts.extra_upstream_roots {
            for der in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                roots.add(der.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            }
        }
        let tls = ClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(tls.clone())
            .https_or_http()
            .enable_http1()
            .enable_http2()
            .build();

        let (tx, rx) = oneshot::channel::<()>();
        let proxy = Proxy::builder()
            .with_listener(listener)
            .with_ca(authority)
            .with_http_connector(https)
            .with_websocket_connector(Connector::Rustls(Arc::new(tls)))
            .with_http_handler(Capture { engine: self.inner.clone(), id: None, is_head: false, break_response: false, download_bps: None })
            .with_graceful_shutdown(async { let _ = rx.await; })
            .build()
            .map_err(|e| e.to_string())?;
        let task = tokio::spawn(async move {
            if let Err(e) = proxy.start().await {
                tracing::error!("proxy stopped: {e}");
            }
        });
        Ok(ProxyHandle { addr, shutdown: Some(tx), task })
    }
}

pub struct ProxyHandle {
    pub addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl ProxyHandle {
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = (&mut self.task).await;
    }
}

/// Per-request handler: hudsucker clones it for each request, so fields link request to response.
#[derive(Clone)]
struct Capture {
    engine: Arc<Inner>,
    id: Option<FlowId>,
    is_head: bool,
    break_response: bool,
    download_bps: Option<u64>,
}

fn error_response(status: StatusCode, msg: String) -> Response<Body> {
    Response::builder().status(status).header("content-type", "text/plain").body(Body::from(msg)).expect("valid response")
}

fn header_map(headers: &Headers) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        if let (Ok(k), Ok(v)) = (HeaderName::try_from(k.as_str()), HeaderValue::try_from(v.as_str())) {
            map.append(k, v);
        }
    }
    map
}

/// Text view of a body for editing (`None` when binary), decoding Content-Encoding first.
fn editable_body(headers: &Headers, raw: &Bytes) -> Option<String> {
    let m = Message { headers: headers.clone(), body: raw.clone(), body_size: raw.len() };
    String::from_utf8(m.decoded_body().to_vec()).ok()
}

/// Applies an edited body: edited text is sent uncompressed, so encoding/length headers are reset.
fn apply_body(headers: &mut HeaderMap, original: Bytes, edited: Option<String>) -> Bytes {
    match edited {
        None => original,
        Some(text) => {
            headers.remove("content-encoding");
            headers.insert("content-length", HeaderValue::from(text.len()));
            Bytes::from(text)
        }
    }
}

fn map_remote(uri: &Uri, plan: &Plan) -> Option<Uri> {
    if plan.map_remote.is_empty() {
        return None;
    }
    let mut scheme = uri.scheme_str().unwrap_or("http").to_owned();
    let mut host = uri.host().unwrap_or_default().to_owned();
    let mut port = uri.port_u16();
    let mut path = uri.path().to_owned();
    for (s, h, p, pa) in &plan.map_remote {
        if let Some(s) = s { scheme = s.clone(); port = None; }
        if let Some(h) = h { host = h.clone(); }
        if let Some(p) = p { port = Some(*p); }
        if let Some(pa) = pa { path = pa.clone(); }
    }
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let port = port.map(|p| format!(":{p}")).unwrap_or_default();
    format!("{scheme}://{host}{port}{path}{query}").parse().ok()
}

async fn throttle_bytes(len: usize, bps: Option<u64>) {
    if let Some(bps) = bps {
        tokio::time::sleep(Duration::from_secs_f64(len as f64 / bps as f64)).await;
    }
}

impl Capture {
    fn record(&mut self, ctx: &HttpContext, parts: &hudsucker::hyper::http::request::Parts, body: &Bytes, tags: Vec<String>) -> FlowId {
        let id = self.engine.next_id.fetch_add(1, Ordering::Relaxed);
        self.id = Some(id);
        let uri = &parts.uri;
        let flow = Flow {
            id,
            client_addr: ctx.client_addr.to_string(),
            started_ms: now_ms(),
            method: parts.method.to_string(),
            url: uri.to_string(),
            scheme: uri.scheme_str().unwrap_or("http").to_owned(),
            host: uri.host().unwrap_or_default().to_owned(),
            path: uri.path_and_query().map(|p| p.to_string()).unwrap_or_else(|| "/".into()),
            http_version: format!("{:?}", parts.version),
            request: Message { headers: headers_from(&parts.headers), body_size: body.len(), body: truncate(body) },
            tags,
            ..Default::default()
        };
        let summary = flow.summary();
        let evicted = {
            let mut flows = self.engine.flows.write().unwrap();
            flows.insert(id, flow);
            let excess = flows.len().saturating_sub(MAX_FLOWS);
            // ponytail: linear scan of the oldest entries; only runs once the cap is hit.
            let ids: Vec<_> = flows.values().filter(|f| !f.pinned).take(excess).map(|f| f.id).collect();
            ids.iter().for_each(|id| { flows.remove(id); });
            ids
        };
        let _ = self.engine.events.send(FlowEvent::Upsert(summary));
        if !evicted.is_empty() {
            let _ = self.engine.events.send(FlowEvent::Removed(evicted));
        }
        id
    }

    /// Records a response generated by the proxy itself (block, map local, abort).
    fn local_response(&self, id: FlowId, status: StatusCode, headers: HeaderMap, body: Bytes, error: Option<String>) -> Response<Body> {
        let recorded = Message { headers: headers_from(&headers), body_size: body.len(), body: truncate(&body) };
        self.engine.update(id, |f| {
            let elapsed = now_ms().saturating_sub(f.started_ms);
            f.status = Some(status.as_u16());
            f.ttfb_ms = Some(elapsed);
            f.duration_ms = Some(elapsed);
            f.response = Some(recorded);
            f.state = if error.is_some() { FlowState::Failed } else { FlowState::Complete };
            f.error = error;
        });
        let mut res = Response::new(Body::from(body));
        *res.status_mut() = status;
        *res.headers_mut() = headers;
        res
    }
}

impl HttpHandler for Capture {
    async fn handle_request(&mut self, ctx: &HttpContext, req: Request<Body>) -> RequestOrResponse {
        if req.method() == Method::CONNECT {
            return req.into();
        }
        let (mut parts, body) = req.into_parts();
        let body = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("failed to read request body: {e}")).into(),
        };
        self.is_head = parts.method == Method::HEAD;
        let rules = self.engine.rules.read().unwrap().clone();
        let plan = rules.plan(parts.method.as_str(), &parts.uri.to_string());
        if !plan.record {
            return Request::from_parts(parts, Body::from(body)).into();
        }
        let id = self.record(ctx, &parts, &body, plan.tags.clone());
        self.break_response = plan.break_response;
        self.download_bps = plan.download_bps;

        if plan.block {
            let mut h = HeaderMap::new();
            h.insert("content-type", HeaderValue::from_static("text/plain"));
            return self.local_response(id, StatusCode::FORBIDDEN, h, Bytes::from_static(b"Blocked by Sniffo"), None).into();
        }

        let mut body = body;
        if plan.break_request {
            let headers = headers_from(&parts.headers);
            let editable = Editable {
                method: parts.method.to_string(),
                url: parts.uri.to_string(),
                status: 0,
                body: editable_body(&headers, &body),
                headers,
            };
            match self.engine.pause(id, false, editable).await {
                Decision::Abort => {
                    return self.local_response(id, StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new(), Some("aborted at breakpoint".into())).into();
                }
                Decision::Continue(e) => {
                    parts.method = Method::from_bytes(e.method.as_bytes()).unwrap_or(parts.method);
                    parts.uri = e.url.parse().unwrap_or(parts.uri);
                    parts.headers = header_map(&e.headers);
                    body = apply_body(&mut parts.headers, body, e.body);
                    let (method, url, headers, recorded) = (parts.method.to_string(), parts.uri.to_string(), headers_from(&parts.headers), body.clone());
                    self.engine.update(id, |f| {
                        f.method = method;
                        f.url = url;
                        f.request = Message { headers, body_size: recorded.len(), body: truncate(&recorded) };
                    });
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(plan.latency_ms)).await;
        throttle_bytes(body.len(), plan.upload_bps).await;

        if let Some((status, headers, text, file)) = plan.map_local {
            let (bytes, error) = match file {
                Some(path) => match tokio::fs::read(&path).await {
                    Ok(b) => (Bytes::from(b), None),
                    Err(e) => (Bytes::new(), Some(format!("map local: cannot read {path}: {e}"))),
                },
                None => (Bytes::from(text), None),
            };
            let mut h = header_map(&headers);
            h.insert("content-length", HeaderValue::from(bytes.len()));
            let status = if error.is_some() { StatusCode::INTERNAL_SERVER_ERROR } else { StatusCode::from_u16(status).unwrap_or(StatusCode::OK) };
            throttle_bytes(bytes.len(), plan.download_bps).await;
            return self.local_response(id, status, h, bytes, error).into();
        }

        if let Some(uri) = map_remote(&parts.uri, &plan) {
            parts.uri = uri;
        }
        Request::from_parts(parts, Body::from(body)).into()
    }

    async fn handle_response(&mut self, _ctx: &HttpContext, res: Response<Body>) -> Response<Body> {
        let Some(id) = self.id else { return res };
        let (mut parts, body) = res.into_parts();

        if self.break_response {
            // Editing needs the whole body, so this path buffers instead of streaming.
            let raw = match body.collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) => return self.local_response(id, StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new(), Some(format!("reading response: {e}"))),
            };
            let headers = headers_from(&parts.headers);
            let editable = Editable { method: String::new(), url: String::new(), status: parts.status.as_u16(), body: editable_body(&headers, &raw), headers };
            return match self.engine.pause(id, true, editable).await {
                Decision::Abort => self.local_response(id, StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new(), Some("aborted at breakpoint".into())),
                Decision::Continue(e) => {
                    let mut headers = header_map(&e.headers);
                    let body = apply_body(&mut headers, raw, e.body);
                    throttle_bytes(body.len(), self.download_bps).await;
                    self.local_response(id, StatusCode::from_u16(e.status).unwrap_or(parts.status), headers, body, None)
                }
            };
        }

        let headers = headers_from(&parts.headers);
        let bodyless = self.is_head || parts.status.is_informational() || matches!(parts.status.as_u16(), 204 | 304);
        let expected = if bodyless {
            Some(0)
        } else {
            parts.headers.get("content-length").and_then(|v| v.to_str().ok()?.parse().ok())
        };
        self.engine.update(id, |f| {
            f.status = Some(parts.status.as_u16());
            f.ttfb_ms = Some(now_ms().saturating_sub(f.started_ms));
            f.response = Some(Message { headers, ..Default::default() });
        });
        if self.download_bps.is_some() {
            // Throttled bodies arrive slowly; let hyper stream rather than trusting the length upfront.
            parts.headers.remove("content-length");
        }
        let tee = Tee {
            inner: body.into_data_stream(),
            buf: BytesMut::new(),
            size: 0,
            expected,
            sink: Some((self.engine.clone(), id)),
            rate: self.download_bps,
            delay: None,
        };
        Response::from_parts(parts, Body::from_stream(tee))
    }

    async fn handle_error(&mut self, _ctx: &HttpContext, err: hudsucker::hyper_util::client::legacy::Error) -> Response<Body> {
        let msg = format!("{err}: {}", std::error::Error::source(&err).map(|s| s.to_string()).unwrap_or_default());
        if let Some(id) = self.id {
            self.engine.update(id, |f| {
                f.state = FlowState::Failed;
                f.error = Some(msg.clone());
                f.duration_ms = Some(now_ms().saturating_sub(f.started_ms));
            });
        }
        error_response(StatusCode::BAD_GATEWAY, msg)
    }

    async fn should_intercept_tls(&mut self, _ctx: &HttpContext, hello: hudsucker::rustls::server::ClientHello<'_>) -> bool {
        hello.server_name().is_some_and(|sni| self.engine.ssl.read().unwrap().should_decrypt(sni))
    }
}

fn truncate(b: &Bytes) -> Bytes {
    b.slice(..b.len().min(MAX_STORED_BODY))
}

/// Forwards response chunks as they arrive (keeps SSE/streaming working) while recording them.
struct Tee {
    inner: BodyDataStream<Body>,
    buf: BytesMut,
    size: usize,
    /// From Content-Length: hyper stops polling once it has that many bytes, so `None` may never come.
    expected: Option<usize>,
    sink: Option<(Arc<Inner>, FlowId)>,
    /// Download throttle in bytes/s: after each chunk, wait before reading the next.
    rate: Option<u64>,
    delay: Option<Pin<Box<Sleep>>>,
}

impl Tee {
    fn finish(&mut self, error: Option<String>) {
        let Some((engine, id)) = self.sink.take() else { return };
        let (body, size) = (std::mem::take(&mut self.buf).freeze(), self.size);
        engine.update(id, |f| {
            if let Some(r) = f.response.as_mut() {
                r.body = body;
                r.body_size = size;
            }
            f.duration_ms = Some(now_ms().saturating_sub(f.started_ms));
            f.state = if error.is_some() { FlowState::Failed } else { FlowState::Complete };
            f.error = error;
        });
    }
}

impl Stream for Tee {
    type Item = Result<Bytes, hudsucker::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(d) = self.delay.as_mut() {
            ready!(d.as_mut().poll(cx));
            self.delay = None;
        }
        let poll = Pin::new(&mut self.inner).poll_next(cx);
        match &poll {
            Poll::Ready(Some(Ok(chunk))) => {
                self.size += chunk.len();
                let room = MAX_STORED_BODY.saturating_sub(self.buf.len());
                let chunk = chunk.slice(..chunk.len().min(room));
                self.buf.extend_from_slice(&chunk);
                if let Some(rate) = self.rate {
                    self.delay = Some(Box::pin(tokio::time::sleep(Duration::from_secs_f64(chunk.len() as f64 / rate as f64))));
                }
                if self.expected.is_some_and(|e| self.size >= e) {
                    self.finish(None);
                }
            }
            Poll::Ready(Some(Err(e))) => {
                let e = e.to_string();
                self.finish(Some(e));
            }
            Poll::Ready(None) => self.finish(None),
            Poll::Pending => {}
        }
        poll
    }
}

impl Drop for Tee {
    fn drop(&mut self) {
        match self.expected {
            Some(e) if self.size >= e => self.finish(None),
            _ => self.finish(Some("connection closed before response completed".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_matches() {
        assert!(wildcard("*", "a.com"));
        assert!(wildcard("*.example.com", "api.example.com"));
        assert!(!wildcard("*.example.com", "example.com"));
        assert!(wildcard("API.example.com", "api.EXAMPLE.com"));
        assert!(wildcard("a*c*e", "abcde"));
        assert!(!wildcard("a*c*f", "abcde"));
    }

    #[test]
    fn exclude_wins() {
        let ssl = SslProxying { enabled: true, include: vec!["*".into()], exclude: vec!["*.apple.com".into()] };
        assert!(ssl.should_decrypt("google.com"));
        assert!(!ssl.should_decrypt("gs.apple.com"));
    }
}
