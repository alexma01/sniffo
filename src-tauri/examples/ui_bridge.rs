//! The real app (commands, engine, proxy, events) behind HTTP, for the browser UI tests:
//! `src/dev-bridge.ts` forwards every `invoke()` here and replays events. OS tools are the
//! test fakes, so nothing on this machine changes.
//!
//! `cargo run -p sniffo --example ui_bridge -- <port>` prints `READY <port>` when listening.
//!   POST /invoke/<command>   JSON args -> {"ok": value} | {"err": message} | raw bytes
//!   GET  /events?since=N     long-poll -> {"next": M, "events": [[name, payload], ...]}
//!   GET  /calls              fake OS tool invocations, one per line
//!   POST /fake/<trusted|deny>/<0|1>, /fake/proxy/<host:port|none>   steer the fakes
//!   GET  /info               {"data_dir", "ca_path"}
#[path = "../tests/support/mod.rs"]
mod support;

use serde_json::{Value, json};
use std::{io::{BufReader, Write}, net::TcpListener, time::{Duration, Instant}};

fn main() {
    let fakes = support::fakes();
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(0);
    let app = support::TestApp::in_dir(support::temp_dir("ui"));
    let (webview, events, dir) = (app.webview.clone(), app.events(), app.dir.clone());
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bridge port");
    println!("READY {}", listener.local_addr().unwrap().port());
    for stream in listener.incoming().flatten() {
        let (webview, events, dir) = (webview.clone(), events.clone(), dir.clone());
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let Some((first, _, body)) = support::read_message(&mut reader) else { return };
            let mut parts = first.split(' ');
            let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            let json_reply = |v: Value| ("application/json", serde_json::to_vec(&v).unwrap());
            let (ctype, out): (&str, Vec<u8>) = match (method, path) {
                ("OPTIONS", _) => ("text/plain", vec![]),
                ("POST", p) if p.starts_with("/invoke/") => {
                    let args: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
                    match support::invoke(&webview, &p["/invoke/".len()..], args) {
                        Ok(tauri::ipc::InvokeResponseBody::Raw(b)) => ("application/octet-stream", b),
                        Ok(b) => json_reply(json!({ "ok": b.deserialize::<Value>().unwrap_or(Value::Null) })),
                        Err(e) => json_reply(json!({ "err": e })),
                    }
                }
                ("GET", "/events") => {
                    let since: usize = query.strip_prefix("since=").and_then(|s| s.parse().ok()).unwrap_or(0);
                    let end = Instant::now() + Duration::from_secs(15);
                    loop {
                        let all = events.lock().unwrap();
                        if all.len() > since || Instant::now() > end {
                            let new: Vec<_> = all.iter().skip(since).map(|(n, p)| json!([n, p])).collect();
                            break json_reply(json!({ "next": all.len(), "events": new }));
                        }
                        drop(all);
                        std::thread::sleep(Duration::from_millis(15));
                    }
                }
                ("GET", "/calls") => ("text/plain", fakes.calls().into_bytes()),
                ("GET", "/info") => json_reply(json!({ "data_dir": dir, "ca_path": dir.join("sniffo-ca.pem"), "fakes_dir": fakes.dir })),
                ("POST", p) if p.starts_with("/fake/") => {
                    let mut seg = p["/fake/".len()..].splitn(2, '/');
                    match (seg.next().unwrap_or(""), seg.next().unwrap_or("")) {
                        ("trusted", v) => fakes.set_trusted(v == "1"),
                        ("deny", v) => fakes.set_deny(v == "1"),
                        ("proxy", "none") => fakes.set_effective_proxy(None),
                        ("proxy", v) => {
                            let (h, p) = v.rsplit_once(':').unwrap();
                            fakes.set_effective_proxy(Some((h, p.parse().unwrap())));
                        }
                        _ => {}
                    }
                    json_reply(json!({ "ok": null }))
                }
                _ => ("text/plain", b"not found".to_vec()),
            };
            let mut s = stream;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\naccess-control-allow-origin: *\r\naccess-control-allow-headers: *\r\naccess-control-allow-methods: GET, POST\r\naccess-control-expose-headers: content-type\r\nconnection: close\r\n\r\n",
                out.len()
            );
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&out);
        });
    }
}
