import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { Logo } from "./Logo";
import { Command, Palette } from "./Palette";
import { api, BreakpointHit, FlowEvent, ScriptLog, FlowSummary, formatBytes, ProxyStatus, Rule, Rules, SslProxying } from "./api";
import { open, save } from "@tauri-apps/plugin-dialog";
import { BreakpointEditor } from "./BreakpointEditor";
import { Compose } from "./Compose";
import { Diff } from "./Diff";
import { Req, toCurl, toFetch, toPython } from "./snippets";
import { Devices } from "./Devices";
import { defaultAction, newRule, RulesEditor } from "./RulesEditor";
import { clientLabel, compile, emptyFilter, Filter, STATUSES, toggle, TYPES } from "./filters";
import { FlowDetail } from "./FlowDetail";
import { FlowList, isTunnel, listCommand } from "./FlowList";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";
import { setLocalIps } from "./clients";
import "./App.css";

function useFlows() {
  const [flows, setFlows] = useState<Map<number, FlowSummary>>(new Map());
  const [hits, setHits] = useState<BreakpointHit[]>([]);
  const [logs, setLogs] = useState<ScriptLog[]>([]);
  useEffect(() => {
    api.listBreakpoints().then(setHits);
    const reload = () => api.listFlows().then((list) => setFlows(new Map(list.map((f) => [f.id, f]))));
    reload();
    // Each commit re-filters and re-counts every flow: past a few thousand flows, batches are
    // pooled so that work runs at most every size/100 ms (≤250 ms) instead of every 50 ms.
    let pending: FlowEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let size = 0;
    const queue = (events: FlowEvent[]) => {
      pending.push(...events);
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; const e = pending; pending = []; apply(e); }, Math.min(250, size / 100));
    };
    const apply = (events: FlowEvent[]) => {
      const newHits = events.flatMap((e) => (e.type === "breakpoint" ? [e.data] : []));
      if (newHits.length) setHits((h) => [...h, ...newHits]);
      const newLogs = events.flatMap((e) => (e.type === "log" ? [e.data] : []));
      if (newLogs.length) setLogs((l) => [...l, ...newLogs].slice(-1000));
      setFlows((prev) => {
        let next = new Map(prev);
        for (const e of events) {
          if (e.type === "cleared") next = new Map();
          else if (e.type === "removed") e.data.forEach((id) => next.delete(id));
          else if (e.type === "upsert") next.set(e.data.id, e.data);
        }
        size = next.size;
        return next;
      });
    };
    const un = [api.onFlows(queue), api.onResync(reload)];
    return () => { clearTimeout(timer); un.forEach((p) => p.then((f) => f())); };
  }, []);
  return { flows, hits, logs, clearLogs: () => setLogs([]), doneHit: (hit: BreakpointHit) => setHits((h) => h.filter((x) => x !== hit)) };
}

interface Menu { id: number; x: number; y: number }

const HIGHLIGHTS: Record<string, string> = {
  Red: "rgb(255 59 48 / 0.22)", Orange: "rgb(255 149 0 / 0.22)", Yellow: "rgb(255 204 0 / 0.25)",
  Green: "rgb(52 199 89 / 0.22)", Blue: "rgb(0 122 255 / 0.20)", Purple: "rgb(175 82 222 / 0.22)",
};

