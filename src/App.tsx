import { useEffect, useMemo, useState } from "react";
import { api, FlowEvent, FlowSummary, ProxyStatus } from "./api";
import { compile, emptyFilter, Filter, STATUSES, toggle, TYPES } from "./filters";
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
          else if (e.type === "removed") e.data.forEach((id) => next.delete(id));
          else next.set(e.data.id, e.data);
        }
        return next;
      });
    const un = [api.onFlows(apply), api.onResync(reload)];
    return () => { un.forEach((p) => p.then((f) => f())); };
  }, []);
  return flows;
}

interface Menu { id: number; x: number; y: number }

export default function App() {
  const flows = useFlows();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>(emptyFilter);
  const [searchBodies, setSearchBodies] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);

  const refresh = () => api.status().then(setStatus);
  const start = () => api.start().then(() => setError(null), (e) => setError(String(e))).finally(refresh);
  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }));

  useEffect(() => {
    api.status().then((s) => (s.running ? setStatus(s) : start()));
  }, []);

  // Body search runs in the backend; debounce and re-run as new flows arrive.
  useEffect(() => {
    if (!searchBodies || !filter.text) { set({ bodyHits: null }); return; }
    const t = setTimeout(() => api.search(filter.text).then((ids) => set({ bodyHits: new Set(ids) })), 300);
    return () => clearTimeout(t);
  }, [searchBodies, filter.text, searchBodies && flows.size]);

  const hosts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of flows.values()) m.set(f.host, (m.get(f.host) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [flows]);

  const predicate = useMemo(() => compile(filter), [filter]);
  const visible = useMemo(
    () => (typeof predicate === "string" ? [] : [...flows.values()].filter(predicate)),
    [flows, predicate],
  );
  const sel = selected != null ? flows.get(selected) : undefined;
  const pinnedCount = useMemo(() => [...flows.values()].filter((f) => f.pinned).length, [flows]);

  const remove = (ids: number[]) => { api.remove(ids); if (selected != null && ids.includes(selected)) setSelected(null); };

  useEffect(() => {
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Backspace" || e.key === "Delete") && selected != null && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) remove([selected]);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [selected]);

  const menuFlow = menu ? flows.get(menu.id) : undefined;

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
        <button onClick={() => { api.clear(); setSelected(null); }} title="Remove all unpinned flows">Clear</button>
        <span className="spacer" />
        <span className="muted">{visible.length} / {flows.size}</span>
        <button onClick={() => setShowSettings(true)}>Settings</button>
      </header>
      <div className="filterbar">
        <input
          className={`filter ${typeof predicate === "string" ? "invalid" : ""}`}
          placeholder={searchBodies ? "Search URL, headers and bodies" : filter.regex ? "Regex on URL, method, status" : "Filter: URL, method, status"}
          title={typeof predicate === "string" ? predicate : undefined}
          value={filter.text}
          onChange={(e) => set({ text: e.target.value })}
        />
        <button className={`chip ${filter.regex ? "on" : ""}`} disabled={searchBodies} onClick={() => set({ regex: !filter.regex })} title="Regular expression">.*</button>
        <button className={`chip ${searchBodies ? "on" : ""}`} onClick={() => setSearchBodies(!searchBodies)} title="Also search headers and bodies">Body</button>
        <span className="sep" />
        {TYPES.map((t) => (
          <button key={t} className={`chip ${filter.types.has(t) ? "on" : ""}`} onClick={() => set({ types: toggle(filter.types, t) })}>{t}</button>
        ))}
        <span className="sep" />
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${filter.statuses.has(s) ? "on" : ""}`} onClick={() => set({ statuses: toggle(filter.statuses, s) })}>{s}</button>
        ))}
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Auto-scroll</label>
      </div>
      {showSettings && <Settings status={status} onClose={() => setShowSettings(false)} onChanged={refresh} />}
      {error && <div className="banner">{error}</div>}
      <div className="main">
        <aside className="sidebar">
          <div className={`side-item ${!filter.host && !filter.pinnedOnly ? "active" : ""}`} onClick={() => set({ host: null, pinnedOnly: false })}>
            All <span className="muted">{flows.size}</span>
          </div>
          <div className={`side-item ${filter.pinnedOnly ? "active" : ""}`} onClick={() => set({ host: null, pinnedOnly: true })}>
            📌 Pinned <span className="muted">{pinnedCount}</span>
          </div>
          <div className="side-title">Domains</div>
          {hosts.map(([h, n]) => (
            <div key={h} className={`side-item ${filter.host === h ? "active" : ""}`} onClick={() => set({ host: h, pinnedOnly: false })} title={h}>
              <span className="ellipsis">{h}</span> <span className="muted">{n}</span>
            </div>
          ))}
        </aside>
        <div className="content">
          <FlowList
            flows={visible}
            selected={selected}
            onSelect={(id) => { setSelected(id); setFollow(false); }}
            onContextMenu={(id, x, y) => { setSelected(id); setMenu({ id, x, y }); }}
            follow={follow}
          />
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
      {menu && menuFlow && (
        <div className="menu" style={{ left: menu.x, top: menu.y }}>
          <div onClick={() => api.pin(menuFlow.id, !menuFlow.pinned)}>{menuFlow.pinned ? "Unpin" : "Pin"}</div>
          <div onClick={() => navigator.clipboard.writeText(menuFlow.url)}>Copy URL</div>
          <div onClick={() => set({ host: menuFlow.host, pinnedOnly: false })}>Show only {menuFlow.host}</div>
          <hr />
          <div className="danger" onClick={() => remove([menuFlow.id])}>Delete</div>
        </div>
      )}
    </div>
  );
}
