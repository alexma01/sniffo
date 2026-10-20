//! MITM proxy engine: captures every flow and publishes change events.

use crate::{
    ca::RootCa,
    flow::{Flow, FlowId, FlowState, FlowSummary, Headers, Message, WsMessage, headers_from, now_ms},
    client::ClientApps,
    net::{NetworkOptions, NoVerify, OverrideResolver, UpstreamKind},
    rules::{Plan, Rules},
};
use hyper_util::client::legacy::connect::{HttpConnector, proxy::{SocksV5, Tunnel}};
use bytes::{Bytes, BytesMut};
use http_body_util::{BodyExt, BodyDataStream};
use hudsucker::{
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse, WebSocketContext, WebSocketHandler,
    certificate_authority::RcgenAuthority,
    futures::Stream,
    hyper::{HeaderMap, Method, Request, Response, StatusCode, Uri, header::{HeaderName, HeaderValue}},
    rustls::{ClientConfig, RootCertStore, crypto::aws_lc_rs, pki_types::{CertificateDer, pem::PemObject}},
    tokio_tungstenite::{Connector, tungstenite::Message as WsMsg},
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
/// Magic host served by the proxy itself: phones open it to download the root CA.
pub const CERT_HOST: &str = "sniffo.cert";

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
    /// Output of a script rule: console.log lines and errors.
    Log(ScriptLog),
}

#[derive(Clone, Debug, Serialize)]
pub struct ScriptLog {
    pub id: FlowId,
    pub rule: String,
    pub message: String,
    pub error: bool,
    pub time_ms: u64,
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
    apps: ClientApps,
    /// (client address, ws/wss URI) -> flow of the upgrade request, to attach frames to it.
    websockets: Mutex<HashMap<(SocketAddr, String), FlowId>>,
    /// `sharedState` visible to every script.
    shared_state: Mutex<serde_json::Value>,
}

/// Frames are kept per connection up to this count; older ones are dropped.
pub const MAX_WS_MESSAGES: usize = 10_000;
const MAX_WS_FRAME_STORED: usize = 256 * 1024;

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

    /// Runs script rules in order; each gets the previous one's output. Returns the final value.
    async fn run_scripts(self: &Arc<Self>, id: FlowId, scripts: &[(String, String)], function: &'static str, context: serde_json::Value, mut args: Vec<serde_json::Value>) -> Option<serde_json::Value> {
        let mut changed = None;
        for (rule, code) in scripts {
            let (engine, code, call_args) = (self.clone(), code.clone(), serde_json::Value::Array([vec![context.clone()], args.clone()].concat()));
            let out = tokio::task::spawn_blocking(move || {
                let mut shared = engine.shared_state.lock().unwrap().clone();
                let out = crate::script::run(&code, function, &call_args, &mut shared);
                *engine.shared_state.lock().unwrap() = shared;
                out
            })
            .await
            .unwrap_or_default();
            let log = |message: String, error: bool| {
                let _ = self.events.send(FlowEvent::Log(ScriptLog { id, rule: rule.clone(), message, error, time_ms: now_ms() }));
            };
            out.logs.into_iter().for_each(|l| log(l, false));
            if let Some(e) = out.error {
                log(format!("{function}: {e}"), true);
            }
            if let Some(v) = out.value {
                *args.last_mut().expect("message argument") = v.clone();
                changed = Some(v);
            }
        }
        changed
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
                apps: ClientApps::default(),
                websockets: Mutex::default(),
                shared_state: Mutex::new(serde_json::json!({})),
            }),
        }
    }
}

#[derive(Default)]
pub struct StartOptions {
    /// Extra PEM roots trusted for upstream TLS (self-signed dev servers, tests).
    pub extra_upstream_roots: Vec<String>,
    pub network: NetworkOptions,
    /// Reverse-proxy mode: requests to this listener go to this base URL (e.g. http://localhost:3000).
    pub reverse_target: Option<String>,
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

    /// Full copies of every flow (for export).
    pub fn all_flows(&self) -> Vec<Flow> {
        self.inner.flows.read().unwrap().values().cloned().collect()
    }

