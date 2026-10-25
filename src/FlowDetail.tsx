import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "./icons";
import { backendText, rich, t, useLang } from "./i18n";
import { api, Flow, FlowSummary, formatBytes, header, Headers, WsMessage } from "./api";
import { CodeArea, highlightHttp, highlightJson, highlightMaybeJson } from "./highlight";
import { JsonTree } from "./JsonTree";
import { decode, grpcFrames, toPlain } from "./protobuf";
import { SCHEMAS_CHANGED } from "./Settings";

type Tab = "headers" | "query" | "cookies" | "body" | "raw" | "timing" | "messages" | "graphql";

function isText(bytes: Uint8Array) {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c < 9) return false;
  }
  return true;
}

function hexdump(bytes: Uint8Array, limit = 64 * 1024) {
  const lines: string[] = [];
  for (let off = 0; off < Math.min(bytes.length, limit); off += 16) {
    const row = bytes.subarray(off, off + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > limit) lines.push(t("detail.more", { size: formatBytes(bytes.length - limit) }));
  return lines.join("\n");
}

function prettyXml(xml: string) {
  let depth = 0;
  return xml
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = "  ".repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
      return out;
    })
    .join("\n");
}

interface Part { headers: Headers; body: Uint8Array }

function parseMultipart(bytes: Uint8Array, contentType: string): Part[] | null {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return null;
  // latin1 keeps a 1:1 byte <-> char mapping so slices map back to the original bytes.
  const text = new TextDecoder("latin1").decode(bytes);
  const parts: Part[] = [];
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) break;
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const headers = chunk.slice(2, sep).split("\r\n").filter(Boolean).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    });
    const body = chunk.slice(sep + 4).replace(/\r\n$/, "");
    parts.push({ headers, body: Uint8Array.from(body, (c) => c.charCodeAt(0)) });
  }
  return parts;
}

/** One tree per protobuf message (gRPC bodies carry several); null when it doesn't decode. */
function protobufView(bytes: Uint8Array, grpc: boolean) {
  try {
    const messages = grpc ? grpcFrames(bytes) : [{ compressed: false, data: bytes }];
    return (
      <div>
        {messages.map((m, i) => (
          <div key={i} className="part">
            {grpc && <div className="muted pad-s">{t("detail.grpcMessage", { n: i + 1 })}{m.compressed ? t("detail.grpcCompressed") : ""} · {formatBytes(m.data.length)}</div>}
            {m.compressed ? <pre className="code">{hexdump(m.data)}</pre> : <JsonTree value={toPlain(decode(m.data))} />}
          </div>
        ))}
      </div>
    );
  } catch {
    return null;
  }
}

const protoKey = (flow: Flow, response: boolean) => `sniffo.proto.${flow.host}${flow.path.split("?")[0]}.${response ? "res" : "req"}`;

/** Protobuf body with an optional schema type (remembered per endpoint); raw decode otherwise. */
function ProtoBody({ flow, response, bytes, contentType }: { flow: Flow; response: boolean; bytes: Uint8Array | null; contentType?: string }) {
  useLang();
  const [types, setTypes] = useState<string[]>([]);
  const [type, setType] = useState<string>(() => { try { return localStorage.getItem(protoKey(flow, response)) ?? ""; } catch { return ""; } });
  const [decoded, setDecoded] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.getProtoSchemas().then((s) => setTypes(s.messages));
    load();
    window.addEventListener(SCHEMAS_CHANGED, load);
    return () => window.removeEventListener(SCHEMAS_CHANGED, load);
  }, []);
  useEffect(() => {
    setDecoded(null); setError(null);
    if (!type) return;
    api.decodeProto(flow.id, response, type).then(setDecoded, (e) => setError(backendText(e)));
  }, [flow.id, response, type, flow.state]);

  const choose = (v: string) => {
    setType(v);
    try { if (v) localStorage.setItem(protoKey(flow, response), v); else localStorage.removeItem(protoKey(flow, response)); } catch { /* storage unavailable */ }
  };

  return (
    <div>
      <div className="seg">
        <select value={type} onChange={(e) => choose(e.target.value)} title={t(types.length ? "detail.protoTypeTitle" : "detail.protoNoSchemas")}>
          <option value="">{t("detail.protoRaw")}</option>
          {types.map((m) => <option key={m}>{m}</option>)}
        </select>
      </div>
      {error && <p className="err pad-s">{error}</p>}
      {type && decoded ? decoded.map((m, i) => <div key={i} className="part"><JsonTree value={m} /></div>) : <BodyView bytes={bytes} contentType={contentType} />}
    </div>
  );
}

