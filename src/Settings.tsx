import { useEffect, useState } from "react";
import { api, ProxyStatus, SslProxying } from "./api";

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function Settings(props: { status: ProxyStatus | null; onClose: () => void; onChanged: () => void }) {
  const { status, onClose, onChanged } = props;
  const [ssl, setSsl] = useState<SslProxying | null>(null);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [port, setPort] = useState(status?.address?.split(":").pop() ?? "9191");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.getSsl().then((s) => { setSsl(s); setInclude(s.include.join("\n")); setExclude(s.exclude.join("\n")); });
  }, []);

  const save = async () => {
    if (!ssl) return;
    try {
      await api.setSsl({ enabled: ssl.enabled, include: lines(include), exclude: lines(exclude) });
      const p = Number(port);
      if (status?.running && !status.address?.endsWith(`:${p}`)) await api.start(p);
      onChanged();
      onClose();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const trust = () =>
    api.trustCa().then(() => { setMsg("Certificate installed"); onChanged(); }, (e) => setMsg(String(e)));

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <section>
          <h4>Proxy</h4>
          <label className="row">Port <input className="input" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} /></label>
        </section>

        <section>
          <h4>Root certificate</h4>
          <p className="muted">{status?.ca_path}</p>
          <p>Status: {status?.ca_trusted ? <span className="ok">trusted by this system</span> : <span className="err">not trusted</span>}</p>
          <div className="row">
            <button onClick={trust}>Install &amp; trust…</button>
            <button onClick={() => api.revealCa()}>Show in folder</button>
          </div>
        </section>

        <section>
          <h4>SSL proxying</h4>
          {ssl && (
            <label className="row"><input type="checkbox" checked={ssl.enabled} onChange={(e) => setSsl({ ...ssl, enabled: e.target.checked })} /> Decrypt HTTPS traffic</label>
          )}
          <div className="cols">
            <label>Include hosts (one per line, <code>*</code> wildcard)
              <textarea value={include} onChange={(e) => setInclude(e.target.value)} rows={6} />
            </label>
            <label>Exclude hosts (tunnelled untouched)
              <textarea value={exclude} onChange={(e) => setExclude(e.target.value)} rows={6} placeholder="*.apple.com" />
            </label>
          </div>
        </section>

        {msg && <p className="muted">{msg}</p>}
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