    /// Adds flows (e.g. from a HAR/session file) with fresh ids.
    pub fn import(&self, flows: Vec<Flow>) -> usize {
        let n = flows.len();
        for mut f in flows {
            f.id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
            let summary = f.summary();
            self.inner.flows.write().unwrap().insert(f.id, f);
            let _ = self.inner.events.send(FlowEvent::Upsert(summary));
        }
        n
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
        let provider = Arc::new(aws_lc_rs::default_provider());
        let builder = ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().map_err(|e| e.to_string())?;
        let tls = if opts.network.ignore_upstream_tls_errors {
            builder.dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider))).with_no_client_auth()
        } else {
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
            builder.with_root_certificates(roots).with_no_client_auth()
        };
        let mut http = HttpConnector::new_with_resolver(OverrideResolver::new(&opts.network.dns)?);
        // hyper-rustls handles https; the plain connector must let those URIs through.
        http.enforce_http(false);

        match &opts.network.upstream {
            None => self.launch(listener, ca, &opts, tls.clone(), https(tls, http)).await,
            Some(up) => {
                let uri: Uri = format!("http://{}:{}", up.host, up.port).parse().map_err(|e| format!("upstream proxy address: {e}"))?;
                match up.kind {
                    UpstreamKind::Http => {
                        let mut tunnel = Tunnel::new(uri, http);
                        if !up.username.is_empty() {
                            use base64::Engine as _;
                            let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", up.username, up.password));
                            tunnel = tunnel.with_auth(HeaderValue::from_str(&format!("Basic {token}")).map_err(|e| e.to_string())?);
                        }
                        self.launch(listener, ca, &opts, tls.clone(), https(tls, tunnel)).await
                    }
                    UpstreamKind::Socks5 => {
                        let mut socks = SocksV5::new(uri, http);
                        if !up.username.is_empty() {
                            socks = socks.with_auth(up.username.clone(), up.password.clone());
                        }
                        self.launch(listener, ca, &opts, tls.clone(), https(tls, socks)).await
                    }
                }
            }
        }
    }

    async fn launch<C>(&self, listener: TcpListener, ca: &RootCa, opts: &StartOptions, tls: ClientConfig, connector: C) -> Result<ProxyHandle, String>
    where
        C: hudsucker::hyper_util::client::legacy::connect::Connect + Clone + Send + Sync + 'static,
    {
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        let authority = RcgenAuthority::new(ca.issuer().map_err(|e| e.to_string())?, 1_000, aws_lc_rs::default_provider());
        let reverse = match &opts.reverse_target {
            Some(t) => Some(Arc::new(t.parse::<Uri>().map_err(|e| format!("reverse proxy target: {e}"))?)),
            None => None,
        };
        let (tx, rx) = oneshot::channel::<()>();
        let proxy = Proxy::builder()
            .with_listener(listener)
            .with_ca(authority)
            .with_http_connector(connector)
            .with_websocket_connector(Connector::Rustls(Arc::new(tls)))
            .with_websocket_handler(Frames { engine: self.inner.clone() })
            .with_http_handler(Capture {
                engine: self.inner.clone(),
                id: None,
                is_head: false,
                break_response: false,
                download_bps: None,
                ca: Arc::new(ca.clone()),
                proxy_port: addr.port(),
                lookup: None,
                scripts: Arc::default(),
                script_request: serde_json::Value::Null,
                reverse,
            })
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

fn https<C>(tls: ClientConfig, inner: C) -> hyper_rustls::HttpsConnector<C> {
    hyper_rustls::HttpsConnectorBuilder::new().with_tls_config(tls).https_or_http().enable_http1().enable_http2().wrap_connector(inner)
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
    ca: Arc<RootCa>,
    proxy_port: u16,
    /// Script rules for this request, plus the request as scripts last saw it (for onResponse).
    scripts: Arc<Vec<(String, String)>>,
    script_request: serde_json::Value,
    /// Reverse-proxy target for this listener.
    reverse: Option<Arc<Uri>>,
    /// Client-app lookup running alongside the upstream request (see `handle_response`).
    lookup: Option<Arc<Mutex<Option<JoinHandle<()>>>>>,
}

const CERT_PAGE: &str = r#"<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sniffo certificate</title>
<style>body{font:17px -apple-system,Roboto,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.5}
a.b{display:block;text-align:center;background:#0a66ff;color:#fff;padding:12px;border-radius:10px;text-decoration:none;margin:12px 0}</style>
<h2>Sniffo root certificate</h2>
<a class="b" href="/sniffo-ca.pem">Download for iOS / macOS</a>
<a class="b" href="/sniffo-ca.crt">Download for Android</a>
<h3>iPhone / iPad</h3><ol><li>Open this page in <b>Safari</b> and tap the iOS download, then <i>Allow</i>.</li>
<li>Settings → General → VPN &amp; Device Management → <i>Sniffo Root CA</i> → Install.</li>
<li>Settings → General → About → Certificate Trust Settings → enable <i>Sniffo Root CA</i>.</li></ol>
<h3>Android</h3><ol><li>Tap the Android download.</li><li>Settings → Security → Encryption &amp; credentials → Install a certificate → <i>CA certificate</i>.</li>
<li>Apps must trust user CAs (<code>network_security_config</code>) to be decrypted; browsers like Chrome do.</li></ol>"#;

/// Serves the certificate page when a device opens http://sniffo.cert or hits the proxy port directly.
fn cert_response(path: &str, ca: &RootCa) -> Response<Body> {
    let (ct, body): (&str, Body) = match path {
        "/sniffo-ca.pem" => ("application/x-x509-ca-cert", Body::from(ca.cert_pem.clone())),
        "/sniffo-ca.crt" => ("application/x-x509-ca-cert", Body::from(ca.cert_der())),
        _ => ("text/html; charset=utf-8", Body::from(CERT_PAGE)),
    };
    let mut res = Response::new(body);
    res.headers_mut().insert("content-type", HeaderValue::from_static(ct));
    if path.ends_with(".crt") || path.ends_with(".pem") {
        res.headers_mut().insert("content-disposition", HeaderValue::from_str(&format!("attachment; filename=\"{}\"", &path[1..])).expect("ascii"));
    }
    res
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
        let flow = Flow { graphql: crate::flow::graphql_operation(&flow.url, &flow.request), ..flow };
        if ctx.client_addr.ip().is_loopback() {
            let (engine, proxy_port, client_port) = (self.engine.clone(), self.proxy_port, ctx.client_addr.port());
            let task = tokio::spawn(async move {
                if let Some(app) = engine.apps.resolve(proxy_port, client_port).await {
                    engine.update(id, |f| f.client_app = Some(app));
                }
            });
            self.lookup = Some(Arc::new(Mutex::new(Some(task))));
        }
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
        if let (None, Some(target)) = (parts.uri.authority(), &self.reverse) {
            let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
            let base = target.to_string();
            if let Ok(uri) = format!("{}{pq}", base.trim_end_matches('/')).parse() {
                parts.uri = uri;
            }
        }
        if parts.uri.authority().is_none() || parts.uri.host() == Some(CERT_HOST) {
            return cert_response(parts.uri.path(), &self.ca).into();
        }
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

        if parts.headers.get("upgrade").and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
        {
            // hudsucker answers the upgrade itself (no handle_response), so record the 101 here.
            let scheme = if parts.uri.scheme_str() == Some("https") { "wss" } else { "ws" };
            let ws_uri = format!("{scheme}://{}{}", parts.uri.authority().map(|a| a.as_str()).unwrap_or(""), parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/"));
            self.engine.websockets.lock().unwrap().insert((ctx.client_addr, ws_uri), id);
            self.engine.update(id, |f| {
                f.status = Some(101);
                f.ttfb_ms = Some(now_ms().saturating_sub(f.started_ms));
                f.response = Some(Message { headers: vec![("upgrade".into(), "websocket".into())], ..Default::default() });
                f.state = FlowState::Complete;
            });
            return Request::from_parts(parts, Body::from(body)).into();
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

        if !plan.scripts.is_empty() {
            use crate::script::{body_from_js, body_to_js, headers_from_js, headers_to_js};
            let headers = headers_from(&parts.headers);
            let request = serde_json::json!({
                "method": parts.method.as_str(), "url": parts.uri.to_string(),
                "headers": headers_to_js(&headers), "body": body_to_js(editable_body(&headers, &body).as_deref()),
            });
            let context = serde_json::json!({ "flowId": id, "url": parts.uri.to_string() });
            let result = self.engine.run_scripts(id, &plan.scripts, "onRequest", context, vec![request.clone()]).await;
            self.script_request = result.clone().unwrap_or(request);
            if let Some(r) = result {
                if let Some(m) = r["method"].as_str().and_then(|m| Method::from_bytes(m.as_bytes()).ok()) { parts.method = m; }
                if let Some(u) = r["url"].as_str().and_then(|u| u.parse().ok()) { parts.uri = u; }
                if let Some(h) = headers_from_js(&r["headers"]) { parts.headers = header_map(&h); }
                body = apply_body(&mut parts.headers, body, body_from_js(&r["body"]));
                let (method, url, headers, recorded) = (parts.method.to_string(), parts.uri.to_string(), headers_from(&parts.headers), body.clone());
                self.engine.update(id, |f| {
                    f.method = method;
                    f.url = url;
                    f.request = Message { headers, body_size: recorded.len(), body: truncate(&recorded) };
                });
            }
            self.scripts = Arc::new(plan.scripts.clone());
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
        // Keep the client connection open until lsof has seen it (one-shot clients close right after).
        let lookup = self.lookup.take().and_then(|l| l.lock().unwrap().take());
        if let Some(task) = lookup {
            let _ = tokio::time::timeout(Duration::from_millis(300), task).await;
        }
        let (mut parts, body) = res.into_parts();

        if self.break_response || !self.scripts.is_empty() {
            // Editing needs the whole body, so this path buffers instead of streaming.
            let raw = match body.collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) => return self.local_response(id, StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new(), Some(format!("reading response: {e}"))),
            };
            let headers = headers_from(&parts.headers);
            let mut msg = Editable { method: String::new(), url: String::new(), status: parts.status.as_u16(), body: editable_body(&headers, &raw), headers };
            let mut edited = false;
            if !self.scripts.is_empty() {
                use crate::script::{body_from_js, body_to_js, headers_from_js, headers_to_js};
                let response = serde_json::json!({ "status": msg.status, "headers": headers_to_js(&msg.headers), "body": body_to_js(msg.body.as_deref()) });
                let context = serde_json::json!({ "flowId": id, "url": self.script_request["url"] });
                let scripts = self.scripts.clone();
                if let Some(r) = self.engine.run_scripts(id, &scripts, "onResponse", context, vec![self.script_request.clone(), response]).await {
                    msg.status = r["status"].as_u64().map(|s| s as u16).unwrap_or(msg.status);
                    msg.headers = headers_from_js(&r["headers"]).unwrap_or(msg.headers);
                    // Only replace the body when the script produced one; binary bodies stay untouched.
                    msg.body = body_from_js(&r["body"]);
                    edited = true;
                }
            }
            if self.break_response {
                match self.engine.pause(id, true, msg.clone()).await {
                    Decision::Abort => return self.local_response(id, StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new(), Some("aborted at breakpoint".into())),
                    Decision::Continue(e) => { msg = e; edited = true; }
                }
            }
            let (mut headers, body_text) = if edited { (header_map(&msg.headers), msg.body) } else { (parts.headers.clone(), None) };
            let body = apply_body(&mut headers, raw, body_text);
            throttle_bytes(body.len(), self.download_bps).await;
            return self.local_response(id, StatusCode::from_u16(msg.status).unwrap_or(parts.status), headers, body, None);
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

/// Records WebSocket frames on the flow of their upgrade request; frames pass through unchanged.
#[derive(Clone)]
struct Frames {
    engine: Arc<Inner>,
}

impl WebSocketHandler for Frames {
    async fn handle_message(&mut self, ctx: &WebSocketContext, msg: WsMsg) -> Option<WsMsg> {
        let (key, outgoing) = match ctx {
            WebSocketContext::ClientToServer { src, dst, .. } => ((*src, dst.to_string()), true),
            WebSocketContext::ServerToClient { src, dst, .. } => ((*dst, src.to_string()), false),
        };
        let id = self.engine.websockets.lock().unwrap().get(&key).copied();
        if let Some(id) = id {
            let (kind, size, data) = match &msg {
                WsMsg::Text(t) => ("text", t.len(), t.as_str().chars().take(MAX_WS_FRAME_STORED).collect()),
                WsMsg::Binary(b) => {
                    use base64::Engine as _;
                    ("binary", b.len(), base64::engine::general_purpose::STANDARD.encode(&b[..b.len().min(MAX_WS_FRAME_STORED)]))
                }
                WsMsg::Ping(p) => ("ping", p.len(), String::new()),
                WsMsg::Pong(p) => ("pong", p.len(), String::new()),
                WsMsg::Close(c) => ("close", 0, c.as_ref().map(|c| format!("{} {}", u16::from(c.code), c.reason)).unwrap_or_default()),
                WsMsg::Frame(f) => ("frame", f.len(), String::new()),
            };
            let closed = kind == "close";
            self.engine.update(id, |f| {
                if f.ws_messages.len() >= MAX_WS_MESSAGES {
                    f.ws_messages.remove(0);
                }
                f.ws_messages.push(WsMessage { outgoing, time_ms: now_ms(), kind, size, data });
                if closed {
                    f.duration_ms = Some(now_ms().saturating_sub(f.started_ms));
                }
            });
            if closed {
                self.engine.websockets.lock().unwrap().remove(&key);
            }
        }
        Some(msg)
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
