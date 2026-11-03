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
    /// App name -> its .app bundle (macOS), for icons.
    bundles: Mutex<HashMap<String, std::path::PathBuf>>,
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
        let known: Vec<String> = self.bundles.lock().unwrap().keys().cloned().collect();
        let (found, bundles) = tokio::task::spawn_blocking(move || {
            let found = scan(proxy_port);
            // Bundle lookups only for apps not seen before (one `ps` per new app).
            let mut bundles = vec![];
            for (_, name, pid) in &found {
                if !known.contains(name) && !bundles.iter().any(|(n, _)| n == name) {
                    if let Some(b) = bundle_of(*pid) {
                        bundles.push((name.clone(), b));
                    }
                }
            }
            (found, bundles)
        })
        .await
        .ok()?;
        self.bundles.lock().unwrap().extend(bundles);
        let now = Instant::now();
        let mut cache = self.cache.lock().unwrap();
        cache.retain(|_, (_, t)| t.elapsed() < TTL);
        cache.extend(found.into_iter().map(|(p, n, _)| (p, (n, now))));
        cache.get(&client_port).map(|(n, _)| n.clone())
    }

    /// The .app bundle of a client app seen in traffic (macOS only), e.g. for its icon.
    pub fn bundle(&self, name: &str) -> Option<std::path::PathBuf> {
        self.bundles.lock().unwrap().get(name).cloned()
    }
}

/// Outermost `.app` containing the process' executable: helpers resolve to their app.
#[cfg(target_os = "macos")]
fn bundle_of(pid: u32) -> Option<std::path::PathBuf> {
    let exe = output("ps", &["-o", "comm=", "-p", &pid.to_string()])?;
    outer_app(exe.trim())
}

#[cfg(not(target_os = "macos"))]
fn bundle_of(_pid: u32) -> Option<std::path::PathBuf> {
    None
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn outer_app(exe: &str) -> Option<std::path::PathBuf> {
    let end = exe.find(".app/")? + 4;
    Some(std::path::PathBuf::from(&exe[..end]))
}

fn output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// (client port, app name, pid) for every connection to our port.
#[cfg(unix)]
fn scan(proxy_port: u16) -> Vec<(u16, String, u32)> {
    let own = std::process::id();
    if let Some(out) = output("lsof", &["-nP", "+c", "0", &format!("-iTCP:{proxy_port}"), "-sTCP:ESTABLISHED", "-F", "pcn"]) {
        return parse_lsof(&out, proxy_port, own);
    }
    // Many Linux distros ship `ss` but not `lsof`.
    output("ss", &["-tnpH", "state", "established", &format!("dport = :{proxy_port}")]).map(|o| parse_ss(&o, own)).unwrap_or_default()
}

#[cfg(windows)]
fn scan(proxy_port: u16) -> Vec<(u16, String, u32)> {
    let Some(netstat) = output("netstat", &["-ano", "-p", "TCP"]) else { return vec![] };
    let conns = parse_netstat(&netstat, proxy_port, std::process::id());
    if conns.is_empty() {
        return vec![];
    }
    let names = output("tasklist", &["/FO", "CSV", "/NH"]).map(|t| parse_tasklist(&t)).unwrap_or_default();
    conns.into_iter().filter_map(|(port, pid)| names.get(&pid).map(|n| (port, app_name(n), pid))).collect()
}

#[cfg(not(any(unix, windows)))]
fn scan(_proxy_port: u16) -> Vec<(u16, String, u32)> {
    vec![]
}

/// `ss -tnpH` lines: `0 0 127.0.0.1:49441 127.0.0.1:9191 users:(("curl",pid=123,fd=5))`
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_ss(out: &str, own_pid: u32) -> Vec<(u16, String, u32)> {
    out.lines()
        .filter_map(|l| {
            let cols: Vec<&str> = l.split_whitespace().collect();
            let local = cols.iter().find(|c| c.contains(':') && !c.starts_with("users"))?;
            let port = local.rsplit(':').next()?.parse().ok()?;
            let users = l.split("users:((").nth(1)?;
            let name = users.split('"').nth(1)?;
            let pid: u32 = users.split("pid=").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
            (pid != own_pid).then(|| (port, app_name(name), pid))
        })
        .collect()
}

/// `netstat -ano` rows connected to our port: (client port, pid).
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_netstat(out: &str, proxy_port: u16, own_pid: u32) -> Vec<(u16, u32)> {
    let target = format!(":{proxy_port}");
    out.lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split_whitespace().collect();
            if c.len() < 5 || c[0] != "TCP" || !c[2].ends_with(&target) || c[3] != "ESTABLISHED" {
                return None;
            }
            let port = c[1].rsplit(':').next()?.parse().ok()?;
            let pid: u32 = c[4].parse().ok()?;
            (pid != own_pid).then_some((port, pid))
        })
        .collect()
}

/// `tasklist /FO CSV /NH`: "chrome.exe","1234",... -> pid -> "chrome"
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_tasklist(out: &str) -> std::collections::HashMap<u32, String> {
    out.lines()
        .filter_map(|l| {
            let mut f = l.split("\",\"");
            let image = f.next()?.trim_start_matches('"');
            let pid = f.next()?.parse().ok()?;
            Some((pid, image.strip_suffix(".exe").or_else(|| image.strip_suffix(".EXE")).unwrap_or(image).to_owned()))
        })
        .collect()
}

/// Parses `lsof -F pcn` output into (client port, app name), skipping our own process.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_lsof(out: &str, proxy_port: u16, own_pid: u32) -> Vec<(u16, String, u32)> {
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
                        result.push((port, name.clone(), pid));
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
    fn parses_ss() {
        let out = "0      0      127.0.0.1:49441     127.0.0.1:9191 users:((\"curl\",pid=123,fd=5))\n0 0 127.0.0.1:50000 127.0.0.1:9191 users:((\"sniffo\",pid=9,fd=7))\n";
        assert_eq!(parse_ss(out, 9), vec![(49441, "curl".into(), 123)]);
    }

    #[test]
    fn parses_netstat_and_tasklist() {
        let netstat = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:49441        127.0.0.1:9191         ESTABLISHED     4321\r\n  TCP    127.0.0.1:9191         127.0.0.1:49441        ESTABLISHED     999\r\n  TCP    127.0.0.1:49500        127.0.0.1:9191         TIME_WAIT       0\r\n";
        assert_eq!(parse_netstat(netstat, 9191, 999), vec![(49441, 4321)]);
        let tasks = "\"chrome.exe\",\"4321\",\"Console\",\"1\",\"120,000 K\"\r\n\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\r\n";
        let names = parse_tasklist(tasks);
        assert_eq!(names[&4321], "chrome");
        assert_eq!(names[&0], "System Idle Process");
    }

    #[test]
    fn parses_lsof_and_skips_self() {
        let out = "p91278\ncsniffo\nf17\nn127.0.0.1:9191->127.0.0.1:49441\np92365\nccurl\nf5\nn127.0.0.1:49441->127.0.0.1:9191\np7\ncGoogle Chrome Helper (Renderer)\nf9\nn127.0.0.1:50000->127.0.0.1:9191\n";
        assert_eq!(parse_lsof(out, 9191, 91278), vec![(49441, "curl".into(), 92365), (50000, "Google Chrome".into(), 7)]);
        assert_eq!(
            outer_app("/Applications/Brave Browser.app/Contents/Frameworks/B.framework/Helpers/Brave Browser Helper (Renderer).app/Contents/MacOS/x"),
            Some("/Applications/Brave Browser.app".into())
        );
        assert_eq!(outer_app("/usr/bin/curl"), None);
    }
}
