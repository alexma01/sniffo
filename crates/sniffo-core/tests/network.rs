mod common;

use common::*;
use sniffo_core::{Engine, RootCa, StartOptions, net::{NetworkOptions, Upstream, UpstreamKind}};
use tokio::net::TcpListener;

async fn start_with(opts: StartOptions) -> (Engine, sniffo_core::ProxyHandle, RootCa) {
    let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
    let ca = RootCa::generate().unwrap();
    let engine = Engine::default();
    let h = engine.start(TcpListener::bind("127.0.0.1:0").await.unwrap(), &ca, opts).await.unwrap();
    (engine, h, ca)
}

fn via(proxy: &sniffo_core::ProxyHandle) -> reqwest::Client {
    reqwest::Client::builder().proxy(reqwest::Proxy::all(format!("http://{}", proxy.addr)).unwrap()).build().unwrap()
}

#[tokio::test]
async fn dns_override_resolves_custom_host() {
    let up = upstream_http().await;
    let net = NetworkOptions { dns: vec![("my-api.test".into(), "127.0.0.1".into())], ..Default::default() };
    let (engine, h, _) = start_with(StartOptions { network: net, ..Default::default() }).await;
    let body = via(&h).get(format!("http://my-api.test:{}/dns", up.port())).send().await.unwrap().text().await.unwrap();
    assert_eq!(body, r#"{"path":"/dns"}"#);
    assert_eq!(engine.summaries()[0].host, "my-api.test");
}

#[tokio::test]
async fn chains_through_upstream_http_proxy() {
    let up = upstream_http().await;
    let (outer_engine, outer, _) = start_with(StartOptions::default()).await;
    let net = NetworkOptions { upstream: Some(Upstream { kind: UpstreamKind::Http, host: "127.0.0.1".into(), port: outer.addr.port(), ..Default::default() }), ..Default::default() };
    let (inner_engine, inner, _) = start_with(StartOptions { network: net, ..Default::default() }).await;
    let body = via(&inner).get(format!("http://{up}/chained")).send().await.unwrap().text().await.unwrap();
    assert_eq!(body, r#"{"path":"/chained"}"#);
    assert_eq!(inner_engine.summaries()[0].path, "/chained");
    assert_eq!(outer_engine.summaries()[0].path, "/chained", "the upstream proxy saw the request too");
}

#[tokio::test]
async fn ignore_upstream_tls_errors() {
    let (up, _pem) = upstream_https().await;
    let url = format!("https://localhost:{}/selfsigned", up.port());

    let (_, strict, ca) = start_with(StartOptions::default()).await;
    let c = |h: &sniffo_core::ProxyHandle, ca: &RootCa| reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", h.addr)).unwrap())
        .tls_certs_only([reqwest::Certificate::from_pem(ca.cert_pem.as_bytes()).unwrap()])
        .build().unwrap();
    assert_eq!(c(&strict, &ca).get(&url).send().await.unwrap().status(), 502, "self-signed upstream rejected by default");

    let net = NetworkOptions { ignore_upstream_tls_errors: true, ..Default::default() };
    let (_, lenient, ca) = start_with(StartOptions { network: net, ..Default::default() }).await;
    assert_eq!(c(&lenient, &ca).get(&url).send().await.unwrap().status(), 200);
}

#[tokio::test]
async fn reverse_proxy_forwards_to_target() {
    let up = upstream_http().await;
    let (engine, h, _) = start_with(StartOptions { reverse_target: Some(format!("http://{up}")), ..Default::default() }).await;
    let body = reqwest::get(format!("http://{}/through/reverse?x=1", h.addr)).await.unwrap().text().await.unwrap();
    assert_eq!(body, r#"{"path":"/through/reverse"}"#);
    let f = &engine.summaries()[0];
    assert_eq!((f.host.as_str(), f.path.as_str()), ("127.0.0.1", "/through/reverse?x=1"));
}

#[tokio::test]
async fn rejects_bad_dns_entry() {
    let ca = RootCa::generate().unwrap();
    let net = NetworkOptions { dns: vec![("x".into(), "not-an-ip".into())], ..Default::default() };
    let err = Engine::default().start(TcpListener::bind("127.0.0.1:0").await.unwrap(), &ca, StartOptions { network: net, ..Default::default() }).await.err().unwrap();
    assert!(err.contains("not an IP"));
}
