import { useState } from "react";
import { api } from "./api";
import { headersToText, textToHeaders } from "./RulesEditor";
import { parseCurl, Req } from "./snippets";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Builds and sends a request through the proxy (it shows up in the list like any other). */
export function Compose({ initial, onClose }: { initial?: Req; onClose: () => void }) {
  const [method, setMethod] = useState(initial?.method ?? "GET");
  const [url, setUrl] = useState(initial?.url ?? "https://");
  const [headers, setHeaders] = useState(headersToText(initial?.headers ?? [["accept", "*/*"]]));
  const [body, setBody] = useState(initial?.body ?? "");
  const [curl, setCurl] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const importCurl = () => {
    try {
      const r = parseCurl(curl);
      setMethod(r.method); setUrl(r.url); setHeaders(headersToText(r.headers)); setBody(r.body); setCurl("");
      setMsg(null);
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      const status = await api.compose(method, url, textToHeaders(headers), body);
      setMsg({ ok: true, text: `Sent — ${status}. The request is in the list.` });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Compose request</h3>
        <div className="form">
          <div className="row">
            <select value={METHODS.includes(method) ? method : "other"} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => <option key={m}>{m}</option>)}
              {!METHODS.includes(method) && <option value="other">{method}</option>}
            </select>
            <input className="input wide grow" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
            <button className="primary" disabled={busy} onClick={send}>Send</button>
          </div>
          <label>Headers <textarea rows={6} value={headers} onChange={(e) => setHeaders(e.target.value)} /></label>
          <label>Body <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          <details>
            <summary>Import from cURL</summary>
            <textarea rows={4} value={curl} placeholder="curl 'https://…' -H '…'" onChange={(e) => setCurl(e.target.value)} />
            <div className="row"><button onClick={importCurl} disabled={!curl.trim()}>Import</button></div>
          </details>
          {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
        </div>
        <div className="row end"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
