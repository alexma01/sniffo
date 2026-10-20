import { useEffect, useMemo, useState } from "react";
import { api, Flow, FlowSummary, formatBytes, header, Headers, WsMessage } from "./api";
import { JsonTree } from "./JsonTree";

type Tab = "headers" | "query" | "cookies" | "body" | "raw" | "timing" | "messages";

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

function BodyView({ bytes, contentType }: { bytes: Uint8Array | null; contentType?: string }) {
  const [mode, setMode] = useState<"tree" | "pretty">("tree");
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
  if (!isText(bytes)) return <pre className="code">{hexdump(bytes)}</pre>;
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

function Messages({ messages }: { messages: WsMessage[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!messages.length) return <div className="muted pad">No frames yet</div>;
  const t0 = messages[0].time_ms;
  return (
    <div className="ws">
      {messages.map((m, i) => (
        <div key={i}>
          <div className={`ws-row ${m.outgoing ? "out" : "in"} ${open === i ? "open" : ""}`} onClick={() => setOpen(open === i ? null : i)}>
            <span className="ws-dir">{m.outgoing ? "↑" : "↓"}</span>
            <span className="ws-time">+{((m.time_ms - t0) / 1000).toFixed(3)}s</span>
            <span className="ws-kind">{m.kind}</span>
            <span className="ws-size">{formatBytes(m.size)}</span>
            <span className="ws-data">{m.data}</span>
          </div>
          {open === i && m.kind === "text" && <BodyView bytes={new TextEncoder().encode(m.data)} />}
          {open === i && m.kind === "binary" && <BodyView bytes={Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0))} />}
        </div>
      ))}
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
    : ["headers", "query", "cookies", "body", "raw"];
  useEffect(() => { if (ws && response) setTab("messages"); }, [flow.id]);
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
          <Messages messages={flow.ws_messages} />
        ) : !msg ? (
          <div className="muted pad">{flow.error ?? "Waiting for response…"}</div>
        ) : tab === "headers" ? (
          <HeaderTable headers={msg.headers} />
        ) : tab === "query" ? (
          <HeaderTable headers={query} />
        ) : tab === "cookies" ? (
          <HeaderTable headers={cookies(msg.headers, response)} />
        ) : tab === "body" ? (
          <BodyView bytes={bytes} contentType={header(msg.headers, "content-type")} />
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
      <div className="detail-panes">
        <Pane title="Request" flow={flow} response={false} />
        <Pane title="Response" flow={flow} response={true} />
      </div>
    </div>
  );
}
