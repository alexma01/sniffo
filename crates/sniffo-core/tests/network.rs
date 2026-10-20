mod common;

use common::*;
use sniffo_core::{Engine, RootCa, StartOptions, net::{NetworkOptions, Upstream, UpstreamKind}};
use tokio::net::TcpListener;

async fn start_with(opts: StartOptions) -> (Engine, sniffo_core::ProxyHandle, RootCa) {
    let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
    let ca = RootCa::generate().unwrap();
    let engine = Engine::default();
    engine.set_ssl_proxying(decrypt_all());
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

/// Undecrypted HTTPS (a CONNECT tunnel) must honour DNS overrides and the upstream proxy too.
fn insecure_via(proxy: &sniffo_core::ProxyHandle) -> reqwest::Client {
    reqwest::Client::builder().proxy(reqwest::Proxy::all(format!("http://{}", proxy.addr)).unwrap()).danger_accept_invalid_certs(true).build().unwrap()
}

#[tokio::test]
async fn tunnels_use_dns_overrides() {
    let (up, _) = upstream_https().await;
    let net = NetworkOptions { dns: vec![("tunnel.test".into(), "127.0.0.1".into())], ..Default::default() };
    let (engine, h, _) = start_with(StartOptions { network: net, ..Default::default() }).await;
    engine.set_ssl_proxying(sniffo_core::SslProxying::default());
    let res = insecure_via(&h).get(format!("https://tunnel.test:{}/t", up.port())).send().await.unwrap();
    assert_eq!(res.text().await.unwrap(), r#"{"path":"/t"}"#);
    let f = &engine.summaries()[0];
    assert_eq!((f.method.as_str(), f.host.as_str()), ("CONNECT", "tunnel.test"));
}

#[tokio::test]
async fn tunnels_go_through_the_upstream_proxy() {
    let (up, _) = upstream_https().await;
    let (outer_engine, outer, _) = start_with(StartOptions::default()).await;
    outer_engine.set_ssl_proxying(sniffo_core::SslProxying::default());
    let net = NetworkOptions { upstream: Some(Upstream { kind: UpstreamKind::Http, host: "127.0.0.1".into(), port: outer.addr.port(), ..Default::default() }), ..Default::default() };
    let (inner_engine, inner, _) = start_with(StartOptions { network: net, ..Default::default() }).await;
    inner_engine.set_ssl_proxying(sniffo_core::SslProxying::default());
    let res = insecure_via(&inner).get(format!("https://localhost:{}/chained-tunnel", up.port())).send().await.unwrap();
    assert_eq!(res.text().await.unwrap(), r#"{"path":"/chained-tunnel"}"#);
    assert_eq!(inner_engine.summaries()[0].method, "CONNECT");
    assert_eq!(outer_engine.summaries()[0].method, "CONNECT", "the tunnel went through the upstream proxy");

    // An unreachable upstream: the client gets a 502 and the tunnel flow is marked failed.
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let net = NetworkOptions { upstream: Some(Upstream { kind: UpstreamKind::Http, host: "127.0.0.1".into(), port: dead, ..Default::default() }), ..Default::default() };
    let (engine, h, _) = start_with(StartOptions { network: net, ..Default::default() }).await;
    engine.set_ssl_proxying(sniffo_core::SslProxying::default());
    assert!(insecure_via(&h).get(format!("https://localhost:{}/", up.port())).send().await.is_err());
    let f = engine.flow(1).unwrap();
    assert_eq!(f.state, sniffo_core::FlowState::Failed);
    assert!(f.error.unwrap().starts_with("tunnel to localhost:"));
}

/// Minimal SOCKS5 server (CONNECT only, optional user/password); records the targets.
async fn socks5(auth: Option<(&'static str, &'static str)>) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut b = [0u8; 2];
                c.read_exact(&mut b).await?;
                let mut methods = vec![0u8; b[1] as usize];
                c.read_exact(&mut methods).await?;
                if let Some((user, pass)) = auth {
                    c.write_all(&[5, 2]).await?;
                    let mut v = [0u8; 2];
                    c.read_exact(&mut v).await?;
                    let mut u = vec![0u8; v[1] as usize];
                    c.read_exact(&mut u).await?;
                    let mut pl = [0u8; 1];
                    c.read_exact(&mut pl).await?;
                    let mut p = vec![0u8; pl[0] as usize];
                    c.read_exact(&mut p).await?;
                    let ok = u == user.as_bytes() && p == pass.as_bytes();
                    c.write_all(&[1, if ok { 0 } else { 1 }]).await?;
                    if !ok { return Ok::<_, std::io::Error>(()); }
                } else {
                    c.write_all(&[5, 0]).await?;
                }
                let mut h = [0u8; 4];
                c.read_exact(&mut h).await?;
                let host = match h[3] {
                    1 => { let mut a = [0u8; 4]; c.read_exact(&mut a).await?; std::net::Ipv4Addr::from(a).to_string() }
                    3 => { let mut l = [0u8; 1]; c.read_exact(&mut l).await?; let mut n = vec![0u8; l[0] as usize]; c.read_exact(&mut n).await?; String::from_utf8_lossy(&n).into_owned() }
                    _ => return Ok(()),
                };
                let mut p = [0u8; 2];
                c.read_exact(&mut p).await?;
                let target = format!("{host}:{}", u16::from_be_bytes(p));
                log.lock().unwrap().push(target.clone());
                let mut up = tokio::net::TcpStream::connect(target.replace("localhost", "127.0.0.1")).await?;
                c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                tokio::io::copy_bidirectional(&mut c, &mut up).await.map(drop)
            });
        }
    });
    (port, seen)
}

#[tokio::test]
async fn chains_through_socks5_with_and_without_credentials() {
    let up = upstream_http().await;
    let (tls_up, _) = upstream_https().await;
    for auth in [None, Some(("alice", "s3cret"))] {
        let (port, seen) = socks5(auth).await;
        let socks = Upstream { kind: UpstreamKind::Socks5, host: "127.0.0.1".into(), port, username: auth.map(|a| a.0.into()).unwrap_or_default(), password: auth.map(|a| a.1.into()).unwrap_or_default() };
        let (engine, h, _) = start_with(StartOptions { network: NetworkOptions { upstream: Some(socks), ..Default::default() }, ..Default::default() }).await;
        let body = via(&h).get(format!("http://{up}/socks")).send().await.unwrap().text().await.unwrap();
        assert_eq!(body, r#"{"path":"/socks"}"#);
        // Undecrypted HTTPS goes through it too.
        engine.set_ssl_proxying(sniffo_core::SslProxying::default());
        let body = insecure_via(&h).get(format!("https://localhost:{}/socks-tunnel", tls_up.port())).send().await.unwrap().text().await.unwrap();
        assert_eq!(body, r#"{"path":"/socks-tunnel"}"#);
        assert_eq!(seen.lock().unwrap().clone(), vec![up.to_string(), format!("localhost:{}", tls_up.port())], "auth {auth:?}");
    }
    // Wrong password: the request fails instead of bypassing the proxy.
    let (port, seen) = socks5(Some(("alice", "s3cret"))).await;
    let socks = Upstream { kind: UpstreamKind::Socks5, host: "127.0.0.1".into(), port, username: "alice".into(), password: "wrong".into() };
    let (_, h, _) = start_with(StartOptions { network: NetworkOptions { upstream: Some(socks), ..Default::default() }, ..Default::default() }).await;
    assert_eq!(via(&h).get(format!("http://{up}/denied")).send().await.unwrap().status(), 502);
    assert!(seen.lock().unwrap().is_empty());
}
