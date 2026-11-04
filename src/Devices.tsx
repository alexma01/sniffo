import QRCode from "qrcode";
import { backdrop } from "./backdrop";
import { toast, toastError } from "./toast";
import { Icon, IconName } from "./icons";
import { useEffect, useRef, useState } from "react";
import { api, Device, DeviceCommand, ProxyStatus } from "./api";
import { backendText, Key, rich, t, useLang } from "./i18n";

const ICON: Record<Device["platform"], IconName> = { ios_simulator: "phone", ios_device: "phone", android: "android", android_avd: "android" };
const kind = (p: Device["platform"]) => t(`devices.kind.${p}`);
const ORDER: Device["platform"][] = ["ios_simulator", "android", "ios_device", "android_avd"];

const running = (d: Device) => d.state === "Booted" || d.state === "device" || d.state.startsWith("connected");

/** Actions available for a device in its current state: [label key, command, hint key]. */
function actions(d: Device): [Key, DeviceCommand, Key?][] {
  switch (d.platform) {
    case "ios_simulator":
      return running(d)
        ? [["devices.installTrustCa", { type: "install_ca" }], ["devices.restart", { type: "restart" }], ["devices.shutdown", { type: "shutdown" }]]
        : [["devices.boot", { type: "boot" }]];
    case "android":
      if (d.state === "unauthorized") return [];
      return [
        ["devices.setProxy", { type: "set_proxy" }],
        ["devices.removeProxy", { type: "clear_proxy" }],
        ["devices.installCaUser", { type: "install_ca" }],
        ...(d.emulator ? [["devices.installCaSystem", { type: "install_system_ca" }, "devices.installCaSystemHint"] as [Key, DeviceCommand, Key]] : []),
        ["devices.reboot", { type: "restart" }],
        ...(d.emulator ? [["devices.stopEmulator", { type: "shutdown" }] as [Key, DeviceCommand]] : []),
      ];
    case "android_avd":
      return [["devices.startEmulator", { type: "boot" }]];
    case "ios_device":
      return [];
  }
}

type Os = "ios" | "android";

/** A value with a one-click copy button, for typing into a phone's proxy settings. */
function Copyable({ value, children }: { value: string; children?: React.ReactNode }) {
  return <>{children ?? value} <button className="chip" onClick={() => navigator.clipboard.writeText(value).then(() => toast(t("devices.copied", { value })), toastError)}>{t("common.copy")}</button></>;
}

function WifiSetup({ os, status, onChanged }: { os: Os; status: ProxyStatus | null; onChanged: () => void }) {
  useLang();
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
        {t("devices.allowLan")}
      </label>
      {!status?.allow_lan ? (
        <p className="muted">{t("devices.enableLan")}</p>
      ) : !status.lan.length ? (
        <p className="err">{t("devices.noLan")}</p>
      ) : (
        <div className="device-grid">
          <div>
            <h4>{t("devices.step1")}</h4>
            <table className="kv big">
              <tbody>
                {status.lan_name && <tr><td className="k">{t("devices.server")}</td><td className="v"><Copyable value={status.lan_name} /></td></tr>}
                <tr>
                  <td className="k">{t(status.lan_name ? "devices.orIp" : "devices.server")}</td>
                  <td className="v">
                    {status.lan.length > 1 ? (
                      <select value={ip} onChange={(e) => setIp(e.target.value)}>
                        {status.lan.map((a) => <option key={a.ip + a.interface} value={a.ip}>{a.ip} ({a.interface})</option>)}
                      </select>
                    ) : null}
                    {ip && <Copyable value={ip}>{status.lan.length > 1 ? <></> : ip}</Copyable>}
                  </td>
                </tr>
                <tr><td className="k">{t("common.port")}</td><td className="v">{port ? <Copyable value={String(port)} /> : "—"}</td></tr>
              </tbody>
            </table>
            <p className="muted">{t("devices.sameWifi")}{status.lan_name && <> {rich(t("devices.lanName", { name: status.lan_name }))}</>}</p>
            {os === "ios" ? <>
            <h4>{t("devices.ios.title")}</h4>
            <ol className="steps">
              <li>{rich(t("devices.ios.1"))}</li>
              <li>{rich(t("devices.ios.2"))}</li>
              <li>{rich(t("devices.ios.3"))}</li>
              <li className="must">{rich(t("devices.ios.4"))}</li>
              <li>{rich(t("devices.ios.5"))}</li>
            </ol>
            </> : <>
            <h4>{t("devices.android.title")}</h4>
            <ol className="steps">
              <li>{rich(t("devices.android.1"))}</li>
              <li>{rich(t("devices.android.2"))}</li>
              <li className="must">{rich(t("devices.android.3"))}</li>
              <li>{rich(t("devices.android.4"))}</li>
            </ol>
            </>}
            <div className="callout">
              <b>{t("devices.tips")}</b>
              <ul>
                <li>{rich(t("devices.tip.vpn"))}</li>
                <li>{rich(t("devices.tip.pinning"))}</li>
                <li>{rich(t("devices.tip.done"))}</li>
              </ul>
            </div>
          </div>
          <div className="qr">
            {qr && <img src={qr} width={180} height={180} alt={t("devices.qrAlt")} />}
            <p className="muted">{t("devices.qrHint")}</p>
            <code>{certUrl}</code>
          </div>
        </div>
      )}
    </>
  );
}

