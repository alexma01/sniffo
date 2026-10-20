//! Test harness shared by the IPC command tests and the UI test bridge (`examples/ui_bridge.rs`):
//! the real app (commands, state, events) on Tauri's mock runtime, fake OS tools on PATH so
//! system proxy / CA / device commands run end to end without touching this machine, and a
//! tiny upstream HTTP server.
#![allow(dead_code)]

use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Listener, Manager, ipc::{CallbackFn, InvokeBody, InvokeResponseBody}, test::MockRuntime, webview::InvokeRequest};

// ---------------------------------------------------------------- fake OS tools

pub struct Fakes {
    pub dir: PathBuf,
    pub log: PathBuf,
}

/// Fake `networksetup`, `security`, `scutil`, `sudo`, `osascript`, `gsettings`, `pkexec`,
/// `openssl verify`, `xcrun`, `open`, `adb`, `emulator`: they record every call in `log` and
/// answer like the real tools. Installed once per process, before anything runs a command.
#[cfg(unix)]
pub fn fakes() -> &'static Fakes {
    static FAKES: OnceLock<Fakes> = OnceLock::new();
    FAKES.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("sniffo-fakes-{}", std::process::id()));
        let bin = dir.join("bin");
        let sdk = dir.join("android-sdk");
        for d in [&bin, &sdk.join("platform-tools"), &sdk.join("emulator")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let log = dir.join("calls.log");
        std::fs::write(&log, "").unwrap();
        let script = |path: PathBuf, body: &str| {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&path, format!("#!/bin/sh\nF=\"{}\"\necho \"$(basename \"$0\") $*\" >> \"$F/calls.log\"\n{body}", dir.display())).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        script(bin.join("networksetup"), r#"case "$1" in
  -fake-check) echo FAKE ;;
  -listallnetworkservices) printf 'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*Bluetooth PAN\nUSB LAN\n' ;;
  -getwebproxy) printf 'Enabled: Yes\nServer: corp.proxy\nPort: 3128\nAuthenticated Proxy Enabled: 0\n' ;;
  -getsecurewebproxy) printf 'Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n' ;;
esac
"#);
        script(bin.join("gsettings"), r#"case "$1 $3" in
  "get mode") echo "'none'" ;;
  "get host") echo "'corp.proxy'" ;;
  "get port") echo 3128 ;;
esac
"#);
        // Trust is a marker file: add-trusted-cert creates it, verify-cert checks it.
        script(bin.join("security"), r#"case "$1" in
  add-trusted-cert) [ -f "$F/deny" ] && { echo "User canceled" >&2; exit 1; }; touch "$F/trusted" ;;
  verify-cert) [ -f "$F/trusted" ] || exit 1 ;;
esac
"#);
        script(bin.join("pkexec"), r#"[ -f "$F/deny" ] && exit 126; touch "$F/trusted""#);
        script(bin.join("openssl"), r#"if [ "$1" = verify ]; then [ -f "$F/trusted" ] || exit 1; else exec /usr/bin/openssl "$@"; fi"#);
        script(bin.join("scutil"), r#"[ -f "$F/scutil.txt" ] && cat "$F/scutil.txt" || printf '<dictionary> {\n  HTTPSEnable : 0\n}\n'"#);
        // Plays the VPN helper: `sudo -n <helper> set <port>` makes macOS report our proxy.
        script(bin.join("sudo"), r#"[ -f "$F/deny" ] && { echo "sudo: a password is required" >&2; exit 1; }
[ "$3" = set ] && printf '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : %s\n  HTTPSProxy : 127.0.0.1\n}\n' "$4" > "$F/scutil.txt"
exit 0"#);
        script(bin.join("osascript"), r#"[ -f "$F/deny" ] && { echo "User canceled." >&2; exit 1; }; exit 0"#);
        script(bin.join("open"), "");
        script(bin.join("xcrun"), r#"case "$1 $2" in
  "simctl list") echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"udid":"SIM-BOOTED","name":"iPhone 18 Pro","state":"Booted"},{"udid":"SIM-OFF","name":"iPad Air","state":"Shutdown"}]}}' ;;
  "devicectl list") for a; do last="$a"; done
    echo '{"result":{"devices":[{"identifier":"PHONE-1","deviceProperties":{"name":"Test iPhone","osVersionNumber":"26.1"},"hardwareProperties":{"reality":"physical","platform":"iOS"},"connectionProperties":{"transportType":"wired"}}]}}' > "$last" ;;
esac
"#);
        script(sdk.join("platform-tools/adb"), r#"case "$*" in
  "devices -l") printf 'List of devices attached\nemulator-5554          device product:sdk model:sdk_gphone64_arm64 device:emu64a\nR58N123                unauthorized usb:1-1\n' ;;
  *"emu avd name"*) printf 'Pixel_8\nOK\n' ;;
  *"getprop ro.build.version.release"*) echo 15 ;;
  *"id -u"*) echo 0 ;;
  *SNIFFO_OK*) echo SNIFFO_OK ;;
