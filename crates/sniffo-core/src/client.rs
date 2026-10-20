//! Maps local client connections to the app that opened them (Chrome, curl, Simulator…).

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Ports get reused by other apps; forget mappings after this long.
const TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct ClientApps {
    cache: Mutex<HashMap<u16, (String, Instant)>>,
    /// Serializes lsof runs: one run resolves every connection open at that moment.
    scan: tokio::sync::Mutex<()>,
}

impl ClientApps {
    fn cached(&self, port: u16) -> Option<String> {
        self.cache.lock().unwrap().get(&port).filter(|(_, t)| t.elapsed() < TTL).map(|(n, _)| n.clone())
    }

    /// App name for the local process connected from `client_port` to our `proxy_port`.
    pub async fn resolve(&self, proxy_port: u16, client_port: u16) -> Option<String> {
        if let Some(n) = self.cached(client_port) {
            return Some(n);
        }
        let _guard = self.scan.lock().await;
        if let Some(n) = self.cached(client_port) {
            return Some(n);
        }
        let found = tokio::task::spawn_blocking(move || scan(proxy_port)).await.ok()?;
        let now = Instant::now();
        let mut cache = self.cache.lock().unwrap();
        cache.retain(|_, (_, t)| t.elapsed() < TTL);
        cache.extend(found.into_iter().map(|(p, n)| (p, (n, now))));
        cache.get(&client_port).map(|(n, _)| n.clone())
    }
}

#[cfg(unix)]
fn scan(proxy_port: u16) -> Vec<(u16, String)> {
    let Ok(out) = std::process::Command::new("lsof")
        .args(["-nP", "+c", "0", &format!("-iTCP:{proxy_port}"), "-sTCP:ESTABLISHED", "-F", "pcn"])
        .output()
    else {
        return vec![];
    };
    parse_lsof(&String::from_utf8_lossy(&out.stdout), proxy_port, std::process::id())
}

#[cfg(not(unix))]
fn scan(_proxy_port: u16) -> Vec<(u16, String)> {
    // ponytail: no Windows lookup yet; `GetExtendedTcpTable` + process name would fill this in.
    vec![]
}

/// Parses `lsof -F pcn` output into (client port, app name), skipping our own process.
fn parse_lsof(out: &str, proxy_port: u16, own_pid: u32) -> Vec<(u16, String)> {
    let mut result = vec![];
    let (mut pid, mut name) = (0u32, String::new());
    let suffix = format!("->127.0.0.1:{proxy_port}");
    for line in out.lines() {
        let (tag, val) = line.split_at(line.len().min(1));
        match tag {
            "p" => pid = val.parse().unwrap_or(0),
            "c" => name = app_name(val),
            "n" if pid != own_pid => {
                // n127.0.0.1:49441->127.0.0.1:9191  (client side of the connection)
                if let Some(local) = val.strip_suffix(&suffix) {
                    if let Some(port) = local.rsplit(':').next().and_then(|p| p.parse().ok()) {
                        result.push((port, name.clone()));
                    }
                }
            }
            _ => {}
        }
    }
    result
}

/// "Google Chrome Helper (Renderer)" -> "Google Chrome": helpers belong to their app.
fn app_name(process: &str) -> String {
    if process == "adb" {
        // Traffic tunnelled with `adb reverse` from an emulator or USB phone.
        return "Android (adb)".into();
    }
    process.split(" Helper").next().unwrap_or(process).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_and_skips_self() {
        let out = "p91278\ncsniffo\nf17\nn127.0.0.1:9191->127.0.0.1:49441\np92365\nccurl\nf5\nn127.0.0.1:49441->127.0.0.1:9191\np7\ncGoogle Chrome Helper (Renderer)\nf9\nn127.0.0.1:50000->127.0.0.1:9191\n";
        assert_eq!(parse_lsof(out, 9191, 91278), vec![(49441, "curl".into()), (50000, "Google Chrome".into())]);
    }
}
