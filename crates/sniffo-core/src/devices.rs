//! Simulators, emulators and USB devices: discovery and one-click setup commands.
//!
//! iOS Simulator uses the Mac's network settings, so it only needs the CA in its keychain.
//! Android goes through `adb reverse`, which works for emulators and USB phones alike
//! without being on the same Wi-Fi. Physical iPhones cannot be driven remotely: they are
//! listed so the UI can show the manual (QR) setup.

use crate::error::{Error, Message};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command as Cmd,
};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    IosSimulator,
    IosDevice,
    Android,
    /// An Android Virtual Device that is not running yet.
    AndroidAvd,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: Platform,
    /// Booted / Shutdown / device / offline / unauthorized / available.
    pub state: String,
    pub os: String,
    pub emulator: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Command {
    InstallCa,
    /// Android emulator only: trust the CA system-wide (needs a non-Play image).
    InstallSystemCa,
    SetProxy,
    ClearProxy,
    Restart,
    Boot,
    Shutdown,
    OpenUrl(String),
}

pub struct Context<'a> {
    pub ca_pem: &'a Path,
    pub proxy_port: u16,
}

fn run(program: &Path, args: &[&str]) -> Result<String, String> {
    let out = Cmd::new(program).args(args).output().map_err(|e| format!("{}: {e}", program.display()))?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() { Ok(text) } else { Err(text.trim().to_owned()) }
}

/// adb from PATH or the usual SDK locations.
pub fn adb_path() -> Option<PathBuf> {
    sdk_tool("platform-tools", "adb")
}

fn sdk_tool(dir: &str, name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() };
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"].iter().filter_map(|v| std::env::var_os(v)).map(PathBuf::from).collect();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(Path::new(&home).join("Library/Android/sdk"));
        roots.push(Path::new(&home).join("Android/Sdk"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(Path::new(&local).join("Android/Sdk"));
    }
    let found = roots.into_iter().map(|r| r.join(dir).join(&exe)).find(|p| p.exists());
    found.or_else(|| {
        std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|p| p.join(&exe)).find(|p| p.exists()))
    })
}

/// From PATH (normally /usr/bin), so tests can substitute it.
fn xcrun() -> &'static Path {
    Path::new("xcrun")
}

pub fn list() -> Vec<Device> {
    let mut devices = vec![];
    if cfg!(target_os = "macos") {
        if let Ok(json) = run(xcrun(), &["simctl", "list", "devices", "available", "-j"]) {
            devices.extend(parse_simctl(&json));
        }
        devices.extend(list_ios_devices());
    }
    if let Some(adb) = adb_path() {
        let running = run(&adb, &["devices", "-l"]).map(|o| parse_adb(&o)).unwrap_or_default();
        let running_avds: Vec<String> = running
            .iter()
            .filter(|d| d.emulator)
            .filter_map(|d| run(&adb, &["-s", &d.id, "emu", "avd", "name"]).ok()?.lines().next().map(|s| s.trim().to_owned()))
            .collect();
        devices.extend(running.into_iter().map(|mut d| {
            if d.state == "device" {
                d.os = run(&adb, &["-s", &d.id, "shell", "getprop", "ro.build.version.release"]).map(|v| format!("Android {}", v.trim())).unwrap_or_default();
            }
            d
        }));
        if let Some(emulator) = sdk_tool("emulator", "emulator") {
            if let Ok(out) = run(&emulator, &["-list-avds"]) {
                devices.extend(out.lines().map(str::trim).filter(|n| !n.is_empty() && !n.starts_with("INFO") && !running_avds.iter().any(|r| r == n)).map(|n| Device {
                    id: n.to_owned(),
                    name: n.replace('_', " "),
                    platform: Platform::AndroidAvd,
                    state: "Shutdown".into(),
                    os: "Android emulator".into(),
                    emulator: true,
                }));
            }
        }
    }
    devices
}