function loadNumber(key: string, fallback: number) {
  try { return Number(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}

async function requestOf(id: number): Promise<Req> {
  const flow = await api.getFlow(id);
  const body = new TextDecoder().decode(await api.getBody(id, false));
  return { method: flow?.method ?? "GET", url: flow?.url ?? "", headers: flow?.request.headers ?? [], body };
}

/** Dev only (?open=settings…): start with a dialog open, for the ?gallery page. */
const OPEN = import.meta.env.DEV ? new URLSearchParams(location.search).get("open") : null;

const HAR = [{ name: "HAR / Sniffo session", extensions: ["har"] }];

export default function App() {
  const { flows, hits, logs, clearLogs, doneHit } = useFlows();
  const [showConsole, setShowConsole] = useState(OPEN === "console");
  const [palette, setPalette] = useState(OPEN === "palette");
  const [rulesDraft, setRulesDraft] = useState<Rule | null | undefined>(OPEN === "rules" ? null : undefined);
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>(emptyFilter);
  const [searchBodies, setSearchBodies] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showSettings, setShowSettings] = useState(OPEN === "settings");
  const [busy, setBusy] = useState(false);
  const [showDevices, setShowDevices] = useState(OPEN === "devices");
  const [compose, setCompose] = useState<Req | null | undefined>(OPEN === "compose" ? null : undefined);
  const [diffBase, setDiffBase] = useState<number | null>(null);
  const [diff, setDiff] = useState<[number, number] | null>(null);
  const [fileMenu, setFileMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [listPct, setListPct] = useState(() => loadNumber("sniffo.listHeight", 45));
  const [colors, setColors] = useState<Map<number, string>>(new Map());
  const highlight = (id: number, color: string | null) => setColors((m) => {
    const next = new Map(m);
    if (color) next.set(id, color); else next.delete(id);
    return next;
  });

  /** Drag the divider between the list and the detail panes. */
  const startSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = contentRef.current!.getBoundingClientRect();
    let pct = listPct;
    const move = (ev: MouseEvent) => { pct = Math.min(85, Math.max(15, ((ev.clientY - box.top) / box.height) * 100)); setListPct(pct); };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      try { localStorage.setItem("sniffo.listHeight", String(Math.round(pct))); } catch { /* storage unavailable */ }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const notify = (text: string) => { setToast(text); setTimeout(() => setToast(null), 3000); };
  const fail = (e: unknown) => setError(String(e));
  const exportHar = async (ids: number[] = []) => {
    const path = await save({ filters: HAR, defaultPath: ids.length === 1 ? `flow-${ids[0]}.har` : "sniffo-session.har" });
    if (path) api.exportHar(path, ids).then((n) => notify(`Saved ${n} flows to ${path}`), fail);
  };
  const importHar = async (replace: boolean) => {
    const path = await open({ filters: HAR, multiple: false, directory: false });
    if (typeof path === "string") api.importHar(path, replace).then((n) => notify(`Loaded ${n} flows`), fail);
  };
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => notify(`Copied ${what}`));
  const [menu, setMenu] = useState<Menu | null>(null);

  const [rules, setRules] = useState<Rules | null>(null);
  const [ssl, setSsl] = useState<SslProxying | null>(null);
  useEffect(() => { if (status) setLocalIps(status.lan.map((a) => a.ip)); }, [status]);
  const refresh = () => {
    api.getRules().then(setRules);
    api.getSsl().then(setSsl);
    return api.status().then(setStatus);
  };
  /** Same matching as the core (case-insensitive * wildcards; exclude wins). Compiled once per
   *  settings change and cached per host: rows and sidebar call it on every render. */
  const decrypts = useMemo(() => {
    if (!ssl?.enabled) return () => false;
    const glob = (p: string) => new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    const [include, exclude] = [ssl.include.map(glob), ssl.exclude.map(glob)];
    const seen = new Map<string, boolean>();
    return (host: string) => {
      let v = seen.get(host);
      if (v === undefined) seen.set(host, (v = include.some((r) => r.test(host)) && !exclude.some((r) => r.test(host))));
      return v;
    };
  }, [ssl]);
  /** Proxyman-style per-host toggle: enable adds the host to Include; disable removes it, excluding it if a wildcard still matches. */
  const sslForHost = (host: string, on: boolean) => {
    if (!ssl) return;
    const other = (l: string[]) => l.filter((h) => h.toLowerCase() !== host.toLowerCase());
    const glob = (p: string) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    const include = on ? [...other(ssl.include), host] : other(ssl.include);
    const exclude = on || !include.some((p) => glob(p).test(host)) ? other(ssl.exclude) : [...other(ssl.exclude), host];
    api.setSsl({ ...ssl, include, exclude })
      .then(() => notify(on ? `SSL Proxying enabled for ${host}${ssl.enabled ? " — retry the request to see it decrypted" : " (SSL Proxying is off in Settings)"}` : `SSL Proxying disabled for ${host}`), fail)
      .finally(refresh);
  };
  // Stable handlers so the memoized detail pane skips the re-render of every flow batch.
  const sslRef = useRef(sslForHost);
  sslRef.current = sslForHost;
  const onSsl = useCallback((host: string, on: boolean) => sslRef.current(host, on), []);
  const onPin = useCallback((id: number, pinned: boolean) => { api.pin(id, pinned); }, []);
  const start = () => api.start().then(() => setError(null), (e) => setError(String(e))).finally(refresh);
  /** First start of this app run: also take over the system proxy if the user wants that (default, like Proxyman). */
  const launch = () => api.start()
    .then(async () => {
      setError(null);
      const s = await api.status();
      if (s.auto_system_proxy && !s.system_proxy) await api.setSystemProxy(true);
    })
    .catch((e) => setError(String(e)))
    .finally(refresh);
  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }));

  useEffect(() => {
    api.status().then((s) => (s.running ? refresh() : launch()));
    // LAN addresses change when Wi-Fi/VPN changes.
    const t = setInterval(() => api.status().then(setStatus), 10_000);
    return () => clearInterval(t);
  }, []);

  // Body search runs in the backend: debounced while typing, then re-run at most every 2 s while
  // new flows arrive (a debounce keyed on the flow count never fired under steady traffic).
  const latestFlows = useRef(flows);
  latestFlows.current = flows;
  useEffect(() => {
    if (!searchBodies || !filter.text) { set({ bodyHits: null }); return; }
    let searched: typeof flows | null = null;
    const run = () => {
      if (searched === latestFlows.current) return;
      searched = latestFlows.current;
      api.search(filter.text).then((ids) => set({ bodyHits: new Set(ids) }));
    };
    const t = setTimeout(run, 300);
    const i = setInterval(run, 2000);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [searchBodies, filter.text]);

  // Typing stays instant: the list re-filters in a background render.
  const deferredFilter = useDeferredValue(filter);
  const predicate = useMemo(() => compile(deferredFilter), [deferredFilter]);
  const visible = useMemo(
    () => (typeof predicate === "string" ? [] : [...flows.values()].filter(predicate)),
    [flows, predicate],
  );
  const sel = selected != null ? flows.get(selected) : undefined;
  const stats = useMemo(() => {
    let pinned = 0, errors = 0, paused = 0, down = 0, up = 0;
    const apps = new Map<string, number>();
    for (const f of flows.values()) {
      if (f.pinned) pinned++;
      if (f.state === "failed" || (f.status ?? 0) >= 400) errors++;
      if (f.state === "paused") paused++;
      down += f.response_size ?? 0;
      up += f.request_size;
      apps.set(clientLabel(f), (apps.get(clientLabel(f)) ?? 0) + 1);
    }
    return { pinned, errors, paused, down, up, apps: [...apps.entries()].sort((a, b) => b[1] - a[1]) };
  }, [flows]);
  const activeRules = rules?.rules.filter((r) => r.enabled).length ?? 0;

  const remove = (ids: number[]) => { api.remove(ids); if (selected != null && ids.includes(selected)) setSelected(null); };

  // Proxyman-style shortcuts; the same list feeds the ⌘P palette.
  const commands: (Command & { key?: string; shift?: boolean; inInput?: boolean })[] = [
    { label: "Repeat selected flow", key: "r", shortcut: "⌘R", run: () => { if (selected != null) api.repeat(selected).then((st) => notify(`Repeated — ${st}`), fail); } },
    { label: "Edit & Repeat selected flow…", key: "e", shortcut: "⌘E", run: () => { if (selected != null) requestOf(selected).then(setCompose); } },
    { label: "Copy selected flow as cURL", key: "c", shift: true, shortcut: "⇧⌘C", run: () => { if (selected != null) requestOf(selected).then((r) => copy(toCurl(r), "as cURL")); } },
    { label: "Compose request", key: "n", shortcut: "⌘N", run: () => setCompose(null) },
    { label: "Clear session", key: "k", shortcut: "⌘K", run: () => { api.clear(); setSelected(null); } },
    { label: "Filter flows", key: "f", shortcut: "⌘F", inInput: true, run: () => filterRef.current?.focus() },
    { label: "Rules", key: "l", shortcut: "⌘L", run: () => setRulesDraft(null) },
    { label: "Settings", key: ",", shortcut: "⌘,", run: () => setShowSettings(true) },
    { label: "Devices…", run: () => setShowDevices(true) },
    { label: "Export session as HAR…", key: "s", shortcut: "⌘S", inInput: true, run: () => exportHar() },
    { label: "Open HAR…", key: "o", shortcut: "⌘O", inInput: true, run: () => importHar(true) },
    { label: "Toggle console", run: () => setShowConsole((v) => !v) },
    { label: "Go to top of the list", shortcut: "Home", run: () => listCommand("top") },
    { label: "Go to bottom of the list", shortcut: "End", run: () => listCommand("bottom") },
    { label: "Newest / oldest first", run: () => listCommand("order") },
    { label: "Search or run…", key: "p", shortcut: "⌘P", inInput: true, run: () => setPalette(true) },
  ];

  useEffect(() => {
    const close = () => { setMenu(null); setFileMenu(false); };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        setShowSettings(false); setShowDevices(false); setCompose(undefined); setDiff(null); setRulesDraft(undefined); setMenu(null); setPalette(false);
        return;
      }
      if (!mod) {
        if ((e.key === "Backspace" || e.key === "Delete") && selected != null && !typing) {
          e.preventDefault(); // WebKit maps Backspace to "go back"
          remove([selected]);
        }
        return;
      }
      const k = e.key.toLowerCase();
      const cmd = commands.find((c) => c.key === k && !c.shift === !e.shiftKey);
      // Plain copy/paste/select-all stay native while typing; only a few shortcuts work from inputs.
      if (cmd && !(typing && !cmd.inInput)) {
        e.preventDefault();
        cmd.run();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [selected]);

  const menuFlow = menu ? flows.get(menu.id) : undefined;

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region>
        <span className="brand"><Logo /> Sniffo</span>
        <span className={`dot ${status?.running ? "on" : "off"}`} title={status?.running ? `Listening on ${status.address}` : "Proxy stopped"} />
        {status?.running && (
          <button className="lan" onClick={() => setShowDevices(true)} title="Use this address on phones and tablets">
            {status.allow_lan && status.lan[0] ? <><Icon name="phone" /> {status.lan_name ?? status.lan[0].ip}:{status.port}</> : <><Icon name="phone" /> Devices</>}
          </button>
        )}
        {status?.running ? (
          // Restoring the OS proxy settings takes a few seconds (networksetup per network service).
          <button className="danger" disabled={busy} onClick={() => { setBusy(true); api.stop().finally(() => refresh().finally(() => setBusy(false))); }}>{busy ? "Stopping…" : "Stop"}</button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => { setBusy(true); start().finally(() => setBusy(false)); }}>{busy ? "Starting…" : "Start"}</button>
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
        <button onClick={() => { api.clear(); setSelected(null); }} title="Remove all unpinned flows (⌘K)">Clear</button>
        <span className="spacer" />
        <button className="palette-open" onClick={() => setPalette(true)}><Icon name="search" /> Search or run…<kbd>⌘P</kbd></button>
        <span className="spacer" />
        <button className="primary" onClick={() => setCompose(null)} title="Compose a request (⌘N) · Edit & repeat selected (⌘E) · Repeat (⌘R) · Copy as cURL (⌘⇧C)">Compose</button>
        <div className="dropdown">
          <button onClick={(e) => { e.stopPropagation(); setFileMenu(!fileMenu); }}>File ▾</button>
          {fileMenu && (
            <div className="menu right" onClick={() => setFileMenu(false)}>
              <div onClick={() => importHar(true)}>Open session…  ⌘O</div>
              <div onClick={() => exportHar()}>Save session…  ⌘S</div>
              <hr />
              <div onClick={() => importHar(false)}>Import HAR…</div>
              <div onClick={() => exportHar(visible.map((f) => f.id))}>Export visible as HAR…</div>
            </div>
          )}
        </div>
        <button onClick={() => setRulesDraft(null)} title="Rules (⌘L)">Rules</button>
        <button onClick={() => setShowSettings(true)} title="Settings (⌘,)">Settings</button>
      </header>
      <div className="filterbar">
        <input
          ref={filterRef}
          className={`filter ${typeof predicate === "string" ? "invalid" : ""}`}
          placeholder={searchBodies ? "Search URL, headers and bodies" : filter.regex ? "Regex on URL, method, status" : "Filter: URL, method, status  (⌘F)"}
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
      {rulesDraft !== undefined && <RulesEditor draft={rulesDraft} onClose={() => { setRulesDraft(undefined); refresh(); }} />}
      {hits.length > 0 && <BreakpointEditor hits={hits} onDone={doneHit} />}
      {compose !== undefined && <Compose initial={compose ?? undefined} onClose={() => setCompose(undefined)} />}
      {diff && <Diff left={diff[0]} right={diff[1]} onClose={() => setDiff(null)} />}
      {toast && <div className="toast">{toast}</div>}
      {palette && (
        <Palette commands={commands} flows={visible} onClose={() => setPalette(false)}
          onHost={(host) => set({ host, pinnedOnly: false, client: null })}
          onFlow={(id) => { setSelected(id); setFollow(false); }} />
      )}
      {showDevices && <Devices status={status} onClose={() => setShowDevices(false)} onChanged={refresh} />}
      {showSettings && <Settings status={status} onClose={() => setShowSettings(false)} onChanged={refresh} />}
      {error && <div className="banner">{error}</div>}
      <div className="main">
        <Sidebar
          flows={flows}
          filter={filter}
          set={set}
          decrypts={decrypts}
          sslForHost={sslForHost}
          onRule={setRulesDraft}
          onExport={exportHar}
          onRemove={remove}
          notify={notify}
        />
        <div className="content" ref={contentRef} style={{ ["--list-pct" as string]: `${listPct}%` }}>
          <FlowList
            flows={visible}
            selected={selected}
            onSelect={(id) => { setSelected(id); setFollow(false); }}
            onContextMenu={(id, x, y) => { setSelected(id); setMenu({ id, x, y }); }}
            follow={follow}
            onFollowChange={setFollow}
            colors={colors}
            onEnableSsl={(host) => sslForHost(host, true)}
            decrypts={decrypts}
          />
          <div className="split" onMouseDown={startSplit} title="Drag to resize" />
          {sel ? (
            <FlowDetail summary={sel} onSsl={onSsl} decrypts={decrypts} onPin={onPin} />
          ) : (
            <div className="detail empty">
              {flows.size === 0 && <Logo size={104} tile />}
              {flows.size === 0 && <div className="empty-title">{status?.running ? "Waiting for traffic…" : "Proxy stopped"}</div>}
              <div className="muted">
                {status?.running
                  ? `Set your HTTP/HTTPS proxy to ${status.address} and trust the CA at ${status.ca_path}`
                  : "Start the proxy to capture traffic"}
              </div>
              {flows.size === 0 && status?.running && (
                <div className="row">
                  <button className="primary" onClick={() => setShowDevices(true)}>Connect a device…</button>
                  <button onClick={() => setCompose(null)}>Compose request</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {showConsole && (
        <div className="console">
          <div className="console-head">
            <strong>Script console</strong>
            <span className="spacer" />
            <button onClick={clearLogs}>Clear</button>
            <button onClick={() => setShowConsole(false)} aria-label="Close console"><Icon name="x" size={12} /></button>
          </div>
          <div className="console-body">
            {!logs.length && <div className="muted">console.log output and script errors appear here.</div>}
            {logs.map((l, i) => (
              <div key={i} className={l.error ? "err" : ""}>
                <span className="muted">{new Date(l.time_ms).toLocaleTimeString([], { hour12: false })} [{l.rule}] </span>
                <a href="#" onClick={(e) => { e.preventDefault(); setSelected(l.id); }}>#{l.id}</a> {l.message}
              </div>
            ))}
          </div>
        </div>
      )}
      <footer className="statusbar">
        <span className="item"><span className={`dot ${status?.running ? "on" : "off"}`} />{status?.running ? `Proxy ${status.address}` : "Proxy stopped"}</span>
        {status?.running && status.allow_lan && status.lan[0] && (
          <span className="item" title={status.lan.map((a) => `${a.interface}: ${a.ip}`).join("\n")}><span className="label">LAN</span> {status.lan_name ?? status.lan[0].ip}:{status.port}</span>
        )}
        <span className="item"><span className="label">System proxy</span> {status?.system_proxy ? <span className="ok">On</span> : "Off"}</span>
        {status?.system_proxy && status.vpn.state === "applied" && <span className="item ok" title="A VPN overrides the system proxy; Sniffo routes its entry through the proxy">VPN routed</span>}
        {status?.system_proxy && status.vpn.state === "helper_missing" && (
          <button className="linkish err" title="A VPN (e.g. Cato) is hiding the system proxy, so browsers bypass Sniffo. Installing the helper asks for your password once."
            onClick={() => api.installVpnHelper().then(() => notify("VPN helper installed"), fail).finally(refresh)}>
            VPN bypasses Sniffo — Install helper…
          </button>
        )}
        {status?.system_proxy && status.vpn.state === "failed" && <span className="item err" title={status.vpn.detail}>VPN routing failed</span>}
        <span className="item"><span className="label">Certificate</span> {status?.ca_trusted ? <span className="ok">Trusted</span> : <span className="err">Not trusted</span>}</span>
        <span className="item"><span className="label">SSL proxying</span> {!ssl?.enabled ? "Off" : ssl.include.includes("*") ? "All hosts" : `${ssl.include.length} hosts`}{ssl?.exclude.length ? ` (−${ssl.exclude.length})` : ""}</span>
        <span className="item"><span className="label">Rules</span> {activeRules} active</span>
        {rules?.allow_list.enabled && <span className="item warn">Allow list on</span>}
        {rules?.no_caching && <span className="item warn">No caching</span>}
        <span className="spacer" />
        {stats.paused > 0 && <span className="item warn"><Icon name="pause" size={11} /> {stats.paused} paused</span>}
        <button className={`linkish ${logs.some((l) => l.error) ? "err" : ""}`} onClick={() => setShowConsole(!showConsole)}>Console ({logs.length})</button>
        <span className="item"><span className="label">Errors</span> {stats.errors}</span>
        <span className="item"><span className="label">↑</span> {formatBytes(stats.up)} <span className="label">↓</span> {formatBytes(stats.down)}</span>
        <span className="item">{visible.length} / {flows.size} flows</span>
      </footer>
      {menu && menuFlow && (
        <div className="menu" style={{ left: menu.x, top: menu.y }}>
          {isTunnel(menuFlow) ? (
            <div onClick={() => sslForHost(menuFlow.host, true)}>Enable SSL Proxying for {menuFlow.host}</div>
          ) : (
            <>
              <div onClick={() => api.repeat(menuFlow.id).then((s) => notify(`Repeated — ${s}`), fail)}>Repeat</div>
              <div onClick={() => requestOf(menuFlow.id).then(setCompose)}>Edit &amp; Repeat…</div>
              {(menuFlow.scheme === "https" || menuFlow.scheme === "wss") && <div onClick={() => sslForHost(menuFlow.host, false)}>Disable SSL Proxying for {menuFlow.host}</div>}
            </>
          )}
          <hr />
          <div onClick={() => api.pin(menuFlow.id, !menuFlow.pinned)}>{menuFlow.pinned ? "Unpin" : "Pin"}</div>
          <div className="swatches" onClick={(e) => e.stopPropagation()}>
            {Object.entries(HIGHLIGHTS).map(([name, c]) => (
              <span key={name} title={name} style={{ background: c.replace(/0\.2\d\)/, "0.9)") }} onClick={() => { highlight(menuFlow.id, c); setMenu(null); }} />
            ))}
            <span title="No highlight" className="none" onClick={() => { highlight(menuFlow.id, null); setMenu(null); }}><Icon name="x" size={10} /></span>
          </div>
          <div onClick={() => copy(menuFlow.url, "URL")}>Copy URL</div>
          {!isTunnel(menuFlow) && <>
          <div onClick={() => requestOf(menuFlow.id).then((r) => copy(toCurl(r), "as cURL"))}>Copy as cURL</div>
          <div onClick={() => requestOf(menuFlow.id).then((r) => copy(toFetch(r), "as fetch"))}>Copy as fetch</div>
          <div onClick={() => requestOf(menuFlow.id).then((r) => copy(toPython(r), "as Python"))}>Copy as Python requests</div>
          <div onClick={() => exportHar([menuFlow.id])}>Export as HAR…</div>
          <hr />
          {diffBase != null && diffBase !== menuFlow.id
            ? <div onClick={() => { setDiff([diffBase, menuFlow.id]); setDiffBase(null); }}>Compare with #{diffBase}</div>
            : <div onClick={() => { setDiffBase(menuFlow.id); notify(`#${menuFlow.id} marked — right-click another flow to compare`); }}>Mark for diff</div>}
          </>}
          <div onClick={() => set({ host: menuFlow.host, pinnedOnly: false })}>Show only {menuFlow.host}</div>
          {!isTunnel(menuFlow) && <>
          <hr />
          <div onClick={() => setRulesDraft(newRule(menuFlow.url.split("?")[0] + "*", defaultAction("breakpoint")))}>Breakpoint…</div>
          <div onClick={async () => {
            const body = new TextDecoder().decode(await api.getBody(menuFlow.id, true));
            const flow = await api.getFlow(menuFlow.id);
            const headers = (flow?.response?.headers ?? []).filter(([k]) => !["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(k.toLowerCase()));
            setRulesDraft(newRule(menuFlow.url.split("?")[0] + "*", { type: "map_local", status: flow?.status ?? 200, headers, body, file: null }));
          }}>Map Local…</div>
          <div onClick={() => setRulesDraft(newRule(`${menuFlow.url.split("://")[0]}://${menuFlow.host}/*`, defaultAction("map_remote")))}>Map Remote…</div>
          <div onClick={() => setRulesDraft(newRule(menuFlow.url.split("?")[0] + "*", defaultAction("script")))}>Script…</div>
          <div onClick={() => setRulesDraft(newRule(`*://${menuFlow.host}/*`, defaultAction("throttle")))}>Throttle host…</div>
          <div onClick={() => setRulesDraft(newRule(`*://${menuFlow.host}/*`, defaultAction("block")))}>Block host…</div>
          </>}
          <hr />
          <div className="danger" onClick={() => remove([menuFlow.id])}>Delete</div>
        </div>
      )}
    </div>
  );
}
