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