fn parse_simctl(json: &str) -> Vec<Device> {
    #[derive(Deserialize)]
    struct Sim {
        udid: String,
        name: String,
        state: String,
    }
    #[derive(Deserialize)]
    struct List {
        devices: std::collections::BTreeMap<String, Vec<Sim>>,
    }
    let Ok(list) = serde_json::from_str::<List>(json) else { return vec![] };
    let mut out: Vec<Device> = list
        .devices
        .into_iter()
        .flat_map(|(runtime, sims)| {
            // com.apple.CoreSimulator.SimRuntime.iOS-27-0 -> iOS 27.0
            let os = runtime.rsplit('.').next().unwrap_or("").replacen('-', " ", 1).replace('-', ".");
            sims.into_iter().map(move |s| Device { id: s.udid, name: s.name, platform: Platform::IosSimulator, state: s.state, os: os.clone(), emulator: true })
        })
        .collect();
    // Booted first: those are the ones people want to act on.
    out.sort_by_key(|d| d.state != "Booted");
    out
}

fn list_ios_devices() -> Vec<Device> {
    let path = std::env::temp_dir().join(format!("sniffo-devicectl-{}.json", std::process::id()));
    let ok = run(xcrun(), &["devicectl", "list", "devices", "--quiet", "--json-output", &path.to_string_lossy()]).is_ok();
    let json = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    if ok { parse_devicectl(&json) } else { vec![] }
}

fn parse_devicectl(json: &str) -> Vec<Device> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let s = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_owned();
    v["result"]["devices"]
        .as_array()
        .into_iter()
        .flatten()
        // devicectl also lists booted simulators ("simulated"); simctl already covers those.
        .filter(|d| d["hardwareProperties"]["reality"] == "physical")
        .map(|d| Device {
            id: s(&d["identifier"]),
            name: s(&d["deviceProperties"]["name"]),
            platform: Platform::IosDevice,
            // tunnelState stays "disconnected" until Xcode opens a debug tunnel; the transport
            // says whether the phone is actually plugged in (wired) or reachable (localNetwork).
            state: match d["connectionProperties"]["transportType"].as_str() {
                Some("wired") => "connected (USB)".into(),
                Some("localNetwork") => "connected (Wi-Fi)".into(),
                _ => "offline".into(),
            },
            os: format!("{} {}", s(&d["hardwareProperties"]["platform"]), s(&d["deviceProperties"]["osVersionNumber"])),
            emulator: false,
        })
        .collect()
}

fn parse_adb(out: &str) -> Vec<Device> {
    out.lines()
        .skip(1) // "List of devices attached"
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let (id, state) = (parts.next()?, parts.next()?);
            let model = parts.find_map(|p| p.strip_prefix("model:")).map(|m| m.replace('_', " "));
            let emulator = id.starts_with("emulator-");
            Some(Device {
                id: id.to_owned(),
                name: model.unwrap_or_else(|| if emulator { "Android Emulator".into() } else { id.to_owned() }),
                platform: Platform::Android,
                state: state.to_owned(),
                os: String::new(),
                emulator,
            })
        })
        .collect()
}

/// Runs a setup command; returns the result line (translated by the UI, like errors).
pub fn execute(device: &Device, cmd: &Command, ctx: &Context) -> Result<Message, Error> {
    match device.platform {
        Platform::IosSimulator => ios_sim(&device.id, cmd, ctx),
        Platform::Android => android(&device.id, device.emulator, cmd, ctx),
        Platform::AndroidAvd => match cmd {
            Command::Boot => {
                let emulator = sdk_tool("emulator", "emulator").ok_or(Error::new("emulator_missing"))?;
                Cmd::new(emulator).args(["-avd", &device.id]).spawn().map_err(|e| e.to_string())?;
                Ok(Message::new("emulator_starting").arg("name", &device.name))
            }
            _ => Err(Error::new("emulator_stopped")),
        },
        Platform::IosDevice => Err(Error::new("ios_remote")),
    }
}

