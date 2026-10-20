import { diffLines } from "diff";
import { useEffect, useState } from "react";
import { api, Flow } from "./api";

/** Raw-ish text of one side of a flow, pretty-printing JSON so diffs line up. */
async function render(flow: Flow, response: boolean): Promise<string> {
  const msg = response ? flow.response : flow.request;
  if (!msg) return flow.error ?? "(no response)";
  const first = response ? `${flow.http_version} ${flow.status ?? ""}` : `${flow.method} ${flow.url}`;
  const headers = [...msg.headers].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join("\n");
  let body = new TextDecoder().decode(await api.getBody(flow.id, response));
  try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* not JSON */ }
  return `${first}\n${headers}\n\n${body}`;
}

function DiffView({ a, b }: { a: string; b: string }) {
  const parts = diffLines(a, b);
  return (
    <pre className="code diff">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? "add" : p.removed ? "del" : ""}>
          {p.value.replace(/\n$/, "").split("\n").map((l) => `${p.added ? "+" : p.removed ? "-" : " "} ${l}`).join("\n") + "\n"}
        </span>
      ))}
    </pre>
  );
}

export function Diff({ left, right, onClose }: { left: number; right: number; onClose: () => void }) {
  const [texts, setTexts] = useState<{ req: [string, string]; res: [string, string] } | null>(null);
  const [tab, setTab] = useState<"req" | "res">("res");

  useEffect(() => {
    (async () => {
      const [a, b] = await Promise.all([api.getFlow(left), api.getFlow(right)]);
      if (!a || !b) return;
      const [ra, rb, sa, sb] = await Promise.all([render(a, false), render(b, false), render(a, true), render(b, true)]);
      setTexts({ req: [ra, rb], res: [sa, sb] });
    })();
  }, [left, right]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide tall" onClick={(e) => e.stopPropagation()}>
        <h3>Diff #{left} → #{right}</h3>
        <div className="seg flush">
          <button className={tab === "req" ? "active" : ""} onClick={() => setTab("req")}>Request</button>
          <button className={tab === "res" ? "active" : ""} onClick={() => setTab("res")}>Response</button>
        </div>
        {texts ? <DiffView a={texts[tab][0]} b={texts[tab][1]} /> : <p className="muted">Loading…</p>}
        <div className="row end"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
