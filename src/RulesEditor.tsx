import { open, save } from "@tauri-apps/plugin-dialog";
import { toast, toastError } from "./toast";
import { backdrop } from "./backdrop";
import { CodeArea } from "./highlight";
import { useEffect, useState } from "react";
import { Action, api, Headers, Rewrite, Rule, Rules } from "./api";
import { Key, rich, t, useLang } from "./i18n";

const ACTIONS: Action["type"][] = ["breakpoint", "map_local", "map_local_dir", "map_remote", "block", "throttle", "script", "rewrite"];
export const actionLabel = (type: Action["type"]) => t(`rules.action.${type}`);

export const SCRIPT_TEMPLATE = `// Runs for every matching request. Return the (modified) object, or nothing to leave it unchanged.
// request  = { method, url, headers, body }   response = { status, headers, body }
// Headers use lowercase names; JSON bodies are already parsed. \`sharedState\` persists across calls.

function onRequest(context, request) {
  // request.headers["authorization"] = "Bearer " + sharedState.token;
  return request;
}

function onResponse(context, request, response) {
  // response.body.debug = true;
  console.log(request.method, request.url, "->", response.status);
  return response;
}
`;

// Labels are i18n keys except the generation names.
export const THROTTLE_PRESETS: Record<string, [number, number, number]> = {
  "3G": [300, 96, 32],
  "4G": [100, 1024, 512],
  "rules.throttle.edge": [500, 30, 10],
  "rules.throttle.verySlow": [2000, 5, 2],
};
const presetLabel = (n: string) => (n.startsWith("rules.") ? t(n as Key) : n);

export function defaultAction(type: Action["type"]): Action {
  switch (type) {
    case "breakpoint": return { type, request: true, response: false };
    case "map_local": return { type, status: 200, headers: [["content-type", "application/json"]], body: "{}", file: null };
    case "map_local_dir": return { type, dir: "" };
    case "map_remote": return { type, scheme: null, host: "localhost", port: 3000, path: null };
    case "block": return { type };
    case "throttle": return { type, latency_ms: 300, download_kbps: 96, upload_kbps: 32 };
    case "script": return { type, code: SCRIPT_TEMPLATE };
    case "rewrite": return { type, items: [newRewrite()] };
  }
}

export function newRule(url: string, action: Action, name?: string): Rule {
  return { id: crypto.randomUUID(), name: name ?? `${actionLabel(action.type)} ${url}`, enabled: true, matcher: { url, regex: false, methods: [] }, action };
}

export const headersToText = (h: Headers) => h.map(([k, v]) => `${k}: ${v}`).join("\n");
export const textToHeaders = (t: string): Headers =>
  t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    return (i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]) as [string, string];
  });

const newRewrite = (): Rewrite => ({ response: false, target: "header", op: "set", name: "", pattern: "", value: "" });

function RewriteForm({ items, onChange }: { items: Rewrite[]; onChange: (items: Rewrite[]) => void }) {
  useLang();
  const set = (i: number, patch: Partial<Rewrite>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="form">
      {items.map((it, i) => {
        // Query and URL exist only on requests, status only on responses.
        const targets = it.response ? ["header", "status", "body"] : ["header", "query", "url", "body"];
        const ops = it.target === "status" ? ["set"] : it.target === "url" ? ["replace", "set"] : ["set", "replace", "remove"];
        return (
          <div className="row rewrite" key={i}>
            <select value={it.response ? "response" : "request"} aria-label={t("rules.phase")} onChange={(e) => {
              const response = e.target.value === "response";
              set(i, { response, target: (response ? ["header", "status", "body"] : ["header", "query", "url", "body"]).includes(it.target) ? it.target : "header" });
            }}>
              <option value="request">{t("common.request")}</option><option value="response">{t("common.response")}</option>
            </select>
            <select value={it.target} aria-label={t("rules.target")} onChange={(e) => {
              const target = e.target.value as Rewrite["target"];
              set(i, { target, op: target === "status" ? "set" : target === "url" ? "replace" : it.op });
            }}>
              {targets.map((x) => <option key={x} value={x}>{t(`rules.target.${x}` as Key)}</option>)}
            </select>
            <select value={it.op} aria-label={t("rules.operation")} onChange={(e) => set(i, { op: e.target.value as Rewrite["op"] })}>
              {ops.map((o) => <option key={o} value={o}>{t(`rules.op.${o}` as Key)}</option>)}
            </select>
            {(it.target === "header" || it.target === "query") && <input className="input" value={it.name} placeholder={t("rules.name")} onChange={(e) => set(i, { name: e.target.value })} />}
            {it.op === "replace" && <input className="input grow" value={it.pattern} placeholder={t("rules.regex")} onChange={(e) => set(i, { pattern: e.target.value })} />}
            {it.op !== "remove" && <input className="input grow" value={it.value} placeholder={t(it.op === "replace" ? "rules.replacement" : "rules.value")} onChange={(e) => set(i, { value: e.target.value })} />}
            <button title={t("common.remove")} onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
          </div>
        );
      })}
      <div className="row"><button onClick={() => onChange([...items, newRewrite()])}>{t("rules.addEdit")}</button></div>
      <p className="muted">{t("rules.rewriteHint")}</p>
    </div>
  );
}

