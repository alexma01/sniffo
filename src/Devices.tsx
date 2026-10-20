import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, ProxyStatus } from "./api";

/** Setup guide for phones/tablets on the same network. */
export function Devices({ status, onClose, onChanged }: { status: ProxyStatus | null; onClose: () => void; onChanged: () => void }) {
  const [ip, setIp] = useState(status?.lan[0]?.ip ?? "");
  const [qr, setQr] = useState<string | null>(null);
  const port = status?.port;
  // Opening the proxy port directly serves the certificate page, so the QR works before the proxy is configured.
  const certUrl = ip && port ? `http://${ip}:${port}/` : null;

  useEffect(() => {
    if (certUrl) QRCode.toDataURL(certUrl, { margin: 1, width: 180 }).then(setQr);
  }, [certUrl]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Connect a phone or tablet</h3>
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
        <div className="row end"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
