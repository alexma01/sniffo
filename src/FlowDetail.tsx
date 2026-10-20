import { useEffect, useMemo, useState } from "react";
import { api, Flow, FlowSummary, formatBytes, header, Headers } from "./api";

type Tab = "headers" | "body" | "query" | "raw";

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

function BodyView({ bytes, contentType }: { bytes: Uint8Array | null; contentType?: string }) {
  const url = useMemo(() => {
    if (!bytes || !contentType?.startsWith("image/")) return null;
    return URL.createObjectURL(new Blob([bytes.slice()], { type: contentType }));
  }, [bytes, contentType]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  if (!bytes) return <div className="muted pad">Loading…</div>;
  if (!bytes.length) return <div className="muted pad">No body</div>;
  if (url) return <div className="pad"><img className="preview" src={url} /></div>;
  if (!isText(bytes)) return <pre className="code">{hexdump(bytes)}</pre>;
  const text = new TextDecoder().decode(bytes);
  if (contentType?.includes("json") || /^\s*[{[]/.test(text)) {
    try {
      return <pre className="code">{JSON.stringify(JSON.parse(text), null, 2)}</pre>;
    } catch { /* not JSON after all */ }
  }
  return <pre className="code">{text}</pre>;
}

function HeaderTable({ headers }: { headers: Headers }) {
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

  const tabs: Tab[] = response ? ["headers", "body", "raw"] : ["headers", "query", "body", "raw"];
  const firstLine = response
    ? `${flow.http_version} ${flow.status ?? ""}`
    : `${flow.method} ${flow.path} ${flow.http_version}`;

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
        {!msg ? (
          <div className="muted pad">{flow.error ?? "Waiting for response…"}</div>
        ) : tab === "headers" ? (
          <HeaderTable headers={msg.headers} />
        ) : tab === "query" ? (
          query.length ? <HeaderTable headers={query} /> : <div className="muted pad">No query parameters</div>
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
