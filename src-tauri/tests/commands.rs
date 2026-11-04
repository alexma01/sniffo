//! Every IPC command, invoked the way the UI invokes it (src/api.ts argument names) on the real
//! app running on Tauri's mock runtime. OS tools are fakes (see support::fakes).
mod support;

use serde_json::{Value, json};
use std::time::{Duration, Instant};
use support::*;

/// A stopped listener may linger for a moment on macOS: wait briefly for connections to be refused.
fn port_closes(port: u16) -> bool {
    (0..20).any(|_| {
        let closed = std::net::TcpStream::connect(("127.0.0.1", port)).is_err();
        if !closed {
            std::thread::sleep(Duration::from_millis(50));
        }
        closed
    })
}

/// A coded backend error as the UI receives it (see sniffo_core::Error).
fn err(code: &str) -> String {
    json!({ "code": code }).to_string()
}

/// Commands that `src/api.ts` calls, the app registers, and this file exercises must be the
/// same set: a command added without a test (or renamed on one side only) fails here.
#[test]
fn contract_every_ui_command_is_registered_and_tested() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let api = std::fs::read_to_string(root.join("../src/api.ts")).unwrap();
    let lib = std::fs::read_to_string(root.join("src/lib.rs")).unwrap();
    let tests = std::fs::read_to_string(root.join("tests/commands.rs")).unwrap();
    let ui: std::collections::BTreeSet<String> = api.split("invoke<").skip(1).filter_map(|s| s.split('"').nth(1)).map(str::to_owned).collect();
    let handler = lib.split("generate_handler![").nth(1).unwrap().split(']').next().unwrap();
    let registered: std::collections::BTreeSet<String> = handler.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    assert_eq!(ui, registered, "src/api.ts and the invoke handler disagree");
    let untested: Vec<_> = registered.iter().filter(|c| !tests.contains(&format!("(\"{c}\""))).collect();
    assert!(untested.is_empty(), "commands without a test: {untested:?}");
}

#[test]
fn status_start_restart_and_stop() {
    let app = TestApp::new();
    let s = app.ok("proxy_status", json!({}));
    assert_eq!((s["running"].clone(), s["allow_lan"].clone(), s["auto_system_proxy"].clone(), s["system_proxy"].clone()), (json!(false), json!(true), json!(true), json!(false)));
    assert!(std::path::Path::new(s["ca_path"].as_str().unwrap()).exists(), "CA written to the data folder");
    assert_eq!(s["vpn"], json!({ "state": "not_needed" }));
    assert!(s["lan"].is_array());

    let port = app.start();
    let s = app.ok("proxy_status", json!({}));
    assert_eq!((s["running"].clone(), s["port"].clone(), s["address"].clone()), (json!(true), json!(port), json!(format!("127.0.0.1:{port}"))));

    // Allow LAN off restarts the listener on the same port, loopback only.
    let t = Instant::now();
    app.ok("set_allow_lan", json!({ "allow": false }));
    assert!(t.elapsed() < Duration::from_secs(3));
    let s = app.ok("proxy_status", json!({}));
    assert_eq!((s["allow_lan"].clone(), s["port"].clone()), (json!(false), json!(port)));
    let up = Upstream::start();
    assert_eq!(via(port, "GET", &up.url("/after-restart"), &[], b"").status, 200);
    if let Some(lan) = s["lan"][0]["ip"].as_str() {
        let addr: std::net::SocketAddr = format!("{lan}:{port}").parse().unwrap();
        assert!(std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err(), "not reachable from the LAN");
    }
    app.ok("set_allow_lan", json!({ "allow": true }));
    if let Some(lan) = s["lan"][0]["ip"].as_str() {
        let addr: std::net::SocketAddr = format!("{lan}:{port}").parse().unwrap();
        assert!(std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok(), "reachable from the LAN");
    }

    // Restart on another port, then a busy port is a readable error and the proxy stays usable.
    let other = free_port();
    assert_eq!(app.ok("start_proxy", json!({ "port": other })), json!(format!("0.0.0.0:{other}")));
    let busy = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let busy_port = busy.local_addr().unwrap().port();
    let err = app.call("start_proxy", json!({ "port": busy_port })).unwrap_err();
    assert!(err.contains("port_unavailable") && err.contains(&format!("\"port\":\"{busy_port}\"")), "{err}");

    app.ok("stop_proxy", json!({}));
    assert_eq!(app.ok("proxy_status", json!({}))["running"], json!(false));
    assert!(port_closes(other), "port released");
}

#[test]
fn browsers_and_terminal_env_use_the_running_proxy() {
    let app = TestApp::new();
    assert!(app.ok("list_browsers", json!({})).is_array());
    assert_eq!(app.call("terminal_env", json!({})).unwrap_err(), err("proxy_stopped"));
    assert_eq!(app.call("launch_browser", json!({ "id": "chrome" })).unwrap_err(), err("proxy_stopped"));
    let port = app.start();
    assert_eq!(app.call("launch_browser", json!({ "id": "netscape" })).unwrap_err(), json!({ "code": "browser_missing", "id": "netscape" }).to_string());
    let env: Vec<(String, String)> = serde_json::from_value(app.ok("terminal_env", json!({}))).unwrap();
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap();
    assert_eq!(get("HTTPS_PROXY"), format!("http://127.0.0.1:{port}"));
    assert_eq!(get("NODE_EXTRA_CA_CERTS"), app.dir.join("sniffo-ca.pem").display().to_string());
    let bundle = std::fs::read_to_string(get("SSL_CERT_FILE")).unwrap();
    assert!(bundle.ends_with(&std::fs::read_to_string(app.dir.join("sniffo-ca.pem")).unwrap()), "bundle ends with the Sniffo CA");
}

