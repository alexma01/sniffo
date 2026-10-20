use hudsucker::rcgen::{CertificateParams, KeyPair};
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use sniffo_core::{Engine, FlowState, RootCa, SslProxying, StartOptions};
use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio_rustls::{TlsAcceptor, rustls::{ServerConfig, pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer}}};

async fn hello(req: Request<Incoming>) -> Result<Response<String>, Infallible> {
    Ok(Response::builder()
        .header("content-type", "application/json")
        .body(format!(r#"{{"path":"{}"}}"#, req.uri().path()))
        .unwrap())
}

async fn upstream_http() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            tokio::spawn(hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(s), service_fn(hello)));
        }
    });
    addr
}

/// HTTPS upstream on 127.0.0.1 with a self-signed cert for "localhost"; returns (addr, cert pem).
async fn upstream_https() -> (SocketAddr, String) {
    let key = KeyPair::generate().unwrap();
    let cert = CertificateParams::new(vec!["localhost".into()]).unwrap().self_signed(&key).unwrap();
    let cfg = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.der().to_vec())],
            PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(cfg));
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(s).await else { return };
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls), service_fn(hello)).await;
            });
        }
    });
    (addr, cert.pem())
}

struct Setup {
    engine: Engine,
    proxy: sniffo_core::ProxyHandle,
    ca: RootCa,
}

async fn start(extra_roots: Vec<String>) -> Setup {
    let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
    let ca = RootCa::generate().unwrap();
    let engine = Engine::default();
    let proxy = engine
        .start(TcpListener::bind("127.0.0.1:0").await.unwrap(), &ca, StartOptions { extra_upstream_roots: extra_roots })
        .await
        .unwrap();
    Setup { engine, proxy, ca }
}

fn client(s: &Setup, extra_root: Option<&str>) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", s.proxy.addr)).unwrap())
        .tls_certs_only([reqwest::Certificate::from_pem(s.ca.cert_pem.as_bytes()).unwrap()]);
    if let Some(pem) = extra_root {
        b = b.tls_certs_merge([reqwest::Certificate::from_pem(pem.as_bytes()).unwrap()]);
    }
    b.timeout(Duration::from_secs(10)).build().unwrap()
}

/// Waits until the response body has been fully recorded (Tee finishes after the client reads it).
async fn settled(engine: &Engine, id: u64) -> sniffo_core::Flow {
    for _ in 0..100 {
        let f = engine.flow(id).unwrap();
        if f.state != FlowState::Pending {
            return f;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("flow {id} never settled");
}

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
