//! Debugging rules: matched against each request in order; unlimited count.

use crate::{flow::Headers, proxy::wildcard};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Matcher {
    /// Matched against the full URL. Wildcard (`*`) unless `regex` is set.
    pub url: String,
    #[serde(default)]
    pub regex: bool,
    /// Empty = any method.
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(skip)]
    compiled: OnceLock<Option<Regex>>,
}

impl Matcher {
    pub fn new(url: &str) -> Self {
        Self { url: url.into(), ..Default::default() }
    }

    pub fn matches(&self, method: &str, url: &str) -> bool {
        if !self.methods.is_empty() && !self.methods.iter().any(|m| m.eq_ignore_ascii_case(method)) {
            return false;
        }
        if self.regex {
            // Invalid patterns never match (UI validates before saving).
            self.compiled.get_or_init(|| Regex::new(&format!("(?i){}", self.url)).ok()).as_ref().is_some_and(|r| r.is_match(url))
        } else {
            wildcard(&self.url, url)
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Answer locally without contacting the server.
    MapLocal {
        status: u16,
        #[serde(default)]
        headers: Headers,
        #[serde(default)]
        body: String,
        /// When set, the body is read from this file at request time.
        #[serde(default)]
        file: Option<String>,
    },
    /// Serve files from a local folder: the URL part after the pattern's `*` is the file path.
    MapLocalDir { dir: String },
    /// Rewrite parts of the destination URL; `None` keeps the original part.
    MapRemote {
        scheme: Option<String>,
        host: Option<String>,
        port: Option<u16>,
        path: Option<String>,
    },
    /// Reply 403 without contacting the server.
    Block,
    /// Pause for manual editing.
    Breakpoint {
        #[serde(default = "yes")]
        request: bool,
        #[serde(default)]
        response: bool,
    },
    /// JavaScript `onRequest` / `onResponse` (see `script` module).
    Script { code: String },
    /// Declarative edits of headers, query, URL, status and body, applied in order.
    Rewrite { items: Vec<Rewrite> },
    /// Simulated network conditions.
    Throttle {
        #[serde(default)]
        latency_ms: u64,
        /// Kilobytes per second, 0 = unlimited.
        #[serde(default)]
        download_kbps: u64,
        #[serde(default)]
        upload_kbps: u64,
    },
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Rewrite {
    /// Applies to the response instead of the request.
    #[serde(default)]
    pub response: bool,
    pub target: RewriteTarget,
    pub op: RewriteOp,
    /// Header or query parameter name.
    #[serde(default)]
    pub name: String,
    /// Regex for `replace` (all matches; `$1` in `value` refers to groups).
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RewriteTarget { Header, Query, Url, Status, Body }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RewriteOp { Set, Remove, Replace }

// Rewrite rules run as generated scripts: same buffering, ordering and error console as Script.
const REWRITE_JS: &str = r##"
const __dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
function __query(url, it, edit) {
  const h = url.indexOf("#"), hash = h < 0 ? "" : url.slice(h);
  if (h >= 0) url = url.slice(0, h);
  const q = url.indexOf("?"), base = q < 0 ? url : url.slice(0, q);
  let ps = q < 0 ? [] : url.slice(q + 1).split("&").filter(Boolean);
  const hit = (p) => __dec(p.split("=")[0]) === it.name;
  if (it.op === "remove") ps = ps.filter((p) => !hit(p));
  else if (it.op === "set") {
    const kv = encodeURIComponent(it.name) + "=" + encodeURIComponent(it.value);
    ps = ps.some(hit) ? ps.map((p) => (hit(p) ? kv : p)) : [...ps, kv];
  } else ps = ps.map((p) => {
    if (!hit(p)) return p;
    const i = p.indexOf("=");
    return (i < 0 ? p + "=" : p.slice(0, i + 1)) + encodeURIComponent(edit(i < 0 ? "" : __dec(p.slice(i + 1))));
  });
  return base + (ps.length ? "?" + ps.join("&") : "") + hash;
}
function __apply(m, res) {
  for (const it of __items) {
    if (it.response !== res) continue;
    const re = it.op === "replace" ? new RegExp(it.pattern, "g") : null;
    const edit = (s) => (re ? String(s).replace(re, it.value) : it.value);
    if (it.target === "header") {
      const k = it.name.toLowerCase();
      if (it.op === "remove") delete m.headers[k];
      else if (it.op === "set") m.headers[k] = it.value;
      else if (k in m.headers) m.headers[k] = Array.isArray(m.headers[k]) ? m.headers[k].map(edit) : edit(m.headers[k]);
    } else if (it.target === "body") {
      if (re && m.body == null) continue; // binary or empty: nothing to search
      const json = m.body !== null && typeof m.body === "object";
      let b = it.op === "remove" ? "" : edit(json ? JSON.stringify(m.body) : m.body);
      if (json) try { b = JSON.parse(b); } catch {}
      m.body = b;
    } else if (it.target === "status") {
      if (res && it.op === "set") m.status = Number(it.value) || m.status;
    } else if (!res && it.target === "url" && it.op !== "remove") m.url = edit(m.url);
    else if (!res && it.target === "query") m.url = __query(m.url, it, edit);
  }
  return m;
}
function onRequest(c, request) { return __apply(request, false); }
function onResponse(c, request, response) { return __apply(response, true); }
"##;

pub fn rewrite_script(items: &[Rewrite]) -> String {
    format!("const __items = {};{REWRITE_JS}", serde_json::to_string(items).unwrap_or_else(|_| "[]".into()))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub matcher: Matcher,
    pub action: Action,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AllowList {
    pub enabled: bool,
    pub patterns: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Rules {
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// When enabled, only matching URLs are recorded (others still pass through).
    #[serde(default)]
    pub allow_list: AllowList,
    /// Strip conditional/caching headers so every request hits the server.
    #[serde(default)]
    pub no_caching: bool,
}

/// What the proxy should do with one request, merged from all matching rules.
#[derive(Debug, Default)]
pub struct Plan {
    pub tags: Vec<String>,
    pub record: bool,
    pub block: bool,
    pub map_local: Option<(u16, Headers, String, Option<String>)>,
    pub map_remote: Vec<(Option<String>, Option<String>, Option<u16>, Option<String>)>,
    pub break_request: bool,
    pub break_response: bool,
    pub latency_ms: u64,
    pub download_bps: Option<u64>,
    pub upload_bps: Option<u64>,
    /// (rule name, code), run in rule order.
    pub scripts: Vec<(String, String)>,
    /// (URL prefix, local folder) for Map Local Directory.
    pub map_dir: Option<(String, String)>,
    pub no_caching: bool,
}

impl Rules {
    pub fn plan(&self, method: &str, url: &str) -> Plan {
        let al = &self.allow_list;
        let mut p = Plan { record: !al.enabled || al.patterns.iter().any(|pat| wildcard(pat, url)), no_caching: self.no_caching, ..Default::default() };
        for r in self.rules.iter().filter(|r| r.enabled && r.matcher.matches(method, url)) {
            p.tags.push(r.name.clone());
            match &r.action {
                Action::Block => p.block = true,
                // First Map Local wins: later ones can't answer the same request twice.
                Action::MapLocal { status, headers, body, file } => {
                    p.map_local.get_or_insert_with(|| (*status, headers.clone(), body.clone(), file.clone()));
                }
                Action::MapLocalDir { dir } => {
                    let prefix = r.matcher.url.split('*').next().unwrap_or("").to_owned();
                    p.map_dir.get_or_insert((prefix, dir.clone()));
                }
                Action::MapRemote { scheme, host, port, path } => p.map_remote.push((scheme.clone(), host.clone(), *port, path.clone())),
                Action::Breakpoint { request, response } => {
                    p.break_request |= request;
                    p.break_response |= response;
                }
                Action::Script { code } => p.scripts.push((r.name.clone(), code.clone())),
                Action::Rewrite { items } => p.scripts.push((r.name.clone(), rewrite_script(items))),
                Action::Throttle { latency_ms, download_kbps, upload_kbps } => {
                    p.latency_ms = p.latency_ms.max(*latency_ms);
                    let bps = |k: u64| (k > 0).then_some(k * 1024);
                    p.download_bps = p.download_bps.or(bps(*download_kbps));
                    p.upload_bps = p.upload_bps.or(bps(*upload_kbps));
                }
            }
        }
        // A rule acting on traffic should always be visible, even outside the allow list.
        p.record |= !p.tags.is_empty();
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, url: &str, action: Action) -> Rule {
        Rule { id: name.into(), name: name.into(), enabled: true, matcher: Matcher::new(url), action }
    }

    #[test]
    fn merges_matching_rules() {
        let rules = Rules {
            rules: vec![
                rule("block ads", "*://ads.*", Action::Block),
                rule("mock", "https://api.x.com/v1/*", Action::MapLocal { status: 200, headers: vec![], body: "{}".into(), file: None }),
                rule("slow", "https://api.x.com/*", Action::Throttle { latency_ms: 300, download_kbps: 50, upload_kbps: 0 }),
                Rule { enabled: false, ..rule("off", "*", Action::Block) },
            ],
            allow_list: AllowList::default(),
            no_caching: false,
        };
        let p = rules.plan("GET", "https://api.x.com/v1/users");
        assert_eq!(p.tags, ["mock", "slow"]);
        assert!(!p.block && p.map_local.is_some() && p.record);
        assert_eq!((p.latency_ms, p.download_bps, p.upload_bps), (300, Some(50 * 1024), None));
        assert!(rules.plan("GET", "http://ads.tracker.com/x").block);
    }

    #[test]
    fn rewrite_edits_request_and_response() {
        use serde_json::json;
        let it = |response, target, op, name: &str, pattern: &str, value: &str| Rewrite { response, target, op, name: name.into(), pattern: pattern.into(), value: value.into() };
        use {RewriteOp::*, RewriteTarget::*};
        let code = rewrite_script(&[
            it(false, Header, Set, "X-Debug", "", "1"),
            it(false, Header, Remove, "cookie", "", ""),
            it(false, Header, Replace, "user-agent", "Chrome/\\d+", "Chrome/1"),
            it(false, Query, Set, "page", "", "2 3"),
            it(false, Query, Remove, "token", "", ""),
            it(false, Url, Replace, "", "api\\.example\\.com", "staging.example.com"),
            it(false, Body, Replace, "", "\"admin\":false", "\"admin\":true"),
            it(true, Status, Set, "", "", "503"),
            it(true, Body, Replace, "", "(\\w+)@example\\.com", "$1@test"),
            it(true, Header, Set, "cache-control", "", "no-store"),
        ]);
        let mut shared = json!({});
        let req = json!({ "method": "POST", "url": "https://api.example.com/u?token=abc&page=1#top",
            "headers": { "cookie": "s=1", "user-agent": "Mozilla Chrome/120" }, "body": { "admin": false } });
        let out = crate::script::run(&code, "onRequest", &json!([{}, req]), &mut shared);
        assert_eq!(out.error, None);
        let v = out.value.unwrap();
        assert_eq!(v["url"], "https://staging.example.com/u?page=2%203#top");
        assert_eq!(v["headers"], json!({ "user-agent": "Mozilla Chrome/1", "x-debug": "1" }));
        assert_eq!(v["body"], json!({ "admin": true }), "JSON bodies stay JSON");

        let res = json!({ "status": 200, "headers": {}, "body": "mail ada@example.com" });
        let v = crate::script::run(&code, "onResponse", &json!([{}, req, res]), &mut shared).value.unwrap();
        assert_eq!((v["status"].clone(), v["body"].clone(), v["headers"]["cache-control"].clone()), (json!(503), json!("mail ada@test"), json!("no-store")));
        let binary = json!({ "status": 200, "headers": {}, "body": null });
        assert!(crate::script::run(&code, "onResponse", &json!([{}, req, binary]), &mut shared).value.unwrap()["body"].is_null(), "binary bodies untouched");
    }

    #[test]
    fn allow_list_and_methods_and_regex() {
        let mut m = Matcher { url: r"^https://api\.x\.com/v\d+/".into(), regex: true, methods: vec!["POST".into()], ..Default::default() };
        assert!(m.matches("post", "https://api.x.com/v2/items"));
        assert!(!m.matches("GET", "https://api.x.com/v2/items"));
        m.url = "(".into();
        m.compiled = OnceLock::new();
        assert!(!m.matches("POST", "("), "invalid regex never matches");

        let rules = Rules { rules: vec![], allow_list: AllowList { enabled: true, patterns: vec!["*api.x.com*".into()] }, no_caching: false };
        assert!(rules.plan("GET", "https://api.x.com/").record);
        assert!(!rules.plan("GET", "https://other.com/").record);
    }
}
