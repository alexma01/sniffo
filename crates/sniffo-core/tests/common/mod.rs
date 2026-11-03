#![allow(dead_code)]
use hudsucker::rcgen::{CertificateParams, KeyPair};
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use sniffo_core::{Engine, FlowState, RootCa, SslProxying, StartOptions};
use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio_rustls::{TlsAcceptor, rustls::{ServerConfig, pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer}}};

pub async fn hello(req: Request<Incoming>) -> Result<Response<String>, Infallible> {
    // Keeps the connection open long enough for the proxy to look up the client process.
    if req.uri().path() == "/slow" {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(Response::builder()
        .header("content-type", "application/json")
        .body(format!(r#"{{"path":"{}"}}"#, req.uri().path()))
        .unwrap())
}

pub async fn upstream_http() -> SocketAddr {
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
pub async fn upstream_https() -> (SocketAddr, String) {
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

pub struct Setup {
    pub engine: Engine,
    pub proxy: sniffo_core::ProxyHandle,
    pub ca: RootCa,
}

/// Proxy that decrypts every host (the app default decrypts none).
pub async fn start(extra_roots: Vec<String>) -> Setup {
    let s = start_default(extra_roots).await;
    s.engine.set_ssl_proxying(decrypt_all());
    s
}

pub fn decrypt_all() -> SslProxying {
    SslProxying { include: vec!["*".into()], ..Default::default() }
}

/// Proxy with the out-of-the-box SSL Proxying settings.
pub async fn start_default(extra_roots: Vec<String>) -> Setup {
    let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
    let ca = RootCa::generate().unwrap();
    let engine = Engine::default();
    let proxy = engine
        .start(TcpListener::bind("127.0.0.1:0").await.unwrap(), &ca, StartOptions { extra_upstream_roots: extra_roots, ..Default::default() })
        .await
        .unwrap();
    Setup { engine, proxy, ca }
}

pub fn client(s: &Setup, extra_root: Option<&str>) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", s.proxy.addr)).unwrap())
        .tls_certs_only([reqwest::Certificate::from_pem(s.ca.cert_pem.as_bytes()).unwrap()]);
    if let Some(pem) = extra_root {
        b = b.tls_certs_merge([reqwest::Certificate::from_pem(pem.as_bytes()).unwrap()]);
    }
    b.timeout(Duration::from_secs(10)).build().unwrap()
}

/// Waits until the response body has been fully recorded (Tee finishes after the client reads it).
pub async fn settled(engine: &Engine, id: u64) -> sniffo_core::Flow {
    for _ in 0..100 {
        let f = engine.flow(id).unwrap();
        if f.state != FlowState::Pending {
            return f;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("flow {id} never settled");
}


/// An address nothing listens on.
pub async fn dead_addr() -> SocketAddr {
    TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap()
}
