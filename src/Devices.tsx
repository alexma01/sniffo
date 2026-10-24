import QRCode from "qrcode";
import { backdrop } from "./backdrop";
import { toast, toastError } from "./toast";
import { Icon, IconName } from "./icons";
import { useEffect, useRef, useState } from "react";
import { api, Device, DeviceCommand, ProxyStatus } from "./api";

const ICON: Record<Device["platform"], IconName> = { ios_simulator: "phone", ios_device: "phone", android: "android", android_avd: "android" };
const KIND: Record<Device["platform"], string> = { ios_simulator: "iOS Simulator", ios_device: "iPhone / iPad", android: "Android", android_avd: "Android emulator (off)" };
const ORDER: Device["platform"][] = ["ios_simulator", "android", "ios_device", "android_avd"];

const running = (d: Device) => d.state === "Booted" || d.state === "device" || d.state.startsWith("connected");

/** Actions available for a device in its current state. */
function actions(d: Device): [string, DeviceCommand, string?][] {
  switch (d.platform) {
    case "ios_simulator":
      return running(d)
        ? [["Install & trust CA", { type: "install_ca" }], ["Restart", { type: "restart" }], ["Shut down", { type: "shutdown" }]]
        : [["Boot", { type: "boot" }]];
    case "android":
      if (d.state === "unauthorized") return [];
      return [
        ["Set proxy (adb reverse)", { type: "set_proxy" }],
        ["Remove proxy", { type: "clear_proxy" }],
        ["Install CA (user)", { type: "install_ca" }],
        ...(d.emulator ? [["Install CA (system)", { type: "install_system_ca" }, "Needs a Google APIs image (not Play) started with -writable-system; reboots the emulator"] as [string, DeviceCommand, string]] : []),
        ["Reboot", { type: "restart" }],
        ...(d.emulator ? [["Stop emulator", { type: "shutdown" }] as [string, DeviceCommand]] : []),
      ];
    case "android_avd":
      return [["Start emulator", { type: "boot" }]];
    case "ios_device":
      return [];
  }
}

type Os = "ios" | "android";