function GraphQL({ flow, bytes }: { flow: Flow; bytes: Uint8Array | null }) {
  useLang();
  const op = useMemo(() => {
    try {
      if (bytes?.length) {
        const v = JSON.parse(new TextDecoder().decode(bytes));
        return Array.isArray(v) ? v[0] : v;
      }
      const q = new URL(flow.url).searchParams;
      return { query: q.get("query"), operationName: q.get("operationName"), variables: JSON.parse(q.get("variables") ?? "null") };
    } catch {
      return null;
    }
  }, [bytes, flow.url]);
  if (!op) return <div className="muted pad">{t("detail.notGraphql")}</div>;
  return (
    <div>
      <div className="pad-s"><span className="badge gql">{flow.graphql}</span></div>
      <pre className="code">{String(op.query ?? "").trim()}</pre>
      {op.variables != null && (<><div className="muted pad-s">{t("detail.variables")}</div><JsonTree value={op.variables} /></>)}
    </div>
  );
}

/** Plain text bodies above this are cut until the user asks for all of it. */
const TEXT_CAP = 256 * 1024;

/** `text` up to TEXT_CAP, with a button that shows the rest. */
function LongText({ text }: { text: string }) {
  useLang();
  const [all, setAll] = useState(false);
  if (all || text.length <= TEXT_CAP) return <pre className="code">{text}</pre>;
  return (
    <div>
      <pre className="code">{text.slice(0, TEXT_CAP)}</pre>
      <div className="seg"><button onClick={() => setAll(true)}>{t("detail.showAll", { size: formatBytes(text.length) })}</button></div>
    </div>
  );
}

