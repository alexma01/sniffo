mod common;

use common::*;
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
