mod common;

use common::*;
use sniffo_core::{FlowState, SslProxying};
use tokio::net::TcpListener;

#[tokio::test]
async fn captures_plain_http() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    let mut events = s.engine.subscribe();
    let body = client(&s, None).post(format!("http://{up}/hello?x=1")).body("ping").send().await.unwrap().text().await.unwrap();
    assert_eq!(body, r#"{"path":"/hello"}"#);

    let f = settled(&s.engine, 1).await;
    assert_eq!(f.state, FlowState::Complete, "{:?}", f.error);
    assert_eq!((f.method.as_str(), f.path.as_str(), f.status), ("POST", "/hello?x=1", Some(200)));
    assert_eq!(&f.request.body[..], b"ping");
    assert_eq!(&f.response.as_ref().unwrap().body[..], body.as_bytes());
    assert!(matches!(events.recv().await.unwrap(), sniffo_core::FlowEvent::Upsert(_)));
    s.proxy.stop().await;
}

#[tokio::test]
async fn decrypts_https() {
    let (up, up_pem) = upstream_https().await;
    let s = start(vec![up_pem]).await;
    let res = client(&s, None).get(format!("https://localhost:{}/secure", up.port())).send().await.unwrap();
    assert_eq!(res.status(), 200);
    res.text().await.unwrap();

    let f = settled(&s.engine, 1).await;
    assert_eq!(f.scheme, "https");
    assert_eq!(f.host, "localhost");
    assert_eq!(f.path, "/secure");
    assert_eq!(f.state, FlowState::Complete, "{:?}", f.error);
    s.proxy.stop().await;
}

#[tokio::test]
async fn excluded_hosts_are_tunnelled() {
    let (up, up_pem) = upstream_https().await;
    let s = start(vec![]).await;
    s.engine.set_ssl_proxying(SslProxying { exclude: vec!["localhost".into()], ..Default::default() });
    // Client must trust the real upstream cert: the proxy does not touch the TLS stream.
    let res = client(&s, Some(&up_pem)).get(format!("https://localhost:{}/tunnel", up.port())).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(s.engine.summaries().is_empty());
    s.proxy.stop().await;
}

#[tokio::test]
async fn records_upstream_failure() {
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap(); // closed when dropped
    let s = start(vec![]).await;
    let res = client(&s, None).get(format!("http://{dead}/")).send().await.unwrap();
    assert_eq!(res.status(), 502);
    let f = s.engine.flow(1).unwrap();
    assert_eq!(f.state, FlowState::Failed);
    assert!(f.error.is_some());
    s.proxy.stop().await;
}

#[tokio::test]
async fn search_pin_and_clear() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    let c = client(&s, None);
    c.post(format!("http://{up}/a")).body("needle-in-request").send().await.unwrap().text().await.unwrap();
    c.get(format!("http://{up}/b")).send().await.unwrap().text().await.unwrap();
    settled(&s.engine, 2).await;

    assert_eq!(s.engine.search("NEEDLE"), vec![1]);
    assert_eq!(s.engine.search(r#""path":"/b""#), vec![2], "searches response body");

    s.engine.set_pinned(2, true);
    s.engine.clear();
    let left: Vec<_> = s.engine.summaries().iter().map(|f| f.id).collect();
    assert_eq!(left, vec![2], "pinned flows survive clear");
    s.proxy.stop().await;
}

#[tokio::test]
async fn serves_certificate_page_to_devices() {
    let s = start(vec![]).await;
    let c = client(&s, None);
    let page = c.get("http://sniffo.cert/").send().await.unwrap().text().await.unwrap();
    assert!(page.contains("/sniffo-ca.pem"));
    let pem = c.get("http://sniffo.cert/sniffo-ca.pem").send().await.unwrap().text().await.unwrap();
    assert_eq!(pem, s.ca.cert_pem);
    let der = c.get("http://sniffo.cert/sniffo-ca.crt").send().await.unwrap().bytes().await.unwrap();
    assert_eq!(der.to_vec(), s.ca.cert_der());
    // Opening http://<proxy-ip>:<port>/ directly (no proxy configured yet) shows the same page.
    let direct = reqwest::get(format!("http://{}/", s.proxy.addr)).await.unwrap().text().await.unwrap();
    assert!(direct.contains("Sniffo root certificate"));
    assert!(s.engine.summaries().is_empty(), "cert page is not recorded");
}

#[cfg(unix)]
#[tokio::test]
async fn resolves_local_client_app() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    let status = tokio::process::Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-x", &format!("http://{}", s.proxy.addr), &format!("http://{up}/who")])
        .status()
        .await
        .unwrap();
    assert!(status.success());
    for _ in 0..100 {
        if let Some(app) = s.engine.flow(1).and_then(|f| f.client_app) {
            assert_eq!(app, "curl");
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("client app never resolved");
}

#[tokio::test]
async fn compose_goes_through_proxy_and_har_roundtrips() {
    let up = upstream_http().await;
    let s = start(vec![]).await;
    let status = sniffo_core::compose::send(s.proxy.addr, &s.ca.cert_pem, "PUT", &format!("http://{up}/composed"), &vec![("x-test".into(), "1".into()), ("host".into(), "ignored".into())], "payload".into())
        .await
        .unwrap();
    assert_eq!(status, 200);
    let f = settled(&s.engine, 1).await;
    assert_eq!((f.method.as_str(), f.path.as_str()), ("PUT", "/composed"));
    assert_eq!(&f.request.body[..], b"payload");
    assert!(f.request.headers.iter().any(|(k, v)| k == "x-test" && v == "1"));

    let har = sniffo_core::har::export(&s.engine.all_flows()).to_string();
    s.engine.clear();
    assert_eq!(s.engine.import(sniffo_core::har::import(&har).unwrap()), 1);
    let back = &s.engine.summaries()[0];
    assert_eq!((back.path.as_str(), back.status), ("/composed", Some(200)));
    s.proxy.stop().await;
}

#[tokio::test]
async fn stop_is_quick_with_open_tunnels() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let up = upstream_http().await;
    let s = start(vec![]).await;
    let addr = s.proxy.addr;
    // A browser-style CONNECT tunnel that never closes.
    let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    tcp.write_all(format!("CONNECT {up} HTTP/1.1\r\nHost: {up}\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = [0u8; 64];
    let _ = tcp.read(&mut buf).await.unwrap();

    let t = std::time::Instant::now();
    s.proxy.stop().await;
    assert!(t.elapsed() < std::time::Duration::from_secs(2), "stop took {:?}", t.elapsed());
    tokio::net::TcpListener::bind(addr).await.expect("port is free again");
    drop(tcp);
}
