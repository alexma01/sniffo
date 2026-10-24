import { useState } from "react";
import { backdrop } from "./backdrop";
import { CodeArea } from "./highlight";
import { api } from "./api";
import { t, useLang } from "./i18n";
import { headersToText, textToHeaders } from "./RulesEditor";
import { parseCurl, Req } from "./snippets";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Builds and sends a request through the proxy (it shows up in the list like any other). */
export function Compose({ initial, onClose }: { initial?: Req; onClose: () => void }) {
  useLang();
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
      setMsg({ ok: true, text: t("compose.sent", { status }) });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" {...backdrop(onClose)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{t("compose.title")}</h3>
        <div className="form">
          <div className="row">
            <select value={METHODS.includes(method) ? method : "other"} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => <option key={m}>{m}</option>)}
              {!METHODS.includes(method) && <option value="other">{method}</option>}
            </select>
            <input className="input wide grow" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
            <button className="primary" disabled={busy} onClick={send}>{t("detail.send")}</button>
          </div>
          <label>{t("detail.headers")} <CodeArea kind="headers" rows={6} value={headers} onChange={(e) => setHeaders(e.target.value)} /></label>
          <label>{t("detail.body")} <CodeArea kind="json" rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          <details>
            <summary>{t("compose.importCurl")}</summary>
            <textarea rows={4} value={curl} placeholder="curl 'https://…' -H '…'" onChange={(e) => setCurl(e.target.value)} />
            <div className="row"><button onClick={importCurl} disabled={!curl.trim()}>{t("compose.import")}</button></div>
          </details>
          {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
        </div>
        <div className="row end"><button onClick={onClose}>{t("detail.close")}</button></div>
      </div>
    </div>
  );
}
