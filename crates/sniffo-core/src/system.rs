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
    // The VPN entry wins over System Settings, so it must go back first (no-op if untouched).
    restore_vpn_proxy();
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

    /// networksetup takes ~0.2 s per call and Macs have many services (VPNs, USB adapters…):
    /// handle each service on its own thread instead of one after the other.
    fn per_service<T: Send>(items: Vec<String>, f: impl Fn(&str) -> io::Result<T> + Sync) -> io::Result<Vec<T>> {
        std::thread::scope(|scope| {
            let handles: Vec<_> = items.iter().map(|s| scope.spawn(|| f(s))).collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(io::Error::other("networksetup thread panicked")))).collect()
        })
    }

    pub fn read() -> io::Result<Snapshot> {
        let entries = per_service(services()?, |s| {
            let web = parse(&run("networksetup", &["-getwebproxy", s])?);
            let secure = parse(&run("networksetup", &["-getsecurewebproxy", s])?);
            Ok((s.to_owned(), web, secure))
        })?;
        Ok(Snapshot { entries })
    }

    pub fn set(host: &str, port: u16) -> io::Result<()> {
        let p = port.to_string();
        per_service(services()?, |s| {
            run("networksetup", &["-setwebproxy", s, host, &p])?;
            run("networksetup", &["-setsecurewebproxy", s, host, &p]).map(drop)
        })
        .map(drop)
    }

    pub fn restore(snap: &Snapshot) -> io::Result<()> {
        let names: Vec<String> = snap.entries.iter().map(|(s, _, _)| s.clone()).collect();
        per_service(names, |s| {
            let (_, web, secure) = snap.entries.iter().find(|(n, _, _)| n == s).expect("service from snapshot");
            for (setting, set, state) in [(web, "-setwebproxy", "-setwebproxystate"), (secure, "-setsecurewebproxy", "-setsecurewebproxystate")] {
                if setting.enabled {
                    run("networksetup", &[set, s, &setting.server, &setting.port.to_string()])?;
                } else {
                    run("networksetup", &[state, s, "off"])?;
                }
            }
            Ok(())
        })
        .map(drop)
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

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LanAddress {
    pub interface: String,
    pub ip: String,
}

/// IPv4 addresses phones on the same network can reach, physical interfaces first.
pub fn lan_addresses() -> Vec<LanAddress> {
    let mut list: Vec<_> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(interface, ip)| match ip {
            std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => {
                Some(LanAddress { interface, ip: v4.to_string() })
            }
            _ => None,
        })
        .collect();
    list.sort_by_key(|a| lan_rank(&a.interface, &a.ip));
    list.dedup();
    list
}

/// Lower is better: Wi-Fi/Ethernet with a private address before VPN/tunnel interfaces.
fn lan_rank(interface: &str, ip: &str) -> u8 {
    let i = interface.to_ascii_lowercase();
    let tunnel = ["utun", "tun", "tap", "tailscale", "wg", "ppp", "ipsec", "vpn", "docker", "br-", "veth", "vmnet", "bridge"].iter().any(|t| i.contains(t));
    let private = ip.starts_with("192.168.") || ip.starts_with("10.") || (ip.starts_with("172.") && ip.split('.').nth(1).and_then(|o| o.parse::<u8>().ok()).is_some_and(|o| (16..32).contains(&o)));
    match (tunnel, private) {
        (false, true) => 0,
        (false, false) => 1,
        (true, _) => 2,
    }
}

#[cfg(test)]
mod lan_tests {
    #[test]
    fn ranks_wifi_before_vpn() {
        assert!(super::lan_rank("en0", "192.168.1.12") < super::lan_rank("utun3", "10.8.0.2"));
        assert!(super::lan_rank("Wi-Fi", "172.20.1.4") < super::lan_rank("Wi-Fi", "100.64.0.1"));
        assert!(super::lan_addresses().iter().all(|a| a.ip != "127.0.0.1"));
    }
}

/// Outcome of pointing a VPN's own proxy entry at Sniffo (macOS).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "state", content = "detail")]
pub enum VpnProxy {
    /// System Settings proxies are in effect; nothing to do.
    NotNeeded,
    /// A VPN overrode them and the helper pointed it back at us.
    Applied,
    /// A VPN overrides the proxy and the one-time helper isn't installed yet.
    HelperMissing,
    Failed(String),
}

// Like Proxyman's Helper Tool: VPN clients (Cato, GlobalProtect…) publish their own proxy
// entry in the dynamic store, which wins over System Settings and needs root to change.
// A root-owned script plus a sudoers rule limited to it is installed once, with the user's
// approval in macOS's own password prompt; it only accepts `set <port>` and `restore`.
#[cfg(target_os = "macos")]
const VPN_HELPER_SCRIPT: &str = include_str!("macos-vpn-helper.sh");
#[cfg(target_os = "macos")]
const VPN_HELPER: &str = "/Library/PrivilegedHelperTools/dev.sniffo.vpn-proxy";
#[cfg(target_os = "macos")]
// sudo's #includedir silently skips file names containing a '.', so no dots here.
const VPN_SUDOERS: &str = "/etc/sudoers.d/sniffo";

