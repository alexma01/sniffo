import { useEffect, useMemo, useState } from "react";
import { api, Flow, FlowSummary, formatBytes, header, Headers, WsMessage } from "./api";
import { JsonTree } from "./JsonTree";
import { decode, grpcFrames, toPlain } from "./protobuf";

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
  if (bytes.length > limit) lines.push(`… ${formatBytes(bytes.length - limit)} more`);
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
            {grpc && <div className="muted pad-s">gRPC message {i + 1}{m.compressed ? " (compressed — showing raw)" : ""} · {formatBytes(m.data.length)}</div>}
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
  const [types, setTypes] = useState<string[]>([]);
  const [type, setType] = useState<string>(() => { try { return localStorage.getItem(protoKey(flow, response)) ?? ""; } catch { return ""; } });
  const [decoded, setDecoded] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getProtoSchemas().then((s) => setTypes(s.messages)); }, []);
  useEffect(() => {
    setDecoded(null); setError(null);
    if (!type) return;
    api.decodeProto(flow.id, response, type).then(setDecoded, (e) => setError(String(e)));
  }, [flow.id, response, type, flow.state]);

  const choose = (t: string) => {
    setType(t);
    try { if (t) localStorage.setItem(protoKey(flow, response), t); else localStorage.removeItem(protoKey(flow, response)); } catch { /* storage unavailable */ }
  };

  return (
    <div>
      <div className="seg">
        <select value={type} onChange={(e) => choose(e.target.value)} title={types.length ? "Message type from your .proto schemas" : "Add .proto files in Settings to decode with a schema"}>
          <option value="">Raw (no schema)</option>
          {types.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      {error && <p className="err pad-s">{error}</p>}
      {type && decoded ? decoded.map((m, i) => <div key={i} className="part"><JsonTree value={m} /></div>) : <BodyView bytes={bytes} contentType={contentType} />}
    </div>
  );
}

function GraphQL({ flow, bytes }: { flow: Flow; bytes: Uint8Array | null }) {
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
  if (!op) return <div className="muted pad">Not a GraphQL request</div>;
  return (
    <div>
      <div className="pad-s"><span className="badge gql">{flow.graphql}</span></div>
      <pre className="code">{String(op.query ?? "").trim()}</pre>
      {op.variables != null && (<><div className="muted pad-s">Variables</div><JsonTree value={op.variables} /></>)}
    </div>
  );
}