#[test]
fn settings_survive_a_restart() {
    let dir = temp_dir("persist");
    let proto = dir.join("user.proto");
    std::fs::write(&proto, "syntax = \"proto3\"; package demo; message User { int32 id = 1; string name = 2; }").unwrap();
    let rules = json!({ "rules": [{ "id": "r1", "name": "Block ads", "enabled": true, "matcher": { "url": "*ads*", "regex": false, "methods": ["GET"] }, "action": { "type": "block" } }],
        "allow_list": { "enabled": true, "patterns": ["*api*"] }, "no_caching": true });
    let ssl = json!({ "enabled": true, "include": ["*.example.com"], "exclude": ["pinned.example.com"] });
    let network = json!({ "upstream": { "kind": "socks5", "host": "corp", "port": 1080, "username": "u", "password": "p" }, "dns": [["api.test", "127.0.0.1"]], "ignore_upstream_tls_errors": true });
    let reverse = json!([{ "enabled": false, "port": 9300, "target": "http://localhost:3000" }]);
    {
        let app = TestApp::in_dir(dir.clone());
        app.ok("set_auto_system_proxy", json!({ "enabled": false }));
        app.ok("set_allow_lan", json!({ "allow": false }));
        app.ok("set_ssl_proxying", json!({ "ssl": ssl }));
        app.ok("set_rules", json!({ "rules": rules }));
        app.ok("set_network", json!({ "network": network }));
        assert_eq!(app.ok("set_reverse", json!({ "reverse": reverse })), json!([null]));
        app.ok("set_proto_files", json!({ "files": [proto] }));
    }
    let app = TestApp::in_dir(dir);
    let s = app.ok("proxy_status", json!({}));
    assert_eq!((s["auto_system_proxy"].clone(), s["allow_lan"].clone()), (json!(false), json!(false)));
    assert_eq!(app.ok("get_ssl_proxying", json!({})), ssl);
    assert_eq!(app.ok("get_rules", json!({})), rules);
    assert_eq!(app.ok("get_network", json!({})), network);
    assert_eq!(app.ok("get_reverse", json!({})), reverse);
    assert_eq!(app.ok("get_proto_schemas", json!({})), json!({ "files": [proto], "messages": ["demo.User"] }));
}

/// Connections the proxy closed leave TIME_WAIT sockets on its port: restarting on that port
/// (allow LAN, network settings, Settings → Save) must still work, or the proxy is left stopped.
#[test]
fn restart_on_the_same_port_after_traffic() {
    let app = TestApp::new();
    let port = app.start();
    let up = Upstream::start();
    for round in 0..3 {
        for i in 0..20 {
            assert_eq!(via(port, "GET", &up.url(&format!("/r{round}-{i}")), &[], b"").status, 200);
        }
        app.ok("set_allow_lan", json!({ "allow": round % 2 == 1 }));
        app.ok("set_network", json!({ "network": { "upstream": null, "dns": [], "ignore_upstream_tls_errors": false } }));
        assert_eq!(app.ok("proxy_status", json!({}))["port"], json!(port));
    }
    assert_eq!(via(port, "GET", &up.url("/still-up"), &[], b"").status, 200);
}

#[test]
fn unreadable_settings_fall_back_to_defaults() {
    let dir = temp_dir("corrupt");
    std::fs::write(dir.join("settings.json"), "{ not json").unwrap();
    let app = TestApp::in_dir(dir);
    let s = app.ok("proxy_status", json!({}));
    assert_eq!((s["allow_lan"].clone(), s["auto_system_proxy"].clone()), (json!(true), json!(true)));
    assert_eq!(app.ok("get_ssl_proxying", json!({})), json!({ "enabled": true, "include": [], "exclude": [] }));
}