esac
"#);
        script(sdk.join("emulator/emulator"), r#"[ "$1" = -list-avds ] && printf 'Pixel_8\nMedium_Phone\n'; exit 0"#);
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        // SAFETY: set once, before this process runs any OS tool (tests and the bridge call this first).
        unsafe {
            std::env::set_var("PATH", path);
            std::env::set_var("ANDROID_HOME", &sdk);
            std::env::remove_var("ANDROID_SDK_ROOT");
        }
        // Never let a test reach the real networksetup: that would change this Mac's proxy.
        let check = std::process::Command::new("networksetup").arg("-fake-check").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&check.stdout).trim(), "FAKE", "fake OS tools are not first on PATH");
        Fakes { dir, log }
    })
}

impl Fakes {
    pub fn calls(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
    pub fn set_trusted(&self, trusted: bool) {
        toggle(&self.dir.join("trusted"), trusted);
    }
    /// Makes the OS prompts (admin password, keychain) fail as if the user cancelled.
    pub fn set_deny(&self, deny: bool) {
        toggle(&self.dir.join("deny"), deny);
    }
    /// What `scutil --proxy` reports (the proxy macOS actually uses, e.g. a VPN's).
    pub fn set_effective_proxy(&self, proxy: Option<(&str, u16)>) {
        let path = self.dir.join("scutil.txt");
        match proxy {
            Some((h, p)) => std::fs::write(path, format!("<dictionary> {{\n  HTTPSEnable : 1\n  HTTPSPort : {p}\n  HTTPSProxy : {h}\n}}\n")).unwrap(),
            None => toggle(&path, false),
        }
    }
}

fn toggle(path: &Path, on: bool) {
    if on {
        std::fs::write(path, "").unwrap();
    } else {
        let _ = std::fs::remove_file(path);
    }
}

// ---------------------------------------------------------------- app on the mock runtime

pub struct TestApp {
    pub app: tauri::App<MockRuntime>,
    pub webview: tauri::WebviewWindow<MockRuntime>,
    pub dir: PathBuf,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn temp_dir(name: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("sniffo-test-{}-{name}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

impl TestApp {
    pub fn new() -> Self {
        Self::in_dir(temp_dir("app"))
    }

    /// The app as it starts with this data folder (settings, CA, snapshot from a previous run).
    pub fn in_dir(dir: PathBuf) -> Self {
        // Always, before the app exists: stop/restore paths run OS tools (networksetup, the
        // passwordless VPN helper via sudo) that must never be the real ones in a test.
        #[cfg(unix)]
        fakes();
        let mut app = sniffo_lib::setup(tauri::test::mock_builder(), Some(dir.clone()))
            // The app's real config and capabilities, so the ACL is the one the UI gets.
            .build(tauri::generate_context!("tauri.conf.json", test = true))
            .expect("app builds");
        let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        for name in ["flows", "flows:resync"] {
            let events = events.clone();
            app.listen_any(name, move |e| {
                events.lock().unwrap().push((name.to_owned(), serde_json::from_str(e.payload()).unwrap_or(Value::Null)));
            });
        }
        // One event-loop turn runs `setup` and opens the configured "main" window, as at launch.
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        let webview = app.get_webview_window("main").expect("main window from tauri.conf.json");
        Self { app, webview, dir, events }
    }

    fn invoke(&self, cmd: &str, args: Value) -> Result<InvokeResponseBody, String> {
        invoke(&self.webview, cmd, args)
    }

    /// Every event sent to the UI so far, in order: (event name, payload).
    pub fn events(&self) -> Arc<Mutex<Vec<(String, Value)>>> {
        self.events.clone()
    }

    /// Runs a command exactly as the UI does (same argument names as src/api.ts).
    pub fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        self.invoke(cmd, args).map(|b| b.deserialize::<Value>().unwrap_or(Value::Null))
    }

    /// For commands answering with raw bytes (an ArrayBuffer in the UI).
    pub fn raw(&self, cmd: &str, args: Value) -> Result<Vec<u8>, String> {
        match self.invoke(cmd, args)? {
            InvokeResponseBody::Raw(b) => Ok(b),
            InvokeResponseBody::Json(j) => Err(format!("expected raw bytes, got JSON {j}")),
        }
    }

    pub fn ok(&self, cmd: &str, args: Value) -> Value {
        self.call(cmd, args).unwrap_or_else(|e| panic!("{cmd}: {e}"))
    }

    /// Starts the proxy on a free port; returns it.
    pub fn start(&self) -> u16 {
        let port = free_port();
        self.ok("start_proxy", json!({ "port": port }));
        port
    }

    /// Every `flows` event item the UI received so far.
    pub fn flow_events(&self) -> Vec<Value> {
        self.events.lock().unwrap().iter().filter(|(n, _)| n == "flows").flat_map(|(_, v)| v.as_array().cloned().unwrap_or_default()).collect()
    }

    pub fn wait_event(&self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        wait(what, || self.flow_events().into_iter().find(|e| pred(e)))
    }

    /// The flow with this id once it has a response (or failed).
    pub fn settled(&self, id: u64) -> Value {
        wait(&format!("flow {id} settled"), || {
            let f = self.call("get_flow", json!({ "id": id })).ok()?;
            matches!(f["state"].as_str(), Some("complete" | "failed")).then_some(f)
        })
    }

    pub fn flows(&self) -> Vec<Value> {
        self.ok("list_flows", json!({})).as_array().cloned().unwrap()
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let _ = self.call("stop_proxy", json!({}));
    }
}

/// Invokes a command on the app's main window, as the UI's `invoke()` does.
pub fn invoke(webview: &tauri::WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<InvokeResponseBody, String> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        // The app's own origin (remote origins are denied custom commands).
        url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    };
    tauri::test::get_ipc_response(webview, request).map_err(|e| e.as_str().map(str::to_owned).unwrap_or_else(|| e.to_string()))
}

pub fn wait<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A free port outside the OS ephemeral range, so a client connection elsewhere in the test
/// process can't grab it while the proxy restarts on it.
pub fn free_port() -> u16 {
    static NEXT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
    let base = 20_000 + (std::process::id() % 400) as u16 * 40;
    loop {
        let port = base + NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 8_000;
        // Both: a socket on one address doesn't always block binding the other.
        if TcpListener::bind(("127.0.0.1", port)).is_ok() && TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return port;
        }
    }
}

// ---------------------------------------------------------------- HTTP

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.text()))
    }
}

