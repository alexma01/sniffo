use serde::Serialize;
use serde::Deserialize;
use sniffo_core::devices::{self, Device};
use sniffo_core::net::NetworkOptions;
use sniffo_core::{BreakpointHit, Decision, Engine, Flow, FlowEvent, FlowSummary, ProxyHandle, RootCa, Rules, SslProxying, StartOptions, system};
use std::{path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, ipc::Response};
use tokio::{net::TcpListener, sync::Mutex};

const DEFAULT_PORT: u16 = 9191;

struct AppState {
    engine: Engine,
    ca: RootCa,
    ca_path: PathBuf,
    snapshot_path: PathBuf,
    settings_path: PathBuf,
    allow_lan: AtomicBool,
    auto_system_proxy: AtomicBool,
    /// What the user asked for; a watchdog re-applies it (e.g. after a panic hook undid it).
    want_system_proxy: AtomicBool,
    /// Last result of routing a VPN's own proxy entry through us (macOS).
    vpn: std::sync::Mutex<system::VpnProxy>,
    proxy: Mutex<Option<ProxyHandle>>,
    network: std::sync::Mutex<NetworkOptions>,
    reverse_cfg: std::sync::Mutex<Vec<ReverseProxy>>,
    reverse: Mutex<Vec<ProxyHandle>>,
    proto_files: std::sync::Mutex<Vec<String>>,
    proto_pool: std::sync::Mutex<Option<prost_reflect::DescriptorPool>>,
    /// PNG cache of client app icons.
    icons_dir: PathBuf,
}

/// Persisted user configuration.
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    /// Listen on all interfaces so phones/tablets on the LAN can use the proxy.
    #[serde(default = "yes")]
    allow_lan: bool,
    /// Like Proxyman: point the OS at Sniffo on launch (restored on quit).
    #[serde(default = "yes")]
    auto_system_proxy: bool,
    #[serde(default)]
    ssl: SslProxying,
    #[serde(default)]
    rules: Rules,
    #[serde(default)]
    network: NetworkOptions,
    #[serde(default)]
    reverse: Vec<ReverseProxy>,
    /// .proto / descriptor-set files used to decode protobuf bodies.
    #[serde(default)]
    proto_files: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ReverseProxy {
    enabled: bool,
    port: u16,
    /// Base URL requests are forwarded to, e.g. http://localhost:3000
    target: String,
}

fn yes() -> bool {
    true
}

impl AppState {
    /// CA, saved settings and crash recovery of the system proxy, from the app data folder.
    fn load(dir: &Path, icons_dir: PathBuf) -> std::io::Result<Self> {
        let ca = RootCa::load_or_create(dir)?;
        let snapshot_path = dir.join("system-proxy-snapshot.json");
        if system::system_proxy_enabled(&snapshot_path) {
            tracing::warn!("previous run left the system proxy on; restoring");
            if let Err(e) = system::disable_system_proxy(&snapshot_path) {
                tracing::error!("restoring system proxy: {e}");
            }
        }
        let engine = Engine::default();
        let settings_path = dir.join("settings.json");
        let mut saved = Saved { allow_lan: true, auto_system_proxy: true, ..Default::default() };
        if let Ok(data) = std::fs::read(&settings_path) {
            match serde_json::from_slice::<Saved>(&data) {
                Ok(s) => saved = s,
                Err(e) => tracing::error!("ignoring unreadable {}: {e}", settings_path.display()),
            }
        }
        engine.set_ssl_proxying(saved.ssl);
        engine.set_rules(saved.rules);
        let proto_pool = match saved.proto_files.is_empty() {
            true => None,
            false => sniffo_core::schema::load(&saved.proto_files.iter().map(PathBuf::from).collect::<Vec<_>>())
                .inspect_err(|e| tracing::error!("protobuf schemas: {e}"))
                .ok(),
        };
        Ok(AppState {
            engine,
            ca,
            ca_path: dir.join("sniffo-ca.pem"),
            snapshot_path,
            settings_path,
            allow_lan: AtomicBool::new(saved.allow_lan),
            auto_system_proxy: AtomicBool::new(saved.auto_system_proxy),
            want_system_proxy: AtomicBool::new(false),
            vpn: std::sync::Mutex::new(system::VpnProxy::NotNeeded),
            proxy: Mutex::new(None),
            network: std::sync::Mutex::new(saved.network),
            reverse_cfg: std::sync::Mutex::new(saved.reverse),
            reverse: Mutex::new(vec![]),
            proto_files: std::sync::Mutex::new(saved.proto_files),
            proto_pool: std::sync::Mutex::new(proto_pool),
            icons_dir,
        })
    }

