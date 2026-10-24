import { useEffect, useState } from "react";
import { CodeArea } from "./highlight";
import { api, BreakpointHit, Editable } from "./api";
import { t, useLang } from "./i18n";
import { headersToText, textToHeaders } from "./RulesEditor";

/** Edits the oldest paused flow; the others wait in the queue. */
export function BreakpointEditor({ hits, onDone }: { hits: BreakpointHit[]; onDone: (hit: BreakpointHit) => void }) {
  useLang();
  const hit = hits[0];
  const [msg, setMsg] = useState<Editable>(hit.message);
  const [headers, setHeaders] = useState(headersToText(hit.message.headers));

  useEffect(() => { setMsg(hit.message); setHeaders(headersToText(hit.message.headers)); }, [hit]);

  const finish = (abort: boolean) => {
    const decision = abort ? { type: "abort" as const } : { type: "continue" as const, message: { ...msg, headers: textToHeaders(headers) } };
    api.resume(hit.id, hit.response, decision).finally(() => onDone(hit));
  };

  const more = hits.length > 1 && <span className="muted">{t("bp.waiting", { n: hits.length - 1 })}</span>;
  if (hit.ws) return (
    <div className="modal-back">
      <div className="modal wide">
        <h3>{t("bp.ws", { dir: t(hit.response ? "bp.wsDown" : "bp.wsUp"), id: hit.id })}{more}</h3>
        <div className="form">
          <label>
            {t(hit.ws === "binary" ? "bp.binaryFrame" : "bp.textFrame")}
            <CodeArea kind="json" rows={12} value={msg.body ?? ""} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
          </label>
        </div>
        <div className="row end">
          <button className="danger" onClick={() => finish(true)}>{t("bp.dropFrame")}</button>
          <button className="primary" onClick={() => finish(false)}>{t("bp.forward")}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-back">
      <div className="modal wide">
        <h3>
          {t(hit.response ? "bp.responseTitle" : "bp.requestTitle", { id: hit.id })}
          {more}
        </h3>
        <div className="form">
          {hit.response ? (
            <label>{t("bp.status")} <input className="input" value={msg.status} onChange={(e) => setMsg({ ...msg, status: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
          ) : (
            <div className="row">
              <label>{t("bp.method")} <input className="input" value={msg.method} onChange={(e) => setMsg({ ...msg, method: e.target.value.toUpperCase() })} /></label>
              <label className="grow">URL <input className="input wide" value={msg.url} onChange={(e) => setMsg({ ...msg, url: e.target.value })} /></label>
            </div>
          )}
          <label>{t("detail.headers")} <CodeArea kind="headers" rows={8} value={headers} onChange={(e) => setHeaders(e.target.value)} /></label>
          <label>
            {t("detail.body")}
            {msg.body == null ? (
              <p className="muted">{t("bp.binaryBody")}</p>
            ) : (
              <CodeArea kind="json" rows={12} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
            )}
          </label>
        </div>
        <div className="row end">
          <button className="danger" onClick={() => finish(true)}>{t("bp.abort")}</button>
          <button className="primary" onClick={() => finish(false)}>{t("bp.execute")}</button>
        </div>
      </div>
    </div>
  );
}
