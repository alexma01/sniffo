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