function WifiSetup({ os, status, onChanged }: { os: Os; status: ProxyStatus | null; onChanged: () => void }) {
  const [ip, setIp] = useState(status?.lan[0]?.ip ?? "");
  const [qr, setQr] = useState<string | null>(null);
  const port = status?.port;
  // Opening the proxy port directly serves the certificate page, so the QR works before the proxy is configured.
  const certUrl = ip && port ? `http://${ip}:${port}/` : null;

  useEffect(() => {
    if (certUrl) QRCode.toDataURL(certUrl, { margin: 1, width: 180 }).then(setQr);
  }, [certUrl]);

  return (
    <>
      <label className="check">
        <input type="checkbox" checked={!!status?.allow_lan} onChange={(e) => api.setAllowLan(e.target.checked).finally(onChanged)} />
        Allow devices on the local network (listen on all interfaces)
      </label>
      {!status?.allow_lan ? (
        <p className="muted">Enable LAN access to proxy traffic from other devices.</p>
      ) : !status.lan.length ? (
        <p className="err">No network address found. Connect this computer to Wi-Fi or Ethernet.</p>
      ) : (
        <div className="device-grid">
          <div>
            <h4>1. Proxy settings on the device</h4>
            <table className="kv big">
              <tbody>
                {status.lan_name && <tr><td className="k">Server</td><td className="v">{status.lan_name}</td></tr>}
                <tr>
                  <td className="k">{status.lan_name ? "or IP" : "Server"}</td>
                  <td className="v">
                    {status.lan.length > 1 ? (
                      <select value={ip} onChange={(e) => setIp(e.target.value)}>
                        {status.lan.map((a) => <option key={a.ip + a.interface} value={a.ip}>{a.ip} ({a.interface})</option>)}
                      </select>
                    ) : ip}
                  </td>
                </tr>
                <tr><td className="k">Port</td><td className="v">{port ?? "—"}</td></tr>
              </tbody>
            </table>
            <p className="muted">The device must be on the same Wi-Fi network as this computer.{status.lan_name && <> <code>{status.lan_name}</code> follows this computer across networks; use the IP if the device can't resolve it (some Android versions, guest Wi-Fi).</>}</p>
            {os === "ios" ? <>
            <h4>2. iPhone / iPad</h4>
            <ol className="steps">
              <li><b>Proxy</b>: Settings → Wi-Fi → ⓘ next to the network → Configure Proxy → <b>Manual</b> → server and port above → Save.</li>
              <li><b>Download the certificate</b>: in <b>Safari</b> (not Chrome) open <code>http://sniffo.cert</code> or scan the QR → <i>Download for iOS</i> → Allow.</li>
              <li><b>Install it</b>: Settings → General → VPN &amp; Device Management → <i>Sniffo Root CA</i> → Install.</li>
              <li className="must"><b>Trust it</b>: Settings → General → About → <b>Certificate Trust Settings</b> → turn on <i>Sniffo Root CA</i>. Without this switch iOS keeps saying “This connection is not private”.</li>
              <li><b>Choose what to decrypt</b>: in Sniffo click the lock next to a domain in the sidebar, or <i>Enable SSL Proxying</i> on its row. Other HTTPS stays an untouched tunnel.</li>
            </ol>
            </> : <>
            <h4>2. Android</h4>
            <ol className="steps">
              <li><b>Proxy</b>: Settings → Wi-Fi → long-press the network → Modify → Advanced → Proxy <b>Manual</b> → server and port above. (Over USB select the device above → <i>Set proxy</i> instead.)</li>
              <li><b>Download</b>: open <code>http://sniffo.cert</code> in Chrome → <i>Download for Android</i>.</li>
              <li className="must"><b>Install</b>: Settings → Security → Encryption &amp; credentials → Install a certificate → <b>CA certificate</b> → sniffo-ca.crt.</li>
              <li><b>Choose what to decrypt</b>: in Sniffo click the lock next to a domain in the sidebar, or <i>Enable SSL Proxying</i> on its row. Chrome trusts user CAs; your own apps need a <code>network_security_config</code> that trusts user certificates; other apps ignore them.</li>
            </ol>
            </>}
            <div className="callout">
              <b>Good to know</b>
              <ul>
                <li><b>Corporate VPN on this computer</b> (Cato, Zscaler, GlobalProtect…): if it inspects TLS, HTTPS tunnelled from the phone arrives with the company's certificate, which the phone rejects. Enable SSL Proxying for the hosts you use (or <code>*</code> in Settings) so Sniffo re-signs them with its own CA.</li>
                <li><b>Certificate pinning</b>: apps that pin their server certificate (banking, many Apple/Google services) can't be decrypted by any proxy; leave them tunnelled.</li>
                <li><b>When you're done</b> set the phone's proxy back to <i>Off</i>: if Sniffo isn't running the phone has no internet.</li>
              </ul>
            </div>
          </div>
          <div className="qr">
            {qr && <img src={qr} width={180} height={180} alt="Certificate page QR code" />}
            <p className="muted">Scan to open the certificate page</p>
            <code>{certUrl}</code>
          </div>
        </div>
      )}
    </>
  );
}

function Connected({ show, empty, port, compact }: { show: (d: Device) => boolean; empty: string; port: number; compact?: boolean }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);
  const [url, setUrl] = useState("https://");

  const scanning = useRef(false);
  // A scan takes ~1.5 s (simctl + devicectl + adb); poll often but never overlap scans.
  const reload = () => {
    if (scanning.current) return;
    scanning.current = true;
    api.listDevices().then((all) => {
      const list = all.filter(show);
      list.sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform) || Number(running(b)) - Number(running(a)));
      setDevices(list);
      setSelected((s) => s ?? list.find(running)?.id ?? list[0]?.id ?? null);
    }).finally(() => { scanning.current = false; });
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, []);

  const device = devices?.find((d) => d.id === selected);
  const run = async (cmd: DeviceCommand, label: string) => {
    if (!device) return;
    setBusy(true);
    try {
      const out = await api.deviceCommand(device.id, cmd);
      setLog((l) => [{ ok: true, text: `${device.name}: ${out}` }, ...l]);
    } catch (e) {
      setLog((l) => [{ ok: false, text: `${device.name} — ${label}: ${e}` }, ...l]);
    } finally {
      setBusy(false);
      reload();
    }
  };

  if (!devices) return <p className="muted">Looking for devices…</p>;
  if (!devices.length) return <p className="muted">{empty}</p>;

  return (
    <div className={`dev-split ${compact ? "compact" : ""}`}>
      <div className="dev-list">
        {devices.map((d) => (
          <div key={d.id} className={`dev-item ${d.id === selected ? "active" : ""}`} onClick={() => setSelected(d.id)}>
            <Icon name={ICON[d.platform]} />
            <div className="grow">
              <div className="ellipsis"><b>{d.name}</b></div>
              <div className="muted small">{[KIND[d.platform], d.os, d.platform === "ios_device" || d.platform === "android" ? d.state : ""].filter(Boolean).join(" · ")}</div>
            </div>
            <span className={`dot ${running(d) ? "on" : "off"}`} title={d.state} />
          </div>
        ))}
      </div>
      <div className="dev-detail">
        {device && (
          <>
            <h4><Icon name={ICON[device.platform]} /> {device.name}</h4>
            <p className="muted">{[KIND[device.platform], device.os, device.state].filter(Boolean).join(" · ")} · <code className="small">{device.id}</code></p>
            {device.platform === "ios_device" ? (
              <p>
                {running(device) ? "Connected. " : "Not connected — plug it in with USB and unlock it. "}
                iOS doesn't let a computer change an iPhone's proxy or certificates, even over USB, so the setup is done on the phone: follow the Wi-Fi steps below.
              </p>
            ) : device.platform === "android" && device.state === "unauthorized" ? (
              <p className="warn">Accept the “Allow USB debugging” prompt on the device.</p>
            ) : (
              <>
                <div className="dev-actions">
                  {actions(device).map(([label, cmd, hint]) => (
                    <button key={label} disabled={busy} title={hint} onClick={() => run(cmd, label)}>{label}</button>
                  ))}
                </div>
                {running(device) && (
                  <div className="row">
                    <input className="input wide" value={url} onChange={(e) => setUrl(e.target.value)} />
                    <button disabled={busy} onClick={() => run({ type: "open_url", value: url }, "Open URL")}>Open URL</button>
                  </div>
                )}
                {device.platform === "ios_simulator" && <p className="muted small">The simulator uses this Mac's network: keep “System proxy” on, install the CA here, then enable SSL Proxying for the hosts you want to decrypt (🔒 in the sidebar).</p>}
                {device.platform === "android" && <p className="muted small">“Set proxy” tunnels the device's 127.0.0.1:{port} to this computer over adb — works over USB, no Wi-Fi needed. After installing the CA, enable SSL Proxying for the hosts to decrypt (🔒 in the sidebar). Remove the proxy before unplugging.</p>}
              </>
            )}
          </>
        )}
        {busy && <p className="muted">Running…</p>}
        <div className="dev-log">
          {log.map((l, i) => <div key={i} className={l.ok ? "" : "err"}>{l.ok ? "✓" : "✗"} {l.text}</div>)}
        </div>
      </div>
    </div>
  );
}

const WINDOWS = navigator.userAgent.includes("Windows");

/** Browsers and terminals on this computer, sent through Sniffo without the system proxy. */
function ThisComputer({ running }: { running: boolean }) {
  const [browsers, setBrowsers] = useState<{ id: string; name: string }[] | null>(null);
  const [env, setEnv] = useState<[string, string][] | null>(null);
  useEffect(() => { api.listBrowsers().then(setBrowsers, () => setBrowsers([])); }, []);
  useEffect(() => { if (running) api.terminalEnv().then(setEnv, toastError); }, [running]);
  const script = (env ?? []).map(([k, v]) => (WINDOWS ? `$env:${k} = "${v}"` : `export ${k}="${v}"`)).join("\n");
  if (!running) return <p className="muted">Start the proxy first.</p>;
  return (
    <>
      <h4>Browser</h4>
      <p className="muted">Opens with its own profile: proxy and certificate are preset, your usual browser and the system proxy stay untouched.</p>
      <div className="row">
        {browsers?.map((b) => <button key={b.id} onClick={() => api.launchBrowser(b.id).then(() => toast(`${b.name} opened through Sniffo`), toastError)}>Open {b.name}</button>)}
        {browsers && !browsers.length && <span className="muted">No supported browser found (Chrome, Edge, Brave, Chromium, Firefox).</span>}
      </div>
      {browsers?.some((b) => b.id === "firefox") && <p className="muted small">Firefox uses the system certificate store: trust the Sniffo CA first (toolbar → Certificate).</p>}
      <h4>Terminal</h4>
      <p className="muted">Paste into a terminal: curl, Node, Python, git, Go, Rust and most CLIs in that session go through Sniffo.</p>
      <pre className="code env">{script}</pre>
      <div className="row"><button onClick={() => navigator.clipboard.writeText(script).then(() => toast("Terminal setup copied"), toastError)} disabled={!env}>Copy</button></div>
    </>
  );
}

const MAC = navigator.userAgent.includes("Mac");

const KINDS: Record<Os, { label: string; virtual: string; show: (d: Device, physical: boolean) => boolean; empty: [string, string] }> = {
  ios: {
    label: "iOS", virtual: "Simulators",
    show: (d, physical) => d.platform === (physical ? "ios_device" : "ios_simulator"),
    empty: [MAC ? "No simulators found. Create one in Xcode → Window → Devices and Simulators." : "The iOS Simulator needs a Mac with Xcode.",
      "No iPhone or iPad connected over USB. You don't need one: set it up over Wi-Fi below."],
  },
  android: {
    label: "Android", virtual: "Emulators",
    show: (d, physical) => physical ? d.platform === "android" && !d.emulator : d.platform === "android_avd" || (d.platform === "android" && d.emulator),
    empty: ["No emulators found. Create one in Android Studio → Device Manager.",
      "No device connected over USB. Plug it in with USB debugging enabled, or set it up over Wi-Fi below."],
  },
};

export function Devices({ status, onClose, onChanged }: { status: ProxyStatus | null; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Os | "computer">(MAC ? "ios" : "android");
  const [physical, setPhysical] = useState(false);
  const port = status?.port ?? 9191;
  return (
    <div className="modal-back" {...backdrop(onClose)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Devices</h3>
        <div className="seg flush">
          {(["ios", "android"] as const).map((os) => <button key={os} className={tab === os ? "active" : ""} onClick={() => setTab(os)}>{KINDS[os].label}</button>)}
          <button className={tab === "computer" ? "active" : ""} onClick={() => setTab("computer")}>This computer</button>
        </div>
        {tab === "computer" ? <ThisComputer running={!!status?.running} /> : (
          <>
            <div className="seg flush sub">
              <button className={!physical ? "active" : ""} onClick={() => setPhysical(false)}>{KINDS[tab].virtual}</button>
              <button className={physical ? "active" : ""} onClick={() => setPhysical(true)}>Physical devices</button>
            </div>
            {/* Keyed so switching tabs rescans with the new filter and resets the selection. */}
            <Connected key={`${tab}-${physical}`} show={(d) => KINDS[tab].show(d, physical)} empty={KINDS[tab].empty[Number(physical)]} port={port} compact={physical} />
            {physical && <><h4>Over Wi-Fi</h4><WifiSetup os={tab} status={status} onChanged={onChanged} /></>}
          </>
        )}
        <div className="row end"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