pub fn read_message(stream: &mut BufReader<TcpStream>) -> Option<(String, Vec<(String, String)>, Vec<u8>)> {
    let mut first = String::new();
    stream.read_line(&mut first).ok()?;
    if first.is_empty() {
        return None;
    }
    let mut headers = vec![];
    loop {
        let mut line = String::new();
        stream.read_line(&mut line).ok()?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (k, v) = line.split_once(':')?;
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
    }
    let len = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let mut body = vec![0; len];
    stream.read_exact(&mut body).ok()?;
    Some((first.trim_end().to_owned(), headers, body))
}

/// Plain HTTP/1.1 request; `target` is an absolute URL when going through a proxy.
pub fn http(addr: SocketAddr, method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> std::io::Result<Response> {
    let mut s = TcpStream::connect(addr)?;
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let host = target.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or("localhost");
    let mut req = format!("{method} {target} HTTP/1.1\r\nhost: {host}\r\nconnection: close\r\ncontent-length: {}\r\n", body.len());
    for (k, v) in headers {
        req += &format!("{k}: {v}\r\n");
    }
    s.write_all(format!("{req}\r\n").as_bytes())?;
    s.write_all(body)?;
    let mut r = BufReader::new(s);
    let (first, headers, mut body) = read_message(&mut r).ok_or_else(|| std::io::Error::other("no response"))?;
    if !headers.iter().any(|(k, _)| k == "content-length") {
        r.read_to_end(&mut body)?;
    }
    Ok(Response { status: first.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0), headers, body })
}

/// Request through the proxy listening on `port`.
pub fn via(port: u16, method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Response {
    http(([127, 0, 0, 1], port).into(), method, url, headers, body).unwrap_or_else(|e| panic!("{method} {url}: {e}"))
}

/// `{"zipped":true}` gzip-compressed.
pub const GZIP_JSON: [u8; 35] = [31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 171, 86, 170, 202, 44, 40, 72, 77, 81, 178, 42, 41, 42, 77, 173, 5, 0, 132, 40, 188, 8, 15, 0, 0, 0];

/// Upstream server: `/gzip` answers gzip-encoded JSON, `/status/N` that status, `/slow` after
/// 300 ms; anything else echoes the request as JSON. Every request is recorded.
pub struct Upstream {
    pub addr: SocketAddr,
    pub seen: Arc<Mutex<Vec<(String, String, Vec<u8>)>>>,
}

impl Upstream {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<(String, String, Vec<u8>)>>> = Arc::default();
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let log = log.clone();
                std::thread::spawn(move || {
                    let mut r = BufReader::new(stream.try_clone().unwrap());
                    let Some((first, headers, body)) = read_message(&mut r) else { return };
                    let mut parts = first.split(' ');
                    let (method, path) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
                    log.lock().unwrap().push((method.clone(), path.clone(), body.clone()));
                    let (status, extra, out): (u16, &str, Vec<u8>) = if path == "/gzip" {
                        (200, "content-type: application/json\r\ncontent-encoding: gzip\r\n", GZIP_JSON.to_vec())
                    } else if let Some(code) = path.strip_prefix("/status/") {
                        (code.parse().unwrap_or(500), "content-type: text/plain\r\n", b"status page".to_vec())
                    } else {
                        if path == "/slow" {
                            std::thread::sleep(Duration::from_millis(300));
                        }
                        let echo = json!({ "method": method, "path": path, "headers": headers, "body": String::from_utf8_lossy(&body) });
                        (200, "content-type: application/json\r\nset-cookie: sid=abc; Path=/\r\n", serde_json::to_vec(&echo).unwrap())
                    };
                    let mut s = stream;
                    let _ = s.write_all(format!("HTTP/1.1 {status} X\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n", out.len()).as_bytes());
                    let _ = s.write_all(&out);
                });
            }
        });
        Self { addr, seen }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    pub fn paths(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(m, p, _)| format!("{m} {p}")).collect()
    }
}
