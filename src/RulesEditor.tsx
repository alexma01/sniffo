import { open, save } from "@tauri-apps/plugin-dialog";
import { backdrop } from "./backdrop";
import { CodeArea } from "./highlight";
import { useEffect, useState } from "react";
import { Action, api, Headers, Rule, Rules } from "./api";

export const ACTION_LABELS: Record<Action["type"], string> = {
  breakpoint: "Breakpoint",
  map_local: "Map Local",
  map_local_dir: "Map Local Directory",
  map_remote: "Map Remote",
  block: "Block",
  throttle: "Throttle",
  script: "Script",
};

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

export const THROTTLE_PRESETS: Record<string, [number, number, number]> = {
  "3G": [300, 96, 32],
  "4G": [100, 1024, 512],
  Edge: [500, 30, 10],
  "Very slow": [2000, 5, 2],
};

export function defaultAction(type: Action["type"]): Action {
  switch (type) {
    case "breakpoint": return { type, request: true, response: false };
    case "map_local": return { type, status: 200, headers: [["content-type", "application/json"]], body: "{}", file: null };
    case "map_local_dir": return { type, dir: "" };
    case "map_remote": return { type, scheme: null, host: "localhost", port: 3000, path: null };
    case "block": return { type };
    case "throttle": return { type, latency_ms: 300, download_kbps: 96, upload_kbps: 32 };
    case "script": return { type, code: SCRIPT_TEMPLATE };
  }
}

export function newRule(url: string, action: Action, name?: string): Rule {
  return { id: crypto.randomUUID(), name: name ?? `${ACTION_LABELS[action.type]} ${url}`, enabled: true, matcher: { url, regex: false, methods: [] }, action };
}

export const headersToText = (h: Headers) => h.map(([k, v]) => `${k}: ${v}`).join("\n");
export const textToHeaders = (t: string): Headers =>
  t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    return (i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]) as [string, string];
  });

const opt = (s: string) => (s.trim() ? s.trim() : null);

