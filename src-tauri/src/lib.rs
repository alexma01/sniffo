use serde::Serialize;
use sniffo_core::{Engine, Flow, FlowEvent, FlowSummary, ProxyHandle, RootCa, SslProxying, StartOptions};
use std::{path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State, ipc::Response};
use tokio::{net::TcpListener, sync::Mutex};

const DEFAULT_PORT: u16 = 9191;

struct AppState {
    engine: Engine,
    ca: RootCa,
    ca_path: PathBuf,
    proxy: Mutex<Option<ProxyHandle>>,
}

#[derive(Serialize)]
struct ProxyStatus {
    running: bool,
    address: Option<String>,
    ca_path: String,
}

#[tauri::command]
async fn proxy_status(state: State<'_, AppState>) -> Result<ProxyStatus, String> {
    let proxy = state.proxy.lock().await;
    Ok(ProxyStatus {
        running: proxy.is_some(),
        address: proxy.as_ref().map(|p| p.addr.to_string()),
        ca_path: state.ca_path.display().to_string(),
    })
}

#[tauri::command]
async fn start_proxy(state: State<'_, AppState>, port: Option<u16>) -> Result<String, String> {
    let mut proxy = state.proxy.lock().await;
    if let Some(p) = proxy.take() {
        p.stop().await;
    }
    // Loopback only; LAN access for devices is an explicit opt-in (open proxies get abused).
    let listener = TcpListener::bind(("127.0.0.1", port.unwrap_or(DEFAULT_PORT)))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", port.unwrap_or(DEFAULT_PORT)))?;
    let handle = state.engine.start(listener, &state.ca, StartOptions::default()).await?;
    let addr = handle.addr.to_string();
    *proxy = Some(handle);
    Ok(addr)
}

#[tauri::command]
async fn stop_proxy(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(p) = state.proxy.lock().await.take() {
        p.stop().await;
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
fn get_ssl_proxying(state: State<'_, AppState>) -> SslProxying {
    state.engine.ssl_proxying()
}

#[tauri::command]
fn set_ssl_proxying(state: State<'_, AppState>, ssl: SslProxying) {
    state.engine.set_ssl_proxying(ssl);
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
            let engine = Engine::default();
            forward_events(app.handle().clone(), &engine);
            app.manage(AppState { engine, ca, ca_path: dir.join("sniffo-ca.pem"), proxy: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            proxy_status, start_proxy, stop_proxy, list_flows, get_flow, get_body, clear_flows,
            get_ssl_proxying, set_ssl_proxying
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
