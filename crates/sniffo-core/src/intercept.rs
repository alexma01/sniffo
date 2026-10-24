//! Browsers and terminals pointed at the proxy without touching the OS proxy settings.

use crate::ca::RootCa;
use base64::Engine as _;
use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, Serialize)]
pub struct Browser {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(skip)]
    path: PathBuf,
}

/// (id, name, macOS app, Windows exe under Program Files / LocalAppData, Linux commands)
const KNOWN: &[(&str, &str, &str, &str, &[&str])] = &[
    ("chrome", "Google Chrome", "Google Chrome", r"Google\Chrome\Application\chrome.exe", &["google-chrome", "google-chrome-stable"]),
    ("edge", "Microsoft Edge", "Microsoft Edge", r"Microsoft\Edge\Application\msedge.exe", &["microsoft-edge", "microsoft-edge-stable"]),
    ("brave", "Brave", "Brave Browser", r"BraveSoftware\Brave-Browser\Application\brave.exe", &["brave-browser", "brave"]),
    ("chromium", "Chromium", "Chromium", r"Chromium\Application\chrome.exe", &["chromium", "chromium-browser"]),
    ("firefox", "Firefox", "Firefox", r"Mozilla Firefox\firefox.exe", &["firefox"]),
];

fn find(mac_app: &str, win_exe: &str, linux: &[&str]) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        // Firefox's binary is lowercase; Chromium browsers are named after the app.
        let bin = if mac_app == "Firefox" { "firefox" } else { mac_app };
        let home = std::env::var("HOME").unwrap_or_default();
        ["/Applications".to_owned(), format!("{home}/Applications")].iter().map(|d| PathBuf::from(format!("{d}/{mac_app}.app/Contents/MacOS/{bin}"))).collect()
    } else if cfg!(windows) {
        ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"].iter().filter_map(|v| std::env::var(v).ok()).map(|d| Path::new(&d).join(win_exe)).collect()
    } else {
        let path = std::env::var_os("PATH").unwrap_or_default();
        std::env::split_paths(&path).flat_map(|d| linux.iter().map(move |c| d.join(c))).collect()
    };
    candidates.into_iter().find(|p| p.is_file())
}

pub fn browsers() -> Vec<Browser> {
    KNOWN.iter().filter_map(|&(id, name, mac, win, linux)| Some(Browser { id, name, path: find(mac, win, linux)? })).collect()
}

/// base64 SHA-256 of the CA's public key, for Chromium's `--ignore-certificate-errors-spki-list`.
pub fn spki_hash(ca: &RootCa) -> Result<String, String> {
    use hudsucker::rcgen::{KeyPair, PublicKeyData};
    let spki = KeyPair::from_pem(&ca.key_pem).map_err(|e| e.to_string())?.subject_public_key_info();
    let digest = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, &spki);
    Ok(base64::engine::general_purpose::STANDARD.encode(digest.as_ref()))
}

/// Starts `id` with its own profile under `profiles` (kept between launches) using the proxy.
pub fn launch(id: &str, port: u16, ca: &RootCa, ca_path: &Path, profiles: &Path) -> Result<(), String> {
    let b = browsers().into_iter().find(|b| b.id == id).ok_or(format!("{id} is not installed"))?;
    let profile = profiles.join(id);
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&b.path);
    if id == "firefox" {
        firefox_profile(&profile, port, ca_path).map_err(|e| e.to_string())?;
        cmd.arg("-profile").arg(&profile).arg("-no-remote");
    } else {
        cmd.arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("--proxy-server=http://127.0.0.1:{port}"))
            // Chromium skips the proxy for localhost unless told otherwise.
            .arg("--proxy-bypass-list=<-loopback>")
            .arg(format!("--ignore-certificate-errors-spki-list={}", spki_hash(ca)?))
            .args(["--no-first-run", "--no-default-browser-check"]);
    }
    let mut child = cmd.spawn().map_err(|e| format!("starting {}: {e}", b.name))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