#[test]
fn flows_are_listed_read_pinned_searched_removed_and_cleared() {
    let app = TestApp::new();
    let port = app.start();
    let up = Upstream::start();
    let r = via(port, "POST", &up.url("/items?page=2"), &[("content-type", "application/json"), ("cookie", "a=1")], br#"{"name":"needle"}"#);
    assert_eq!(r.json()["path"], json!("/items?page=2"));
    via(port, "GET", &up.url("/gzip"), &[], b"");

    let f1 = app.settled(1);
    assert_eq!((f1["method"].clone(), f1["path"].clone(), f1["status"].clone(), f1["host"].clone()), (json!("POST"), json!("/items?page=2"), json!(200), json!("127.0.0.1")));
    assert!(f1["request"]["headers"].as_array().unwrap().iter().any(|h| h == &json!(["cookie", "a=1"])));
    assert_eq!(app.raw("get_body", json!({ "id": 1, "response": false })).unwrap(), br#"{"name":"needle"}"#);
    let echoed: Value = serde_json::from_slice(&app.raw("get_body", json!({ "id": 1, "response": true })).unwrap()).unwrap();
    assert_eq!(echoed["body"], json!(r#"{"name":"needle"}"#));
    app.settled(2);
    // Content-Encoding is removed for the UI.
    assert_eq!(app.raw("get_body", json!({ "id": 2, "response": true })).unwrap(), br#"{"zipped":true}"#);
    assert_eq!(app.raw("get_body", json!({ "id": 99, "response": true })).unwrap(), b"");
    assert_eq!(app.ok("get_flow", json!({ "id": 99 })), Value::Null);

    let list = app.ok("list_flows", json!({})).as_array().cloned().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["request_type"], json!("application/json"));
    assert_eq!(list[1]["content_type"], json!("application/json"));
    app.wait_event("upsert of flow 2", |e| e["type"] == "upsert" && e["data"]["id"] == 2 && e["data"]["state"] == "complete");

    assert_eq!(app.ok("search_flows", json!({ "query": "NEEDLE" })), json!([1]));
    assert_eq!(app.ok("search_flows", json!({ "query": "zipped" })), json!([2]));
    assert_eq!(app.ok("search_flows", json!({ "query": "nothing-like-this" })), json!([]));

    app.ok("pin_flow", json!({ "id": 1, "pinned": true }));
    app.wait_event("pin upsert", |e| e["type"] == "upsert" && e["data"]["id"] == 1 && e["data"]["pinned"] == true);
    app.ok("mark_flow", json!({ "id": 2, "color": "red", "comment": "  slow  " }));
    app.wait_event("mark upsert", |e| e["type"] == "upsert" && e["data"]["id"] == 2 && e["data"]["color"] == "red" && e["data"]["comment"] == "slow");
    app.ok("mark_flow", json!({ "id": 2, "color": null, "comment": "" }));
    app.wait_event("unmark upsert", |e| e["type"] == "upsert" && e["data"]["id"] == 2 && e["data"]["color"].is_null() && e["data"]["comment"].is_null());
    via(port, "GET", &up.url("/third"), &[], b"");
    app.settled(3);
    app.ok("remove_flows", json!({ "ids": [3] }));
    app.wait_event("removed", |e| e == &json!({ "type": "removed", "data": [3] }));
    // Clear keeps pinned flows.
    app.ok("clear_flows", json!({}));
    let ids: Vec<_> = app.flows().iter().map(|f| f["id"].clone()).collect();
    assert_eq!(ids, vec![json!(1)]);
    app.wait_event("removed unpinned", |e| e == &json!({ "type": "removed", "data": [2] }));
    app.ok("pin_flow", json!({ "id": 1, "pinned": false }));
    app.ok("clear_flows", json!({}));
    assert!(app.flows().is_empty());
    app.wait_event("cleared", |e| e == &json!({ "type": "cleared" }));
}

#[test]
fn check_update_reports_only_newer_releases() {
    let app = TestApp::new();
    let up = Upstream::start();
    // SAFETY: only this test reads SNIFFO_UPDATE_URL, and it sets it before any command runs.
    unsafe { std::env::set_var("SNIFFO_UPDATE_URL", up.url("/release/v99.0.0")) };
    let found = app.ok("check_update", json!({}));
    assert_eq!((found["version"].clone(), found["url"].clone(), found["notes"].clone()), (json!("99.0.0"), json!("https://example.com/release"), json!("notes")));
    assert_eq!(found["current"], json!(env!("CARGO_PKG_VERSION")));
    unsafe { std::env::set_var("SNIFFO_UPDATE_URL", up.url("/release/v0.0.1")) };
    assert_eq!(app.ok("check_update", json!({})), json!(null));
    unsafe { std::env::set_var("SNIFFO_UPDATE_URL", up.url("/status/500")) };
    assert!(app.call("check_update", json!({})).is_err());
}

#[test]
fn repeat_and_compose_go_through_the_proxy() {
    let app = TestApp::new();
    assert_eq!(app.call("compose_request", json!({ "method": "GET", "url": "http://x/", "headers": [], "body": "" })).unwrap_err(), err("proxy_stopped"));
    assert_eq!(app.call("repeat_flow", json!({ "id": 1 })).unwrap_err(), err("proxy_stopped"));
    let port = app.start();
    let up = Upstream::start();
    assert_eq!(app.call("repeat_flow", json!({ "id": 1 })).unwrap_err(), err("flow_not_found"));
    via(port, "PUT", &up.url("/orig"), &[("x-a", "1")], b"payload");
    app.settled(1);
    assert_eq!(app.ok("repeat_flow", json!({ "id": 1 })), json!(200));
    let f2 = app.settled(2);
    assert_eq!((f2["method"].clone(), f2["path"].clone()), (json!("PUT"), json!("/orig")));
    assert_eq!(app.raw("get_body", json!({ "id": 2, "response": false })).unwrap(), b"payload");
    assert_eq!(app.ok("compose_request", json!({ "method": "PATCH", "url": up.url("/composed"), "headers": [["x-c", "2"]], "body": "hi" })), json!(200));
    let f3 = app.settled(3);
    assert_eq!((f3["method"].clone(), f3["path"].clone()), (json!("PATCH"), json!("/composed")));
    assert!(f3["request"]["headers"].as_array().unwrap().contains(&json!(["x-c", "2"])));
    assert_eq!(app.ok("compose_request", json!({ "method": "GET", "url": up.url("/status/404"), "headers": [], "body": "" })), json!(404));
    let err = app.call("compose_request", json!({ "method": "GET", "url": "not a url", "headers": [], "body": "" })).unwrap_err();
    assert!(!err.is_empty());
    assert_eq!(up.paths(), ["PUT /orig", "PUT /orig", "PATCH /composed", "GET /status/404"]);
}

#[test]
fn har_sessions_export_and_import() {
    let app = TestApp::new();
    let port = app.start();
    let up = Upstream::start();
    via(port, "GET", &up.url("/one"), &[], b"");
    via(port, "POST", &up.url("/two"), &[], b"body");
    app.settled(1);
    app.settled(2);
    let dir = temp_dir("har");
    let all = dir.join("all.har");
    let one = dir.join("one.har");
    assert_eq!(app.ok("export_har", json!({ "path": all, "ids": [] })), json!(2));
    assert_eq!(app.ok("export_har", json!({ "path": one, "ids": [2] })), json!(1));
    let har: Value = serde_json::from_str(&std::fs::read_to_string(&one).unwrap()).unwrap();
    assert_eq!(har["log"]["entries"][0]["request"]["method"], json!("POST"));

    // Import appends; opening a session replaces.
    assert_eq!(app.ok("import_har", json!({ "path": one, "replace": false })), json!(1));
    assert_eq!(app.flows().len(), 3);
    assert_eq!(app.ok("import_har", json!({ "path": all, "replace": true })), json!(2));
    let paths: Vec<_> = app.flows().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(paths, ["/one", "/two"]);

    let missing = dir.join("missing.har");
    assert!(app.call("import_har", json!({ "path": missing, "replace": false })).unwrap_err().contains("missing.har"));
    std::fs::write(dir.join("bad.har"), "{}").unwrap();
    assert!(app.call("import_har", json!({ "path": dir.join("bad.har"), "replace": true })).is_err());
    assert_eq!(app.flows().len(), 2, "a failed open keeps the current session");
    assert!(app.call("export_har", json!({ "path": dir.join("no/such/dir.har"), "ids": [] })).is_err());
}

#[test]
fn rules_apply_and_export_import() {
    let app = TestApp::new();
    let port = app.start();
    let up = Upstream::start();
    let rules = json!({ "rules": [
        { "id": "b", "name": "Block", "enabled": true, "matcher": { "url": "*/blocked*", "regex": false, "methods": [] }, "action": { "type": "block" } },
        { "id": "m", "name": "Mock", "enabled": true, "matcher": { "url": "*/mocked", "regex": false, "methods": [] }, "action": { "type": "map_local", "status": 201, "headers": [["content-type", "text/plain"]], "body": "from rule", "file": null } },
        { "id": "off", "name": "Disabled", "enabled": false, "matcher": { "url": "*", "regex": false, "methods": [] }, "action": { "type": "block" } }
    ], "allow_list": { "enabled": false, "patterns": [] }, "no_caching": false });
    app.ok("set_rules", json!({ "rules": rules }));
    assert_eq!(via(port, "GET", &up.url("/blocked"), &[], b"").status, 403);
    let r = via(port, "GET", &up.url("/mocked"), &[], b"");
    assert_eq!((r.status, r.text()), (201, "from rule".into()));
    assert_eq!(via(port, "GET", &up.url("/free"), &[], b"").status, 200);
    assert_eq!(up.paths(), ["GET /free"]);

    let dir = temp_dir("rules");
    let file = dir.join("rules.json");
    assert_eq!(app.ok("export_rules", json!({ "path": file })), json!(3));
    assert_eq!(app.ok("import_rules", json!({ "path": file })), json!(3));
    let now = app.ok("get_rules", json!({}));
    let ids: Vec<_> = now["rules"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids.len(), 6);
    assert!(ids[3].starts_with("b-") && ids[3] != "b", "imported rules get fresh ids: {ids:?}");
    for junk in ["[1,2]", "[]", "{}", r#"{"log":{"entries":[]}}"#, "not json"] {
        std::fs::write(dir.join("junk.json"), junk).unwrap();
        let err = app.call("import_rules", json!({ "path": dir.join("junk.json") })).unwrap_err();
        assert!(err.contains("\"rules_file\""), "{junk}: {err}");
    }
    assert_eq!(app.ok("get_rules", json!({}))["rules"].as_array().unwrap().len(), 6, "nothing imported from junk");
    assert!(app.call("import_rules", json!({ "path": dir.join("nope.json") })).unwrap_err().contains("nope.json"));
    assert!(app.call("export_rules", json!({ "path": dir.join("no/dir/x.json") })).is_err());
}

#[test]
fn breakpoints_pause_until_resumed() {
    let app = TestApp::new();
    let port = app.start();
    let up = Upstream::start();
    app.ok("set_rules", json!({ "rules": { "rules": [{ "id": "bp", "name": "bp", "enabled": true, "matcher": { "url": "*/held*", "regex": false, "methods": [] }, "action": { "type": "breakpoint", "request": true, "response": true } }], "allow_list": { "enabled": false, "patterns": [] }, "no_caching": false } }));
    assert_eq!(app.ok("list_breakpoints", json!({})), json!([]));

    let url = up.url("/held");
    let client = std::thread::spawn(move || via(port, "GET", &url, &[], b""));
    let hit = app.wait_event("request breakpoint", |e| e["type"] == "breakpoint" && e["data"]["response"] == false)["data"].clone();
    assert_eq!(app.ok("list_breakpoints", json!({}))[0]["id"], hit["id"]);
    assert_eq!(app.flows()[0]["state"], json!("paused"));
    let mut edited = hit["message"].clone();
    edited["url"] = json!(up.url("/held-edited"));
    assert_eq!(app.ok("resume_breakpoint", json!({ "id": hit["id"], "response": false, "decision": { "type": "continue", "message": edited } })), json!(true));
    let res = app.wait_event("response breakpoint", |e| e["type"] == "breakpoint" && e["data"]["response"] == true)["data"].clone();
    let mut edited = res["message"].clone();
    edited["status"] = json!(299);
    edited["body"] = json!("changed");
    assert!(app.ok("resume_breakpoint", json!({ "id": res["id"], "response": true, "decision": { "type": "continue", "message": edited } })).as_bool().unwrap());
    let r = client.join().unwrap();
    assert_eq!((r.status, r.text()), (299, "changed".into()));
    assert_eq!(up.paths(), ["GET /held-edited"]);

    // Abort answers without contacting the server; resuming again is a no-op.
    let url = up.url("/held-abort");
    let client = std::thread::spawn(move || via(port, "GET", &url, &[], b""));
    let hit = app.wait_event("second breakpoint", |e| e["type"] == "breakpoint" && e["data"]["id"] == 2)["data"].clone();
    assert_eq!(app.ok("resume_breakpoint", json!({ "id": 2, "response": false, "decision": { "type": "abort" } })), json!(true));
    assert!(client.join().unwrap().status >= 400);
    assert_eq!(up.paths(), ["GET /held-edited"]);
    assert_eq!(app.ok("resume_breakpoint", json!({ "id": hit["id"], "response": false, "decision": { "type": "abort" } })), json!(false));
}

#[test]
fn ssl_proxying_settings_roundtrip() {
    let app = TestApp::new();
    assert_eq!(app.ok("get_ssl_proxying", json!({})), json!({ "enabled": true, "include": [], "exclude": [] }));
    let ssl = json!({ "enabled": false, "include": ["*"], "exclude": ["*.apple.com"] });
    app.ok("set_ssl_proxying", json!({ "ssl": ssl }));
    assert_eq!(app.ok("get_ssl_proxying", json!({})), ssl);
    assert!(app.call("set_ssl_proxying", json!({ "ssl": { "enabled": true } })).is_err(), "malformed settings are rejected");
}

#[test]
fn network_options_and_reverse_proxies() {
    let app = TestApp::new();
    let port = app.start();
    let up = Upstream::start();
    let network = json!({ "upstream": null, "dns": [["myapp.test", "127.0.0.1"]], "ignore_upstream_tls_errors": false });
    app.ok("set_network", json!({ "network": network }));
    assert_eq!(app.ok("get_network", json!({})), network);
    assert_eq!(app.ok("proxy_status", json!({}))["port"], json!(port), "restarted on the same port");
    let r = via(port, "GET", &format!("http://myapp.test:{}/dns", up.addr.port()), &[], b"");
    assert_eq!(r.json()["path"], json!("/dns"));
    let bad = app.call("set_network", json!({ "network": { "upstream": null, "dns": [["x.test", "not-an-ip"]], "ignore_upstream_tls_errors": false } })).unwrap_err();
    assert!(bad.contains("not-an-ip"), "{bad}");
    let bad = app.call("set_network", json!({ "network": { "upstream": { "kind": "http", "host": "", "port": 8080, "username": "", "password": "" }, "dns": [], "ignore_upstream_tls_errors": false } })).unwrap_err();
    assert!(bad.contains("host"), "{bad}");
    // Rejected options change nothing: same settings, proxy still running.
    assert_eq!(app.ok("get_network", json!({})), network);
    assert_eq!(app.ok("proxy_status", json!({}))["running"], json!(true));
    assert_eq!(via(port, "GET", &format!("http://myapp.test:{}/still-up", up.addr.port()), &[], b"").status, 200);

    let rp = free_port();
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let reverse = json!([
        { "enabled": true, "port": rp, "target": format!("http://{}", up.addr) },
        { "enabled": true, "port": busy.local_addr().unwrap().port(), "target": "http://localhost:1" },
        { "enabled": false, "port": 1, "target": "http://localhost:1" }
    ]);
    let errors = app.ok("set_reverse", json!({ "reverse": reverse }));
    assert_eq!(errors[0], Value::Null);
    assert_eq!(errors[1]["code"], "reverse_port", "{errors}");
    assert_eq!(errors[2], Value::Null);
    assert_eq!(app.ok("get_reverse", json!({})), reverse);
    let r = http(([127, 0, 0, 1], rp).into(), "GET", "/via-reverse?q=1", &[], b"").unwrap();
    assert_eq!(r.json()["path"], json!("/via-reverse?q=1"));
    assert!(app.flows().iter().any(|f| f["path"] == "/via-reverse?q=1"), "reverse traffic is recorded");
    // The proxy's own port can't be shared (the OS would allow 127.0.0.1:P next to 0.0.0.0:P).
    let errors = app.ok("set_reverse", json!({ "reverse": [{ "enabled": true, "port": port, "target": format!("http://{}", up.addr) }] }));
    assert_eq!(errors[0], json!({ "code": "reverse_own_port", "port": port.to_string() }));
    assert_eq!(via(port, "GET", &up.url("/proxy-still-mine"), &[], b"").json()["path"], json!("/proxy-still-mine"));
    // That refused entry stays saved: restarting the proxy for other settings must still work.
    app.ok("set_network", json!({ "network": network }));
    app.ok("set_allow_lan", json!({ "allow": true }));
    assert_eq!(via(port, "GET", &up.url("/after-restart"), &[], b"").status, 200);
    app.ok("set_reverse", json!({ "reverse": [{ "enabled": true, "port": rp, "target": format!("http://{}", up.addr) }] }));
    let err = app.call("start_proxy", json!({ "port": rp })).unwrap_err();
    assert!(err.contains("port_reverse"), "{err}");
    app.ok("set_reverse", json!({ "reverse": [] }));
    assert!(port_closes(rp), "reverse listener stopped");
}

#[test]
fn protobuf_schemas_decode_bodies() {
    let app = TestApp::new();
    let port = app.start();
    let up = Upstream::start();
    let dir = temp_dir("proto");
    let file = dir.join("user.proto");
    std::fs::write(&file, "syntax = \"proto3\"; package demo; message User { int32 id = 1; string name = 2; }").unwrap();
    std::fs::write(dir.join("broken.proto"), "syntax = \"proto3\"; message {").unwrap();
    assert_eq!(app.ok("get_proto_schemas", json!({})), json!({ "files": [], "messages": [] }));
    // id=150, name="Ada"
    let body = [0x08, 0x96, 0x01, 0x12, 0x03, b'A', b'd', b'a'];
    via(port, "POST", &up.url("/user"), &[("content-type", "application/x-protobuf")], &body);
    app.settled(1);
    assert_eq!(app.call("decode_proto", json!({ "id": 1, "response": false, "messageType": "demo.User" })).unwrap_err(), err("no_schemas"));

    assert_eq!(app.ok("set_proto_files", json!({ "files": [file] })), json!({ "files": [file], "messages": ["demo.User"] }));
    assert_eq!(app.ok("decode_proto", json!({ "id": 1, "response": false, "messageType": "demo.User" })), json!([{ "id": 150, "name": "Ada" }]));
    assert!(app.call("decode_proto", json!({ "id": 1, "response": false, "messageType": "demo.Nope" })).unwrap_err().contains("proto_unknown_type"));
    assert_eq!(app.call("decode_proto", json!({ "id": 7, "response": false, "messageType": "demo.User" })).unwrap_err(), err("flow_not_found"));

    // A broken file is reported and the loaded schemas stay as they were.
    let err = app.call("set_proto_files", json!({ "files": [file, dir.join("broken.proto")] })).unwrap_err();
    assert!(err.contains("broken.proto"), "{err}");
    assert_eq!(app.ok("get_proto_schemas", json!({}))["messages"], json!(["demo.User"]));
    assert_eq!(app.ok("set_proto_files", json!({ "files": [] })), json!({ "files": [], "messages": [] }));
}

#[test]
fn websocket_injection_needs_a_live_connection() {
    let app = TestApp::new();
    assert_eq!(app.call("send_ws_message", json!({ "id": 1, "toServer": true, "data": "hi", "binary": false })).unwrap_err(), err("ws_closed"));
    assert!(app.call("send_ws_message", json!({ "id": 1, "toServer": false, "data": "%%%", "binary": true })).unwrap_err().contains("ws_base64"));
}

#[test]
fn websocket_frames_are_read_incrementally() {
    let app = TestApp::new();
    assert_eq!(app.ok("get_ws_messages", json!({ "id": 1, "from": 0 })), Value::Null);
    let har = temp_dir("ws").join("ws.har");
    let frames = json!([{ "type": "send", "time": 1, "opcode": 1, "data": "a" }, { "type": "receive", "time": 2, "opcode": 1, "data": "b" }]);
    let entry = json!({ "startedDateTime": "2024-01-01T00:00:00.000Z", "time": 0,
        "request": { "method": "GET", "url": "wss://x/ws", "httpVersion": "HTTP/1.1", "headers": [] },
        "response": { "status": 101, "httpVersion": "HTTP/1.1", "headers": [], "content": { "size": 0 } },
        "_webSocketMessages": frames });
    std::fs::write(&har, json!({ "log": { "entries": [entry] } }).to_string()).unwrap();
    assert_eq!(app.ok("import_har", json!({ "path": har, "replace": true })), json!(1));
    let id = app.flows()[0]["id"].clone();
    let all = app.ok("get_ws_messages", json!({ "id": id, "from": 0 }));
    assert_eq!((all[0].clone(), all[1].as_array().unwrap().len()), (json!(0), 2));
    let rest = app.ok("get_ws_messages", json!({ "id": id, "from": 1 }));
    assert_eq!((rest[0].clone(), rest[1][0]["data"].clone()), (json!(1), json!("b")));
    assert_eq!(app.ok("get_ws_messages", json!({ "id": id, "from": 2 }))[1], json!([]));
}

#[test]
fn app_icon_is_empty_for_clients_without_a_bundle() {
    let app = TestApp::new();
    assert_eq!(app.raw("app_icon", json!({ "name": "curl" })).unwrap(), b"");
}

#[cfg(unix)]
#[test]
fn system_proxy_ca_trust_and_vpn_helper_use_the_os_tools() {
    let fakes = fakes();
    let app = TestApp::new();
    assert_eq!(app.call("set_system_proxy", json!({ "enabled": true })).unwrap_err(), err("proxy_stopped"));
    let port = app.start();
    fakes.set_effective_proxy(Some(("127.0.0.1", port)));
    app.ok("set_system_proxy", json!({ "enabled": true }));
    let calls = fakes.calls();
    let s = app.ok("proxy_status", json!({}));
    assert_eq!((s["system_proxy"].clone(), s["vpn"].clone()), (json!(true), json!({ "state": "not_needed" })));
    let snapshot = app.dir.join("system-proxy-snapshot.json");
    assert!(snapshot.exists());
    if cfg!(target_os = "macos") {
        for line in [format!("networksetup -setwebproxy Wi-Fi 127.0.0.1 {port}"), format!("networksetup -setsecurewebproxy USB LAN 127.0.0.1 {port}")] {
            assert!(calls.contains(&line), "missing `{line}` in\n{calls}");
        }
        assert!(!calls.contains("-setwebproxy Bluetooth PAN"), "disabled services are left alone");
    } else {
        assert!(calls.contains("gsettings set org.gnome.system.proxy mode manual"), "{calls}");
    }

    // A new port while the system proxy is on moves the OS to it; the original snapshot is kept.
    let snap_before = std::fs::read(&snapshot).unwrap();
    let new_port = free_port();
    app.ok("start_proxy", json!({ "port": new_port }));
    assert_eq!(std::fs::read(&snapshot).unwrap(), snap_before);
    if cfg!(target_os = "macos") {
        assert!(fakes.calls().contains(&format!("networksetup -setwebproxy Wi-Fi 127.0.0.1 {new_port}")));
    }

    // A VPN publishing its own proxy: without the helper the UI is told so.
    #[cfg(target_os = "macos")]
    {
        fakes.set_effective_proxy(Some(("10.0.0.1", 8080)));
        app.ok("set_system_proxy", json!({ "enabled": true }));
        let vpn = app.ok("proxy_status", json!({}))["vpn"].clone();
        if sniffo_core::system::vpn_helper_installed() {
            assert_eq!(vpn, json!({ "state": "applied" }));
            assert!(fakes.calls().contains(&format!("sudo -n /Library/PrivilegedHelperTools/dev.sniffo.vpn-proxy set {new_port}")));
            // The helper refusing (sudoers rule gone) is reported, not hidden.
            fakes.set_effective_proxy(Some(("10.0.0.1", 8080)));
            fakes.set_deny(true);
            app.ok("set_system_proxy", json!({ "enabled": true }));
            fakes.set_deny(false);
            let vpn = app.ok("proxy_status", json!({}))["vpn"].clone();
            assert_eq!(vpn["state"], json!("failed"));
            assert!(vpn["detail"].as_str().unwrap().contains("password is required"), "{vpn}");
        } else {
            assert_eq!(vpn, json!({ "state": "helper_missing" }));
        }
        fakes.set_effective_proxy(None);
    }

    // Off restores exactly what the snapshot held.
    app.ok("set_system_proxy", json!({ "enabled": false }));
    assert!(!snapshot.exists());
    let s = app.ok("proxy_status", json!({}));
    assert_eq!((s["system_proxy"].clone(), s["vpn"].clone()), (json!(false), json!({ "state": "not_needed" })));
    if cfg!(target_os = "macos") {
        let calls = fakes.calls();
        assert!(calls.contains("networksetup -setwebproxy Wi-Fi corp.proxy 3128"), "{calls}");
        assert!(calls.contains("networksetup -setsecurewebproxystate Wi-Fi off"), "{calls}");
    } else {
        assert!(fakes.calls().contains("gsettings set org.gnome.system.proxy mode none"));
    }

    // Stop never leaves the OS pointing at a dead proxy.
    app.ok("set_system_proxy", json!({ "enabled": true }));
    assert!(snapshot.exists());
    app.ok("stop_proxy", json!({}));
    assert!(!snapshot.exists());

    // CA trust goes through the OS prompt; a cancelled prompt is an error, not a crash.
    fakes.set_trusted(false);
    assert_eq!(app.ok("proxy_status", json!({}))["ca_trusted"], json!(false));
    fakes.set_deny(true);
    assert!(app.call("trust_ca", json!({})).is_err());
    fakes.set_deny(false);
    app.ok("trust_ca", json!({}));
    assert_eq!(app.ok("proxy_status", json!({}))["ca_trusted"], json!(true));
    let ca = app.dir.join("sniffo-ca.pem");
    if cfg!(target_os = "macos") {
        assert!(fakes.calls().contains(&format!("security add-trusted-cert -r trustRoot -p ssl -k {}/Library/Keychains/login.keychain-db {}", std::env::var("HOME").unwrap(), ca.display())));
    } else {
        assert!(fakes.calls().contains("pkexec sh -c"));
    }

    #[cfg(target_os = "macos")]
    {
        fakes.set_deny(true);
        assert!(app.call("install_vpn_helper", json!({})).unwrap_err().contains("User canceled"));
        fakes.set_deny(false);
        app.ok("install_vpn_helper", json!({}));
        assert!(fakes.calls().contains("with administrator privileges"));
    }
    #[cfg(not(target_os = "macos"))]
    assert!(app.call("install_vpn_helper", json!({})).unwrap_err().contains("only needed on macOS"));
}

/// A crash with the system proxy on leaves the snapshot behind: the next start restores it.
#[cfg(unix)]
#[test]
fn next_start_restores_the_system_proxy_after_a_crash() {
    let fakes = fakes();
    let dir = temp_dir("crash");
    std::fs::write(dir.join("system-proxy-snapshot.json"), r#"{"entries":[["Crashed Service",{"enabled":false,"server":"","port":0},{"enabled":true,"server":"orig.proxy","port":8888}]]}"#).unwrap();
    let app = TestApp::in_dir(dir.clone());
    assert!(!dir.join("system-proxy-snapshot.json").exists());
    assert_eq!(app.ok("proxy_status", json!({}))["system_proxy"], json!(false));
    if cfg!(target_os = "macos") {
        let calls = fakes.calls();
        assert!(calls.contains("networksetup -setwebproxystate Crashed Service off"), "{calls}");
        assert!(calls.contains("networksetup -setsecurewebproxy Crashed Service orig.proxy 8888"), "{calls}");
    }
}

#[cfg(unix)]
#[test]
fn devices_are_listed_and_driven_with_their_tools() {
    let fakes = fakes();
    let app = TestApp::new();
    let port = app.start();
    let devices = app.ok("list_devices", json!({}));
    let ids: Vec<_> = devices.as_array().unwrap().iter().map(|d| (d["id"].as_str().unwrap().to_owned(), d["platform"].as_str().unwrap().to_owned(), d["state"].as_str().unwrap().to_owned())).collect();
    let android = [("emulator-5554", "android", "device"), ("R58N123", "android", "unauthorized"), ("Medium_Phone", "android_avd", "Shutdown")];
    for (id, platform, state) in android {
        assert!(ids.contains(&(id.into(), platform.into(), state.into())), "{ids:?}");
    }
    assert!(!ids.iter().any(|(id, _, _)| id == "Pixel_8"), "a running AVD isn't listed twice");
    let emu = devices.as_array().unwrap().iter().find(|d| d["id"] == "emulator-5554").unwrap();
    assert_eq!((emu["name"].clone(), emu["os"].clone(), emu["emulator"].clone()), (json!("sdk gphone64 arm64"), json!("Android 15"), json!(true)));
    if cfg!(target_os = "macos") {
        for d in [("SIM-BOOTED", "ios_simulator", "Booted"), ("SIM-OFF", "ios_simulator", "Shutdown"), ("PHONE-1", "ios_device", "connected (USB)")] {
            assert!(ids.contains(&(d.0.into(), d.1.into(), d.2.into())), "{ids:?}");
        }
    }

    let run = |device: &str, command: Value| app.call("device_command", json!({ "device": device, "command": command }));
    let ca = app.dir.join("sniffo-ca.pem").display().to_string();
    assert_eq!(run("emulator-5554", json!({ "type": "set_proxy" })).unwrap(), json!({ "code": "android_proxy_set", "port": port.to_string() }));
    assert!(fakes.calls().contains(&format!("adb -s emulator-5554 reverse tcp:{port} tcp:{port}")));
    assert!(fakes.calls().contains(&format!("adb -s emulator-5554 shell settings put global http_proxy 127.0.0.1:{port}")));
    run("emulator-5554", json!({ "type": "clear_proxy" })).unwrap();
    assert!(fakes.calls().contains("adb -s emulator-5554 shell settings put global http_proxy :0"));
    run("emulator-5554", json!({ "type": "install_ca" })).unwrap();
    assert!(fakes.calls().contains(&format!("adb -s emulator-5554 push {ca} /sdcard/Download/sniffo-ca.crt")));
    assert_eq!(run("emulator-5554", json!({ "type": "install_system_ca" })).unwrap(), json!({ "code": "android_system_ca" }));
    assert!(fakes.calls().contains(&format!("adb -s emulator-5554 push {ca} /data/local/tmp/sniffo-ca.pem")));
    run("emulator-5554", json!({ "type": "open_url", "value": "https://example.com/x" })).unwrap();
    assert!(fakes.calls().contains("adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d https://example.com/x"));
    run("emulator-5554", json!({ "type": "restart" })).unwrap();
    assert!(fakes.calls().contains("adb -s emulator-5554 reboot"));
    run("emulator-5554", json!({ "type": "shutdown" })).unwrap();
    assert!(fakes.calls().contains("adb -s emulator-5554 emu kill"));
    assert_eq!(run("emulator-5554", json!({ "type": "boot" })).unwrap_err(), err("device_running"));
    assert_eq!(run("Medium_Phone", json!({ "type": "boot" })).unwrap(), json!({ "code": "emulator_starting", "name": "Medium Phone" }));
    wait("emulator launched", || fakes.calls().contains("emulator -avd Medium_Phone").then_some(()));
    assert_eq!(run("Medium_Phone", json!({ "type": "install_ca" })).unwrap_err(), err("emulator_stopped"));
    assert_eq!(run("gone", json!({ "type": "install_ca" })).unwrap_err(), err("device_not_found"));

    if cfg!(target_os = "macos") {
        assert_eq!(run("SIM-BOOTED", json!({ "type": "install_ca" })).unwrap(), json!({ "code": "sim_ca_installed" }));
        assert!(fakes.calls().contains(&format!("xcrun simctl keychain SIM-BOOTED add-root-cert {ca}")));
        run("SIM-BOOTED", json!({ "type": "restart" })).unwrap();
        assert!(fakes.calls().contains("xcrun simctl shutdown SIM-BOOTED") && fakes.calls().contains("xcrun simctl boot SIM-BOOTED"));
        run("SIM-BOOTED", json!({ "type": "open_url", "value": "https://example.com/" })).unwrap();
        assert!(fakes.calls().contains("xcrun simctl openurl SIM-BOOTED https://example.com/"));
        run("SIM-OFF", json!({ "type": "boot" })).unwrap();
        assert!(fakes.calls().contains("xcrun simctl boot SIM-OFF") && fakes.calls().contains("open -a Simulator"));
        run("SIM-BOOTED", json!({ "type": "shutdown" })).unwrap();
        assert_eq!(run("SIM-BOOTED", json!({ "type": "set_proxy" })).unwrap(), json!({ "code": "sim_proxy_hint" }));
        assert_eq!(run("PHONE-1", json!({ "type": "install_ca" })).unwrap_err(), err("ios_remote"));
    }
}

/// Opens a real Finder window, so opt-in: `SNIFFO_DESKTOP_TESTS=1 cargo test -p sniffo --test commands reveal`.
/// The command itself is checked here; the Finder side runs in examples/reveal_check.rs because
/// AppKit only works on the main thread (where the app runs sync commands).
#[cfg(target_os = "macos")]
#[test]
fn reveal_ca_shows_the_certificate_in_finder() {
    let app = TestApp::new();
    if std::env::var("SNIFFO_DESKTOP_TESTS").is_err() {
        eprintln!("Finder part skipped: set SNIFFO_DESKTOP_TESTS=1");
        return;
    }
    app.ok("reveal_ca", json!({}));
    let ca = app.dir.join("sniffo-ca.pem");
    // The real PATH: the build needs the real xcrun, not the fakes.
    let fake_bin = fakes().dir.join("bin");
    let path: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap()).filter(|p| *p != fake_bin).collect();
    let out = std::process::Command::new(env!("CARGO")).args(["run", "-q", "-p", "sniffo", "--example", "reveal_check", "--"]).arg(&ca)
        .env("PATH", std::env::join_paths(path).unwrap()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let finder = |script: &str| String::from_utf8_lossy(&std::process::Command::new("/usr/bin/osascript").args(["-e", script]).output().unwrap().stdout).trim().to_owned();
    let dir = std::fs::canonicalize(&app.dir).unwrap();
    wait("Finder window on the data folder", || {
        let p = finder("tell application \"Finder\" to get POSIX path of (target of front Finder window as alias)");
        (std::fs::canonicalize(&p).ok()? == dir).then_some(())
    });
    let selected = finder("tell application \"Finder\" to get name of item 1 of (get selection)");
    finder("tell application \"Finder\" to close front Finder window");
    assert_eq!(selected, "sniffo-ca.pem");
}

/// The mock runtime cannot exit: reaching its `request_exit` proves the command asked to quit.
#[test]
#[should_panic(expected = "not implemented")]
fn quit_app_requests_exit() {
    TestApp::new().ok("quit_app", json!({}));
}