    fn save(&self) -> Result<(), String> {
        let saved = Saved {
            allow_lan: self.allow_lan.load(Ordering::Relaxed),
            auto_system_proxy: self.auto_system_proxy.load(Ordering::Relaxed),
            ssl: self.engine.ssl_proxying(),
            rules: self.engine.rules(),
            network: self.network.lock().unwrap().clone(),
            reverse: self.reverse_cfg.lock().unwrap().clone(),
            proto_files: self.proto_files.lock().unwrap().clone(),
        };
        let json = serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, json).map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
struct ProxyStatus {
    running: bool,
    address: Option<String>,
    port: Option<u16>,
    allow_lan: bool,
    auto_system_proxy: bool,
    vpn: system::VpnProxy,
    lan: Vec<system::LanAddress>,
    ca_path: String,
    ca_trusted: bool,
    system_proxy: bool,
}

#[tauri::command]
async fn proxy_status(state: State<'_, AppState>) -> Result<ProxyStatus, String> {
    let proxy = state.proxy.lock().await;
    Ok(ProxyStatus {
        running: proxy.is_some(),
        address: proxy.as_ref().map(|p| format!("127.0.0.1:{}", p.addr.port())),
        port: proxy.as_ref().map(|p| p.addr.port()),
        allow_lan: state.allow_lan.load(Ordering::Relaxed),
        auto_system_proxy: state.auto_system_proxy.load(Ordering::Relaxed),
        vpn: state.vpn.lock().unwrap().clone(),
        lan: system::lan_addresses(),
        ca_path: state.ca_path.display().to_string(),
        ca_trusted: system::ca_trusted(&state.ca_path),
        system_proxy: system::system_proxy_enabled(&state.snapshot_path),
    })
}

#[tauri::command]
async fn start_proxy(state: State<'_, AppState>, port: Option<u16>) -> Result<String, String> {
    // The OS may let 0.0.0.0:P and 127.0.0.1:P coexist; a reverse proxy there would steal our
    // traffic. Checked before the running proxy is stopped (reverse lock first, as start_reverse).
    let wanted = port.unwrap_or(DEFAULT_PORT);
    if state.reverse.lock().await.iter().any(|h| h.addr.port() == wanted) {
        return Err(format!("cannot listen on port {wanted}: a reverse proxy uses it"));
    }
    let mut proxy = state.proxy.lock().await;
    if let Some(p) = proxy.take() {
        p.stop().await;
    }
    // All interfaces when LAN devices are allowed (like Proxyman); otherwise loopback only.
    let host = if state.allow_lan.load(Ordering::Relaxed) { "0.0.0.0" } else { "127.0.0.1" };
    let listener = TcpListener::bind((host, port.unwrap_or(DEFAULT_PORT)))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", port.unwrap_or(DEFAULT_PORT)))?;
    let network = state.network.lock().unwrap().clone();
    let handle = state.engine.start(listener, &state.ca, StartOptions { network, ..Default::default() }).await?;
    let addr = handle.addr.to_string();
    let port = handle.addr.port();
    *proxy = Some(handle);
    // Keep the OS pointed at us when the port changes (snapshot of the user's settings is kept).
    if system::system_proxy_enabled(&state.snapshot_path) {
        system::enable_system_proxy("127.0.0.1", port, &state.snapshot_path).map_err(|e| e.to_string())?;
    }
    Ok(addr)
}

#[tauri::command]
async fn stop_proxy(state: State<'_, AppState>) -> Result<(), String> {
    state.want_system_proxy.store(false, Ordering::Relaxed);
    // Never leave the OS pointing at a dead proxy.
    system::disable_system_proxy(&state.snapshot_path).map_err(|e| e.to_string())?;
    if let Some(p) = state.proxy.lock().await.take() {
        p.stop().await;
    }
    Ok(())
}

#[tauri::command]
async fn set_system_proxy(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.want_system_proxy.store(enabled, Ordering::Relaxed);
    if !enabled {
        *state.vpn.lock().unwrap() = system::VpnProxy::NotNeeded;
        return system::disable_system_proxy(&state.snapshot_path).map_err(|e| e.to_string());
    }
    let port = state.proxy.lock().await.as_ref().map(|p| p.addr.port()).ok_or("start the proxy first")?;
    system::enable_system_proxy("127.0.0.1", port, &state.snapshot_path).map_err(|e| e.to_string())?;
    apply_vpn(&state, port).await;
    Ok(())
}

/// VPNs can hide the system proxy; route their entry through us when the helper allows it.
async fn apply_vpn(state: &AppState, port: u16) {
    let result = tauri::async_runtime::spawn_blocking(move || system::apply_vpn_proxy(port)).await.unwrap_or(system::VpnProxy::NotNeeded);
    *state.vpn.lock().unwrap() = result;
}

#[tauri::command]
async fn install_vpn_helper(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(system::install_vpn_helper).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if let Some(port) = state.proxy.lock().await.as_ref().map(|p| p.addr.port()) {
        apply_vpn(&state, port).await;
    }
    Ok(())
}

#[tauri::command]
async fn trust_ca(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.ca_path.clone();
    tauri::async_runtime::spawn_blocking(move || system::trust_ca(&path)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_ca(state: State<'_, AppState>) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&state.ca_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_allow_lan(state: State<'_, AppState>, allow: bool) -> Result<(), String> {
    state.allow_lan.store(allow, Ordering::Relaxed);
    state.save()?;
    let port = state.proxy.lock().await.as_ref().map(|p| p.addr.port());
    if port.is_some() {
        start_proxy(state, port).await?;
    }
    Ok(())
}

#[tauri::command]
async fn list_devices() -> Result<Vec<Device>, String> {
    tauri::async_runtime::spawn_blocking(devices::list).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn device_command(state: State<'_, AppState>, device: String, command: devices::Command) -> Result<String, String> {
    let port = state.proxy.lock().await.as_ref().map(|p| p.addr.port()).unwrap_or(DEFAULT_PORT);
    let ca = state.ca_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let list = devices::list();
        let d = list.iter().find(|d| d.id == device).ok_or("device not found (disconnected?)")?;
        devices::execute(d, &command, &devices::Context { ca_pem: &ca, proxy_port: port })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn repeat_flow(state: State<'_, AppState>, id: u64) -> Result<u16, String> {
    let addr = state.proxy.lock().await.as_ref().map(|p| p.addr).ok_or("start the proxy first")?;
    let f = state.engine.flow(id).ok_or("flow not found")?;
    sniffo_core::compose::send(addr, &state.ca.cert_pem, &f.method, &f.url, &f.request.headers, f.request.body).await
}

#[tauri::command]
async fn compose_request(state: State<'_, AppState>, method: String, url: String, headers: Vec<(String, String)>, body: String) -> Result<u16, String> {
    let addr = state.proxy.lock().await.as_ref().map(|p| p.addr).ok_or("start the proxy first")?;
    sniffo_core::compose::send(addr, &state.ca.cert_pem, &method, &url, &headers, body.into()).await
}

/// Writes the given flows (all when `ids` is empty) as HAR; also used to save sessions.
#[tauri::command]
fn export_har(state: State<'_, AppState>, path: String, ids: Vec<u64>) -> Result<usize, String> {
    let flows: Vec<_> = state.engine.all_flows().into_iter().filter(|f| ids.is_empty() || ids.contains(&f.id)).collect();
    let json = serde_json::to_vec_pretty(&sniffo_core::har::export(&flows)).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("{path}: {e}"))?;
    Ok(flows.len())
}

/// Loads a HAR/session file; `replace` clears current flows first (opening a session).
#[tauri::command]
fn import_har(state: State<'_, AppState>, path: String, replace: bool) -> Result<usize, String> {
    let data = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let flows = sniffo_core::har::import(&data)?;
    if replace {
        state.engine.clear();
    }
    Ok(state.engine.import(flows))
}

#[tauri::command]
fn set_auto_system_proxy(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.auto_system_proxy.store(enabled, Ordering::Relaxed);
    state.save()
}

#[tauri::command]
fn get_network(state: State<'_, AppState>) -> NetworkOptions {
    state.network.lock().unwrap().clone()
}

/// Saves outgoing-connection options and restarts the proxy so they take effect.
#[tauri::command]
async fn set_network(state: State<'_, AppState>, network: NetworkOptions) -> Result<(), String> {
    // A bad entry must not stop the running proxy or be saved for the next launch.
    network.validate()?;
    *state.network.lock().unwrap() = network;
    state.save()?;
    let port = state.proxy.lock().await.as_ref().map(|p| p.addr.port());
    if port.is_some() {
        start_proxy(state, port).await?;
    }
    Ok(())
}

#[tauri::command]
fn get_reverse(state: State<'_, AppState>) -> Vec<ReverseProxy> {
    state.reverse_cfg.lock().unwrap().clone()
}

/// (Re)starts every enabled reverse proxy listener; returns per-entry errors.
#[tauri::command]
async fn set_reverse(state: State<'_, AppState>, reverse: Vec<ReverseProxy>) -> Result<Vec<Option<String>>, String> {
    *state.reverse_cfg.lock().unwrap() = reverse.clone();
    state.save()?;
    start_reverse(&state, &reverse).await
}

async fn start_reverse(state: &AppState, entries: &[ReverseProxy]) -> Result<Vec<Option<String>>, String> {
    let mut running = state.reverse.lock().await;
    for h in running.drain(..) {
        h.stop().await;
    }
    let network = state.network.lock().unwrap().clone();
    let proxy_port = state.proxy.lock().await.as_ref().map(|p| p.addr.port());
    let mut errors = vec![];
    for e in entries {
        if !e.enabled {
            errors.push(None);
            continue;
        }
        if Some(e.port) == proxy_port {
            errors.push(Some(format!("port {}: it's the proxy's own port", e.port)));
            continue;
        }
        let opts = StartOptions { network: network.clone(), reverse_target: Some(e.target.clone()), ..Default::default() };
        let result = match TcpListener::bind(("127.0.0.1", e.port)).await {
            Ok(l) => state.engine.start(l, &state.ca, opts).await,
            Err(err) => Err(format!("port {}: {err}", e.port)),
        };
        match result {
            Ok(h) => { running.push(h); errors.push(None); }
            Err(err) => errors.push(Some(err)),
        }
    }
    Ok(errors)
}

/// PNG icon of a client app (macOS: from its bundle's .icns via sips), cached on disk.
/// Empty response = no icon (CLI tools, LAN devices, other platforms).
#[tauri::command]
async fn app_icon(state: State<'_, AppState>, name: String) -> Result<Response, String> {
    let Some(bundle) = state.engine.client_app_bundle(&name) else { return Ok(Response::new(vec![])) };
    let dir = state.icons_dir.clone();
    let key: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let png = dir.join(format!("{key}.png"));
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Option<Vec<u8>> {
        if let Ok(b) = std::fs::read(&png) {
            return Some(b);
        }
        let plist = bundle.join("Contents/Info.plist");
        let out = std::process::Command::new("plutil").args(["-extract", "CFBundleIconFile", "raw"]).arg(&plist).output().ok()?;
        let mut file = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if file.is_empty() {
            file = "AppIcon".into();
        }
        if !file.ends_with(".icns") {
            file.push_str(".icns");
        }
        std::fs::create_dir_all(&dir).ok()?;
        let icns = bundle.join("Contents/Resources").join(file);
        let ok = std::process::Command::new("sips").args(["-s", "format", "png", "-Z", "64"]).arg(&icns).arg("--out").arg(&png).output().ok()?.status.success();
        if ok { std::fs::read(&png).ok() } else { None }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes.unwrap_or_default()))
}

#[tauri::command]
fn list_flows(state: State<'_, AppState>) -> Vec<FlowSummary> {
    state.engine.summaries()
}

#[tauri::command]
fn get_flow(state: State<'_, AppState>, id: u64) -> Option<Flow> {
    state.engine.flow(id)
}

/// Decoded (Content-Encoding removed) body bytes; arrives in JS as an ArrayBuffer.
#[tauri::command]
fn get_body(state: State<'_, AppState>, id: u64, response: bool) -> Response {
    let body = state.engine.flow(id).and_then(|f| if response { f.response } else { Some(f.request) });
    Response::new(body.map(|m| m.decoded_body().to_vec()).unwrap_or_default())
}

#[tauri::command]
fn clear_flows(state: State<'_, AppState>) {
    state.engine.clear();
}

#[tauri::command]
fn remove_flows(state: State<'_, AppState>, ids: Vec<u64>) {
    state.engine.remove(&ids);
}

#[tauri::command]
fn pin_flow(state: State<'_, AppState>, id: u64, pinned: bool) {
    state.engine.set_pinned(id, pinned);
}

#[tauri::command]
async fn search_flows(state: State<'_, AppState>, query: String) -> Result<Vec<u64>, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.search(&query)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_ssl_proxying(state: State<'_, AppState>) -> SslProxying {
    state.engine.ssl_proxying()
}

#[tauri::command]
fn set_ssl_proxying(state: State<'_, AppState>, ssl: SslProxying) -> Result<(), String> {
    state.engine.set_ssl_proxying(ssl);
    state.save()
}

#[tauri::command]
fn get_rules(state: State<'_, AppState>) -> Rules {
    state.engine.rules()
}

#[tauri::command]
fn set_rules(state: State<'_, AppState>, rules: Rules) -> Result<(), String> {
    state.engine.set_rules(rules);
    state.save()
}

#[derive(Serialize)]
struct ProtoSchemas {
    files: Vec<String>,
    messages: Vec<String>,
}

fn proto_schemas(state: &AppState) -> ProtoSchemas {
    let messages = state.proto_pool.lock().unwrap().as_ref().map(sniffo_core::schema::message_names).unwrap_or_default();
    ProtoSchemas { files: state.proto_files.lock().unwrap().clone(), messages }
}

#[tauri::command]
fn get_proto_schemas(state: State<'_, AppState>) -> ProtoSchemas {
    proto_schemas(&state)
}

/// Compiles the given schema files; nothing changes if any of them fails.
#[tauri::command]
fn set_proto_files(state: State<'_, AppState>, files: Vec<String>) -> Result<ProtoSchemas, String> {
    let pool = if files.is_empty() { None } else { Some(sniffo_core::schema::load(&files.iter().map(PathBuf::from).collect::<Vec<_>>())?) };
    *state.proto_pool.lock().unwrap() = pool;
    *state.proto_files.lock().unwrap() = files;
    state.save()?;
    Ok(proto_schemas(&state))
}

#[tauri::command]
fn decode_proto(state: State<'_, AppState>, id: u64, response: bool, message_type: String) -> Result<Vec<serde_json::Value>, String> {
    let flow = state.engine.flow(id).ok_or("flow not found")?;
    let msg = if response { flow.response.ok_or("no response")? } else { flow.request };
    let grpc = msg.header("content-type").is_some_and(|c| c.starts_with("application/grpc"));
    let pool = state.proto_pool.lock().unwrap();
    sniffo_core::schema::decode(pool.as_ref().ok_or("no protobuf schemas loaded")?, &message_type, &msg.decoded_body(), grpc)
}

#[tauri::command]
fn export_rules(state: State<'_, AppState>, path: String) -> Result<usize, String> {
    let rules = state.engine.rules();
    std::fs::write(&path, serde_json::to_vec_pretty(&rules).map_err(|e| e.to_string())?).map_err(|e| format!("{path}: {e}"))?;
    Ok(rules.rules.len())
}

/// Appends rules from a file exported by Sniffo (existing rules are kept).
#[tauri::command]
fn import_rules(state: State<'_, AppState>, path: String) -> Result<usize, String> {
    let data = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    // Every field has a default, so check the shape: any other JSON would import "0 rules".
    let value: serde_json::Value = serde_json::from_slice(&data).map_err(|e| format!("not a Sniffo rules file: {e}"))?;
    if !value.get("rules").is_some_and(serde_json::Value::is_array) {
        return Err("not a Sniffo rules file: no \"rules\" list".into());
    }
    let incoming: Rules = serde_json::from_value(value).map_err(|e| format!("not a Sniffo rules file: {e}"))?;
    let mut rules = state.engine.rules();
    let n = incoming.rules.len();
    let stamp = sniffo_core::flow::now_ms();
    for (i, mut r) in incoming.rules.into_iter().enumerate() {
        r.id = format!("{}-{stamp}-{i}", r.id);
        rules.rules.push(r);
    }
    state.engine.set_rules(rules);
    state.save()?;
    Ok(n)
}

#[tauri::command]
fn list_breakpoints(state: State<'_, AppState>) -> Vec<BreakpointHit> {
    state.engine.breakpoints()
}

#[tauri::command]
fn resume_breakpoint(state: State<'_, AppState>, id: u64, response: bool, decision: Decision) -> bool {
    state.engine.resume(id, response, decision)
}

#[tauri::command]
fn send_ws_message(state: State<'_, AppState>, id: u64, to_server: bool, data: String, binary: bool) -> Result<(), String> {
    state.engine.send_ws(id, to_server, data, binary)
}

/// Forwards engine events to the UI in batches so heavy traffic doesn't flood IPC.
fn forward_events<R: Runtime>(app: AppHandle<R>, engine: &Engine) {
    let mut rx = engine.subscribe();
    tauri::async_runtime::spawn(async move {
        let mut batch: Vec<FlowEvent> = Vec::new();
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(ev) => batch.push(ev),
                    // UI fell behind: tell it to reload the full list.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => { batch.clear(); let _ = app.emit("flows:resync", ()); }
                    Err(_) => break,
                },
                _ = tick.tick() => if !batch.is_empty() {
                    let _ = app.emit("flows", std::mem::take(&mut batch));
                },
            }
        }
    });
}

