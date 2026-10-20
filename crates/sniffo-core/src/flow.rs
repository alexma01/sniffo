//! Captured request/response pairs.

use bytes::Bytes;
use serde::Serialize;
use std::{
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
    /// Names of the rules that acted on this flow.
    pub tags: Vec<String>,
}

/// Lightweight row for the flow list (no bodies, no headers).
#[derive(Clone, Debug, Serialize)]
pub struct FlowSummary {
    pub id: FlowId,
    pub started_ms: u64,
    pub duration_ms: Option<u64>,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub status: Option<u16>,
    pub state: FlowState,
    pub content_type: Option<String>,
    pub request_size: usize,
    pub response_size: Option<usize>,
    pub error: Option<String>,
    pub pinned: bool,
    pub tags: Vec<String>,
}

impl Flow {
    pub fn summary(&self) -> FlowSummary {
        FlowSummary {
            id: self.id,
            started_ms: self.started_ms,
            duration_ms: self.duration_ms,
            method: self.method.clone(),
            url: self.url.clone(),
            host: self.host.clone(),
            path: self.path.clone(),
            status: self.status,
            state: self.state.clone(),
            content_type: self.response.as_ref().and_then(|r| r.header("content-type")).map(str::to_owned),
            request_size: self.request.body_size,
            response_size: self.response.as_ref().map(|r| r.body_size),
            error: self.error.clone(),
            pinned: self.pinned,
            tags: self.tags.clone(),
        }
    }

    /// Case-insensitive search across URL, headers and decoded text bodies.
    pub fn contains(&self, needle_lower: &str) -> bool {
        let hit = |s: &str| s.to_lowercase().contains(needle_lower);
        let msg_hit = |m: &Message| {
            m.headers.iter().any(|(k, v)| hit(k) || hit(v))
                || std::str::from_utf8(&m.decoded_body()).is_ok_and(hit)
        };
        hit(&self.url) || msg_hit(&self.request) || self.response.as_ref().is_some_and(msg_hit)
    }
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
}
