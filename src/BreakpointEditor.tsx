import { useEffect, useState } from "react";
import { CodeArea } from "./highlight";
import { api, BreakpointHit, Editable } from "./api";
import { headersToText, textToHeaders } from "./RulesEditor";

/** Edits the oldest paused flow; the others wait in the queue. */
export function BreakpointEditor({ hits, onDone }: { hits: BreakpointHit[]; onDone: (hit: BreakpointHit) => void }) {
  const hit = hits[0];
  const [msg, setMsg] = useState<Editable>(hit.message);
  const [headers, setHeaders] = useState(headersToText(hit.message.headers));

  useEffect(() => { setMsg(hit.message); setHeaders(headersToText(hit.message.headers)); }, [hit]);

  const finish = (abort: boolean) => {
    const decision = abort ? { type: "abort" as const } : { type: "continue" as const, message: { ...msg, headers: textToHeaders(headers) } };
    api.resume(hit.id, hit.response, decision).finally(() => onDone(hit));
  };

  const more = hits.length > 1 && <span className="muted"> ({hits.length - 1} more waiting)</span>;
  if (hit.ws) return (
    <div className="modal-back">
      <div className="modal wide">
        <h3>Breakpoint — WebSocket {hit.response ? "↓ server → client" : "↑ client → server"} #{hit.id}{more}</h3>
        <div className="form">
          <label>
            {hit.ws === "binary" ? "Binary frame (base64)" : "Text frame"}
            <CodeArea kind="json" rows={12} value={msg.body ?? ""} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
          </label>
        </div>
        <div className="row end">
          <button className="danger" onClick={() => finish(true)}>Drop frame</button>
          <button className="primary" onClick={() => finish(false)}>Forward</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-back">
      <div className="modal wide">
        <h3>
          Breakpoint — {hit.response ? "Response" : "Request"} #{hit.id}
          {more}
        </h3>
        <div className="form">
          {hit.response ? (
            <label>Status <input className="input" value={msg.status} onChange={(e) => setMsg({ ...msg, status: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
          ) : (
            <div className="row">
              <label>Method <input className="input" value={msg.method} onChange={(e) => setMsg({ ...msg, method: e.target.value.toUpperCase() })} /></label>
              <label className="grow">URL <input className="input wide" value={msg.url} onChange={(e) => setMsg({ ...msg, url: e.target.value })} /></label>
            </div>
          )}
          <label>Headers <CodeArea kind="headers" rows={8} value={headers} onChange={(e) => setHeaders(e.target.value)} /></label>
          <label>
            Body
            {msg.body == null ? (
              <p className="muted">Binary body — forwarded unchanged.</p>
            ) : (
              <CodeArea kind="json" rows={12} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
            )}
          </label>
        </div>
        <div className="row end">
          <button className="danger" onClick={() => finish(true)}>Abort</button>
          <button className="primary" onClick={() => finish(false)}>Execute</button>
        </div>
      </div>
    </div>
  );
}