function Connected({ show, empty, port, compact }: { show: (d: Device) => boolean; empty: Key; port: number; compact?: boolean }) {
  useLang();
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
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, []);

  const device = devices?.find((d) => d.id === selected);
  const run = async (cmd: DeviceCommand, label: Key) => {
    if (!device) return;
    setBusy(true);
    try {
      const out = await api.deviceCommand(device.id, cmd);
      setLog((l) => [{ ok: true, text: `${device.name}: ${backendText(out)}` }, ...l]);
    } catch (e) {
      setLog((l) => [{ ok: false, text: `${device.name} — ${t(label)}: ${backendText(e)}` }, ...l]);
    } finally {
      setBusy(false);
      reload();
    }
  };

  if (!devices) return <p className="muted">{t("devices.looking")}</p>;
  if (!devices.length) return <p className="muted">{t(empty)}</p>;

  return (
    <div className={`dev-split ${compact ? "compact" : ""}`}>
      <div className="dev-list">
        {devices.map((d) => (
          <div key={d.id} className={`dev-item ${d.id === selected ? "active" : ""}`} onClick={() => setSelected(d.id)}>
            <Icon name={ICON[d.platform]} />
            <div className="grow">
              <div className="ellipsis"><b>{d.name}</b></div>
              <div className="muted small">{[kind(d.platform), d.os, d.platform === "ios_device" || d.platform === "android" ? d.state : ""].filter(Boolean).join(" · ")}</div>
            </div>
            <span className={`dot ${running(d) ? "on" : "off"}`} title={d.state} />
          </div>
        ))}
      </div>
      <div className="dev-detail">
        {device && (
          <>
            <h4><Icon name={ICON[device.platform]} /> {device.name}</h4>
            <p className="muted">{[kind(device.platform), device.os, device.state].filter(Boolean).join(" · ")} · <code className="small">{device.id}</code></p>
            {device.platform === "ios_device" ? (
              <p>
                {t(running(device) ? "devices.connected" : "devices.notConnected")}
                {t("devices.iosUsb")}
              </p>
            ) : device.platform === "android" && device.state === "unauthorized" ? (
              <p className="warn">{t("devices.acceptDebug")}</p>
            ) : (
              <>
                <div className="dev-actions">
                  {actions(device).map(([label, cmd, hint]) => (
                    <button key={label} disabled={busy} title={hint && t(hint)} onClick={() => run(cmd, label)}>{t(label)}</button>
                  ))}
                </div>
                {running(device) && (
                  <div className="row">
                    <input className="input wide" value={url} onChange={(e) => setUrl(e.target.value)} />
                    <button disabled={busy} onClick={() => run({ type: "open_url", value: url }, "devices.openUrl")}>{t("devices.openUrl")}</button>
                  </div>
                )}
                {device.platform === "ios_simulator" && <p className="muted small">{t("devices.simHint")}</p>}
                {device.platform === "android" && <p className="muted small">{t("devices.androidHint", { port })}</p>}
              </>
            )}
          </>
        )}
        {busy && <p className="muted">{t("devices.running")}</p>}
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
  useLang();
  const [browsers, setBrowsers] = useState<{ id: string; name: string }[] | null>(null);
  const [env, setEnv] = useState<[string, string][] | null>(null);
  useEffect(() => { api.listBrowsers().then(setBrowsers, () => setBrowsers([])); }, []);
  useEffect(() => { if (running) api.terminalEnv().then(setEnv, toastError); }, [running]);
  const script = (env ?? []).map(([k, v]) => (WINDOWS ? `$env:${k} = "${v}"` : `export ${k}="${v}"`)).join("\n");
  if (!running) return <p className="muted">{t("devices.startProxy")}</p>;
  return (
    <>
      <h4>{t("devices.browser")}</h4>
      <p className="muted">{t("devices.browserHint")}</p>
      <div className="row">
        {browsers?.map((b) => <button key={b.id} onClick={() => api.launchBrowser(b.id).then(() => toast(t("devices.browserOpened", { name: b.name })), toastError)}>{t("devices.openBrowser", { name: b.name })}</button>)}
        {browsers && !browsers.length && <span className="muted">{t("devices.noBrowser")}</span>}
      </div>
      {browsers?.some((b) => b.id === "firefox") && <p className="muted small">{t("devices.firefoxHint")}</p>}
      <h4>{t("devices.terminal")}</h4>
      <p className="muted">{t("devices.terminalHint")}</p>
      <pre className="code env">{script}</pre>
      <div className="row"><button onClick={() => navigator.clipboard.writeText(script).then(() => toast(t("devices.terminalCopied")), toastError)} disabled={!env}>{t("common.copy")}</button></div>
    </>
  );
}

