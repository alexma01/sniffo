import { open } from "@tauri-apps/plugin-dialog";
import { toast, toastError } from "./toast";
import { backdrop } from "./backdrop";
import { Icon } from "./icons";
import { useEffect, useState } from "react";
import { getLang, Key, Lang, LANGS, rich, setLang, t, useLang } from "./i18n";
import { api, NetworkOptions, ProtoSchemas, ProxyStatus, ReverseProxy, SslProxying } from "./api";

export const SCHEMAS_CHANGED = "sniffo:schemas";

const SECTIONS = ["general", "ssl", "network", "protobuf", "reverse"] as const;
type Section = (typeof SECTIONS)[number];

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function Settings(props: { status: ProxyStatus | null; onClose: () => void; onChanged: () => void }) {
  const { status, onClose, onChanged } = props;
  useLang();
  const [ssl, setSsl] = useState<SslProxying | null>(null);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [port, setPort] = useState(status?.address?.split(":").pop() ?? "9191");
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<Section>("general");
  const [net, setNet] = useState<NetworkOptions | null>(null);
  const [dns, setDns] = useState("");
  const [reverse, setReverse] = useState<ReverseProxy[]>([]);
  const [reverseErrors, setReverseErrors] = useState<(string | null)[]>([]);
  const [proto, setProto] = useState<ProtoSchemas | null>(null);
  const setProtoFiles = (files: string[]) => api.setProtoFiles(files).then((p) => {
    setProto(p); setMsg(null);
    window.dispatchEvent(new Event(SCHEMAS_CHANGED)); // open protobuf bodies reload their types
  }, (e) => setMsg(String(e)));

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
      if (errs.some(Boolean)) { setMsg(t("settings.reverseFailed")); return; }
      const p = Number(port);
      if (status?.running && !status.address?.endsWith(`:${p}`)) await api.start(p);
      onChanged();
      toast(t("settings.saved"));
      onClose();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const trust = () =>
    api.trustCa().then(() => { setMsg(t("settings.caInstalled")); toast(t("settings.caInstalledTrusted")); onChanged(); }, (e) => { setMsg(String(e)); toastError(e); });

  return (
    <div className="modal-back" {...backdrop(onClose)}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav" aria-label={t("settings.sections")}>
          <h3>{t("settings.title")}</h3>
          {SECTIONS.map((id) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{t(`settings.${id}` as Key)}</button>
          ))}
        </nav>
        <div className="settings-main">
        <div className="settings-body">
        {tab === "general" && <>
        <section>
          <h4>{t("settings.language")}</h4>
          <select value={getLang()} aria-label={t("settings.language")} onChange={(e) => setLang(e.target.value as Lang)}>
            {Object.entries(LANGS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </section>
        <section>
          <h4>{t("settings.proxy")}</h4>
          <label className="row">{t("common.port")} <input className="input" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} /></label>
          <label className="check">
            <input type="checkbox" defaultChecked={status?.auto_system_proxy} onChange={(e) => api.setAutoSystemProxy(e.target.checked).then(onChanged)} />
            {t("settings.autoSystemProxy")}
          </label>
        </section>
        <section>
          <h4>{t("settings.rootCa")}</h4>
          <p className="muted">{status?.ca_path}</p>
          <p>{t("settings.caStatus")} {status?.ca_trusted ? <span className="ok">{t("settings.caTrusted")}</span> : <span className="err">{t("settings.caNotTrusted")}</span>}</p>
          <div className="row">
            <button onClick={trust}>{t("settings.installTrust")}</button>
            <button onClick={() => api.revealCa()}>{t("settings.showInFolder")}</button>
          </div>
        </section>
        </>}
        {tab === "ssl" && <>
        <section>
          <h4>{t("settings.sslTitle")}</h4>
          {ssl && (
            <label className="row"><input type="checkbox" checked={ssl.enabled} onChange={(e) => setSsl({ ...ssl, enabled: e.target.checked })} /> {t("settings.decrypt")}</label>
          )}
          <div className="cols">
            <label><span>{rich(t("settings.include"))}</span>
              <textarea value={include} onChange={(e) => setInclude(e.target.value)} rows={6} />
            </label>
            <label>{t("settings.exclude")}
              <textarea value={exclude} onChange={(e) => setExclude(e.target.value)} rows={6} placeholder="*.apple.com" />
            </label>
          </div>
        </section>
        </>}
        {tab === "network" && <>
        <section>
          <h4>{t("settings.upstream")}</h4>
          {net && (
            <>
              <label className="check">
                <input type="checkbox" checked={!!net.upstream} onChange={(e) => setNet({ ...net, upstream: e.target.checked ? { kind: "http", host: "", port: 8080, username: "", password: "" } : null })} />
                {t("settings.upstreamOn")}
              </label>
              {net.upstream && (
                <div className="grid4">
                  <label>{t("settings.type")}
                    <select value={net.upstream.kind} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, kind: e.target.value as "http" | "socks5" } })}>
                      <option value="http">HTTP</option><option value="socks5">SOCKS5</option>
                    </select>
                  </label>
                  <label>{t("common.host")} <input className="input wide" value={net.upstream.host} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, host: e.target.value.trim() } })} /></label>
                  <label>{t("common.port")} <input className="input" value={net.upstream.port} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, port: Number(e.target.value.replace(/\D/g, "")) || 0 } })} /></label>
                  <label>{t("settings.userPass")}
                    <span className="row tight">
                      <input className="input" value={net.upstream.username} placeholder={t("settings.user")} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, username: e.target.value } })} />
                      <input className="input" type="password" value={net.upstream.password} placeholder={t("settings.pass")} onChange={(e) => setNet({ ...net, upstream: { ...net.upstream!, password: e.target.value } })} />
                    </span>
                  </label>
                </div>
              )}
              <h4>{t("settings.dns")}</h4>
              <textarea rows={3} value={dns} placeholder={"127.0.0.1 api.myapp.test\n10.0.0.5 staging.example.com"} onChange={(e) => setDns(e.target.value)} />
              <label className="check">
                <input type="checkbox" checked={net.ignore_upstream_tls_errors} onChange={(e) => setNet({ ...net, ignore_upstream_tls_errors: e.target.checked })} />
                {t("settings.ignoreTls")} <span className="warn">{t("settings.ignoreTlsWarn")}</span>
              </label>
            </>
          )}
        </section>
        </>}
        {tab === "protobuf" && <>
        <section>
          <h4>{t("settings.protoTitle")}</h4>
          <p className="muted">{rich(t("settings.protoHint"))}</p>
          {proto?.files.map((f) => (
            <div key={f} className="row">
              <code className="grow ellipsis" title={f}>{f}</code>
              <button onClick={() => setProtoFiles(proto.files.filter((x) => x !== f))} aria-label={t("common.remove")}><Icon name="x" size={12} /></button>
            </div>
          ))}
          <div className="row">
            <button onClick={async () => {
              const picked = await open({ multiple: true, filters: [{ name: "Protobuf", extensions: ["proto", "desc", "pb"] }] });
              const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
              if (list.length) setProtoFiles([...new Set([...(proto?.files ?? []), ...list])]);
            }}>{t("settings.protoAdd")}</button>
            {proto && proto.files.length > 0 && <span className="muted">{t("settings.protoTypes", { n: proto.messages.length })}</span>}
          </div>
        </section>
        </>}
        {tab === "reverse" && <>
        <section>
          <h4>{t("settings.reverse")}</h4>
          <p className="muted">{rich(t("settings.reverseHint"))}</p>
          {reverse.map((r, i) => (
            <div key={i} className="row">
              <input type="checkbox" checked={r.enabled} onChange={(e) => setReverse(reverse.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
              localhost:<input className="input" value={r.port} onChange={(e) => setReverse(reverse.map((x, j) => (j === i ? { ...x, port: Number(e.target.value.replace(/\D/g, "")) || 0 } : x)))} />
              →<input className="input wide grow" value={r.target} placeholder="https://api.example.com" onChange={(e) => setReverse(reverse.map((x, j) => (j === i ? { ...x, target: e.target.value.trim() } : x)))} />
              <button onClick={() => setReverse(reverse.filter((_, j) => j !== i))} aria-label={t("common.remove")}><Icon name="x" size={12} /></button>
              {reverseErrors[i] && <span className="err small">{reverseErrors[i]}</span>}
            </div>
          ))}
          <button onClick={() => setReverse([...reverse, { enabled: true, port: 9300 + reverse.length, target: "http://localhost:3000" }])}>{t("settings.reverseAdd")}</button>
        </section>
        </>}
        </div>
        {msg && <p className="muted">{msg}</p>}
        <div className="row end">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" onClick={save}>{t("common.save")}</button>
        </div>
        </div>
      </div>
    </div>
  );
}