function ActionForm({ action, onChange }: { action: Action; onChange: (a: Action) => void }) {
  switch (action.type) {
    case "breakpoint":
      return (
        <div className="row">
          <label className="check"><input type="checkbox" checked={action.request} onChange={(e) => onChange({ ...action, request: e.target.checked })} /> Request <span className="muted">(+ WebSocket frames ↑)</span></label>
          <label className="check"><input type="checkbox" checked={action.response} onChange={(e) => onChange({ ...action, response: e.target.checked })} /> Response <span className="muted">(+ WebSocket frames ↓)</span></label>
        </div>
      );
    case "map_local":
      return (
        <div className="form">
          <label>Status <input className="input" value={action.status} onChange={(e) => onChange({ ...action, status: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
          <label>Headers <CodeArea kind="headers" rows={3} value={headersToText(action.headers)} onChange={(e) => onChange({ ...action, headers: textToHeaders(e.target.value) })} /></label>
          <label>Body file (optional, overrides body) <input className="input wide" value={action.file ?? ""} placeholder="/path/to/response.json" onChange={(e) => onChange({ ...action, file: opt(e.target.value) })} /></label>
          <label>Body <CodeArea kind="json" rows={8} value={action.body} disabled={!!action.file} onChange={(e) => onChange({ ...action, body: e.target.value })} /></label>
        </div>
      );
    case "map_local_dir":
      return (
        <div className="form">
          <div className="row">
            <input className="input wide grow" value={action.dir} placeholder="/path/to/folder" onChange={(e) => onChange({ ...action, dir: e.target.value })} />
            <button onClick={async () => { const d = await open({ directory: true }); if (typeof d === "string") onChange({ ...action, dir: d }); }}>Choose…</button>
          </div>
          <p className="muted">The part of the URL after the pattern's <code>*</code> is the file path (folders serve <code>index.html</code>). E.g. <code>https://cdn.example.com/assets/*</code> → <code>{action.dir || "folder"}/js/app.js</code>.</p>
        </div>
      );
    case "map_remote":
      return (
        <div className="form grid4">
          <label>Scheme <input className="input" value={action.scheme ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, scheme: opt(e.target.value) })} /></label>
          <label>Host <input className="input" value={action.host ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, host: opt(e.target.value) })} /></label>
          <label>Port <input className="input" value={action.port ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, port: Number(e.target.value.replace(/\D/g, "")) || null })} /></label>
          <label>Path <input className="input" value={action.path ?? ""} placeholder="keep" onChange={(e) => onChange({ ...action, path: opt(e.target.value) })} /></label>
        </div>
      );
    case "block":
      return <p className="muted">Matching requests get a 403 without reaching the server.</p>;
    case "script":
      return (
        <textarea
          className="code-editor"
          rows={18}
          spellCheck={false}
          value={action.code}
          onChange={(e) => onChange({ ...action, code: e.target.value })}
          onKeyDown={(e) => {
            // Tab inserts spaces instead of leaving the editor.
            if (e.key !== "Tab") return;
            e.preventDefault();
            const t = e.currentTarget, { selectionStart: a, selectionEnd: b } = t;
            onChange({ ...action, code: action.code.slice(0, a) + "  " + action.code.slice(b) });
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
          }}
        />
      );
    case "throttle":
      return (
        <div className="form">
          <div className="row">
            Presets:
            {Object.entries(THROTTLE_PRESETS).map(([n, [l, d, u]]) => (
              <button key={n} onClick={() => onChange({ ...action, latency_ms: l, download_kbps: d, upload_kbps: u })}>{n}</button>
            ))}
          </div>
          <div className="grid4">
            <label>Latency ms <input className="input" value={action.latency_ms} onChange={(e) => onChange({ ...action, latency_ms: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
            <label>Download KB/s <input className="input" value={action.download_kbps} onChange={(e) => onChange({ ...action, download_kbps: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
            <label>Upload KB/s <input className="input" value={action.upload_kbps} onChange={(e) => onChange({ ...action, upload_kbps: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
          </div>
          <p className="muted">0 = unlimited.</p>
        </div>
      );
  }
}

function regexError(r: Rule) {
  if (!r.matcher.regex) return null;
  try { new RegExp(r.matcher.url); return null; } catch (e) { return String(e); }
}

/** Rule list + editor. `draft` opens the editor on a new rule (e.g. from the context menu). */
export function RulesEditor(props: { draft?: Rule | null; onClose: () => void }) {
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
    return api.setRules(next).then(() => setMsg(null), (e) => { setMsg(String(e)); api.getRules().then(setRules); });
  };

  if (!rules) return null;

  const saveRule = () => {
    if (!editing) return;
    const err = regexError(editing);
    if (err) { setMsg(err); return; }
    const exists = rules.rules.some((r) => r.id === editing.id);
    persist({ ...rules, rules: exists ? rules.rules.map((r) => (r.id === editing.id ? editing : r)) : [...rules.rules, editing] });
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
        <h3>Rules</h3>
        {editing ? (
          <div className="form">
            <label>Name <input className="input wide" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <div className="row">
              <label className="grow">URL <input className="input wide" value={editing.matcher.url} placeholder="https://api.example.com/*" onChange={(e) => setEditing({ ...editing, matcher: { ...editing.matcher, url: e.target.value } })} /></label>
              <label className="check"><input type="checkbox" checked={editing.matcher.regex} onChange={(e) => setEditing({ ...editing, matcher: { ...editing.matcher, regex: e.target.checked } })} /> Regex</label>
            </div>
            <label>Methods (comma separated, empty = any)
              <input className="input wide" value={editing.matcher.methods.join(", ")} onChange={(e) => setEditing({ ...editing, matcher: { ...editing.matcher, methods: e.target.value.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean) } })} />
            </label>
            <label>Action
              <select value={editing.action.type} onChange={(e) => setEditing({ ...editing, action: defaultAction(e.target.value as Action["type"]) })}>
                {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <ActionForm action={editing.action} onChange={(action) => setEditing({ ...editing, action })} />
            {msg && <p className="err">{msg}</p>}
            <div className="row end">
              <button onClick={() => { setEditing(null); setMsg(null); }}>Cancel</button>
              <button className="primary" onClick={saveRule}>Save rule</button>
            </div>
          </div>
        ) : (
          <>
            <table className="rules">
              <tbody>
                {rules.rules.map((r, i) => (
                  <tr key={r.id} className={r.enabled ? "" : "disabled"}>
                    <td><input type="checkbox" checked={r.enabled} onChange={(e) => persist({ ...rules, rules: rules.rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)) })} /></td>
                    <td><span className="badge">{ACTION_LABELS[r.action.type]}</span></td>
                    <td className="grow" title={r.matcher.url}><strong>{r.name}</strong><div className="muted ellipsis">{r.matcher.methods.join(",")} {r.matcher.url}</div></td>
                    <td className="nowrap">
                      <button onClick={() => move(i, -1)} title="Move up">↑</button>
                      <button onClick={() => move(i, 1)} title="Move down">↓</button>
                      <button onClick={() => setEditing(structuredClone(r))}>Edit</button>
                      <button onClick={() => persist({ ...rules, rules: rules.rules.filter((x) => x.id !== r.id) })}>Delete</button>
                    </td>
                  </tr>
                ))}
                {!rules.rules.length && <tr><td className="muted pad">No rules yet. Right-click a flow or add one.</td></tr>}
              </tbody>
            </table>
            <div className="row">
              <button className="primary" onClick={() => setEditing(newRule("*", defaultAction("breakpoint"), "New rule"))}>Add rule</button>
            </div>
            <div className="row">
              <button onClick={async () => {
                const path = await open({ filters: [{ name: "Sniffo rules", extensions: ["json"] }] });
                if (typeof path === "string") api.importRules(path).then((n) => { setMsg(`Imported ${n} rules`); api.getRules().then(setRules); }, (e) => setMsg(String(e)));
              }}>Import…</button>
              <button onClick={async () => {
                const path = await save({ filters: [{ name: "Sniffo rules", extensions: ["json"] }], defaultPath: "sniffo-rules.json" });
                if (path) api.exportRules(path).then((n) => setMsg(`Exported ${n} rules`), (e) => setMsg(String(e)));
              }}>Export…</button>
            </div>
            <h4>No Caching</h4>
            <label className="check">
              <input type="checkbox" checked={rules.no_caching} onChange={(e) => persist({ ...rules, no_caching: e.target.checked })} />
              Strip caching headers so every request reaches the server (If-None-Match, ETag, Cache-Control…)
            </label>
            <h4>Allow list</h4>
            <label className="check">
              <input type="checkbox" checked={rules.allow_list.enabled} onChange={(e) => persist({ ...rules, allow_list: { ...rules.allow_list, enabled: e.target.checked } })} />
              Record only matching URLs (others pass through unrecorded)
            </label>
            <textarea rows={3} value={patterns} placeholder="*api.example.com*" onChange={(e) => setPatterns(e.target.value)}
              onBlur={() => persist({ ...rules, allow_list: { ...rules.allow_list, patterns: patterns.split("\n").map((l) => l.trim()).filter(Boolean) } })} />
            {msg && <p className="err">{msg}</p>}
            <div className="row end"><button onClick={props.onClose}>Close</button></div>
          </>
        )}
      </div>
    </div>
  );
}
