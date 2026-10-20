use serde::Serialize;
use serde::Deserialize;
use sniffo_core::{BreakpointHit, Decision, Engine, Flow, FlowEvent, FlowSummary, ProxyHandle, RootCa, Rules, SslProxying, StartOptions, system};
use std::{path::PathBuf, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, ipc::Response};
use tokio::{net::TcpListener, sync::Mutex};

const DEFAULT_PORT: u16 = 9191;

struct AppState {
    engine: Engine,
    ca: RootCa,
    ca_path: PathBuf,
    snapshot_path: PathBuf,
    settings_path: PathBuf,
    allow_lan: AtomicBool,
    proxy: Mutex<Option<ProxyHandle>>,
}

/// Persisted user configuration.
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    /// Listen on all interfaces so phones/tablets on the LAN can use the proxy.
    #[serde(default = "yes")]
    allow_lan: bool,
    #[serde(default)]
    ssl: SslProxying,
    #[serde(default)]
    rules: Rules,
}

fn yes() -> bool {
    true
}

impl AppState {
    fn save(&self) -> Result<(), String> {
        let saved = Saved { allow_lan: self.allow_lan.load(Ordering::Relaxed), ssl: self.engine.ssl_proxying(), rules: self.engine.rules() };
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
        lan: system::lan_addresses(),
        ca_path: state.ca_path.display().to_string(),
        ca_trusted: system::ca_trusted(&state.ca_path),
        system_proxy: system::system_proxy_enabled(&state.snapshot_path),
    })
}

#[tauri::command]
async fn start_proxy(state: State<'_, AppState>, port: Option<u16>) -> Result<String, String> {
    let mut proxy = state.proxy.lock().await;
    if let Some(p) = proxy.take() {
        p.stop().await;
    }
    // All interfaces when LAN devices are allowed (like Proxyman); otherwise loopback only.
    let host = if state.allow_lan.load(Ordering::Relaxed) { "0.0.0.0" } else { "127.0.0.1" };
    let listener = TcpListener::bind((host, port.unwrap_or(DEFAULT_PORT)))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", port.unwrap_or(DEFAULT_PORT)))?;
    let handle = state.engine.start(listener, &state.ca, StartOptions::default()).await?;
    let addr = handle.addr.to_string();
    *proxy = Some(handle);
    Ok(addr)
}

#[tauri::command]
async fn stop_proxy(state: State<'_, AppState>) -> Result<(), String> {
    // Never leave the OS pointing at a dead proxy.
    system::disable_system_proxy(&state.snapshot_path).map_err(|e| e.to_string())?;
    if let Some(p) = state.proxy.lock().await.take() {
        p.stop().await;
    }
    Ok(())
}

#[tauri::command]
async fn set_system_proxy(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    if !enabled {
        return system::disable_system_proxy(&state.snapshot_path).map_err(|e| e.to_string());
    }
    let port = state.proxy.lock().await.as_ref().map(|p| p.addr.port()).ok_or("start the proxy first")?;
    system::enable_system_proxy("127.0.0.1", port, &state.snapshot_path).map_err(|e| e.to_string())
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

#[tauri::command]
fn list_breakpoints(state: State<'_, AppState>) -> Vec<BreakpointHit> {
    state.engine.breakpoints()
}

#[tauri::command]
fn resume_breakpoint(state: State<'_, AppState>, id: u64, decision: Decision) -> bool {
    state.engine.resume(id, decision)
}

/// Forwards engine events to the UI in batches so heavy traffic doesn't flood IPC.
fn forward_events(app: AppHandle, engine: &Engine) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let ca = RootCa::load_or_create(&dir)?;
            let snapshot_path = dir.join("system-proxy-snapshot.json");
            if system::system_proxy_enabled(&snapshot_path) {
                tracing::warn!("previous run left the system proxy on; restoring");
                if let Err(e) = system::disable_system_proxy(&snapshot_path) {
                    tracing::error!("restoring system proxy: {e}");
                }
            }
            let engine = Engine::default();
            let settings_path = dir.join("settings.json");
            let mut allow_lan = true;
            if let Ok(data) = std::fs::read(&settings_path) {
                match serde_json::from_slice::<Saved>(&data) {
                    Ok(saved) => {
                        allow_lan = saved.allow_lan;
                        engine.set_ssl_proxying(saved.ssl);
                        engine.set_rules(saved.rules);
                    }
                    Err(e) => tracing::error!("ignoring unreadable {}: {e}", settings_path.display()),
                }
            }
            forward_events(app.handle().clone(), &engine);
            app.manage(AppState { engine, ca, ca_path: dir.join("sniffo-ca.pem"), snapshot_path, settings_path, allow_lan: AtomicBool::new(allow_lan), proxy: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            proxy_status, start_proxy, stop_proxy, set_allow_lan, set_system_proxy, trust_ca, reveal_ca, list_flows, get_flow, get_body, clear_flows, remove_flows, pin_flow, search_flows,
            get_ssl_proxying, set_ssl_proxying, get_rules, set_rules, list_breakpoints, resume_breakpoint
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                if let Err(e) = system::disable_system_proxy(&state.snapshot_path) {
                    tracing::error!("restoring system proxy on exit: {e}");
                }
            }
        });
}
