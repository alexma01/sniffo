import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, NetworkOptions, ProtoSchemas, ProxyStatus, ReverseProxy, SslProxying } from "./api";

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function Settings(props: { status: ProxyStatus | null; onClose: () => void; onChanged: () => void }) {
  const { status, onClose, onChanged } = props;
  const [ssl, setSsl] = useState<SslProxying | null>(null);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [port, setPort] = useState(status?.address?.split(":").pop() ?? "9191");
  const [msg, setMsg] = useState<string | null>(null);
  const [net, setNet] = useState<NetworkOptions | null>(null);
  const [dns, setDns] = useState("");
  const [reverse, setReverse] = useState<ReverseProxy[]>([]);
  const [reverseErrors, setReverseErrors] = useState<(string | null)[]>([]);
  const [proto, setProto] = useState<ProtoSchemas | null>(null);
  const setProtoFiles = (files: string[]) => api.setProtoFiles(files).then((p) => { setProto(p); setMsg(null); }, (e) => setMsg(String(e)));

  useEffect(() => {
    api.getSsl().then((s) => { setSsl(s); setInclude(s.include.join("\n")); setExclude(s.exclude.join("\n")); });
    api.getNetwork().then((n) => { setNet(n); setDns(n.dns.map(([h, ip]) => `${ip} ${h}`).join("\n")); });
    api.getReverse().then(setReverse);
    api.getProtoSchemas().then(setProto);
  }, []);

  const save = async () => {
    if (!ssl) return;
    try {
      await api.setSsl({ enabled: ssl.enabled, include: lines(include), exclude: lines(exclude) });
      if (net) {
        // hosts-file style: "IP host"
        const entries = lines(dns).map((l) => l.split(/\s+/)).filter((p) => p.length >= 2).map(([ip, h]) => [h, ip] as [string, string]);
        await api.setNetwork({ ...net, dns: entries });
      }
      const errs = await api.setReverse(reverse);
      setReverseErrors(errs);
      if (errs.some(Boolean)) { setMsg("Some reverse proxies failed to start"); return; }
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

        <section>
          <h4>Upstream proxy</h4>
          {net && (
            <>
              <label className="check">
                <input type="checkbox" checked={!!net.upstream} onChange={(e) => setNet({ ...net, upstream: e.target.checked ? { kind: "http", host: "", port: 8080, username: "", password: "" } : null })} />
                Send traffic through another proxy (e.g. corporate)
              </label>
              {net.upstream && (
                <div className="grid4">
                  <label>Type
                    <select value={net.upstream.kind} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, kind: e.target.value as "http" | "socks5" } })}>
                      <option value="http">HTTP</option><option value="socks5">SOCKS5</option>
                    </select>
                  </label>
                  <label>Host <input className="input wide" value={net.upstream.host} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, host: e.target.value.trim() } })} /></label>
                  <label>Port <input className="input" value={net.upstream.port} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, port: Number(e.target.value.replace(/\D/g, "")) || 0 } })} /></label>
                  <label>User / password
                    <span className="row tight">
                      <input className="input" value={net.upstream.username} placeholder="user" onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, username: e.target.value } })} />
                      <input className="input" type="password" value={net.upstream.password} placeholder="pass" onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, password: e.target.value } })} />
                    </span>
                  </label>
                </div>
              )}
              <h4>DNS overrides</h4>
              <textarea rows={3} value={dns} placeholder={"127.0.0.1 api.myapp.test\n10.0.0.5 staging.example.com"} onChange={(e) => setDns(e.target.value)} />
              <label className="check">
                <input type="checkbox" checked={net.ignore_upstream_tls_errors} onChange={(e) => setNet({ ...net, ignore_upstream_tls_errors: e.target.checked })} />
                Ignore upstream certificate errors <span className="warn">(insecure — only for self-signed dev servers)</span>
              </label>
            </>
          )}
        </section>

        <section>
          <h4>Protobuf schemas</h4>
          <p className="muted">Decode protobuf/gRPC bodies with your message types (<code>.proto</code> files, or <code>.desc</code>/<code>.pb</code> descriptor sets).</p>
          {proto?.files.map((f) => (
            <div key={f} className="row">
              <code className="grow ellipsis" title={f}>{f}</code>
              <button onClick={() => setProtoFiles(proto.files.filter((x) => x !== f))}>✕</button>
            </div>
          ))}
          <div className="row">
            <button onClick={async () => {
              const picked = await open({ multiple: true, filters: [{ name: "Protobuf", extensions: ["proto", "desc", "pb"] }] });
              const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
              if (list.length) setProtoFiles([...new Set([...(proto?.files ?? []), ...list])]);
            }}>Add schema files…</button>
            {proto && proto.files.length > 0 && <span className="muted">{proto.messages.length} message types</span>}
          </div>
        </section>

        <section>
          <h4>Reverse proxy</h4>
          <p className="muted">Point an app at <code>http://localhost:PORT</code> and Sniffo forwards to the target, recording everything.</p>
          {reverse.map((r, i) => (
            <div key={i} className="row">
              <input type="checkbox" checked={r.enabled} onChange={(e) => setReverse(reverse.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
              localhost:<input className="input" value={r.port} onChange={(e) => setReverse(reverse.map((x, j) => (j === i ? { ...x, port: Number(e.target.value.replace(/\D/g, "")) || 0 } : x)))} />
              →<input className="input wide grow" value={r.target} placeholder="https://api.example.com" onChange={(e) => setReverse(reverse.map((x, j) => (j === i ? { ...x, target: e.target.value.trim() } : x)))} />
              <button onClick={() => setReverse(reverse.filter((_, j) => j !== i))}>✕</button>
              {reverseErrors[i] && <span className="err small">{reverseErrors[i]}</span>}
            </div>
          ))}
          <button onClick={() => setReverse([...reverse, { enabled: true, port: 9300 + reverse.length, target: "http://localhost:3000" }])}>Add reverse proxy</button>
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