/** Decoding, parsing and pretty-printing run once per body (the pane re-renders on every flow update). */
function BodyView({ bytes, contentType }: { bytes: Uint8Array | null; contentType?: string }) {
  useLang();
  const [mode, setMode] = useState<"tree" | "pretty">("tree");
  const [forceProto, setForceProto] = useState(false);
  const ct = (contentType ?? "").toLowerCase();
  const url = useMemo(() => {
    if (!bytes || !ct.startsWith("image/")) return null;
    return URL.createObjectURL(new Blob([bytes.slice()], { type: ct }));
  }, [bytes, ct]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const parts = useMemo(() => (bytes && ct.startsWith("multipart/") ? parseMultipart(bytes, contentType!) : null), [bytes, ct]);
  const proto = useMemo(
    () => (bytes?.length && (ct.includes("protobuf") || ct.startsWith("application/grpc") || forceProto) ? protobufView(bytes, ct.startsWith("application/grpc")) : null),
    [bytes, ct, forceProto],
  );
  const text = useMemo(() => (bytes?.length && isText(bytes) ? new TextDecoder().decode(bytes) : null), [bytes]);
  const hex = useMemo(() => (bytes?.length && text == null ? hexdump(bytes) : null), [bytes, text]);
  const json = useMemo(() => {
    if (text == null || !(ct.includes("json") || /^\s*[{[]/.test(text))) return null;
    try { return { value: JSON.parse(text) as unknown }; } catch { return null; }
  }, [text, ct]);
  const pretty = useMemo(() => (json && mode === "pretty" ? highlightJson(JSON.stringify(json.value, null, 2)) : null), [json, mode]);
  const xml = useMemo(() => (text != null && !json && ct.includes("xml") ? prettyXml(text) : null), [text, json, ct]);

  if (!bytes) return <div className="muted pad">{t("detail.loading")}</div>;
  if (!bytes.length) return <div className="muted pad">{t("detail.noBody")}</div>;
  if (url) return <div className="pad"><img className="preview" src={url} /></div>;

  if (parts) {
    return (
      <div>
        {parts.map((p, i) => (
          <div key={i} className="part">
            <HeaderTable headers={p.headers} />
            <BodyView bytes={p.body} contentType={header(p.headers, "content-type")} />
          </div>
        ))}
      </div>
    );
  }
  if (proto) return proto;
  if (text == null) {
    return (
      <div>
        <div className="seg"><button onClick={() => setForceProto(true)}>{t("detail.decodeProto")}</button></div>
        {forceProto && <p className="err pad-s">{t("detail.invalidProto")}</p>}
        <pre className="code">{hex}</pre>
      </div>
    );
  }

  if (ct.includes("x-www-form-urlencoded")) {
    return <HeaderTable headers={[...new URLSearchParams(text).entries()]} />;
  }
  if (json) {
    return (
      <div>
        <div className="seg">
          <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>{t("detail.tree")}</button>
          <button className={mode === "pretty" ? "active" : ""} onClick={() => setMode("pretty")}>{t("detail.pretty")}</button>
        </div>
        {mode === "tree" ? <JsonTree value={json.value} /> : <pre className="code">{pretty}</pre>}
      </div>
    );
  }
  return <LongText text={xml ?? text} />;
}

function HeaderTable({ headers }: { headers: Headers }) {
  useLang();
  if (!headers.length) return <div className="muted pad">{t("detail.none")}</div>;
  return (
    <table className="kv">
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}><td className="k">{k}</td><td className="v">{v}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function cookies(headers: Headers, response: boolean): Headers {
  if (response) {
    return headers.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => {
      const [pair, ...attrs] = v.split(";");
      const i = pair.indexOf("=");
      return [pair.slice(0, i).trim(), [pair.slice(i + 1), ...attrs].join(";").trim()] as [string, string];
    });
  }
  return headers
    .filter(([k]) => k.toLowerCase() === "cookie")
    .flatMap(([, v]) => v.split(";"))
    .map((c) => { const i = c.indexOf("="); return [c.slice(0, i).trim(), c.slice(i + 1).trim()] as [string, string]; })
    .filter(([k]) => k);
}

function Timing({ flow }: { flow: Flow }) {
  useLang();
  const rows: Headers = [
    [t("timing.started"), new Date(flow.started_ms).toLocaleString()],
    [t("timing.waiting"), flow.ttfb_ms != null ? `${flow.ttfb_ms} ms` : "—"],
    [t("timing.download"), flow.ttfb_ms != null && flow.duration_ms != null ? `${flow.duration_ms - flow.ttfb_ms} ms` : "—"],
    [t("timing.total"), flow.duration_ms != null ? `${flow.duration_ms} ms` : "—"],
    [t("timing.client"), flow.client_addr],
    [t("timing.protocol"), `${flow.scheme.toUpperCase()} · ${flow.http_version}`],
    [t("timing.state"), flow.state + (flow.error ? ` — ${flow.error}` : "")],
  ];
  return <HeaderTable headers={rows} />;
}

/** One WebSocket frame; memoized so a new frame renders one row, not all of them. */
const Frame = memo(function Frame({ m, n, t0, open, closed, onToggle, onEdit }: { m: WsMessage; n: number; t0: number; open: boolean; closed: boolean; onToggle: (n: number) => void; onEdit: (m: WsMessage) => void }) {
  useLang();
  const bytes = useMemo(
    () => (!open ? null : m.kind === "text" ? new TextEncoder().encode(m.data) : m.kind === "binary" ? Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)) : null),
    [open, m],
  );
  return (
    <div>
      <div className={`ws-row ${m.outgoing ? "out" : "in"} ${open ? "open" : ""}`} onClick={() => onToggle(n)}>
        <span className="ws-dir">{m.outgoing ? "↑" : "↓"}</span>
        <span className="ws-time">+{((m.time_ms - t0) / 1000).toFixed(3)}s</span>
        <span className="ws-kind">{m.kind}</span>
        <span className="ws-size">{formatBytes(m.size)}</span>
        <span className="ws-data">{m.injected && <span className="badge warn" title={t("ws.injectedTitle")}>{t("ws.injected")}</span>}{m.kind === "text" ? highlightMaybeJson(m.data) : m.data}</span>
      </div>
      {open && (m.kind === "text" || m.kind === "binary") && !closed && (
        <div className="seg"><button onClick={() => onEdit(m)}>{t("ws.editResend")}</button></div>
      )}
      {bytes && <BodyView bytes={bytes} />}
    </div>
  );
});

/** Frames rendered at first (newest); older ones on request. */
const FRAMES_SHOWN = 500;

/** `dropped`: frames before messages[0] that are no longer kept (numbers rows stably). */
function Messages({ flowId, messages, dropped }: { flowId: number; messages: WsMessage[]; dropped: number }) {
  useLang();
  const [open, setOpen] = useState<number | null>(null);
  const [shown, setShown] = useState(FRAMES_SHOWN);
  const [draft, setDraft] = useState({ toServer: true, binary: false, data: "" });
  const [error, setError] = useState<string | null>(null);
  const closed = messages.some((m) => m.kind === "close");
  const send = () => api.sendWs(flowId, draft.toServer, draft.data, draft.binary).then(() => setError(null), (e) => setError(backendText(e)));
  const format = () => { try { setDraft({ ...draft, data: JSON.stringify(JSON.parse(draft.data), null, 2) }); setError(null); } catch (e) { setError(String(e)); } };
  const onToggle = useCallback((n: number) => setOpen((o) => (o === n ? null : n)), []);
  const onEdit = useCallback((m: WsMessage) => setDraft({ toServer: m.outgoing, binary: m.kind === "binary", data: m.data }), []);
  const t0 = messages[0]?.time_ms ?? 0;
  const first = Math.max(0, messages.length - shown);
  return (
    <div className="ws">
      {!messages.length && <div className="muted pad">{t("ws.noFrames")}</div>}
      {first > 0 && <div className="seg"><button onClick={() => setShown(shown + 2000)}>{t("ws.earlier", { n: Math.min(first, 2000) })}</button></div>}
      {messages.slice(first).map((m, i) => {
        const n = dropped + first + i;
        return <Frame key={n} m={m} n={n} t0={t0} open={open === n} closed={closed} onToggle={onToggle} onEdit={onEdit} />;
      })}
      {!closed && (
        <div className="ws-compose">
          <div className="ws-compose-bar">
            <button className={draft.toServer ? "active" : ""} onClick={() => setDraft({ ...draft, toServer: true })} title={t("ws.toServerTitle")}>{t("ws.toServer")}</button>
            <button className={!draft.toServer ? "active" : ""} onClick={() => setDraft({ ...draft, toServer: false })} title={t("ws.toClientTitle")}>{t("ws.toClient")}</button>
            <span className="spacer" />
            <button className={!draft.binary ? "active" : ""} onClick={() => setDraft({ ...draft, binary: false })}>{t("ws.text")}</button>
            <button className={draft.binary ? "active" : ""} onClick={() => setDraft({ ...draft, binary: true })} title={t("ws.base64Title")}>Base64</button>
            {!draft.binary && <button onClick={format} title={t("ws.formatJson")}>{"{ }"}</button>}
            <button className="primary" disabled={!draft.data} onClick={send}>{t("detail.send")}</button>
          </div>
          <CodeArea kind="json" rows={3} value={draft.data} placeholder={t(draft.binary ? "ws.base64Placeholder" : "ws.textPlaceholder")}
            onChange={(e) => setDraft({ ...draft, data: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.data) send(); }} />
          {error && <div className="err">{error}</div>}
        </div>
      )}
    </div>
  );
}

function Pane(props: { title: string; flow: Flow; response: boolean }) {
  useLang();
  const { flow, response } = props;
  const msg = response ? flow.response : flow.request;
  const [tab, setTab] = useState<Tab>("body");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);

  useEffect(() => {
    setBytes(null);
    if (!msg) return;
    let live = true;
    api.getBody(flow.id, response).then((b) => { if (live) setBytes(new Uint8Array(b)); });
    return () => { live = false; };
  }, [flow.id, response, flow.state, msg?.body_size]);

  const query = useMemo(() => {
    try { return [...new URL(flow.url).searchParams.entries()] as Headers; } catch { return []; }
  }, [flow.url]);

  const ws = flow.status === 101 || flow.ws_messages.length > 0;
  const tabs: Tab[] = response
    ? ws ? ["messages", "headers", "timing"] : ["headers", "cookies", "body", "raw", "timing"]
    : flow.graphql ? ["graphql", "headers", "query", "body", "raw"] : ["headers", "query", "cookies", "body", "raw"];
  useEffect(() => {
    if (ws && response) setTab("messages");
    else if (flow.graphql && !response) setTab("graphql");
    else if (!tabs.includes(tab)) setTab("body");
  }, [flow.id]);
  const firstLine = response ? `${flow.http_version} ${flow.status ?? ""}` : `${flow.method} ${flow.path} ${flow.http_version}`;
  const raw = useMemo(() => {
    if (tab !== "raw" || !msg) return null;
    const body = !bytes ? "" : !isText(bytes) ? t("detail.binary", { size: formatBytes(bytes.length) })
      : bytes.length > TEXT_CAP ? `${new TextDecoder().decode(bytes.subarray(0, TEXT_CAP))}\n${t("detail.rawMore", { size: formatBytes(bytes.length - TEXT_CAP) })}`
      : new TextDecoder().decode(bytes);
    return highlightHttp(firstLine + "\n" + msg.headers.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\n" + body);
  }, [tab, msg, bytes, firstLine]);

  return (
    <section className="pane">
      <header className="pane-head">
        <strong>{props.title}</strong>
        {tabs.map((id) => (
          <button key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{t(`detail.tab.${id}`)}</button>
        ))}
        <span className="spacer" />
        {msg && <span className="muted">{formatBytes(msg.body_size)}</span>}
      </header>
      <div className="pane-body">
        {tab === "timing" ? (
          <Timing flow={flow} />
        ) : tab === "messages" ? (
          <Messages flowId={flow.id} messages={flow.ws_messages} dropped={flow.ws_dropped} />
        ) : tab === "graphql" ? (
          <GraphQL flow={flow} bytes={bytes} />
        ) : !msg ? (
          <div className="muted pad">{flow.error ?? t("detail.waitingResponse")}</div>
        ) : tab === "headers" ? (
          <HeaderTable headers={msg.headers} />
        ) : tab === "query" ? (
          <HeaderTable headers={query} />
        ) : tab === "cookies" ? (
          <HeaderTable headers={cookies(msg.headers, response)} />
        ) : tab === "body" ? (
          /protobuf|grpc/.test(header(msg.headers, "content-type") ?? "")
            ? <ProtoBody flow={flow} response={response} bytes={bytes} contentType={header(msg.headers, "content-type")} />
            : <BodyView bytes={bytes} contentType={header(msg.headers, "content-type")} />
        ) : (
          <pre className="code">{raw}</pre>
        )}
      </div>
    </section>
  );
}

/** "*.example.com" for "api.example.com"; null when there is no parent domain worth wildcarding. */
export function parentWildcard(host: string): string | null {
  const parts = host.split(".");
  return parts.length > 2 && !/^\d+$/.test(parts[parts.length - 1]) ? `*.${parts.slice(1).join(".")}` : null;
}

/** Same cap as the core (MAX_WS_MESSAGES). */
const MAX_WS = 10_000;

/** Refetches when the flow changes; new WebSocket frames are fetched on their own and appended. */
export const FlowDetail = memo(function FlowDetail({ summary, onSsl, onPin, decrypts }: { summary: FlowSummary; onSsl: (host: string, on: boolean) => void; onPin: (id: number, pinned: boolean) => void; decrypts: (host: string) => boolean }) {
  useLang();
  const [flow, setFlow] = useState<Flow | null>(null);
  // Every upsert replaces the summary; a new frame (ws_count) or a pin needs no full refetch.
  const { ws_count, pinned: _pinned, color: _color, comment: _comment, ...shown } = summary;
  const key = JSON.stringify(shown);
  useEffect(() => {
    let live = true;
    api.getFlow(summary.id).then((f) => { if (live) setFlow(f); });
    return () => { live = false; };
  }, [key]);
  useEffect(() => {
    if (!flow || flow.id !== summary.id) return;
    const next = flow.ws_dropped + flow.ws_messages.length;
    if (ws_count <= next) return;
    let live = true;
    api.getWsMessages(flow.id, next).then((r) => {
      if (!live || !r) return;
      const [start, frames] = r;
      // Frames we missed were dropped in the core: start over from what it still has.
      const merged = start === next ? flow.ws_messages.concat(frames) : frames;
      const kept = merged.slice(-MAX_WS);
      setFlow({ ...flow, ws_messages: kept, ws_dropped: (start === next ? flow.ws_dropped : start) + merged.length - kept.length });
    });
    return () => { live = false; };
  }, [flow, ws_count]);
  if (!flow) return <div className="detail muted pad">{t("detail.notFound")}</div>;
  return (
    <div className="detail">
      <div className="detail-url" title={flow.url}>
        <button className={`pin ${summary.pinned ? "on" : ""}`} onClick={() => onPin(flow.id, !summary.pinned)} title={t(summary.pinned ? "detail.unpin" : "detail.pin")}><Icon name="pin" /></button>
        <span className={`method m-${flow.method}`}>{flow.method}</span> <span className="ellipsis grow">{flow.url}</span>
        {flow.method !== "CONNECT" && (flow.scheme === "https" || flow.scheme === "wss") && (
          <button className="linkish" onClick={() => onSsl(flow.host, false)} title={t("detail.stopDecrypt")}><Icon name="unlock" size={12} /> {t("detail.decryptedDisable")}</button>
        )}
      </div>
      <input key={flow.id} className="flow-comment" placeholder={t("detail.commentPlaceholder")} defaultValue={summary.comment ?? ""} aria-label={t("detail.comment")}
        onBlur={(e) => { if (e.target.value.trim() !== (summary.comment ?? "")) api.mark(flow.id, summary.color, e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
      {flow.method === "CONNECT" && decrypts(flow.host) && (
        <div className="ssl-banner on">
          <div className="ssl-banner-title"><Icon name="unlock" /> {rich(t("detail.sslOn", { host: flow.host }))}</div>
          <p>{t("detail.sslOnText")}</p>
        </div>
      )}
      {flow.method === "CONNECT" && !decrypts(flow.host) && (
        <div className="ssl-banner">
          <div className="ssl-banner-title"><Icon name="lock" /> {rich(t("detail.sslOff", { host: flow.host }))}</div>
          <p>{t("detail.sslOffText")}</p>
          <div className="row">
            <button className="primary" onClick={() => onSsl(flow.host, true)}>{t("detail.enableFor", { host: flow.host })}</button>
            {parentWildcard(flow.host) && <button onClick={() => onSsl(parentWildcard(flow.host)!, true)}>{t("detail.enableFor", { host: parentWildcard(flow.host)! })}</button>}
          </div>
          <p className="muted small">{rich(t("detail.trust"))}</p>
        </div>
      )}
      <div className="detail-panes">
        <Pane title={t("detail.request")} flow={flow} response={false} />
        {flow.method !== "CONNECT" && <Pane title={t("detail.response")} flow={flow} response={true} />}
      </div>
    </div>
  );
});
