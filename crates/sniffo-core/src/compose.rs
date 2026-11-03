//! Repeat / Compose: requests are sent *through our own proxy*, so they are captured
//! like any other traffic and every rule (breakpoints, map local, throttle…) applies.

use crate::flow::Headers;
use bytes::Bytes;
use std::net::SocketAddr;

/// Headers the HTTP client must compute itself.
const SKIP: [&str; 5] = ["host", "content-length", "connection", "proxy-connection", "transfer-encoding"];

pub async fn send(proxy: SocketAddr, ca_pem: &str, method: &str, url: &str, headers: &Headers, body: Bytes) -> Result<u16, String> {
    let ca = reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{}", proxy.port())).map_err(|e| e.to_string())?)
        // Our CA for decrypted hosts, system roots for hosts tunnelled untouched.
        .tls_certs_merge([ca])
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url).body(body);
    for (k, v) in headers.iter().filter(|(k, _)| !SKIP.contains(&k.to_ascii_lowercase().as_str())) {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| format!("{e}: {}", std::error::Error::source(&e).map(|s| s.to_string()).unwrap_or_default()))?;
    let status = res.status().as_u16();
    // Drain so the proxy records the full response.
    let _ = res.bytes().await;
    Ok(status)
}