function BodyView({ bytes, contentType }: { bytes: Uint8Array | null; contentType?: string }) {
  const [mode, setMode] = useState<"tree" | "pretty">("tree");
  const [forceProto, setForceProto] = useState(false);
  const ct = (contentType ?? "").toLowerCase();
  const url = useMemo(() => {
    if (!bytes || !ct.startsWith("image/")) return null;
    return URL.createObjectURL(new Blob([bytes.slice()], { type: ct }));
  }, [bytes, ct]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  if (!bytes) return <div className="muted pad">Loading…</div>;
  if (!bytes.length) return <div className="muted pad">No body</div>;
  if (url) return <div className="pad"><img className="preview" src={url} /></div>;

  if (ct.startsWith("multipart/")) {
    const parts = parseMultipart(bytes, contentType!);
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
  }
  if (ct.includes("protobuf") || ct.startsWith("application/grpc") || forceProto) {
    const view = protobufView(bytes, ct.startsWith("application/grpc"));
    if (view) return view;
  }
  if (!isText(bytes)) {
    return (
      <div>
        <div className="seg"><button onClick={() => setForceProto(true)}>Decode as Protobuf</button></div>
        {forceProto && <p className="err pad-s">Not a valid protobuf message</p>}
        <pre className="code">{hexdump(bytes)}</pre>
      </div>
    );
  }
  const text = new TextDecoder().decode(bytes);

  if (ct.includes("x-www-form-urlencoded")) {
    return <HeaderTable headers={[...new URLSearchParams(text).entries()]} />;
  }
  if (ct.includes("json") || /^\s*[{[]/.test(text)) {
    try {
      const value = JSON.parse(text);
      return (
        <div>
          <div className="seg">
            <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>Tree</button>
            <button className={mode === "pretty" ? "active" : ""} onClick={() => setMode("pretty")}>Pretty</button>
          </div>
          {mode === "tree" ? <JsonTree value={value} /> : <pre className="code">{JSON.stringify(value, null, 2)}</pre>}
        </div>
      );
    } catch { /* not JSON after all */ }
  }
  if (ct.includes("xml")) return <pre className="code">{prettyXml(text)}</pre>;
  return <pre className="code">{text}</pre>;
}

function HeaderTable({ headers }: { headers: Headers }) {
  if (!headers.length) return <div className="muted pad">None</div>;
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
  const rows: Headers = [
    ["Started", new Date(flow.started_ms).toLocaleString()],
    ["Waiting (TTFB)", flow.ttfb_ms != null ? `${flow.ttfb_ms} ms` : "—"],
    ["Download", flow.ttfb_ms != null && flow.duration_ms != null ? `${flow.duration_ms - flow.ttfb_ms} ms` : "—"],
    ["Total", flow.duration_ms != null ? `${flow.duration_ms} ms` : "—"],
    ["Client", flow.client_addr],
    ["Protocol", `${flow.scheme.toUpperCase()} · ${flow.http_version}`],
    ["State", flow.state + (flow.error ? ` — ${flow.error}` : "")],
  ];
  return <HeaderTable headers={rows} />;
}

function Messages({ flowId, messages }: { flowId: number; messages: WsMessage[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState({ toServer: true, binary: false, data: "" });
  const [error, setError] = useState<string | null>(null);
  const closed = messages.some((m) => m.kind === "close");
  const send = () => api.sendWs(flowId, draft.toServer, draft.data, draft.binary).then(() => setError(null), (e) => setError(String(e)));
  const format = () => { try { setDraft({ ...draft, data: JSON.stringify(JSON.parse(draft.data), null, 2) }); setError(null); } catch (e) { setError(String(e)); } };
  const t0 = messages[0]?.time_ms ?? 0;
  return (
    <div className="ws">
      {!messages.length && <div className="muted pad">No frames yet</div>}
      {messages.map((m, i) => (
        <div key={i}>
          <div className={`ws-row ${m.outgoing ? "out" : "in"} ${open === i ? "open" : ""}`} onClick={() => setOpen(open === i ? null : i)}>
            <span className="ws-dir">{m.outgoing ? "↑" : "↓"}</span>
            <span className="ws-time">+{((m.time_ms - t0) / 1000).toFixed(3)}s</span>
            <span className="ws-kind">{m.kind}</span>
            <span className="ws-size">{formatBytes(m.size)}</span>
            <span className="ws-data">{m.injected && <span className="badge warn" title="Sent from Sniffo">injected</span>}{m.data}</span>
          </div>
          {open === i && (m.kind === "text" || m.kind === "binary") && !closed && (
            <div className="seg"><button onClick={() => setDraft({ toServer: m.outgoing, binary: m.kind === "binary", data: m.data })}>Edit &amp; resend</button></div>
          )}
          {open === i && m.kind === "text" && <BodyView bytes={new TextEncoder().encode(m.data)} />}
          {open === i && m.kind === "binary" && <BodyView bytes={Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0))} />}
        </div>
      ))}
      {!closed && (
        <div className="ws-compose">
          <div className="ws-compose-bar">
            <button className={draft.toServer ? "active" : ""} onClick={() => setDraft({ ...draft, toServer: true })} title="Send to the server as if the client sent it">↑ Server</button>
            <button className={!draft.toServer ? "active" : ""} onClick={() => setDraft({ ...draft, toServer: false })} title="Send to the client as if the server sent it">↓ Client</button>
            <span className="spacer" />
            <button className={!draft.binary ? "active" : ""} onClick={() => setDraft({ ...draft, binary: false })}>Text</button>
            <button className={draft.binary ? "active" : ""} onClick={() => setDraft({ ...draft, binary: true })} title="Binary frame, payload as base64">Base64</button>
            {!draft.binary && <button onClick={format} title="Format JSON">{"{ }"}</button>}
            <button className="primary" disabled={!draft.data} onClick={send}>Send</button>
          </div>
          <textarea rows={3} value={draft.data} placeholder={draft.binary ? "base64 payload" : "text or JSON — ⌘↩ to send"}
            onChange={(e) => setDraft({ ...draft, data: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.data) send(); }} />
          {error && <div className="err">{error}</div>}
        </div>
      )}
    </div>
  );
}

function Pane(props: { title: string; flow: Flow; response: boolean }) {
  const { flow, response } = props;
  const msg = response ? flow.response : flow.request;
  const [tab, setTab] = useState<Tab>("body");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);

  useEffect(() => {
    setBytes(null);
    if (!msg) return;
    api.getBody(flow.id, response).then((b) => setBytes(new Uint8Array(b)));
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

  return (
    <section className="pane">
      <header className="pane-head">
        <strong>{props.title}</strong>
        {tabs.map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
        <span className="spacer" />
        {msg && <span className="muted">{formatBytes(msg.body_size)}</span>}
      </header>
      <div className="pane-body">
        {tab === "timing" ? (
          <Timing flow={flow} />
        ) : tab === "messages" ? (
          <Messages flowId={flow.id} messages={flow.ws_messages} />
        ) : tab === "graphql" ? (
          <GraphQL flow={flow} bytes={bytes} />
        ) : !msg ? (
          <div className="muted pad">{flow.error ?? "Waiting for response…"}</div>
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
          <pre className="code">
            {firstLine + "\n" + msg.headers.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\n" +
              (bytes && isText(bytes) ? new TextDecoder().decode(bytes) : bytes ? `<${formatBytes(bytes.length)} binary>` : "")}
          </pre>
        )}
      </div>
    </section>
  );
}

/** Refetches whenever the summary object changes (each upsert event replaces it). */
export function FlowDetail({ summary }: { summary: FlowSummary }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  useEffect(() => { api.getFlow(summary.id).then(setFlow); }, [summary]);
  if (!flow) return <div className="detail muted pad">Flow not found</div>;
  return (
    <div className="detail">
      <div className="detail-url" title={flow.url}>
        <span className="method">{flow.method}</span> {flow.url}
      </div>
      {flow.method === "CONNECT" && (
        <div className="muted pad-s">
          Encrypted tunnel passed through untouched: SSL Proxying is not enabled for {flow.host}. Right-click the row → Enable SSL Proxying, then retry the request.
        </div>
      )}
      <div className="detail-panes">
        <Pane title="Request" flow={flow} response={false} />
        {flow.method !== "CONNECT" && <Pane title="Response" flow={flow} response={true} />}
      </div>
    </div>
  );
}