fn ios_sim(udid: &str, cmd: &Command, ctx: &Context) -> Result<Message, Error> {
    let simctl = |args: &[&str]| run(xcrun(), &[&["simctl"], args].concat());
    match cmd {
        Command::InstallCa | Command::InstallSystemCa => {
            simctl(&["keychain", udid, "add-root-cert", &ctx.ca_pem.to_string_lossy()])?;
            Ok(Message::new("sim_ca_installed"))
        }
        Command::SetProxy | Command::ClearProxy => {
            Ok(Message::new("sim_proxy_hint"))
        }
        Command::Restart => {
            let _ = simctl(&["shutdown", udid]);
            simctl(&["boot", udid])?;
            Ok(Message::new("sim_restarted"))
        }
        Command::Boot => {
            simctl(&["boot", udid])?;
            let _ = run(Path::new("open"), &["-a", "Simulator"]);
            Ok(Message::new("sim_booted"))
        }
        Command::Shutdown => Ok(simctl(&["shutdown", udid]).map(|_| Message::new("sim_shutdown"))?),
        Command::OpenUrl(url) => Ok(simctl(&["openurl", udid, url]).map(|_| Message::new("url_opened").arg("url", url))?),
    }
}

/// Overlays the system CA directory with a tmpfs copy that includes our CA, and on Android 14+
/// bind-mounts it over the conscrypt APEX store inside zygote and every app's mount namespace.
/// Needs root (adb root); no -writable-system or reboot, but it does not survive a reboot.
const SYSTEM_CA_SCRIPT: &str = r#"
set -e
S=/system/etc/security/cacerts
A=/apex/com.android.conscrypt/cacerts
T=/data/local/tmp/sniffo-cacerts
rm -rf $T && mkdir -p -m 700 $T
cp $S/* $T/
if [ -d $A ]; then cp $A/* $T/; fi
cp /data/local/tmp/sniffo-ca.pem $T/{HASH}.0
mount -t tmpfs tmpfs $S
cp $T/* $S/
chown root:root $S/*
chmod 644 $S/*
chcon u:object_r:system_file:s0 $S/*
if [ -d $A ]; then
  mount --bind $S $A
  for Z in $(pidof zygote zygote64); do
    nsenter --mount=/proc/$Z/ns/mnt -- mount --bind $S $A
    for P in $(ps -o PID= -P $Z); do
      nsenter --mount=/proc/$P/ns/mnt -- mount --bind $S $A 2>/dev/null || true
    done
  done
fi
rm -rf $T
echo SNIFFO_OK
"#;

/// Android trusts `subject_hash_old` named files in /system/etc/security/cacerts.
fn subject_hash_old(pem: &Path) -> Result<String, Error> {
    run(Path::new("openssl"), &["x509", "-inform", "PEM", "-subject_hash_old", "-noout", "-in", &pem.to_string_lossy()])
        .map(|h| h.trim().to_owned())
        .map_err(|e| Error::new("openssl_missing").arg("detail", e))
}

fn android(serial: &str, emulator: bool, cmd: &Command, ctx: &Context) -> Result<Message, Error> {
    let adb_bin = adb_path().ok_or(Error::new("adb_missing"))?;
    let adb = |args: &[&str]| run(&adb_bin, &[&["-s", serial], args].concat());
    let port = ctx.proxy_port.to_string();
    match cmd {
        Command::SetProxy => {
            // The device's localhost:PORT is tunnelled over adb to ours: no Wi-Fi/LAN needed.
            adb(&["reverse", &format!("tcp:{port}"), &format!("tcp:{port}")])?;
            adb(&["shell", "settings", "put", "global", "http_proxy", &format!("127.0.0.1:{port}")])?;
            Ok(Message::new("android_proxy_set").arg("port", &port))
        }
        Command::ClearProxy => {
            adb(&["shell", "settings", "put", "global", "http_proxy", ":0"])?;
            let _ = adb(&["reverse", "--remove", &format!("tcp:{port}")]);
            Ok(Message::new("android_proxy_removed"))
        }
        Command::InstallCa => {
            // Android 11+ only allows user CAs through Settings: push the file and open the installer.
            adb(&["push", &ctx.ca_pem.to_string_lossy(), "/sdcard/Download/sniffo-ca.crt"])?;
            let _ = adb(&["shell", "am", "start", "-a", "android.settings.SECURITY_SETTINGS"]);
            Ok(Message::new("android_ca_copied"))
        }
        Command::InstallSystemCa => {
            if !emulator {
                return Err(Error::new("system_ca_emulator_only"));
            }
            let hash = subject_hash_old(ctx.ca_pem)?;
            // `adb root` exits 0 even on production (Google Play) images, so check the uid.
            let _ = adb(&["root"]);
            let _ = adb(&["wait-for-device"]);
            if adb(&["shell", "id", "-u"]).map(|u| u.trim() != "0").unwrap_or(true) {
                return Err(Error::new("system_ca_play_image"));
            }
            adb(&["push", &ctx.ca_pem.to_string_lossy(), "/data/local/tmp/sniffo-ca.pem"])?;
            let out = adb(&["shell", &SYSTEM_CA_SCRIPT.replace("{HASH}", &hash)])?;
            if !out.contains("SNIFFO_OK") {
                return Err(Error::new("system_ca_failed").arg("detail", out.trim()));
            }
            Ok(Message::new("android_system_ca"))
        }
        Command::Restart => Ok(adb(&["reboot"]).map(|_| Message::new("android_rebooting"))?),
        Command::Boot => Err(Error::new("device_running")),
        Command::Shutdown => Ok(adb(&["emu", "kill"]).map(|_| Message::new("android_emulator_stopped"))?),
        Command::OpenUrl(url) => Ok(adb(&["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]).map(|_| Message::new("url_opened").arg("url", url))?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simctl() {
        let json = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[
            {"udid":"A","name":"iPhone 18 Pro Max","state":"Shutdown"},{"udid":"B","name":"iPhone 18 Pro","state":"Booted"}]}}"#;
        let d = parse_simctl(json);
        assert_eq!(d[0].id, "B", "booted first");
        assert_eq!(d[0].os, "iOS 27.0");
        assert_eq!(d[0].platform, Platform::IosSimulator);
    }

    #[test]
    fn parses_adb() {
        let out = "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nR58M12345     unauthorized usb:1-1 transport_id:2\n\n";
        let d = parse_adb(out);
        assert_eq!(d.len(), 2);
        assert!(d[0].emulator && d[0].state == "device" && d[0].name == "sdk gphone64 arm64");
        assert!(!d[1].emulator && d[1].state == "unauthorized" && d[1].name == "R58M12345");
    }

    #[test]
    fn parses_devicectl() {
        let json = r#"{"result":{"devices":[{"identifier":"X","deviceProperties":{"name":"Ale's iPhone","osVersionNumber":"27.0"},"hardwareProperties":{"platform":"iOS","reality":"physical"},"connectionProperties":{"tunnelState":"disconnected","transportType":"wired"}},
            {"identifier":"Y","deviceProperties":{"name":"Old iPhone"},"hardwareProperties":{"platform":"iOS","reality":"physical"},"connectionProperties":{"tunnelState":"unavailable"}},
            {"identifier":"S","deviceProperties":{"name":"iPhone 18 Pro"},"hardwareProperties":{"platform":"iOS","reality":"simulated"}}]}}"#;
        let d = parse_devicectl(json);
        assert_eq!(d.len(), 2, "simulators skipped");
        assert_eq!((d[0].state.as_str(), d[1].state.as_str()), ("connected (USB)", "offline"), "plugged in even without a debug tunnel");
        assert_eq!((d[0].name.as_str(), d[0].os.as_str(), d[0].platform.clone()), ("Ale's iPhone", "iOS 27.0", Platform::IosDevice));
    }
}
