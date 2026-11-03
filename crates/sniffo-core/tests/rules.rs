//! End-to-end checks for every rule action through a real proxy.
mod common;

use common::*;
use sniffo_core::{Action, AllowList, Decision, FlowEvent, FlowState, Matcher, Rule, Rules};
use std::time::{Duration, Instant};

fn rules(url: &str, action: Action) -> Rules {
    Rules { rules: vec![Rule { id: "r".into(), name: "rule".into(), enabled: true, matcher: Matcher::new(url), action }], ..Default::default() }
}

#[tokio::test]
async fn block_returns_403_without_contacting_server() {
    let s = start(vec![]).await;
    s.engine.set_rules(rules("*blocked*", Action::Block));
    let res = client(&s, None).get(format!("http://{}/blocked", dead_addr().await)).send().await.unwrap();
    assert_eq!(res.status(), 403);
    let f = s.engine.flow(1).unwrap();
    assert_eq!((f.status, f.state, f.tags), (Some(403), FlowState::Complete, vec!["rule".to_string()]));
}

#[tokio::test]
async fn map_local_answers_from_rule_and_file() {
    let s = start(vec![]).await;
    let dead = dead_addr().await;
    s.engine.set_rules(rules("*/mock", Action::MapLocal { status: 201, headers: vec![("content-type".into(), "application/json".into())], body: r#"{"mock":true}"#.into(), file: None }));
    let res = client(&s, None).get(format!("http://{dead}/mock")).send().await.unwrap();
    assert_eq!(res.status(), 201);
    assert_eq!(res.text().await.unwrap(), r#"{"mock":true}"#);

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("body.txt");
    std::fs::write(&file, "from file").unwrap();
    s.engine.set_rules(rules("*/file", Action::MapLocal { status: 200, headers: vec![], body: String::new(), file: Some(file.display().to_string()) }));
    assert_eq!(client(&s, None).get(format!("http://{dead}/file")).send().await.unwrap().text().await.unwrap(), "from file");
}

#[tokio::test]
async fn map_remote_rewrites_destination() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    s.engine.set_rules(rules("http://prod.invalid/*", Action::MapRemote { scheme: None, host: Some("127.0.0.1".into()), port: Some(up.port()), path: Some("/mapped".into()) }));
    let body = client(&s, None).get("http://prod.invalid/original?q=1").send().await.unwrap().text().await.unwrap();
    assert_eq!(body, r#"{"path":"/mapped"}"#);
    assert_eq!(s.engine.flow(1).unwrap().url, "http://prod.invalid/original?q=1", "list keeps the URL the client asked for");
}

#[tokio::test]
async fn request_breakpoint_edits_url() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    s.engine.set_rules(rules("*", Action::Breakpoint { request: true, response: false }));
    let mut events = s.engine.subscribe();
    let req = tokio::spawn(client(&s, None).get(format!("http://{up}/before")).send());

    let hit = loop {
        if let FlowEvent::Breakpoint(h) = events.recv().await.unwrap() { break h; }
    };
    assert!(!hit.response);
    assert_eq!(s.engine.flow(hit.id).unwrap().state, FlowState::Paused);
    let mut msg = hit.message;
    msg.url = msg.url.replace("/before", "/after");
    assert!(s.engine.resume(hit.id, hit.response, Decision::Continue(msg)));

    let body = req.await.unwrap().unwrap().text().await.unwrap();
    assert_eq!(body, r#"{"path":"/after"}"#);
}

#[tokio::test]
async fn response_breakpoint_edits_status_and_body_or_aborts() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    s.engine.set_rules(rules("*", Action::Breakpoint { request: false, response: true }));
    let mut events = s.engine.subscribe();
    let next_hit = |events: &mut tokio::sync::broadcast::Receiver<FlowEvent>| {
        let mut rx = events.resubscribe();
        async move { loop { if let FlowEvent::Breakpoint(h) = rx.recv().await.unwrap() { break h; } } }
    };

    let wait = next_hit(&mut events);
    let req = tokio::spawn(client(&s, None).get(format!("http://{up}/x")).send());
    let hit = wait.await;
    assert!(hit.response);
    assert_eq!(hit.message.body.as_deref(), Some(r#"{"path":"/x"}"#));
    let mut msg = hit.message;
    msg.status = 418;
    msg.body = Some("edited".into());
    s.engine.resume(hit.id, hit.response, Decision::Continue(msg));
    let res = req.await.unwrap().unwrap();
    assert_eq!(res.status(), 418);
    assert_eq!(res.text().await.unwrap(), "edited");

    let wait = next_hit(&mut events);
    let req = tokio::spawn(client(&s, None).get(format!("http://{up}/y")).send());
    let hit = wait.await;
    s.engine.resume(hit.id, hit.response, Decision::Abort);
    assert_eq!(req.await.unwrap().unwrap().status(), 502);
    assert_eq!(s.engine.flow(hit.id).unwrap().state, FlowState::Failed);
}

#[tokio::test]
async fn throttle_adds_latency_and_limits_download() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    let c = client(&s, None);

    s.engine.set_rules(rules("*", Action::Throttle { latency_ms: 300, download_kbps: 0, upload_kbps: 0 }));
    let t = Instant::now();
    c.get(format!("http://{up}/fast")).send().await.unwrap().text().await.unwrap();
    assert!(t.elapsed() >= Duration::from_millis(300), "latency {:?}", t.elapsed());

    // ~4 KB body at 4 KB/s should take about a second.
    s.engine.set_rules(rules("*", Action::Throttle { latency_ms: 0, download_kbps: 4, upload_kbps: 0 }));
    let path = "a".repeat(4096);
    let t = Instant::now();
    let body = c.get(format!("http://{up}/{path}")).send().await.unwrap().text().await.unwrap();
    assert!(body.len() > 4096);
    assert!(t.elapsed() >= Duration::from_millis(800), "download {:?}", t.elapsed());
}

#[tokio::test]
async fn allow_list_limits_recording() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    s.engine.set_rules(Rules { rules: vec![], allow_list: AllowList { enabled: true, patterns: vec!["*/keep*".into()] }, ..Default::default() });
    let c = client(&s, None);
    c.get(format!("http://{up}/skip")).send().await.unwrap().text().await.unwrap();
    c.get(format!("http://{up}/keep")).send().await.unwrap().text().await.unwrap();
    let paths: Vec<_> = s.engine.summaries().into_iter().map(|f| f.path).collect();
    assert_eq!(paths, ["/keep"]);
}

#[tokio::test]
async fn script_rewrites_request_and_response_and_logs() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    let code = r#"
        function onRequest(context, request) {
          request.url = request.url.replace("/original", "/scripted");
          console.log("rewrote", context.flowId);
          return request;
        }
        function onResponse(context, request, response) {
          response.status = 202;
          response.body.fromScript = request.url.endsWith("/scripted");
          response.headers["x-script"] = "yes";
          return response;
        }"#;
    s.engine.set_rules(rules("*", Action::Script { code: code.into() }));
    let mut events = s.engine.subscribe();
    let res = client(&s, None).get(format!("http://{up}/original")).send().await.unwrap();
    assert_eq!(res.status(), 202);
    assert_eq!(res.headers()["x-script"], "yes");
    assert_eq!(res.text().await.unwrap(), r#"{"fromScript":true,"path":"/scripted"}"#);
    let log = loop {
        if let FlowEvent::Log(l) = events.recv().await.unwrap() { break l; }
    };
    assert_eq!((log.message.as_str(), log.error), ("rewrote 1", false));
}

#[tokio::test]
async fn script_errors_pass_traffic_through() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    s.engine.set_rules(rules("*", Action::Script { code: "function onRequest() { throw new Error('nope') }".into() }));
    let mut events = s.engine.subscribe();
    let res = client(&s, None).get(format!("http://{up}/ok")).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let log = loop {
        if let FlowEvent::Log(l) = events.recv().await.unwrap() { break l; }
    };
    assert!(log.error && log.message.contains("nope"));
}

#[tokio::test]
async fn map_local_directory_serves_files_and_blocks_traversal() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("js")).unwrap();
    std::fs::write(dir.path().join("js/app.js"), "console.log(1)").unwrap();
    std::fs::write(dir.path().join("index.html"), "<h1>home</h1>").unwrap();
    std::fs::write(dir.path().parent().unwrap().join("secret.txt"), "nope").ok();
    let s = start(vec![]).await;
    s.engine.set_rules(rules("http://cdn.invalid/assets/*", Action::MapLocalDir { dir: dir.path().display().to_string() }));
    let c = client(&s, None);

    let res = c.get("http://cdn.invalid/assets/js/app.js?v=3").send().await.unwrap();
    assert_eq!(res.headers()["content-type"], "application/javascript");
    assert_eq!(res.text().await.unwrap(), "console.log(1)");
    assert_eq!(c.get("http://cdn.invalid/assets/").send().await.unwrap().text().await.unwrap(), "<h1>home</h1>");
    assert_eq!(c.get("http://cdn.invalid/assets/missing.css").send().await.unwrap().status(), 404);
    // reqwest normalizes "..", so send the raw request line a hostile client could send.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut tcp = tokio::net::TcpStream::connect(s.proxy.addr).await.unwrap();
    tcp.write_all(b"GET http://cdn.invalid/assets/../secret.txt HTTP/1.1\r\nHost: cdn.invalid\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut out = String::new();
    tcp.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 403"), "{out}");
}

#[tokio::test]
async fn no_caching_strips_cache_headers() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    s.engine.set_rules(Rules { no_caching: true, ..Default::default() });
    let res = client(&s, None).get(format!("http://{up}/c")).header("if-none-match", "\"abc\"").send().await.unwrap();
    assert_eq!(res.headers()["cache-control"], "no-store");
    let f = s.engine.flow(1).unwrap();
    assert!(!f.request.headers.iter().any(|(k, _)| k == "if-none-match"), "conditional header removed before forwarding");
}

/// An upstream answering with `Transfer-Encoding: chunked`; the edited response must carry a
/// single framing header (strict clients like Node reject both at once).
#[tokio::test]
async fn edited_chunked_responses_are_reframed() {
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n").await;
            });
        }
    });
    let s = start(vec![]).await;
    let code = "function onResponse(c, req, res) { res.body.b = 2; return res; }";
    s.engine.set_rules(rules("*", Action::Script { code: code.into() }));
    let mut tcp = tokio::net::TcpStream::connect(s.proxy.addr).await.unwrap();
    tcp.write_all(format!("GET http://{up}/x HTTP/1.1\r\nhost: {up}\r\nconnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut raw = String::new();
    tcp.read_to_string(&mut raw).await.unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let head = head.to_ascii_lowercase();
    assert!(!(head.contains("transfer-encoding") && head.contains("content-length")), "both framing headers:\n{head}");
    assert!(head.contains("content-length: 13"), "{head}");
    assert_eq!(body, r#"{"a":1,"b":2}"#);
}