/// Commands, state and background tasks, shared by the desktop app, its tests and the UI test
/// bridge. `data_dir` replaces the app data folder (CA, settings, system-proxy snapshot).
pub fn setup<R: Runtime>(builder: tauri::Builder<R>, data_dir: Option<PathBuf>) -> tauri::Builder<R> {
    builder
        .setup(move |app| {
            let (dir, icons) = match data_dir {
                Some(d) => (d.clone(), d.join("icons")),
                None => (app.path().app_data_dir()?, app.path().app_cache_dir()?.join("icons")),
            };
            let state = AppState::load(&dir, icons)?;
            let reverse_cfg = state.reverse_cfg.lock().unwrap().clone();
            forward_events(app.handle().clone(), &state.engine);
            app.manage(state);
            // A panic can abort the process (tokio worker threads do) before the Exit handler runs:
            // undo the system proxy first so the user never loses network to a dead proxy.
            let snap = app.state::<AppState>().snapshot_path.clone();
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let _ = system::disable_system_proxy(&snap);
                default_hook(info);
            }));
            let watchdog = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(10));
                loop {
                    tick.tick().await;
                    let state = watchdog.state::<AppState>();
                    let port = state.proxy.lock().await.as_ref().map(|p| p.addr.port());
                    if let (true, Some(port)) = (state.want_system_proxy.load(Ordering::Relaxed), port) {
                        if !system::system_proxy_enabled(&state.snapshot_path) {
                            tracing::warn!("system proxy was reset (non-fatal panic?); re-applying");
                            let _ = system::enable_system_proxy("127.0.0.1", port, &state.snapshot_path);
                        }
                        // VPN clients may rewrite their proxy entry (reconnects): put us back.
                        apply_vpn(&state, port).await;
                    }
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                if let Ok(errors) = start_reverse(&state, &reverse_cfg).await {
                    errors.into_iter().flatten().for_each(|e| tracing::error!("reverse proxy: {e}"));
                }
            });
            // kill, logout, Ctrl+C or a `tauri dev` rebuild end the process without RunEvent::Exit:
            // put the OS proxy back first, or the machine is left without network.
            #[cfg(unix)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{SignalKind, signal};
                    let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup())) else { return };
                    tokio::select! { _ = term.recv() => {}, _ = int.recv() => {}, _ = hup.recv() => {} }
                    restore_system_proxy(&handle);
                    std::process::exit(0);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            proxy_status, start_proxy, stop_proxy, set_allow_lan, set_auto_system_proxy, install_vpn_helper, list_devices, device_command, app_icon, get_network, set_network, get_reverse, set_reverse, repeat_flow, compose_request, export_har, import_har, set_system_proxy, trust_ca, reveal_ca, list_flows, get_flow, get_body, clear_flows, remove_flows, pin_flow, search_flows,
            get_ssl_proxying, set_ssl_proxying, get_rules, set_rules, export_rules, import_rules, get_proto_schemas, set_proto_files, decode_proto, list_breakpoints, resume_breakpoint, send_ws_message
        ])
}

/// Puts the OS proxy settings back (on quit; also used by the test bridge).
pub fn restore_system_proxy<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if let Err(e) = system::disable_system_proxy(&state.snapshot_path) {
        tracing::error!("restoring system proxy on exit: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    setup(tauri::Builder::default().plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_dialog::init()), None)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                restore_system_proxy(app);
            }
        });
}
