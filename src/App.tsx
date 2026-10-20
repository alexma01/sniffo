import { useEffect, useMemo, useState } from "react";
import { api, FlowEvent, FlowSummary, ProxyStatus } from "./api";
import { FlowDetail } from "./FlowDetail";
import { FlowList } from "./FlowList";
import { Settings } from "./Settings";
import "./App.css";

function useFlows() {
  const [flows, setFlows] = useState<Map<number, FlowSummary>>(new Map());
  useEffect(() => {
    const reload = () => api.listFlows().then((list) => setFlows(new Map(list.map((f) => [f.id, f]))));
    reload();
    const apply = (events: FlowEvent[]) =>
      setFlows((prev) => {
        let next = new Map(prev);
        for (const e of events) {
          if (e.type === "cleared") next = new Map();
          else next.set(e.flow.id, e.flow);
        }
        return next;
      });
    const un = [api.onFlows(apply), api.onResync(reload)];
    return () => { un.forEach((p) => p.then((f) => f())); };
  }, []);
  return flows;
}

function matches(f: FlowSummary, q: string) {
  if (!q) return true;
  const s = q.toLowerCase();
  return f.url.toLowerCase().includes(s) || f.method.toLowerCase() === s || String(f.status ?? "").startsWith(s);
}

export default function App() {
  const flows = useFlows();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [host, setHost] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = () => api.status().then(setStatus);
  const start = () => api.start().then(() => setError(null), (e) => setError(String(e))).finally(refresh);

  useEffect(() => {
    api.status().then((s) => (s.running ? setStatus(s) : start()));
  }, []);

  const hosts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of flows.values()) m.set(f.host, (m.get(f.host) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [flows]);

  const visible = useMemo(
    () => [...flows.values()].filter((f) => (!host || f.host === host) && matches(f, filter)),
    [flows, host, filter],
  );
  const sel = selected != null ? flows.get(selected) : undefined;

  return (
    <div className="app">
      <header className="toolbar">
        <span className={`dot ${status?.running ? "on" : "off"}`} />
        <span>{status?.running ? `Listening on ${status.address}` : "Proxy stopped"}</span>
        {status?.running ? (
          <button onClick={() => api.stop().finally(refresh)}>Stop</button>
        ) : (
          <button onClick={start}>Start</button>
        )}
        <label className="check" title="Route this machine's HTTP/HTTPS traffic through Sniffo">
          <input
            type="checkbox"
            checked={!!status?.system_proxy}
            disabled={!status?.running}
            onChange={(e) => api.setSystemProxy(e.target.checked).then(() => setError(null), (err) => setError(String(err))).finally(refresh)}
          /> System proxy
        </label>
        {status && !status.ca_trusted && (
          <button className="warn" onClick={() => setShowSettings(true)}>Certificate not trusted</button>
        )}
        <button onClick={() => { api.clear(); setSelected(null); }}>Clear</button>
        <input className="filter" placeholder="Filter: URL, method, status" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Auto-scroll</label>
        <span className="spacer" />
        <span className="muted">{visible.length} / {flows.size}</span>
        <button onClick={() => setShowSettings(true)}>Settings</button>
      </header>
      {showSettings && <Settings status={status} onClose={() => setShowSettings(false)} onChanged={refresh} />}
      {error && <div className="banner">{error}</div>}
      <div className="main">
        <aside className="sidebar">
          <div className={`side-item ${host == null ? "active" : ""}`} onClick={() => setHost(null)}>
            All <span className="muted">{flows.size}</span>
          </div>
          <div className="side-title">Domains</div>
          {hosts.map(([h, n]) => (
            <div key={h} className={`side-item ${host === h ? "active" : ""}`} onClick={() => setHost(h)} title={h}>
              <span className="ellipsis">{h}</span> <span className="muted">{n}</span>
            </div>
          ))}
        </aside>
        <div className="content">
          <FlowList flows={visible} selected={selected} onSelect={(id) => { setSelected(id); setFollow(false); }} follow={follow} />
          {sel ? (
            <FlowDetail summary={sel} />
          ) : (
            <div className="detail empty muted">
              {status?.running
                ? `Set your HTTP/HTTPS proxy to ${status.address} and trust the CA at ${status.ca_path}`
                : "Start the proxy to capture traffic"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