const opt = (s: string) => (s.trim() ? s.trim() : null);

function ActionForm({ action, onChange }: { action: Action; onChange: (a: Action) => void }) {
  useLang();
  switch (action.type) {
    case "breakpoint":
      return (
        <div className="row">
          <label className="check"><input type="checkbox" checked={action.request} onChange={(e) => onChange({ ...action, request: e.target.checked })} /> {t("common.request")} <span className="muted">{t("rules.wsUp")}</span></label>
          <label className="check"><input type="checkbox" checked={action.response} onChange={(e) => onChange({ ...action, response: e.target.checked })} /> {t("common.response")} <span className="muted">{t("rules.wsDown")}</span></label>
        </div>
      );
    case "map_local":
      return (
        <div className="form">
          <label>{t("common.status")} <input className="input" value={action.status} onChange={(e) => onChange({ ...action, status: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
          <label>{t("common.headers")} <CodeArea kind="headers" rows={3} value={headersToText(action.headers)} onChange={(e) => onChange({ ...action, headers: textToHeaders(e.target.value) })} /></label>
          <label>{t("rules.bodyFile")} <input className="input wide" value={action.file ?? ""} placeholder="/path/to/response.json" onChange={(e) => onChange({ ...action, file: opt(e.target.value) })} /></label>
          <label>{t("common.body")} <CodeArea kind="json" rows={8} value={action.body} disabled={!!action.file} onChange={(e) => onChange({ ...action, body: e.target.value })} /></label>
        </div>
      );
    case "map_local_dir":
      return (
        <div className="form">
          <div className="row">
            <input className="input wide grow" value={action.dir} placeholder="/path/to/folder" onChange={(e) => onChange({ ...action, dir: e.target.value })} />
            <button onClick={async () => { const d = await open({ directory: true }); if (typeof d === "string") onChange({ ...action, dir: d }); }}>{t("rules.choose")}</button>
          </div>
          <p className="muted">{rich(t("rules.dirHint", { dir: action.dir || t("rules.folder") }))}</p>
        </div>
      );
    case "map_remote":
      return (
        <div className="form grid4">
          <label>{t("rules.scheme")} <input className="input" value={action.scheme ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, scheme: opt(e.target.value) })} /></label>
          <label>{t("common.host")} <input className="input" value={action.host ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, host: opt(e.target.value) })} /></label>
          <label>{t("common.port")} <input className="input" value={action.port ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, port: Number(e.target.value.replace(/\D/g, "")) || null })} /></label>
          <label>{t("rules.path")} <input className="input" value={action.path ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, path: opt(e.target.value) })} /></label>
        </div>
      );
    case "rewrite":
      return <RewriteForm items={action.items} onChange={(items) => onChange({ ...action, items })} />;
    case "block":
      return <p className="muted">{t("rules.blockHint")}</p>;
    case "script":
      return (
        <CodeArea
          kind="js"
          rows={18}
          value={action.code}
          onChange={(e) => onChange({ ...action, code: e.target.value })}
          onKeyDown={(e) => {
            // Tab inserts spaces instead of leaving the editor.
            if (e.key !== "Tab") return;
            e.preventDefault();
            const el = e.currentTarget, { selectionStart: a, selectionEnd: b } = el;
            onChange({ ...action, code: action.code.slice(0, a) + "  " + action.code.slice(b) });
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }}
        />
      );
    case "throttle":
      return (
        <div className="form">
          <div className="row">
            {t("rules.presets")}
            {Object.entries(THROTTLE_PRESETS).map(([n, [l, d, u]]) => (
              <button key={n} onClick={() => onChange({ ...action, latency_ms: l, download_kbps: d, upload_kbps: u })}>{presetLabel(n)}</button>
            ))}
          </div>
          <div className="grid4">
            <label>{t("rules.latency")} <input className="input" value={action.latency_ms} onChange={(e) => onChange({ ...action, latency_ms: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
            <label>Download KB/s <input className="input" value={action.download_kbps} onChange={(e) => onChange({ ...action, download_kbps: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
            <label>Upload KB/s <input className="input" value={action.upload_kbps} onChange={(e) => onChange({ ...action, upload_kbps: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
          </div>
          <p className="muted">{t("rules.unlimited")}</p>
        </div>
      );
  }
}

function regexError(r: Rule) {
  const patterns = [r.matcher.regex ? r.matcher.url : null, ...(r.action.type === "rewrite" ? r.action.items.filter((i) => i.op === "replace").map((i) => i.pattern) : [])];
  for (const p of patterns) {
    if (p == null) continue;
    try { new RegExp(p); } catch (e) { return String(e); }
  }
  return null;
}

/** Rule list + editor. `draft` opens the editor on a new rule (e.g. from the context menu). */
export function RulesEditor(props: { draft?: Rule | null; onClose: () => void }) {
  useLang();
  const [rules, setRules] = useState<Rules | null>(null);
  const [editing, setEditing] = useState<Rule | null>(props.draft ?? null);
  const [patterns, setPatterns] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.getRules().then((r) => { setRules(r); setPatterns(r.allow_list.patterns.join("\n")); });
  }, []);

  // Local state first, so the next edit (e.g. blur then click) builds on this one.
  const persist = (next: Rules) => {
    setRules(next);
    return api.setRules(next).then(() => { setMsg(null); return true; }, (e) => { setMsg(String(e)); toastError(e); api.getRules().then(setRules); return false; });
  };

  if (!rules) return null;

  const saveRule = () => {
    if (!editing) return;
    const err = regexError(editing);
    if (err) { setMsg(err); return; }
    const exists = rules.rules.some((r) => r.id === editing.id);
    persist({ ...rules, rules: exists ? rules.rules.map((r) => (r.id === editing.id ? editing : r)) : [...rules.rules, editing] })
      .then((ok) => ok && toast(t("rules.saved", { name: editing.name })));
    setEditing(null);
  };
  const move = (i: number, d: number) => {
    const list = [...rules.rules];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    persist({ ...rules, rules: list });
  };

  return (
    <div className="modal-back" {...backdrop(props.onClose)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{t("rules.title")}</h3>
        {editing ? (
          <div className="form">
            <label>{t("rules.ruleName")} <input className="input wide" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <div className="row">
              <label className="grow">URL <input className="input wide" value={editing.matcher.url} placeholder="https://api.example.com/*" onChange={(e) => setEditing({ ...editing, matcher: { ...editing.matcher, url: e.target.value } })} /></label>
              <label className="check"><input type="checkbox" checked={editing.matcher.regex} onChange={(e) => setEditing({ ...editing, matcher: { ...editing.matcher, regex: e.target.checked } })} /> Regex</label>
            </div>
            <label>{t("rules.methods")}
              <input className="input wide" value={editing.matcher.methods.join(", ")} onChange={(e) => setEditing({ ...editing, matcher: { ...editing.matcher, methods: e.target.value.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean) } })} />
            </label>
            <label>{t("rules.action")}
              <select value={editing.action.type} onChange={(e) => setEditing({ ...editing, action: defaultAction(e.target.value as Action["type"]) })}>
                {ACTIONS.map((k) => <option key={k} value={k}>{actionLabel(k)}</option>)}
              </select>
            </label>
            <ActionForm action={editing.action} onChange={(action) => setEditing({ ...editing, action })} />
            {msg && <p className="err">{msg}</p>}
            <div className="row end">
              <button onClick={() => { setEditing(null); setMsg(null); }}>{t("common.cancel")}</button>
              <button className="primary" onClick={saveRule}>{t("rules.saveRule")}</button>
            </div>
          </div>
        ) : (
          <>
            <table className="rules">
              <tbody>
                {rules.rules.map((r, i) => (
                  <tr key={r.id} className={r.enabled ? "" : "disabled"}>
                    <td><input type="checkbox" checked={r.enabled} onChange={(e) => persist({ ...rules, rules: rules.rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)) })} /></td>
                    <td><span className="badge">{actionLabel(r.action.type)}</span></td>
                    <td className="grow" title={r.matcher.url}><strong>{r.name}</strong><div className="muted ellipsis">{r.matcher.methods.join(",")} {r.matcher.url}</div></td>
                    <td className="nowrap">
                      <button onClick={() => move(i, -1)} title={t("rules.moveUp")}>↑</button>
                      <button onClick={() => move(i, 1)} title={t("rules.moveDown")}>↓</button>
                      <button onClick={() => setEditing(structuredClone(r))}>{t("rules.edit")}</button>
                      <button onClick={() => persist({ ...rules, rules: rules.rules.filter((x) => x.id !== r.id) }).then((ok) => ok && toast(t("rules.deleted", { name: r.name })))}>{t("rules.delete")}</button>
                    </td>
                  </tr>
                ))}
                {!rules.rules.length && <tr><td className="muted pad">{t("rules.empty")}</td></tr>}
              </tbody>
            </table>
            <div className="row">
              <button className="primary" onClick={() => setEditing(newRule("*", defaultAction("breakpoint"), t("rules.newRule")))}>{t("rules.addRule")}</button>
            </div>
            <div className="row">
              <button onClick={async () => {
                const path = await open({ filters: [{ name: t("rules.fileType"), extensions: ["json"] }] });
                if (typeof path === "string") api.importRules(path).then((n) => { setMsg(t("rules.imported", { n })); api.getRules().then(setRules); }, (e) => setMsg(String(e)));
              }}>{t("rules.import")}</button>
              <button onClick={async () => {
                const path = await save({ filters: [{ name: t("rules.fileType"), extensions: ["json"] }], defaultPath: "sniffo-rules.json" });
                if (path) api.exportRules(path).then((n) => setMsg(t("rules.exported", { n })), (e) => setMsg(String(e)));
              }}>{t("rules.export")}</button>
            </div>
            <h4>{t("rules.noCaching")}</h4>
            <label className="check">
              <input type="checkbox" checked={rules.no_caching} onChange={(e) => persist({ ...rules, no_caching: e.target.checked })} />
              {t("rules.noCachingHint")}
            </label>
            <h4>{t("rules.allowList")}</h4>
            <label className="check">
              <input type="checkbox" checked={rules.allow_list.enabled} onChange={(e) => persist({ ...rules, allow_list: { ...rules.allow_list, enabled: e.target.checked } })} />
              {t("rules.allowListHint")}
            </label>
            <textarea rows={3} value={patterns} placeholder="*api.example.com*" onChange={(e) => setPatterns(e.target.value)}
              onBlur={() => persist({ ...rules, allow_list: { ...rules.allow_list, patterns: patterns.split("\n").map((l) => l.trim()).filter(Boolean) } })} />
            {msg && <p className="err">{msg}</p>}
            <div className="row end"><button onClick={props.onClose}>{t("common.close")}</button></div>
          </>
        )}
      </div>
    </div>
  );
}
