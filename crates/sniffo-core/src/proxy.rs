//! MITM proxy engine: captures every flow and publishes change events.

use crate::{
    ca::RootCa,
    flow::{Flow, FlowId, FlowState, FlowSummary, Message, headers_from, now_ms},
};
use bytes::{Bytes, BytesMut};
use http_body_util::{BodyExt, BodyDataStream};
use hudsucker::{
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
    certificate_authority::RcgenAuthority,
    futures::Stream,
    hyper::{Method, Request, Response, StatusCode},
    rustls::{ClientConfig, RootCertStore, crypto::aws_lc_rs, pki_types::{CertificateDer, pem::PemObject}},
    tokio_tungstenite::Connector,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, RwLock, atomic::{AtomicU64, Ordering}},
    task::{Context, Poll},
};
use tokio::{net::TcpListener, sync::{broadcast, oneshot}, task::JoinHandle};

/// Bodies above this size are forwarded intact but stored truncated.
pub const MAX_STORED_BODY: usize = 32 * 1024 * 1024;
/// Oldest unpinned flows are evicted past this count to bound memory.
pub const MAX_FLOWS: usize = 50_000;

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
}

struct Inner {
    flows: RwLock<BTreeMap<FlowId, Flow>>,
    next_id: AtomicU64,
    events: broadcast::Sender<FlowEvent>,
    ssl: RwLock<SslProxying>,
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
            .with_http_handler(Capture { engine: self.inner.clone(), id: None, is_head: false })
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

/// Per-request handler: hudsucker clones it for each request, so `id` links request to response.
#[derive(Clone)]
struct Capture {
    engine: Arc<Inner>,
    id: Option<FlowId>,
    is_head: bool,
}

fn error_response(status: StatusCode, msg: String) -> Response<Body> {
    Response::builder().status(status).header("content-type", "text/plain").body(Body::from(msg)).expect("valid response")
}

impl HttpHandler for Capture {
    async fn handle_request(&mut self, ctx: &HttpContext, req: Request<Body>) -> RequestOrResponse {
        if req.method() == Method::CONNECT {
            return req.into();
        }
        let (parts, body) = req.into_parts();
        let body = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("failed to read request body: {e}")).into(),
        };
        let id = self.engine.next_id.fetch_add(1, Ordering::Relaxed);
        self.id = Some(id);
        self.is_head = parts.method == Method::HEAD;
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
            request: Message { headers: headers_from(&parts.headers), body_size: body.len(), body: truncate(&body) },
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
        Request::from_parts(parts, Body::from(body)).into()
    }

    async fn handle_response(&mut self, _ctx: &HttpContext, res: Response<Body>) -> Response<Body> {
        let Some(id) = self.id else { return res };
        let (parts, body) = res.into_parts();
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
        let tee = Tee { inner: body.into_data_stream(), buf: BytesMut::new(), size: 0, expected, sink: Some((self.engine.clone(), id)) };
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
        let poll = Pin::new(&mut self.inner).poll_next(cx);
        match &poll {
            Poll::Ready(Some(Ok(chunk))) => {
                self.size += chunk.len();
                let room = MAX_STORED_BODY.saturating_sub(self.buf.len());
                let chunk = chunk.slice(..chunk.len().min(room));
                self.buf.extend_from_slice(&chunk);
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