const MAC = navigator.userAgent.includes("Mac");

const KINDS: Record<Os, { label: string; virtual: Key; show: (d: Device, physical: boolean) => boolean; empty: [Key, Key] }> = {
  ios: {
    label: "iOS", virtual: "devices.simulators",
    show: (d, physical) => d.platform === (physical ? "ios_device" : "ios_simulator"),
    empty: [MAC ? "devices.noSimulators" : "devices.needMac", "devices.noIphone"],
  },
  android: {
    label: "Android", virtual: "devices.emulators",
    show: (d, physical) => physical ? d.platform === "android" && !d.emulator : d.platform === "android_avd" || (d.platform === "android" && d.emulator),
    empty: ["devices.noEmulators", "devices.noAndroid"],
  },
};

export function Devices({ status, onClose, onChanged }: { status: ProxyStatus | null; onClose: () => void; onChanged: () => void }) {
  useLang();
  const [tab, setTab] = useState<Os | "computer">(MAC ? "ios" : "android");
  const [physical, setPhysical] = useState(false);
  const port = status?.port ?? 9191;
  return (
    <div className="modal-back" {...backdrop(onClose)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{t("devices.title")}</h3>
        <div className="seg flush">
          {(["ios", "android"] as const).map((os) => <button key={os} className={tab === os ? "active" : ""} onClick={() => setTab(os)}>{KINDS[os].label}</button>)}
          <button className={tab === "computer" ? "active" : ""} onClick={() => setTab("computer")}>{t("devices.thisComputer")}</button>
        </div>
        {tab === "computer" ? <ThisComputer running={!!status?.running} /> : (
          <>
            <div className="seg flush sub">
              <button className={!physical ? "active" : ""} onClick={() => setPhysical(false)}>{t(KINDS[tab].virtual)}</button>
              <button className={physical ? "active" : ""} onClick={() => setPhysical(true)}>{t("devices.physical")}</button>
            </div>
            {/* Keyed so switching tabs rescans with the new filter and resets the selection. */}
            <Connected key={`${tab}-${physical}`} show={(d) => KINDS[tab].show(d, physical)} empty={KINDS[tab].empty[Number(physical)]} port={port} compact={physical} />
            {physical && <><h4>{t("devices.overWifi")}</h4><WifiSetup os={tab} status={status} onChanged={onChanged} /></>}
          </>
        )}
        <div className="row end"><button onClick={onClose}>{t("common.close")}</button></div>
      </div>
    </div>
  );
}
