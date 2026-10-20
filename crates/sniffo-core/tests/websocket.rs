mod common;

use common::*;
use sniffo_core::{Action, Decision, FlowEvent, FlowState, Matcher, Rule, Rules};
use hudsucker::futures::{SinkExt, StreamExt};
use hudsucker::tokio_tungstenite::{accept_async, client_async, tungstenite::Message};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}};

async fn echo_server() -> std::net::SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut ws = accept_async(s).await.unwrap();
                while let Some(Ok(m)) = ws.next().await {
                    if m.is_text() || m.is_binary() {
                        ws.send(m).await.unwrap();
                    } else if m.is_close() {
                        break;
                    }
                }
            });
        }
    });
    addr
}

#[tokio::test]
async fn records_websocket_frames_on_upgrade_flow() {
    let up = echo_server().await;
    let s = start(vec![]).await;

    // Tunnel through the proxy with CONNECT, then speak WebSocket inside it.
    let mut tcp = TcpStream::connect(s.proxy.addr).await.unwrap();
    tcp.write_all(format!("CONNECT {up} HTTP/1.1\r\nHost: {up}\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = [0u8; 1024];
    let n = tcp.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
    let (mut ws, _) = client_async(format!("ws://{up}/chat"), tcp).await.unwrap();

    ws.send(Message::text("hello")).await.unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "hello");
    ws.send(Message::binary(vec![1u8, 2, 3])).await.unwrap();
    ws.next().await.unwrap().unwrap();
    ws.close(None).await.unwrap();

    for _ in 0..100 {
        let f = s.engine.flow(1).unwrap();
        if f.ws_messages.iter().any(|m| m.kind == "close") {
            assert_eq!(f.status, Some(101));
            assert_eq!(f.path, "/chat");
            let frames: Vec<_> = f.ws_messages.iter().map(|m| (m.outgoing, m.kind, m.data.as_str())).collect();
            assert_eq!(&frames[..4], &[(true, "text", "hello"), (false, "text", "hello"), (true, "binary", "AQID"), (false, "binary", "AQID")]);
            let har = sniffo_core::har::export(&[f.clone()]).to_string();
            assert_eq!(sniffo_core::har::import(&har).unwrap()[0].ws_messages.len(), f.ws_messages.len());
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("frames not recorded: {:?}", s.engine.flow(1).map(|f| f.ws_messages));
}

#[tokio::test]
async fn injects_messages_into_live_websocket() {
    let up = echo_server().await;
    let s = start(vec![]).await;

    let mut tcp = TcpStream::connect(s.proxy.addr).await.unwrap();
    tcp.write_all(format!("CONNECT {up} HTTP/1.1\r\nHost: {up}\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = [0u8; 1024];
    tcp.read(&mut buf).await.unwrap();
    let (mut ws, _) = client_async(format!("ws://{up}/chat"), tcp).await.unwrap();
    // Round-trip once so both forwarders are running before injecting.
    ws.send(Message::text("hi")).await.unwrap();
    ws.next().await.unwrap().unwrap();

    s.engine.send_ws(1, true, "injected".into(), false).unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "injected");
    s.engine.send_ws(1, false, "AQID".into(), true).unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap().into_data().as_ref(), &[1u8, 2, 3]);
    assert!(s.engine.send_ws(1, false, "not base64!".into(), true).is_err());

    let frames: Vec<_> = s.engine.flow(1).unwrap().ws_messages.iter().map(|m| (m.outgoing, m.data.clone(), m.injected)).collect();
    assert_eq!(&frames[2..], &[
        (true, "injected".into(), true),
        (false, "injected".into(), false),
        (false, "AQID".into(), true),
    ]);

    ws.close(None).await.unwrap();
    for _ in 0..100 {
        if s.engine.send_ws(1, true, "late".into(), false).is_err() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("injection channel not cleaned up after close");
}

#[tokio::test]
async fn breakpoint_edits_or_drops_frames() {
    let up = echo_server().await;
    let s = start(vec![]).await;
    let breakpoint = Rule { id: "r".into(), name: "bp".into(), enabled: true, matcher: Matcher::new("*/chat"), action: Action::Breakpoint { request: true, response: false } };
    s.engine.set_rules(Rules { rules: vec![breakpoint], ..Default::default() });
    let mut events = s.engine.subscribe();

    let mut tcp = TcpStream::connect(s.proxy.addr).await.unwrap();
    tcp.write_all(format!("CONNECT {up} HTTP/1.1\r\nHost: {up}\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = [0u8; 1024];
    tcp.read(&mut buf).await.unwrap();
    let (mut ws, _) = client_async(format!("ws://{up}/chat"), tcp).await.unwrap();
    let mut next_hit = async || loop {
        if let FlowEvent::Breakpoint(h) = events.recv().await.unwrap() { break h; }
    };

    // Client -> server frame is held, edited, and the echo of the edit comes back unpaused.
    ws.send(Message::text("hello")).await.unwrap();
    let hit = next_hit().await;
    assert_eq!((hit.response, hit.ws, hit.message.body.as_deref()), (false, Some("text"), Some("hello")));
    assert_eq!(s.engine.flow(hit.id).unwrap().state, FlowState::Paused);
    let mut msg = hit.message;
    msg.body = Some("edited".into());
    assert!(s.engine.resume(hit.id, false, Decision::Continue(msg)));
    assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "edited");
    assert_eq!(s.engine.flow(hit.id).unwrap().state, FlowState::Complete);

    // Aborting drops the frame: the next echo is the following message.
    ws.send(Message::text("drop me")).await.unwrap();
    let hit = next_hit().await;
    s.engine.resume(hit.id, false, Decision::Abort);
    s.engine.set_rules(Rules::default());
    ws.send(Message::text("after")).await.unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "after");

    let frames: Vec<_> = s.engine.flow(hit.id).unwrap().ws_messages.iter().map(|m| m.data.clone()).collect();
    assert_eq!(frames, ["edited", "edited", "after", "after"]);
}

/// Sniffo relays WebSockets to hosts with a DNS override, or all of them with an upstream proxy,
/// itself (hudsucker's relay would dial them directly): they must connect *and* be recorded.
mod relayed {
    use super::*;
    use hudsucker::tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream, client_async_tls_with_config};
    use sniffo_core::{Engine, ProxyHandle, RootCa, SslProxying, StartOptions, net::{NetworkOptions, Upstream, UpstreamKind}};
    use std::{net::SocketAddr, sync::Arc, time::Duration};
    use tokio_rustls::rustls::{ClientConfig, RootCertStore, ServerConfig, pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer}};

    async fn proxy(net: NetworkOptions, ssl: SslProxying) -> (Engine, ProxyHandle, RootCa) {
        let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
        let ca = RootCa::generate().unwrap();
        let engine = Engine::default();
        engine.set_ssl_proxying(ssl);
        let h = engine.start(TcpListener::bind("127.0.0.1:0").await.unwrap(), &ca, StartOptions { network: net, ..Default::default() }).await.unwrap();
        (engine, h, ca)
    }

    async fn tls_echo_server() -> SocketAddr {
        let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
        let key = hudsucker::rcgen::KeyPair::generate().unwrap();
        let cert = hudsucker::rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap().self_signed(&key).unwrap();
        let cfg = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![CertificateDer::from(cert.der().to_vec())], PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key.serialize_der())))
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(s).await else { return };
                    let Ok(mut ws) = accept_async(tls).await else { return };
                    while let Some(Ok(m)) = ws.next().await {
                        if m.is_text() || m.is_binary() {
                            let _ = ws.send(m).await;
                        }
                    }
                });
            }
        });
        addr
    }

    /// CONNECT to `target`, then a WebSocket inside the tunnel (TLS trusting `ca` when given).
    async fn ws_via(proxy: SocketAddr, target: &str, ca: Option<&RootCa>) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
        let mut tcp = TcpStream::connect(proxy).await.unwrap();
        tcp.write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").as_bytes()).await.unwrap();
        let mut buf = [0u8; 1024];
        let n = tcp.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
        let (url, connector) = match ca {
            Some(ca) => {
                let mut roots = RootCertStore::empty();
                roots.add(CertificateDer::from(ca.cert_der())).unwrap();
                (format!("wss://{target}/chat"), Connector::Rustls(Arc::new(ClientConfig::builder().with_root_certificates(roots).with_no_client_auth())))
            }
            None => (format!("ws://{target}/chat"), Connector::Plain),
        };
        client_async_tls_with_config(url, tcp, None, Some(connector)).await.unwrap().0
    }

    /// The upgrade flow for `/chat` once it has `n` frames.
    async fn flow_with_frames(engine: &Engine, n: usize) -> sniffo_core::Flow {
        for _ in 0..200 {
            if let Some(f) = engine.all_flows().into_iter().find(|f| f.path == "/chat" && f.ws_messages.len() >= n) {
                return f;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("no /chat flow with {n} frames: {:?}", engine.summaries());
    }

    #[tokio::test]
    async fn plain_websocket_to_an_overridden_host_is_relayed_and_recorded() {
        let up = echo_server().await;
        let net = NetworkOptions { dns: vec![("ws.test".into(), "127.0.0.1".into())], ..Default::default() };
        let (engine, h, _) = proxy(net, SslProxying::default()).await;
        let mut ws = ws_via(h.addr, &format!("ws.test:{}", up.port()), None).await;
        ws.send(Message::text("over the override")).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "over the override");
        let f = flow_with_frames(&engine, 2).await;
        assert_eq!((f.host.as_str(), f.status), ("ws.test", Some(101)));
        let frames: Vec<_> = f.ws_messages.iter().map(|m| (m.outgoing, m.kind, m.data.as_str())).collect();
        assert_eq!(&frames[..2], &[(true, "text", "over the override"), (false, "text", "over the override")]);
        // Injection works on the relayed connection too.
        engine.send_ws(f.id, true, "injected".into(), false).unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "injected");
        engine.send_ws(f.id, false, "to the client".into(), false).unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "to the client");
    }

    #[tokio::test]
    async fn decrypted_wss_to_an_overridden_host_is_relayed_and_recorded() {
        let up = tls_echo_server().await;
        let net = NetworkOptions { dns: vec![("wss.test".into(), "127.0.0.1".into())], ignore_upstream_tls_errors: true, ..Default::default() };
        let (engine, h, ca) = proxy(net, decrypt_all()).await;
        let mut ws = ws_via(h.addr, &format!("wss.test:{}", up.port()), Some(&ca)).await;
        ws.send(Message::binary(vec![7u8, 8, 9])).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_data().as_ref(), &[7, 8, 9]);
        let f = flow_with_frames(&engine, 2).await;
        assert!(f.url.starts_with("https://wss.test:"), "{}", f.url);
        assert_eq!((f.ws_messages[0].kind, f.ws_messages[0].data.as_str()), ("binary", "BwgJ"));
    }

    #[tokio::test]
    async fn websockets_go_through_the_upstream_proxy() {
        let up = echo_server().await;
        let (outer_engine, outer, _) = proxy(NetworkOptions::default(), SslProxying::default()).await;
        let net = NetworkOptions { upstream: Some(Upstream { kind: UpstreamKind::Http, host: "127.0.0.1".into(), port: outer.addr.port(), ..Default::default() }), ..Default::default() };
        let (inner_engine, inner, _) = proxy(net, SslProxying::default()).await;
        let mut ws = ws_via(inner.addr, &up.to_string(), None).await;
        ws.send(Message::text("chained")).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "chained");
        assert_eq!(flow_with_frames(&inner_engine, 2).await.ws_messages[1].data, "chained");
        // The upstream proxy carried it (and, not decrypting, saw the WebSocket inside its tunnel).
        assert_eq!(flow_with_frames(&outer_engine, 2).await.ws_messages[0].data, "chained");
    }
}
