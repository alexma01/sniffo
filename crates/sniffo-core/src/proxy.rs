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
    futures::{Sink, SinkExt, Stream, StreamExt},
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
use tokio::{net::TcpListener, sync::{broadcast, mpsc, oneshot}, task::JoinHandle, time::Sleep};

/// Bodies above this size are forwarded intact but stored truncated.
pub const MAX_STORED_BODY: usize = 32 * 1024 * 1024;
/// Oldest unpinned flows are evicted past this count to bound memory.
pub const MAX_FLOWS: usize = 50_000;
/// Magic host served by the proxy itself: phones open it to download the root CA.
pub const CERT_HOST: &str = "sniffo.cert";

/// How long stop() waits for in-flight requests before closing the listener for good.
pub const STOP_GRACE: Duration = Duration::from_secs(1);

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

/// Like Proxyman, no host is decrypted until the user enables it: apps with their own
/// trust store (JVM IDEs, CLIs) keep working when Sniffo takes over the system proxy.
impl Default for SslProxying {
    fn default() -> Self {
        Self { enabled: true, include: vec![], exclude: vec![] }
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
    /// For WebSocket frames: server -> client.
    pub response: bool,
    pub message: Editable,
    /// Set for a WebSocket frame ("text" / "binary", the latter base64 in `message.body`).
    pub ws: Option<&'static str>,
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
    /// Keyed by (flow, response): both directions of a WebSocket can be paused at once.
    paused: Mutex<HashMap<(FlowId, bool), (BreakpointHit, oneshot::Sender<Decision>)>>,
    apps: ClientApps,
    /// (client address, ws/wss URI) -> flow of the upgrade request, to attach frames to it.
    websockets: Mutex<HashMap<(SocketAddr, String), FlowId>>,
    /// (flow, client -> server) -> live forwarder of that direction, for injecting messages.
    ws_inject: Mutex<HashMap<(FlowId, bool), mpsc::UnboundedSender<WsMsg>>>,
    /// `sharedState` visible to every script.
    shared_state: Mutex<serde_json::Value>,
    /// (client, local relay port) -> real authority of a CONNECT routed through a relay.
    relays: Mutex<HashMap<(SocketAddr, u16), String>>,
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
    async fn pause(&self, id: FlowId, response: bool, message: Editable, ws: Option<&'static str>) -> Decision {
        let (tx, rx) = oneshot::channel();
        let hit = BreakpointHit { id, response, message: message.clone(), ws };
        self.paused.lock().unwrap().insert((id, response), (hit.clone(), tx));
        self.update(id, |f| f.state = FlowState::Paused);
        let _ = self.events.send(FlowEvent::Breakpoint(hit));
        let decision = tokio::time::timeout(BREAKPOINT_TIMEOUT, rx).await;
        let other_paused = {
            let mut paused = self.paused.lock().unwrap();
            paused.remove(&(id, response));
            paused.contains_key(&(id, !response))
        };
        if !other_paused {
            // An open WebSocket stays complete; an HTTP flow goes back to waiting for its response.
            self.update(id, |f| f.state = if ws.is_some() { FlowState::Complete } else { FlowState::Pending });
        }
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
                ws_inject: Mutex::default(),
                shared_state: Mutex::new(serde_json::json!({})),
                relays: Mutex::default(),
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

    /// .app bundle of a client app seen in traffic (macOS), for its icon.
    pub fn client_app_bundle(&self, name: &str) -> Option<std::path::PathBuf> {
        self.inner.apps.bundle(name)
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

    /// Releases a paused request (`response` false) or response. Returns false if it was no longer paused.
    pub fn resume(&self, id: FlowId, response: bool, decision: Decision) -> bool {
        let Some((_, tx)) = self.inner.paused.lock().unwrap().remove(&(id, response)) else { return false };
        tx.send(decision).is_ok()
    }

    /// Sends a message on a live WebSocket as if `to_server` ? the client : the server sent it.
    /// `binary` messages are given base64-encoded.
    pub fn send_ws(&self, id: FlowId, to_server: bool, data: String, binary: bool) -> Result<(), String> {
        let msg = if binary {
            use base64::Engine as _;
            WsMsg::binary(base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| format!("invalid base64: {e}"))?)
        } else {
            WsMsg::text(data)
        };
        let tx = self.inner.ws_inject.lock().unwrap().get(&(id, to_server)).cloned();
        tx.ok_or("WebSocket connection is closed")?.send(msg).map_err(|_| "WebSocket connection is closed".into())
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

        let overrides: std::collections::HashSet<String> = opts.network.dns.iter().map(|(h, _)| h.trim().to_ascii_lowercase()).collect();
        let ws_tls = Arc::new(tls.clone());
        let via = |dial: Dialer, upstream: bool| (upstream || !overrides.is_empty()).then(|| Arc::new(TunnelVia { dial, tls: ws_tls.clone(), upstream, overrides: overrides.clone() }));
        match &opts.network.upstream {
            None => self.launch(listener, ca, &opts, tls.clone(), https(tls, http.clone()), via(dialer(http), false)).await,
            Some(up) => {
                let uri = up.uri()?;
                match up.kind {
                    UpstreamKind::Http => {
                        let mut tunnel = Tunnel::new(uri, http);
                        if !up.username.is_empty() {
                            use base64::Engine as _;
                            let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", up.username, up.password));
                            tunnel = tunnel.with_auth(HeaderValue::from_str(&format!("Basic {token}")).map_err(|e| e.to_string())?);
                        }
                        self.launch(listener, ca, &opts, tls.clone(), https(tls, tunnel.clone()), via(dialer(tunnel), true)).await
                    }
                    UpstreamKind::Socks5 => {
                        let mut socks = SocksV5::new(uri, http);
                        if !up.username.is_empty() {
                            socks = socks.with_auth(up.username.clone(), up.password.clone());
                        }
                        self.launch(listener, ca, &opts, tls.clone(), https(tls, socks.clone()), via(dialer(socks), true)).await
                    }
                }
            }
        }
    }

    async fn launch<C>(&self, listener: TcpListener, ca: &RootCa, opts: &StartOptions, tls: ClientConfig, connector: C, tunnel: Option<Arc<TunnelVia>>) -> Result<ProxyHandle, String>
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
                no_caching: false,
                connect: None,
                tunnel,
                tunnel_flow: None,
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

trait TunnelIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> TunnelIo for T {}
type Dialer = Arc<dyn Fn(Uri) -> Pin<Box<dyn Future<Output = Result<Box<dyn TunnelIo>, String>> + Send>> + Send + Sync>;

/// Opens undecrypted CONNECT tunnels with the same connector as decrypted traffic, so DNS
/// overrides and the upstream proxy apply to them too (hudsucker would dial the host directly).
struct TunnelVia {
    dial: Dialer,
    /// For wss:// to such hosts (Sniffo relays those WebSockets itself).
    tls: Arc<ClientConfig>,
    upstream: bool,
    /// Hosts with a DNS override (lowercase).
    overrides: std::collections::HashSet<String>,
}

impl TunnelVia {
    fn needed(&self, host: &str) -> bool {
        self.upstream || self.overrides.contains(&host.to_ascii_lowercase())
    }
}

fn dialer<S>(svc: S) -> Dialer
where
    S: tower_service::Service<Uri> + Clone + Send + Sync + 'static,
    S::Response: hudsucker::hyper::rt::Read + hudsucker::hyper::rt::Write + Unpin + Send + 'static,
    S::Future: Send,
    S::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    Arc::new(move |uri| {
        let mut svc = svc.clone();
        Box::pin(async move {
            std::future::poll_fn(|cx| svc.poll_ready(cx)).await.map_err(|e| e.into().to_string())?;
            let io = svc.call(uri).await.map_err(|e| e.into().to_string())?;
            Ok(Box::new(hyper_util::rt::TokioIo::new(io)) as Box<dyn TunnelIo>)
        })
    })
}

pub struct ProxyHandle {
    pub addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl ProxyHandle {
    /// Stops listening at once; open connections get a short grace period. Browsers keep
    /// keep-alive connections and CONNECT tunnels open indefinitely, so a fully graceful
    /// shutdown could hang; those connections end on their own once clients notice.
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if tokio::time::timeout(STOP_GRACE, &mut self.task).await.is_err() {
            self.task.abort();
            // abort() only schedules cancellation: wait until the listener is dropped so a
            // restart on the same port (allow LAN, network options) can bind it again.
            let _ = (&mut self.task).await;
        }
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
    no_caching: bool,
    /// Client-app lookup running alongside the upstream request (see `handle_response`).
    lookup: Option<Arc<Mutex<Option<JoinHandle<()>>>>>,
    /// CONNECT request of this tunnel, recorded as a flow if its TLS is not decrypted.
    connect: Option<Arc<hudsucker::hyper::http::request::Parts>>,
    tunnel: Option<Arc<TunnelVia>>,
    /// Flow of this CONNECT's tunnel, for its relay to report a failed dial.
    tunnel_flow: Option<Arc<Mutex<Option<FlowId>>>>,
}

const CERT_PAGE: &str = r#"<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sniffo certificate</title>
<style>body{font:17px -apple-system,Roboto,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.5}
a.b{display:block;text-align:center;background:#0a66ff;color:#fff;padding:12px;border-radius:10px;text-decoration:none;margin:12px 0}
.must{background:#fff4d6;border-radius:8px;padding:6px 8px}li{margin:6px 0}</style>
<h2>Sniffo root certificate</h2>
<a class="b" href="/sniffo-ca.pem">Download for iOS / macOS</a>
<a class="b" href="/sniffo-ca.crt">Download for Android</a>
<h3>iPhone / iPad</h3><ol>
<li>Open this page in <b>Safari</b>, tap the iOS download, then <i>Allow</i>.</li>
<li>Settings &rarr; General &rarr; VPN &amp; Device Management &rarr; <i>Sniffo Root CA</i> &rarr; Install.</li>
<li class="must"><b>Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings</b> &rarr; turn on <i>Sniffo Root CA</i>. Without it you'll see &ldquo;This connection is not private&rdquo;.</li>
<li>In Sniffo, enable SSL Proxying for the hosts you want to inspect (🔒 next to the domain).</li></ol>
<h3>Android</h3><ol>
<li>Tap the Android download.</li>
<li class="must">Settings &rarr; Security &rarr; Encryption &amp; credentials &rarr; Install a certificate &rarr; <b>CA certificate</b>.</li>
<li>Chrome trusts it; your own apps need a <code>network_security_config</code> that trusts user CAs.</li></ol>
<p>When you're done, turn the Wi-Fi proxy off again: without Sniffo running the device has no internet.</p>"#;

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
            // The new body has a known length: chunked framing from the original would conflict.
            headers.remove("transfer-encoding");
            headers.insert("content-length", HeaderValue::from(text.len()));
            Bytes::from(text)
        }
    }
}

/// `https://h:443/p` -> `https://h/p` (and :80 for http); `None` when there's nothing to drop.
fn without_default_port(uri: &Uri) -> Option<Uri> {
    let default = match uri.scheme_str()? { "https" | "wss" => 443, "http" | "ws" => 80, _ => return None };
    if uri.port_u16()? != default {
        return None;
    }
    let mut parts = uri.clone().into_parts();
    parts.authority = Some(uri.host()?.parse().ok()?);
    Uri::from_parts(parts).ok()
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

/// Map Local Directory: the URL path after `prefix` is a file under `dir`.
async fn serve_dir(prefix: &str, dir: &str, url: &str) -> (StatusCode, HeaderMap, Bytes) {
    let mut h = HeaderMap::new();
    let rel = url.split(['?', '#']).next().unwrap_or("").strip_prefix(prefix).unwrap_or("");
    let rel = crate::flow::percent_decode(rel, false);
    // Never let a URL escape the mapped folder.
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return (StatusCode::FORBIDDEN, h, Bytes::from_static(b"path traversal rejected"));
    }
    let mut path = std::path::Path::new(dir).join(rel.trim_start_matches('/'));
    if path.is_dir() {
        path = path.join("index.html");
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            h.insert("content-type", HeaderValue::from_static(mime_for(&path)));
            (StatusCode::OK, h, bytes.into())
        }
        Err(_) => (StatusCode::NOT_FOUND, h, Bytes::from(format!("Map Local Directory: {} not found", path.display()))),
    }
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "mp4" => "video/mp4",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
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

    /// A TLS tunnel passed through untouched: one row so it is visible and can be enabled for decryption.
    /// ponytail: no byte counts, hudsucker copies the tunnel internally; wrap the stream if they matter.
    fn record_tunnel(&mut self, ctx: &HttpContext, parts: &hudsucker::hyper::http::request::Parts) -> Option<FlowId> {
        let url = format!("https://{}", parts.uri);
        if !self.engine.rules.read().unwrap().plan("CONNECT", &url).record {
            return None;
        }
        let id = self.record(ctx, parts, &Bytes::new(), vec![]);
        self.engine.update(id, |f| {
            f.url = url;
            f.scheme = "https".into();
            f.path = String::new();
            f.state = FlowState::Complete;
        });
        Some(id)
    }

    /// Undecrypted CONNECT to a host that needs `via`: hudsucker is pointed at a one-shot local
    /// relay that dials the real host through `via`. hudsucker still looks inside the tunnel, so
    /// plain HTTP and WebSockets in it are recorded (their requests are mapped back to the host).
    async fn relay_tunnel(&mut self, ctx: &HttpContext, mut parts: hudsucker::hyper::http::request::Parts, via: Arc<TunnelVia>) -> Result<hudsucker::hyper::http::request::Parts, String> {
        let authority = parts.uri.authority().map(|a| a.to_string()).unwrap_or_default();
        let relay = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let port = relay.local_addr().map_err(|e| e.to_string())?.port();
        {
            let mut relays = self.engine.relays.lock().unwrap();
            // ponytail: dropped wholesale past this size; entries are tiny and keyed per connection.
            if relays.len() > 10_000 {
                relays.clear();
            }
            relays.insert((ctx.client_addr, port), authority.clone());
        }
        let slot: Arc<Mutex<Option<FlowId>>> = Arc::default();
        self.tunnel_flow = Some(slot.clone());
        let engine = self.engine.clone();
        tokio::spawn(async move {
            // hudsucker connects only for TLS it doesn't decrypt; otherwise the relay just expires.
            let Ok(Ok((mut client, _))) = tokio::time::timeout(Duration::from_secs(30), relay.accept()).await else { return };
            let dialed = match format!("http://{authority}").parse() {
                Ok(target) => (via.dial)(target).await,
                Err(e) => Err(format!("{e}")),
            };
            match dialed {
                Ok(mut server) => {
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                }
                Err(e) => {
                    let id = *slot.lock().unwrap();
                    if let Some(id) = id {
                        engine.update(id, |f| { f.state = FlowState::Failed; f.error = Some(format!("tunnel to {authority}: {e}")); });
                    }
                }
            }
        });
        parts.uri = format!("127.0.0.1:{port}").parse().map_err(|e| format!("{e}"))?;
        Ok(parts)
    }

    /// WebSocket to a host that needs `via` (DNS override, upstream proxy): hudsucker's relay
    /// would dial it directly, so Sniffo does both handshakes and pumps the frames itself.
    async fn relay_websocket(&self, id: FlowId, ws_uri: String, parts: hudsucker::hyper::http::request::Parts, body: Bytes, via: Arc<TunnelVia>, client: SocketAddr) -> Response<Body> {
        use hudsucker::tokio_tungstenite::{WebSocketStream, client_async_tls_with_config, tungstenite::{handshake::derive_accept_key, protocol::Role}};
        let fail = |e: String| self.local_response(id, StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new(), Some(e));
        let Some(key) = parts.headers.get("sec-websocket-key").map(|k| k.as_bytes().to_vec()) else { return fail("missing Sec-WebSocket-Key".into()) };
        let secure = parts.uri.scheme_str() == Some("https");
        let host = parts.uri.host().unwrap_or_default().to_owned();
        let port = parts.uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
        let dialed = match format!("http://{host}:{port}").parse() {
            Ok(target) => (via.dial)(target).await,
            Err(e) => Err(format!("{e}")),
        };
        let server_io = match dialed {
            Ok(io) => io,
            Err(e) => return fail(format!("websocket to {host}:{port}: {e}")),
        };
        let mut req = Request::builder().uri(ws_uri.as_str());
        for (k, v) in &parts.headers {
            // No compression: neither end of the relay speaks permessage-deflate.
            if k != "sec-websocket-extensions" && k != "proxy-connection" {
                req = req.header(k, v);
            }
        }
        let Ok(req) = req.body(()) else { return fail("invalid WebSocket request".into()) };
        let connector = if secure { Connector::Rustls(via.tls.clone()) } else { Connector::Plain };
        let (server_ws, server_res) = match client_async_tls_with_config(req, server_io, None, Some(connector)).await {
            Ok(ws) => ws,
            Err(e) => return fail(format!("websocket handshake with {host}: {e}")),
        };
        let mut res = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header("upgrade", "websocket")
            .header("connection", "Upgrade")
            .header("sec-websocket-accept", derive_accept_key(&key));
        if let Some(protocol) = server_res.headers().get("sec-websocket-protocol") {
            res = res.header("sec-websocket-protocol", protocol);
        }
        let upgrade = hudsucker::hyper::upgrade::on(Request::from_parts(parts, Body::from(body)));
        let frames = Frames { engine: self.engine.clone() };
        tokio::spawn(async move {
            let Ok(upgraded) = upgrade.await else { return };
            let client_ws = WebSocketStream::from_raw_socket(hyper_util::rt::TokioIo::new(upgraded), Role::Server, None).await;
            let (to_client, from_client) = client_ws.split();
            let (to_server, from_server) = server_ws.split();
            let key = (client, ws_uri);
            tokio::join!(frames.clone().pump(key.clone(), true, from_client, to_server), frames.pump(key, false, from_server, to_client));
        });
        res.body(Body::empty()).unwrap_or_else(|_| Response::new(Body::empty()))
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
            let (parts, body) = req.into_parts();
            // Recorded (if tunnelled) under the host the client asked for.
            self.connect = Some(Arc::new(parts.clone()));
            let host = parts.uri.host().unwrap_or_default().to_owned();
            if let Some(via) = self.tunnel.clone().filter(|t| t.needed(&host) && !self.engine.ssl.read().unwrap().should_decrypt(&host)) {
                match self.relay_tunnel(ctx, parts.clone(), via).await {
                    Ok(relayed) => return Request::from_parts(relayed, body).into(),
                    Err(e) => tracing::warn!("tunnel relay for {host}: {e}"),
                }
            }
            return Request::from_parts(parts, body).into();
        }
        let (mut parts, body) = req.into_parts();
        let body = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("failed to read request body: {e}")).into(),
        };
        // A request inside a relayed tunnel names the relay: put the real host back.
        if let (Some("127.0.0.1"), Some(port)) = (parts.uri.host(), parts.uri.port_u16()) {
            let real = self.engine.relays.lock().unwrap().get(&(ctx.client_addr, port)).cloned();
            if let Some(real) = real {
                let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
                if let Ok(uri) = format!("{}://{real}{pq}", parts.uri.scheme_str().unwrap_or("http")).parse() {
                    parts.uri = uri;
                }
            }
        }
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
        // Decrypted requests carry the CONNECT authority ("host:443"): rules like
        // https://host/* and the recorded URL must see the URL as the client wrote it.
        if let Some(uri) = without_default_port(&parts.uri) {
            parts.uri = uri;
        }
        self.is_head = parts.method == Method::HEAD;
        let rules = self.engine.rules.read().unwrap().clone();
        let plan = rules.plan(parts.method.as_str(), &parts.uri.to_string());
        if !plan.record {
            return Request::from_parts(parts, Body::from(body)).into();
        }
        self.no_caching = plan.no_caching;
        if plan.no_caching {
            for h in ["if-none-match", "if-modified-since"] {
                parts.headers.remove(h);
            }
            parts.headers.insert("cache-control", HeaderValue::from_static("no-cache"));
            parts.headers.insert("pragma", HeaderValue::from_static("no-cache"));
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
            self.engine.websockets.lock().unwrap().insert((ctx.client_addr, ws_uri.clone()), id);
            self.engine.update(id, |f| {
                f.status = Some(101);
                f.ttfb_ms = Some(now_ms().saturating_sub(f.started_ms));
                f.response = Some(Message { headers: vec![("upgrade".into(), "websocket".into())], ..Default::default() });
                f.state = FlowState::Complete;
            });
            if let Some(via) = self.tunnel.clone().filter(|t| t.needed(parts.uri.host().unwrap_or_default())) {
                return self.relay_websocket(id, ws_uri, parts, body, via, ctx.client_addr).await.into();
            }
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
            match self.engine.pause(id, false, editable, None).await {
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

        if let Some((prefix, dir)) = &plan.map_dir {
            let (status, mut h, bytes) = serve_dir(prefix, dir, &parts.uri.to_string()).await;
            h.insert("content-length", HeaderValue::from(bytes.len()));
            throttle_bytes(bytes.len(), plan.download_bps).await;
            return self.local_response(id, status, h, bytes, None).into();
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
                match self.engine.pause(id, true, msg.clone(), None).await {
                    Decision::Abort => return self.local_response(id, StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new(), Some("aborted at breakpoint".into())),
                    Decision::Continue(e) => { msg = e; edited = true; }
                }
            }
            let (mut headers, body_text) = if edited { (header_map(&msg.headers), msg.body) } else { (parts.headers.clone(), None) };
            let body = apply_body(&mut headers, raw, body_text);
            throttle_bytes(body.len(), self.download_bps).await;
            return self.local_response(id, StatusCode::from_u16(msg.status).unwrap_or(parts.status), headers, body, None);
        }

        if self.no_caching {
            for h in ["etag", "last-modified", "expires"] {
                parts.headers.remove(h);
            }
            parts.headers.insert("cache-control", HeaderValue::from_static("no-store"));
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

    async fn should_intercept_tls(&mut self, ctx: &HttpContext, hello: hudsucker::rustls::server::ClientHello<'_>) -> bool {
        let decrypt = hello.server_name().is_some_and(|sni| self.engine.ssl.read().unwrap().should_decrypt(sni));
        if let (false, Some(parts)) = (decrypt, self.connect.take()) {
            let id = self.record_tunnel(ctx, &parts);
            if let (Some(id), Some(slot)) = (id, &self.tunnel_flow) {
                *slot.lock().unwrap() = Some(id);
            }
        }
        decrypt
    }
}

/// Records WebSocket frames on the flow of their upgrade request and forwards messages injected via `Engine::send_ws`.
#[derive(Clone)]
struct Frames {
    engine: Arc<Inner>,
}

impl Frames {
    fn record(&self, id: FlowId, outgoing: bool, msg: &WsMsg, injected: bool) {
        let (kind, size, data) = match msg {
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
        self.engine.update(id, |f| {
            if f.ws_messages.len() >= MAX_WS_MESSAGES {
                f.ws_messages.remove(0);
            }
            f.ws_messages.push(WsMessage { outgoing, time_ms: now_ms(), kind, size, data, injected });
            if kind == "close" {
                f.duration_ms = Some(now_ms().saturating_sub(f.started_ms));
            }
        });
    }
}

impl Frames {
    /// Holds a text/binary frame when a Breakpoint rule matches the connection's URL
    /// (Request = client -> server, Response = server -> client). `None` drops the frame.
    async fn breakpoint(&self, id: FlowId, outgoing: bool, url: &str, msg: WsMsg) -> Option<WsMsg> {
        let plan = self.engine.rules.read().unwrap().plan("GET", url);
        if !(if outgoing { plan.break_request } else { plan.break_response }) {
            return Some(msg);
        }
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let (kind, body) = match &msg {
            WsMsg::Text(t) => ("text", t.as_str().to_owned()),
            WsMsg::Binary(b) => ("binary", b64.encode(b)),
            _ => return Some(msg),
        };
        let editable = Editable { method: String::new(), url: url.to_owned(), status: 0, headers: vec![], body: Some(body) };
        match self.engine.pause(id, !outgoing, editable, Some(kind)).await {
            Decision::Abort => None,
            Decision::Continue(e) => match (kind, e.body) {
                (_, None) => Some(msg),
                ("text", Some(t)) => Some(WsMsg::text(t)),
                (_, Some(b)) => match b64.decode(b.trim()) {
                    Ok(bytes) => Some(WsMsg::binary(bytes)),
                    Err(err) => {
                        tracing::warn!("WebSocket breakpoint: invalid base64 ({err}), forwarding the original frame");
                        Some(msg)
                    }
                },
            },
        }
    }
}

impl WebSocketHandler for Frames {
    async fn handle_websocket(
        self,
        ctx: WebSocketContext,
        stream: impl Stream<Item = Result<WsMsg, hudsucker::tokio_tungstenite::tungstenite::Error>> + Unpin + Send + 'static,
        sink: impl Sink<WsMsg, Error = hudsucker::tokio_tungstenite::tungstenite::Error> + Unpin + Send + 'static,
    ) {
        // Same form as the recorded upgrade URL (default port dropped).
        let norm = |u: &Uri| without_default_port(u).unwrap_or_else(|| u.clone()).to_string();
        let (key, outgoing) = match &ctx {
            WebSocketContext::ClientToServer { src, dst, .. } => ((*src, norm(dst)), true),
            WebSocketContext::ServerToClient { src, dst, .. } => ((*dst, norm(src)), false),
        };
        self.pump(key, outgoing, stream, sink).await
    }
}

impl Frames {
    /// Forwards one direction of a WebSocket, recording frames on the flow of its upgrade
    /// (`key` = client address + URL), with breakpoints and injected messages.
    async fn pump(
        self,
        key: (SocketAddr, String),
        outgoing: bool,
        mut stream: impl Stream<Item = Result<WsMsg, hudsucker::tokio_tungstenite::tungstenite::Error>> + Unpin + Send + 'static,
        mut sink: impl Sink<WsMsg, Error = hudsucker::tokio_tungstenite::tungstenite::Error> + Unpin + Send + 'static,
    ) {
        let id = self.engine.websockets.lock().unwrap().get(&key).copied();
        let url = id.and_then(|id| self.engine.flows.read().unwrap().get(&id).map(|f| f.url.clone())).unwrap_or_default();
        let mut injected = match id {
            Some(id) => {
                let (tx, rx) = mpsc::unbounded_channel();
                self.engine.ws_inject.lock().unwrap().insert((id, outgoing), tx);
                Some(rx)
            }
            None => None,
        };
        loop {
            let (msg, is_injected) = tokio::select! {
                m = stream.next() => match m {
                    Some(Ok(m)) => (m, false),
                    Some(Err(e)) => {
                        tracing::debug!("WebSocket message error: {e}");
                        let _ = sink.send(WsMsg::Close(None)).await;
                        break;
                    }
                    None => break,
                },
                Some(m) = async { injected.as_mut()?.recv().await } => (m, true),
            };
            let msg = match id {
                Some(id) if !is_injected => match self.breakpoint(id, outgoing, &url, msg).await {
                    Some(m) => m,
                    None => continue,
                },
                _ => msg,
            };
            let closed = msg.is_close();
            if let Some(id) = id {
                self.record(id, outgoing, &msg, is_injected);
                if closed {
                    self.engine.websockets.lock().unwrap().remove(&key);
                }
            }
            if let Err(e) = sink.send(msg).await {
                tracing::debug!("WebSocket send error: {e}");
            }
        }
        if let Some(id) = id {
            self.engine.ws_inject.lock().unwrap().remove(&(id, outgoing));
        }
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
        let u = |s: &str| without_default_port(&s.parse().unwrap()).map(|u| u.to_string());
        assert_eq!(u("https://a.test:443/x?y=1"), Some("https://a.test/x?y=1".into()));
        assert_eq!(u("http://a.test:80/"), Some("http://a.test/".into()));
        assert_eq!(u("https://[::1]:443/"), Some("https://[::1]/".into()));
        assert_eq!(u("https://a.test:8443/"), None);
        assert_eq!(u("http://a.test/"), None);
        assert!(!ssl.should_decrypt("gs.apple.com"));
    }
}
