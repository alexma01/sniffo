import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, Device, DeviceCommand, ProxyStatus } from "./api";

const ICON: Record<Device["platform"], string> = { ios_simulator: "📱", ios_device: "📱", android: "🤖", android_avd: "🤖" };
const KIND: Record<Device["platform"], string> = { ios_simulator: "iOS Simulator", ios_device: "iPhone / iPad", android: "Android", android_avd: "Android emulator (off)" };
const ORDER: Device["platform"][] = ["ios_simulator", "android", "ios_device", "android_avd"];

const running = (d: Device) => d.state === "Booted" || d.state === "device";

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
            <ol>
              <li>Settings → Wi-Fi → ⓘ next to the network → Configure Proxy → <b>Manual</b>.</li>
              <li>Enter the server and port above, Save.</li>
              <li>In Safari open <code>http://sniffo.cert</code> (or scan the QR), download and install the profile.</li>
              <li>Settings → General → About → Certificate Trust Settings → enable <b>Sniffo Root CA</b>.</li>
            </ol>
            <h4>Android</h4>
            <ol>
              <li>Settings → Wi-Fi → long-press the network → Modify → Advanced → Proxy <b>Manual</b>.</li>
              <li>Enter the server and port above, Save.</li>
              <li>Open <code>http://sniffo.cert</code> in Chrome, download the Android certificate.</li>
              <li>Settings → Security → Install a certificate → <b>CA certificate</b>.</li>
              <li>Your own apps need a <code>network_security_config</code> that trusts user CAs.</li>
            </ol>
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

  const reload = () => api.listDevices().then((list) => {
    list.sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform) || Number(running(b)) - Number(running(a)));
    setDevices(list);
    setSelected((s) => s ?? list.find(running)?.id ?? list[0]?.id ?? null);
  });

  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000);
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
            <span>{ICON[d.platform]}</span>
            <div className="grow">
              <div className="ellipsis"><b>{d.name}</b></div>
              <div className="muted small">{KIND[d.platform]} · {d.os || d.state}</div>
            </div>
            <span className={`dot ${running(d) || d.state === "connected" ? "on" : "off"}`} title={d.state} />
          </div>
        ))}
      </div>
      <div className="dev-detail">
        {device && (
          <>
            <h4>{ICON[device.platform]} {device.name}</h4>
            <p className="muted">{KIND[device.platform]} · {device.os} · {device.state} · <code className="small">{device.id}</code></p>
            {device.platform === "ios_device" ? (
              <p>Physical iPhones can't be configured remotely (Apple doesn't allow it). <a href="#" onClick={(e) => { e.preventDefault(); onWifi(); }}>Use the Wi-Fi setup with QR code</a>.</p>
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
                {device.platform === "ios_simulator" && <p className="muted small">The simulator uses this Mac's network: enable “System proxy” in the toolbar.</p>}
                {device.platform === "android" && <p className="muted small">“Set proxy” tunnels the device's 127.0.0.1:{port} to this computer over adb — works over USB, no Wi-Fi needed.</p>}
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