/// HTTPS proxy macOS actually uses right now (after VPNs have had their say).
#[cfg(target_os = "macos")]
pub fn effective_proxy() -> Option<(String, u16)> {
    parse_scutil_proxy(&run("scutil", &["--proxy"]).ok()?)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil_proxy(out: &str) -> Option<(String, u16)> {
    let get = |k: &str| out.lines().find_map(|l| l.trim().strip_prefix(k)?.trim().strip_prefix(':').map(|v| v.trim().to_owned()));
    if get("HTTPSEnable")? != "1" {
        return None;
    }
    Some((get("HTTPSProxy")?, get("HTTPSPort")?.parse().ok()?))
}

#[cfg(target_os = "macos")]
pub fn vpn_helper_installed() -> bool {
    Path::new(VPN_HELPER).exists() && Path::new(VPN_SUDOERS).exists()
}

/// One-time install; macOS shows its own administrator prompt (we never see the password).
#[cfg(target_os = "macos")]
pub fn install_vpn_helper() -> io::Result<()> {
    let user = run("id", &["-un"])?.trim().to_owned();
    if user.is_empty() || !user.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(io::Error::other("unexpected user name"));
    }
    let dir = std::env::temp_dir().join(format!("sniffo-helper-{}", std::process::id()));
    fs::create_dir_all(&dir)?;
    let (script, rule) = (dir.join("helper.sh"), dir.join("sudoers"));
    fs::write(&script, VPN_HELPER_SCRIPT)?;
    fs::write(&rule, format!("{user} ALL=(root) NOPASSWD: {VPN_HELPER} set *, {VPN_HELPER} restore\n"))?;
    let cmd = format!(
        "/bin/mkdir -p /Library/PrivilegedHelperTools && /usr/bin/install -o root -g wheel -m 755 '{}' {VPN_HELPER} && /usr/sbin/visudo -cf '{}' && /usr/bin/install -o root -g wheel -m 440 '{}' {VPN_SUDOERS} && /bin/rm -f /etc/sudoers.d/dev.sniffo",
        script.display(),
        rule.display(),
        rule.display()
    );
    let prompt = "Sniffo needs to install a small helper to route traffic through its proxy while a VPN is active. You are asked only once.";
    let result = run("osascript", &["-e", &format!("do shell script \"{cmd}\" with administrator privileges with prompt \"{prompt}\"")]);
    let _ = fs::remove_dir_all(&dir);
    result.map(drop)
}

/// If a VPN hides the system proxy, point its entry at `port` (needs the helper).
#[cfg(target_os = "macos")]
pub fn apply_vpn_proxy(port: u16) -> VpnProxy {
    let ours = || effective_proxy().is_some_and(|(h, p)| h == "127.0.0.1" && p == port);
    if ours() {
        return VpnProxy::NotNeeded;
    }
    if !vpn_helper_installed() {
        return VpnProxy::HelperMissing;
    }
    match run("sudo", &["-n", VPN_HELPER, "set", &port.to_string()]) {
        Ok(_) if ours() => VpnProxy::Applied,
        Ok(_) => VpnProxy::Failed("the VPN keeps overriding the proxy".into()),
        Err(e) => VpnProxy::Failed(e.to_string()),
    }
}

/// Puts the VPN's original proxy entry back (no-op when nothing was changed).
#[cfg(target_os = "macos")]
pub fn restore_vpn_proxy() {
    if vpn_helper_installed() {
        if let Err(e) = run("sudo", &["-n", VPN_HELPER, "restore"]) {
            tracing::error!("restoring VPN proxy entry: {e}");
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apply_vpn_proxy(_port: u16) -> VpnProxy {
    VpnProxy::NotNeeded
}

#[cfg(not(target_os = "macos"))]
pub fn restore_vpn_proxy() {}

#[cfg(not(target_os = "macos"))]
pub fn vpn_helper_installed() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn install_vpn_helper() -> io::Result<()> {
    Err(io::Error::other("only needed on macOS"))
}

#[cfg(test)]
mod vpn_tests {
    #[test]
    fn parses_effective_proxy() {
        let on = "<dictionary> {\n  FTPPassive : 1\n  HTTPSEnable : 1\n  HTTPSPort : 9191\n  HTTPSProxy : 127.0.0.1\n}\n";
        assert_eq!(super::parse_scutil_proxy(on), Some(("127.0.0.1".into(), 9191)));
        assert_eq!(super::parse_scutil_proxy("<dictionary> {\n  FTPPassive : 1\n}\n"), None);
    }
}
