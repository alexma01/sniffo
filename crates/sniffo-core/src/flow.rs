//! Captured request/response pairs.

use bytes::Bytes;
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::Read,
    time::{SystemTime, UNIX_EPOCH},
};

pub type FlowId = u64;
pub type Headers = Vec<(String, String)>;

#[derive(Clone, Debug, Default, Serialize)]
pub struct Message {
    pub headers: Headers,
    #[serde(skip)]
    pub body: Bytes,
    pub body_size: usize,
}

impl Message {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// Body with Content-Encoding (gzip/deflate/br) removed; raw body if unknown or corrupt.
    pub fn decoded_body(&self) -> Bytes {
        let raw = &self.body[..];
        let mut out = Vec::new();
        let ok = match self.header("content-encoding").map(str::trim) {
            Some("gzip" | "x-gzip") => flate2::read::MultiGzDecoder::new(raw).read_to_end(&mut out).is_ok(),
            Some("deflate") => flate2::read::ZlibDecoder::new(raw).read_to_end(&mut out).is_ok()
                || { out.clear(); flate2::read::DeflateDecoder::new(raw).read_to_end(&mut out).is_ok() },
            Some("br") => brotli::Decompressor::new(raw, 4096).read_to_end(&mut out).is_ok(),
            _ => return self.body.clone(),
        };
        if ok { out.into() } else { self.body.clone() }
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowState {
    #[default]
    Pending,
    /// Held at a breakpoint, waiting for the user.
    Paused,
    Complete,
    Failed,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Flow {
    pub id: FlowId,
    pub client_addr: String,
    /// Local app that sent the request (resolved asynchronously; `None` for remote devices).
    pub client_app: Option<String>,
    pub started_ms: u64,
    /// Time until response headers arrived.
    pub ttfb_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub method: String,
    pub url: String,
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub http_version: String,
    pub request: Message,
    pub status: Option<u16>,
    pub response: Option<Message>,
    pub state: FlowState,
    pub error: Option<String>,
    pub pinned: bool,
    /// User highlight: red / orange / yellow / green / blue / purple.
    pub color: Option<String>,
    pub comment: Option<String>,
    /// Names of the rules that acted on this flow.
    pub tags: Vec<String>,
    /// Frames of a WebSocket connection (empty for plain HTTP); the newest MAX_WS_MESSAGES.
    pub ws_messages: VecDeque<WsMessage>,
    /// Older frames dropped from the front of `ws_messages`: frame `i` there is frame
    /// `ws_dropped + i` of the connection.
    pub ws_dropped: usize,
    /// "query GetUser" / "mutation Login" when the request is GraphQL.
    pub graphql: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WsMessage {
    /// Client -> server.
    pub outgoing: bool,
    pub time_ms: u64,
    /// text / binary / ping / pong / close
    pub kind: &'static str,
    pub size: usize,
    /// Text frames as-is; binary frames base64 (truncated to keep memory bounded).
    pub data: String,
    /// Sent by the user from Sniffo rather than by either peer.
    pub injected: bool,
}

/// Lightweight row for the flow list (no bodies, no headers).
#[derive(Clone, Debug, Serialize)]
pub struct FlowSummary {
    pub id: FlowId,
    pub started_ms: u64,
    pub ttfb_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub method: String,
    pub url: String,
    pub scheme: String,
    pub http_version: String,
    pub host: String,
    pub path: String,
    pub client_ip: String,
    pub client_app: Option<String>,
    pub request_type: Option<String>,
    pub status: Option<u16>,
    pub state: FlowState,
    pub content_type: Option<String>,
    pub request_size: usize,
    pub response_size: Option<usize>,
    pub error: Option<String>,
    pub pinned: bool,
    pub color: Option<String>,
    pub comment: Option<String>,
    pub tags: Vec<String>,
    /// Frames seen so far, including dropped ones.
    pub ws_count: usize,
    pub graphql: Option<String>,
}

impl Flow {
    pub fn summary(&self) -> FlowSummary {
        FlowSummary {
            id: self.id,
            started_ms: self.started_ms,
            ttfb_ms: self.ttfb_ms,
            duration_ms: self.duration_ms,
            method: self.method.clone(),
            url: self.url.clone(),
            scheme: self.scheme.clone(),
            http_version: self.http_version.clone(),
            host: self.host.clone(),
            path: self.path.clone(),
            client_ip: self.client_addr.rsplit_once(':').map_or(self.client_addr.as_str(), |(ip, _)| ip).to_owned(),
            client_app: self.client_app.clone(),
            request_type: self.request.header("content-type").map(str::to_owned),
            status: self.status,
            state: self.state.clone(),
            content_type: self.response.as_ref().and_then(|r| r.header("content-type")).map(str::to_owned),
            request_size: self.request.body_size,
            response_size: self.response.as_ref().map(|r| r.body_size),
            error: self.error.clone(),
            pinned: self.pinned,
            color: self.color.clone(),
            comment: self.comment.clone(),
            tags: self.tags.clone(),
            ws_count: self.ws_dropped + self.ws_messages.len(),
            graphql: self.graphql.clone(),
        }
    }

    /// Case-insensitive search across URL, headers and decoded text bodies.
    pub fn contains(&self, needle_lower: &str) -> bool {
        // The UI re-runs body search every 2 s under traffic: an ASCII needle is matched in place,
        // without a lowercase copy of every (up to 32 MB) body.
        let ascii = needle_lower.is_ascii();
        let n = needle_lower.as_bytes();
        let bytes_hit = |b: &[u8]| n.is_empty() || b.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n));
        let hit = |s: &str| if ascii { bytes_hit(s.as_bytes()) } else { s.to_lowercase().contains(needle_lower) };
        let msg_hit = |m: &Message| {
            m.headers.iter().any(|(k, v)| hit(k) || hit(v))
                || if ascii { bytes_hit(&m.decoded_body()) } else { std::str::from_utf8(&m.decoded_body()).is_ok_and(hit) }
        };
        hit(&self.url) || msg_hit(&self.request) || self.response.as_ref().is_some_and(msg_hit)
    }
}

/// Detects a GraphQL request (POST JSON body or GET ?query=) and names its operation.
pub fn graphql_operation(url: &str, request: &Message) -> Option<String> {
    let (query, name) = if request.body.is_empty() {
        let q = url.split_once('?')?.1;
        let param = |k: &str| q.split('&').find_map(|p| p.strip_prefix(k)?.strip_prefix('=')).map(|v| percent_decode(v, true));
        (param("query")?, param("operationName"))
    } else if request.body.len() > 1 << 20 {
        // Runs on every request before forwarding: never parse big uploads.
        return None;
    } else {
        let v: serde_json::Value = serde_json::from_slice(&request.decoded_body()).ok()?;
        // Batched requests are arrays; label by the first operation.
        let op = if v.is_array() { &v[0] } else { &v };
        (op["query"].as_str()?.to_owned(), op["operationName"].as_str().map(str::to_owned))
    };
    let trimmed = query.trim_start();
    let kind = match ["mutation", "subscription", "query"].into_iter().find(|k| trimmed.starts_with(k)) {
        Some(k) => k,
        // Shorthand `{ field }` is an anonymous query.
        None if trimmed.starts_with('{') => "query",
        None => return None,
    };
    // Name from operationName, else from "query Name(...) {".
    let name = name.filter(|n| !n.is_empty()).or_else(|| {
        let rest = trimmed.strip_prefix(kind)?.trim_start();
        let n: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        (!n.is_empty()).then_some(n)
    });
    Some(match name {
        Some(n) => format!("{kind} {n}"),
        None => kind.to_owned(),
    })
}

/// %XX decoding; `plus_as_space` for query strings (form encoding), not for paths.
pub(crate) fn percent_decode(s: &str, plus_as_space: bool) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' if plus_as_space => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn headers_from(map: &hudsucker::hyper::HeaderMap) -> Headers {
    map.iter().map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detects_graphql_operations() {
        let post = |body: &str| Message { headers: vec![], body: body.to_owned().into(), body_size: body.len() };
        assert_eq!(graphql_operation("https://x/graphql", &post(r#"{"query":"query GetUser($id: ID!) { user(id: $id) { name } }","variables":{"id":1}}"#)).as_deref(), Some("query GetUser"));
        assert_eq!(graphql_operation("https://x/graphql", &post(r#"{"query":"mutation { login }","operationName":"Login"}"#)).as_deref(), Some("mutation Login"));
        assert_eq!(graphql_operation("https://x/graphql", &post(r#"[{"query":"{ me { id } }"}]"#)).as_deref(), Some("query"));
        assert_eq!(graphql_operation("https://x/graphql?query=query%20Feed%20%7B%20items%20%7D", &Message::default()).as_deref(), Some("query Feed"));
        assert_eq!(graphql_operation("https://x/api", &post(r#"{"name":"not graphql"}"#)), None);
        assert_eq!(graphql_operation("https://x/api", &post(r#"{"query":"select * from t"}"#)), None);
    }

    #[test]
    fn decodes_gzip_and_brotli() {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(b"hello").unwrap();
        let m = Message { headers: vec![("Content-Encoding".into(), "gzip".into())], body: gz.finish().unwrap().into(), body_size: 0 };
        assert_eq!(&m.decoded_body()[..], b"hello");

        let mut br = Vec::new();
        brotli::CompressorWriter::new(&mut br, 4096, 5, 22).write_all(b"world").unwrap();
        let m = Message { headers: vec![("content-encoding".into(), "br".into())], body: br.into(), body_size: 0 };
        assert_eq!(&m.decoded_body()[..], b"world");

        let m = Message { headers: vec![("content-encoding".into(), "gzip".into())], body: Bytes::from_static(b"not gzip"), body_size: 0 };
        assert_eq!(&m.decoded_body()[..], b"not gzip");
    }

    #[test]
    fn contains_ignores_case() {
        let request = Message { headers: vec![("X-Trace".into(), "AbC".into())], body: Bytes::from_static("{\"name\":\"Ünïcode TOKEN\"}".as_bytes()), body_size: 0 };
        let f = Flow { url: "https://example.com/Path".into(), request, ..Default::default() };
        for q in ["path", "x-trace", "abc", "token", "ünïcode", ""] {
            assert!(f.contains(q), "{q}");
        }
        assert!(!f.contains("missing"));
    }
}
