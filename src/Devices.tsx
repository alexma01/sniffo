import QRCode from "qrcode";
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

function WifiSetup({ status, onChanged }: { status: ProxyStatus | null; onChanged: () => void }) {
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
                <tr>
                  <td className="k">Server</td>
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
            <p className="muted">The device must be on the same Wi-Fi network as this computer.</p>
            <h4>iPhone / iPad</h4>
            <ol className="steps">
              <li><b>Proxy</b>: Settings → Wi-Fi → ⓘ next to the network → Configure Proxy → <b>Manual</b> → server and port above → Save.</li>
              <li><b>Download the certificate</b>: in <b>Safari</b> (not Chrome) open <code>http://sniffo.cert</code> or scan the QR → <i>Download for iOS</i> → Allow.</li>
              <li><b>Install it</b>: Settings → General → VPN &amp; Device Management → <i>Sniffo Root CA</i> → Install.</li>
              <li className="must"><b>Trust it</b>: Settings → General → About → <b>Certificate Trust Settings</b> → turn on <i>Sniffo Root CA</i>. Without this switch iOS keeps saying “This connection is not private”.</li>
              <li><b>Choose what to decrypt</b>: in Sniffo click the lock next to a domain in the sidebar, or <i>Enable SSL Proxying</i> on its row. Other HTTPS stays an untouched tunnel.</li>
            </ol>
            <h4>Android</h4>
            <ol className="steps">
              <li><b>Proxy</b>: Settings → Wi-Fi → long-press the network → Modify → Advanced → Proxy <b>Manual</b> → server and port above. (Over USB use <i>Simulators &amp; USB → Set proxy</i> instead.)</li>
              <li><b>Download</b>: open <code>http://sniffo.cert</code> in Chrome → <i>Download for Android</i>.</li>
              <li className="must"><b>Install</b>: Settings → Security → Encryption &amp; credentials → Install a certificate → <b>CA certificate</b> → sniffo-ca.crt.</li>
              <li><b>Choose what to decrypt</b> in Sniffo, as above. Chrome trusts user CAs; your own apps need a <code>network_security_config</code> that trusts user certificates; other apps ignore them.</li>
            </ol>
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

function Connected({ onWifi, port }: { onWifi: () => void; port: number }) {
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
    api.listDevices().then((list) => {
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

  if (!devices) return <p className="muted">Looking for simulators, emulators and USB devices…</p>;
  if (!devices.length) return <p className="muted">No simulators, emulators or USB devices found. Install Xcode or the Android SDK, or plug a device in with USB debugging enabled.</p>;

  return (
    <div className="dev-split">
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
                iOS doesn't let a computer change an iPhone's proxy or certificates, even over USB, so the setup is done on the phone:{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); onWifi(); }}>Wi-Fi proxy + certificate via QR code</a>.
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

export function Devices({ status, onClose, onChanged }: { status: ProxyStatus | null; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<"connected" | "wifi">("connected");
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Devices</h3>
        <div className="seg flush">
          <button className={tab === "connected" ? "active" : ""} onClick={() => setTab("connected")}>Simulators &amp; USB</button>
          <button className={tab === "wifi" ? "active" : ""} onClick={() => setTab("wifi")}>Wi-Fi device (manual)</button>
        </div>
        {tab === "connected" ? <Connected onWifi={() => setTab("wifi")} port={status?.port ?? 9191} /> : <WifiSetup status={status} onChanged={onChanged} />}
        <div className="row end"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