fn firefox_profile(profile: &Path, port: u16, ca_path: &Path) -> io::Result<()> {
    let prefs = [
        ("network.proxy.type", "1".to_owned()),
        ("network.proxy.http", "\"127.0.0.1\"".into()),
        ("network.proxy.http_port", port.to_string()),
        ("network.proxy.ssl", "\"127.0.0.1\"".into()),
        ("network.proxy.ssl_port", port.to_string()),
        ("network.proxy.no_proxies_on", "\"\"".into()),
        ("network.proxy.allow_hijacking_localhost", "true".into()),
        // Trusts the OS store, where "Trust CA" put the Sniffo CA (macOS, Windows).
        ("security.enterprise_roots.enabled", "true".into()),
        ("browser.shell.checkDefaultBrowser", "false".into()),
        ("browser.aboutwelcome.enabled", "false".into()),
        ("datareporting.policy.dataSubmissionEnabled", "false".into()),
    ];
    fs::write(profile.join("user.js"), prefs.iter().map(|(k, v)| format!("user_pref(\"{k}\", {v});\n")).collect::<String>())?;
    // Linux has no enterprise roots: add the CA to the profile's own NSS db when certutil exists.
    if cfg!(target_os = "linux") {
        let db = format!("sql:{}", profile.display());
        let ca = ca_path.to_string_lossy();
        let _ = Command::new("certutil").args(["-d", &db, "-N", "--empty-password"]).output();
        let _ = Command::new("certutil").args(["-d", &db, "-A", "-t", "C,,", "-n", "Sniffo Root CA", "-i", &ca]).output();
    }
    Ok(())
}

/// System roots plus the Sniffo CA: for tools whose CA setting replaces the trust store, so
/// hosts left undecrypted still verify.
pub fn write_bundle(ca: &RootCa, path: &Path) -> io::Result<()> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut out = String::new();
    for der in crate::proxy::native_roots() {
        let text = b64.encode(der.as_ref());
        out += "-----BEGIN CERTIFICATE-----\n";
        for line in text.as_bytes().chunks(64) {
            out += std::str::from_utf8(line).unwrap_or_default();
            out += "\n";
        }
        out += "-----END CERTIFICATE-----\n";
    }
    out += &ca.cert_pem;
    fs::write(path, out)
}

/// Environment variables that send most CLI tools (curl, Node, Python, git, Go…) through the proxy.
pub fn terminal_env(port: u16, ca_path: &Path, bundle: &Path) -> Vec<(&'static str, String)> {
    let proxy = format!("http://127.0.0.1:{port}");
    let (ca, bundle) = (ca_path.display().to_string(), bundle.display().to_string());
    let mut env: Vec<_> = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].into_iter().map(|k| (k, proxy.clone())).collect();
    env.push(("NODE_EXTRA_CA_CERTS", ca));
    // Node 24+: honour HTTP(S)_PROXY in fetch and http.
    env.push(("NODE_USE_ENV_PROXY", "1".into()));
    env.extend(["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "DENO_CERT"].into_iter().map(|k| (k, bundle.clone())));
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spki_hash_and_firefox_prefs() {
        let ca = RootCa::generate().unwrap();
        let hash = spki_hash(&ca).unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&hash).unwrap().len(), 32);
        let dir = tempfile::tempdir().unwrap();
        firefox_profile(dir.path(), 9191, Path::new("/ca.pem")).unwrap();
        let prefs = fs::read_to_string(dir.path().join("user.js")).unwrap();
        assert!(prefs.contains("user_pref(\"network.proxy.ssl_port\", 9191);"), "{prefs}");
        assert!(prefs.contains("user_pref(\"network.proxy.http\", \"127.0.0.1\");"));
    }

    #[test]
    fn bundle_keeps_system_roots() {
        let ca = RootCa::generate().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bundle.pem");
        write_bundle(&ca, &path).unwrap();
        let pem = fs::read_to_string(&path).unwrap();
        assert!(pem.ends_with(&ca.cert_pem));
        assert_eq!(pem.matches("BEGIN CERTIFICATE").count(), crate::proxy::native_roots().len() + 1);
        let env = terminal_env(9191, Path::new("/ca.pem"), &path);
        assert!(env.contains(&("HTTPS_PROXY", "http://127.0.0.1:9191".into())));
        assert!(env.contains(&("NODE_EXTRA_CA_CERTS", "/ca.pem".into())));
    }
}
