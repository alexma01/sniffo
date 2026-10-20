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
}

impl Rules {
    pub fn plan(&self, method: &str, url: &str) -> Plan {
        let al = &self.allow_list;
        let mut p = Plan { record: !al.enabled || al.patterns.iter().any(|pat| wildcard(pat, url)), ..Default::default() };
        for r in self.rules.iter().filter(|r| r.enabled && r.matcher.matches(method, url)) {
            p.tags.push(r.name.clone());
            match &r.action {
                Action::Block => p.block = true,
                // First Map Local wins: later ones can't answer the same request twice.
                Action::MapLocal { status, headers, body, file } => {
                    p.map_local.get_or_insert_with(|| (*status, headers.clone(), body.clone(), file.clone()));
                }
                Action::MapRemote { scheme, host, port, path } => p.map_remote.push((scheme.clone(), host.clone(), *port, path.clone())),
                Action::Breakpoint { request, response } => {
                    p.break_request |= request;
                    p.break_response |= response;
                }
                Action::Script { code } => p.scripts.push((r.name.clone(), code.clone())),
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
        };
        let p = rules.plan("GET", "https://api.x.com/v1/users");
        assert_eq!(p.tags, ["mock", "slow"]);
        assert!(!p.block && p.map_local.is_some() && p.record);
        assert_eq!((p.latency_ms, p.download_bps, p.upload_bps), (300, Some(50 * 1024), None));
        assert!(rules.plan("GET", "http://ads.tracker.com/x").block);
    }

    #[test]
    fn allow_list_and_methods_and_regex() {
        let mut m = Matcher { url: r"^https://api\.x\.com/v\d+/".into(), regex: true, methods: vec!["POST".into()], ..Default::default() };
        assert!(m.matches("post", "https://api.x.com/v2/items"));
        assert!(!m.matches("GET", "https://api.x.com/v2/items"));
        m.url = "(".into();
        m.compiled = OnceLock::new();
        assert!(!m.matches("POST", "("), "invalid regex never matches");

        let rules = Rules { rules: vec![], allow_list: AllowList { enabled: true, patterns: vec!["*api.x.com*".into()] } };
        assert!(rules.plan("GET", "https://api.x.com/").record);
        assert!(!rules.plan("GET", "https://other.com/").record);
    }
}
