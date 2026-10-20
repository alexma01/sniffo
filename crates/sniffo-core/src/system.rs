//! OS integration: system proxy on/off (with snapshot + crash recovery) and CA trust install.
//!
//! Every change to the system proxy first saves the previous settings to `snapshot_path`;
//! `disable` restores them and deletes the file. If the app dies with the proxy on, the next
//! start finds the file and calls `disable_system_proxy`.

use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path, process::Command};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ProxySetting {
    pub enabled: bool,
    pub server: String,
    pub port: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    /// Per network interface/service (macOS service name, "user" on Windows/Linux).
    pub entries: Vec<(String, ProxySetting, ProxySetting)>,
}

fn run(cmd: &str, args: &[&str]) -> io::Result<String> {
    let out = Command::new(cmd).args(args).output()?;
    if !out.status.success() {
        return Err(io::Error::other(format!(
            "{cmd} {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn enable_system_proxy(host: &str, port: u16, snapshot_path: &Path) -> io::Result<()> {
    // Keep the oldest snapshot: re-enabling must not overwrite the user's original settings.
    if !snapshot_path.exists() {
        let snap = imp::read()?;
        fs::write(snapshot_path, serde_json::to_vec(&snap)?)?;
    }
    imp::set(host, port)
}

pub fn disable_system_proxy(snapshot_path: &Path) -> io::Result<()> {
    let Ok(data) = fs::read(snapshot_path) else { return Ok(()) };
    let snap: Snapshot = serde_json::from_slice(&data)?;
    imp::restore(&snap)?;
    fs::remove_file(snapshot_path)
}

/// True while we own the system proxy; at startup it means a previous run crashed with it on.
pub fn system_proxy_enabled(snapshot_path: &Path) -> bool {
    snapshot_path.exists()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    pub fn services() -> io::Result<Vec<String>> {
        Ok(run("networksetup", &["-listallnetworkservices"])?
            .lines()
            .skip(1) // "An asterisk (*) denotes ..."
            .filter(|l| !l.starts_with('*') && !l.is_empty())
            .map(str::to_owned)
            .collect())
    }

    pub fn parse(out: &str) -> ProxySetting {
        let get = |k: &str| out.lines().find_map(|l| l.strip_prefix(k)).map(str::trim).unwrap_or("");
        ProxySetting { enabled: get("Enabled:") == "Yes", server: get("Server:").into(), port: get("Port:").parse().unwrap_or(0) }
    }

    pub fn read() -> io::Result<Snapshot> {
        let mut entries = vec![];
        for s in services()? {
            let web = parse(&run("networksetup", &["-getwebproxy", &s])?);
            let secure = parse(&run("networksetup", &["-getsecurewebproxy", &s])?);
            entries.push((s, web, secure));
        }
        Ok(Snapshot { entries })
    }

    pub fn set(host: &str, port: u16) -> io::Result<()> {
        let p = port.to_string();
        for s in services()? {
            run("networksetup", &["-setwebproxy", &s, host, &p])?;
            run("networksetup", &["-setsecurewebproxy", &s, host, &p])?;
        }
        Ok(())
    }

    pub fn restore(snap: &Snapshot) -> io::Result<()> {
        for (s, web, secure) in &snap.entries {
            for (setting, set, state) in [(web, "-setwebproxy", "-setwebproxystate"), (secure, "-setsecurewebproxy", "-setsecurewebproxystate")] {
                if setting.enabled {
                    run("networksetup", &[set, s, &setting.server, &setting.port.to_string()])?;
                } else {
                    run("networksetup", &[state, s, "off"])?;
                }
            }
        }
        Ok(())
    }

    pub fn trust_ca(cert_path: &Path) -> io::Result<()> {
        // User-domain trust: macOS shows its own password/Touch ID prompt; we never see credentials.
        let keychain = format!("{}/Library/Keychains/login.keychain-db", std::env::var("HOME").unwrap_or_default());
        run("security", &["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", &keychain, &cert_path.to_string_lossy()]).map(drop)
    }

    pub fn ca_trusted(cert_path: &Path) -> bool {
        run("security", &["verify-cert", "-c", &cert_path.to_string_lossy(), "-p", "ssl"]).is_ok()
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn parses_networksetup_output() {
            let s = super::parse("Enabled: Yes\nServer: 127.0.0.1\nPort: 9090\nAuthenticated Proxy Enabled: 0\n");
            assert_eq!(s, super::ProxySetting { enabled: true, server: "127.0.0.1".into(), port: 9090 });
            assert!(!super::parse("Enabled: No\nServer: \nPort: 0\n").enabled);
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    fn query(name: &str) -> Option<String> {
        let out = run("reg", &["query", KEY, "/v", name]).ok()?;
        out.lines().find(|l| l.trim_start().starts_with(name))?.split_whitespace().nth(2).map(str::to_owned)
    }

    fn split(server: &str) -> (String, u16) {
        // ProxyServer is "host:port" or "http=host:port;https=host:port"; keep the first entry.
        let first = server.split(';').next().unwrap_or("");
        let first = first.split_once('=').map(|(_, v)| v).unwrap_or(first);
        let (h, p) = first.rsplit_once(':').unwrap_or((first, "0"));
        (h.to_owned(), p.parse().unwrap_or(0))
    }

    pub fn read() -> io::Result<Snapshot> {
        let enabled = query("ProxyEnable").is_some_and(|v| v == "0x1");
        let (server, port) = split(&query("ProxyServer").unwrap_or_default());
        let s = ProxySetting { enabled, server, port };
        Ok(Snapshot { entries: vec![("user".into(), s.clone(), s)] })
    }

    fn write(enabled: bool, server: &str) -> io::Result<()> {
        run("reg", &["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", if enabled { "1" } else { "0" }, "/f"])?;
        if !server.is_empty() {
            run("reg", &["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", server, "/f"])?;
        }
        refresh();
        Ok(())
    }

    /// Tell WinINet apps (Edge, Chrome) the settings changed.
    fn refresh() {
        #[link(name = "wininet")]
        unsafe extern "system" {
            fn InternetSetOptionW(h: *mut core::ffi::c_void, opt: u32, buf: *mut core::ffi::c_void, len: u32) -> i32;
        }
        const SETTINGS_CHANGED: u32 = 39;
        const REFRESH: u32 = 37;
        unsafe {
            InternetSetOptionW(core::ptr::null_mut(), SETTINGS_CHANGED, core::ptr::null_mut(), 0);
            InternetSetOptionW(core::ptr::null_mut(), REFRESH, core::ptr::null_mut(), 0);
        }
    }

    pub fn set(host: &str, port: u16) -> io::Result<()> {
        write(true, &format!("{host}:{port}"))
    }

    pub fn restore(snap: &Snapshot) -> io::Result<()> {
        let s = &snap.entries[0].1;
        write(s.enabled, &if s.server.is_empty() { String::new() } else { format!("{}:{}", s.server, s.port) })
    }

    pub fn trust_ca(cert_path: &Path) -> io::Result<()> {
        // Current-user Root store: Windows shows its own confirmation dialog.
        run("certutil", &["-user", "-addstore", "Root", &cert_path.to_string_lossy()]).map(drop)
    }

    pub fn ca_trusted(_cert_path: &Path) -> bool {
        run("certutil", &["-user", "-store", "Root", "Sniffo Root CA"]).is_ok()
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;

    fn get(schema: &str, key: &str) -> String {
        run("gsettings", &["get", schema, key]).unwrap_or_default().trim().trim_matches('\'').to_owned()
    }

    fn setting(kind: &str, manual: bool) -> ProxySetting {
        let schema = format!("org.gnome.system.proxy.{kind}");
        ProxySetting { enabled: manual, server: get(&schema, "host"), port: get(&schema, "port").parse().unwrap_or(0) }
    }

    pub fn read() -> io::Result<Snapshot> {
        let mode = get("org.gnome.system.proxy", "mode");
        let manual = mode == "manual";
        Ok(Snapshot { entries: vec![(mode, setting("http", manual), setting("https", manual))] })
    }

    pub fn set(host: &str, port: u16) -> io::Result<()> {
        for kind in ["http", "https"] {
            let schema = format!("org.gnome.system.proxy.{kind}");
            run("gsettings", &["set", &schema, "host", host])?;
            run("gsettings", &["set", &schema, "port", &port.to_string()])?;
        }
        run("gsettings", &["set", "org.gnome.system.proxy", "mode", "manual"]).map(drop)
    }

    pub fn restore(snap: &Snapshot) -> io::Result<()> {
        let (mode, http, https) = &snap.entries[0];
        for (kind, s) in [("http", http), ("https", https)] {
            let schema = format!("org.gnome.system.proxy.{kind}");
            run("gsettings", &["set", &schema, "host", &s.server])?;
            run("gsettings", &["set", &schema, "port", &s.port.to_string()])?;
        }
        run("gsettings", &["set", "org.gnome.system.proxy", "mode", if mode.is_empty() { "none" } else { mode }]).map(drop)
    }

    pub fn trust_ca(cert_path: &Path) -> io::Result<()> {
        let src = cert_path.to_string_lossy().replace('\'', "'\\''");
        // System store needs root: pkexec shows the desktop's own auth dialog.
        let script = if Path::new("/usr/sbin/update-ca-certificates").exists() || Path::new("/usr/bin/update-ca-certificates").exists() {
            format!("cp '{src}' /usr/local/share/ca-certificates/sniffo-ca.crt && update-ca-certificates")
        } else {
            format!("trust anchor --store '{src}'")
        };
        run("pkexec", &["sh", "-c", &script])?;
        // Chrome/Chromium use the per-user NSS db; best effort when certutil (libnss3-tools) exists.
        if let Ok(home) = std::env::var("HOME") {
            let db = format!("sql:{home}/.pki/nssdb");
            let _ = run("certutil", &["-d", &db, "-A", "-t", "C,,", "-n", "Sniffo Root CA", "-i", &src]);
        }
        Ok(())
    }

    pub fn ca_trusted(cert_path: &Path) -> bool {
        run("openssl", &["verify", &cert_path.to_string_lossy()]).is_ok()
    }
}

pub fn trust_ca(cert_path: &Path) -> io::Result<()> {
    imp::trust_ca(cert_path)
}

pub fn ca_trusted(cert_path: &Path) -> bool {
    imp::ca_trusted(cert_path)
}
