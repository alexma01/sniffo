//! HAR 1.2 import/export. HAR is also Sniffo's session file format.

use crate::flow::{Flow, FlowState, Headers, Message, WsMessage};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn headers_json(h: &Headers) -> Value {
    h.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect()
}

/// HAR stores decoded content: text as-is, anything else base64.
fn content(m: &Message) -> (String, Option<&'static str>) {
    let body = m.decoded_body();
    match String::from_utf8(body.to_vec()) {
        Ok(text) => (text, None),
        Err(_) => (B64.encode(&body), Some("base64")),
    }
}

fn iso(ms: u64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_default()
}

pub fn export(flows: &[Flow]) -> Value {
    let entries: Vec<Value> = flows
        .iter()
        .map(|f| {
            let mime = |m: &Message| m.header("content-type").unwrap_or("").to_owned();
            let (req_text, req_enc) = content(&f.request);
            let query: Vec<Value> = f.url.split_once('?').map(|(_, q)| q).unwrap_or("").split('&').filter(|p| !p.is_empty()).map(|p| {
                let (k, v) = p.split_once('=').unwrap_or((p, ""));
                json!({ "name": k, "value": v })
            }).collect();
            let mut request = json!({
                "method": f.method, "url": f.url, "httpVersion": f.http_version,
                "headers": headers_json(&f.request.headers), "queryString": query, "cookies": [],
                "headersSize": -1, "bodySize": f.request.body_size,
            });
            if f.request.body_size > 0 {
                request["postData"] = json!({ "mimeType": mime(&f.request), "text": req_text });
                if let Some(e) = req_enc { request["postData"]["encoding"] = json!(e); }
            }
            let response = match &f.response {
                Some(r) => {
                    let (text, enc) = content(r);
                    let mut c = json!({ "size": r.body_size, "mimeType": mime(r), "text": text });
                    if let Some(e) = enc { c["encoding"] = json!(e); }
                    json!({
                        "status": f.status.unwrap_or(0), "statusText": "", "httpVersion": f.http_version,
                        "headers": headers_json(&r.headers), "cookies": [], "content": c,
                        "redirectURL": r.header("location").unwrap_or(""), "headersSize": -1, "bodySize": r.body_size,
                    })
                }
                // HAR requires a response; failed flows get status 0 and the error in `_error`.
                None => json!({ "status": 0, "statusText": "", "httpVersion": f.http_version, "headers": [], "cookies": [],
                    "content": { "size": 0, "mimeType": "" }, "redirectURL": "", "headersSize": -1, "bodySize": -1, "_error": f.error }),
            };
            let ttfb = f.ttfb_ms.unwrap_or(0);
            let total = f.duration_ms.unwrap_or(ttfb);
            json!({
                "startedDateTime": iso(f.started_ms), "time": total,
                "request": request, "response": response, "cache": {},
                "timings": { "send": 0, "wait": ttfb, "receive": total.saturating_sub(ttfb) },
                "_client": f.client_app.clone().unwrap_or_else(|| f.client_addr.clone()),
                "_pinned": f.pinned, "_tags": f.tags,
                // Chrome DevTools' convention for WebSocket frames.
                "_webSocketMessages": f.ws_messages.iter().map(|m| json!({
                    "type": if m.outgoing { "send" } else { "receive" },
                    "time": m.time_ms as f64 / 1000.0,
                    "opcode": match m.kind { "text" => 1, "binary" => 2, "close" => 8, "ping" => 9, "pong" => 10, _ => 0 },
                    "data": m.data,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({ "log": { "version": "1.2", "creator": { "name": "Sniffo", "version": env!("CARGO_PKG_VERSION") }, "entries": entries } })
}

fn headers_from(v: &Value) -> Headers {
    v.as_array().into_iter().flatten().filter_map(|h| Some((h["name"].as_str()?.to_owned(), h["value"].as_str().unwrap_or("").to_owned()))).collect()
}

fn body_from(text: &Value, encoding: &Value) -> bytes::Bytes {
    let text = text.as_str().unwrap_or("");
    if encoding.as_str() == Some("base64") { B64.decode(text).unwrap_or_default().into() } else { bytes::Bytes::from(text.to_owned()) }
}

/// Content is already decoded in HAR, so the encoding header would make us decode twice.
fn without_encoding(h: Headers) -> Headers {
    h.into_iter().filter(|(k, _)| !k.eq_ignore_ascii_case("content-encoding")).collect()
}

/// Flows from a HAR document (ids are assigned by the engine on import).
pub fn import(data: &str) -> Result<Vec<Flow>, String> {
    let doc: Value = serde_json::from_str(data).map_err(|e| format!("not a HAR file: {e}"))?;
    let entries = doc["log"]["entries"].as_array().ok_or("not a HAR file: missing log.entries")?;
    Ok(entries
        .iter()
        .filter_map(|e| {
            let req = &e["request"];
            let res = &e["response"];
            let url = req["url"].as_str()?.to_owned();
            let parsed: Option<hudsucker::hyper::Uri> = url.parse().ok();
            let started_ms = e["startedDateTime"].as_str().and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok()).map(|t| (t.unix_timestamp_nanos() / 1_000_000) as u64).unwrap_or(0);
            let req_body = body_from(&req["postData"]["text"], &req["postData"]["encoding"]);
            let status = res["status"].as_u64().filter(|s| *s > 0).map(|s| s as u16);
            let response = status.map(|_| {
                let body = body_from(&res["content"]["text"], &res["content"]["encoding"]);
                Message { headers: without_encoding(headers_from(&res["headers"])), body_size: res["content"]["size"].as_u64().map(|s| s as usize).unwrap_or(body.len()), body }
            });
            let wait = e["timings"]["wait"].as_f64().filter(|w| *w >= 0.0).map(|w| w as u64);
            Some(Flow {
                id: 0,
                client_addr: e["_client"].as_str().unwrap_or("imported").to_owned(),
                client_app: None,
                started_ms,
                ttfb_ms: wait,
                duration_ms: e["time"].as_f64().map(|t| t as u64),
                method: req["method"].as_str().unwrap_or("GET").to_owned(),
                scheme: parsed.as_ref().and_then(|u| u.scheme_str()).unwrap_or("http").to_owned(),
                host: parsed.as_ref().and_then(|u| u.host()).unwrap_or("").to_owned(),
                path: parsed.as_ref().and_then(|u| u.path_and_query()).map(|p| p.to_string()).unwrap_or_else(|| "/".into()),
                url,
                http_version: req["httpVersion"].as_str().unwrap_or("HTTP/1.1").to_owned(),
                request: Message { headers: without_encoding(headers_from(&req["headers"])), body_size: req_body.len(), body: req_body },
                status,
                state: if status.is_some() { FlowState::Complete } else { FlowState::Failed },
                error: res["_error"].as_str().map(str::to_owned),
                response,
                pinned: e["_pinned"].as_bool().unwrap_or(false),
                tags: e["_tags"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(str::to_owned)).collect(),
                ws_messages: e["_webSocketMessages"].as_array().into_iter().flatten().map(|m| {
                    let data = m["data"].as_str().unwrap_or("").to_owned();
                    WsMessage {
                        outgoing: m["type"] == "send",
                        time_ms: (m["time"].as_f64().unwrap_or(0.0) * 1000.0) as u64,
                        kind: match m["opcode"].as_u64() { Some(2) => "binary", Some(8) => "close", Some(9) => "ping", Some(10) => "pong", _ => "text" },
                        size: data.len(),
                        data,
                    }
                }).collect(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_keeps_text_binary_and_metadata() {
        let flow = Flow {
            id: 7,
            client_addr: "127.0.0.1:5000".into(),
            started_ms: 1_792_000_000_123,
            ttfb_ms: Some(40),
            duration_ms: Some(90),
            method: "POST".into(),
            url: "https://api.x.com/v1/items?a=1&b=2".into(),
            scheme: "https".into(),
            host: "api.x.com".into(),
            path: "/v1/items?a=1&b=2".into(),
            http_version: "HTTP/1.1".into(),
            request: Message { headers: vec![("content-type".into(), "application/json".into())], body: "{\"x\":1}".into(), body_size: 7 },
            status: Some(201),
            response: Some(Message { headers: vec![("content-type".into(), "image/png".into())], body: bytes::Bytes::from_static(&[0x89, 0x50, 0, 0xff]), body_size: 4 }),
            state: FlowState::Complete,
            pinned: true,
            tags: vec!["mock".into()],
            ..Default::default()
        };
        let har = export(&[flow]).to_string();
        let back = import(&har).unwrap();
        assert_eq!(back.len(), 1);
        let f = &back[0];
        assert_eq!((f.method.as_str(), f.host.as_str(), f.path.as_str(), f.status), ("POST", "api.x.com", "/v1/items?a=1&b=2", Some(201)));
        assert_eq!(f.started_ms, 1_792_000_000_123);
        assert_eq!((f.ttfb_ms, f.duration_ms), (Some(40), Some(90)));
        assert_eq!(&f.request.body[..], b"{\"x\":1}");
        assert_eq!(&f.response.as_ref().unwrap().body[..], &[0x89, 0x50, 0, 0xff], "binary survives via base64");
        assert!(f.pinned && f.tags == ["mock"]);
    }

    #[test]
    fn rejects_non_har() {
        assert!(import("{}").is_err());
        assert!(import("nope").is_err());
    }
}
