import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { onToast, toast as showToast, Toast, toastError } from "./toast";
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
import { clientLabel, compile, emptyFilter, Filter, kindLabel, STATUSES, toggle, TYPES } from "./filters";
import { FlowDetail } from "./FlowDetail";
import { FlowList, HIGHLIGHTS, isTunnel, listCommand } from "./FlowList";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";
import { setLocalIps } from "./clients";
import { Key, t, tn, useLang } from "./i18n";
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

const PROXY_LABEL = { starting: "app.proxyStarting", stopping: "app.proxyStopping", stopped: "app.proxyStopped", running: "app.proxyRunning" } as const;

const har = () => [{ name: t("app.harFilter"), extensions: ["har"] }];

export default function App() {
  useLang();
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
  /** A proxy transition in flight. Starts as "starting": the app launches the proxy on its own. */
  const [phase, setPhase] = useState<"starting" | "stopping" | "proxy" | null>("starting");
  const [showDevices, setShowDevices] = useState(OPEN === "devices");
  const [compose, setCompose] = useState<Req | null | undefined>(OPEN === "compose" ? null : undefined);
  const [diffBase, setDiffBase] = useState<number | null>(null);
  const [diff, setDiff] = useState<[number, number] | null>(null);
  const [fileMenu, setFileMenu] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [listPct, setListPct] = useState(() => loadNumber("sniffo.listHeight", 45));

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

  const notify = (text: string) => showToast(text);
  const fail = toastError;
  // Latest toast wins; errors stay longer and close on click.
  useEffect(() => onToast((t) => {
    setToast(t);
    setTimeout(() => setToast((cur) => (cur?.id === t.id ? null : cur)), t.kind === "err" ? 7000 : 3000);
  }), []);
  const exportHar = async (ids: number[] = []) => {
    const path = await save({ filters: har(), defaultPath: ids.length === 1 ? `flow-${ids[0]}.har` : "sniffo-session.har" });
    if (path) api.exportHar(path, ids).then((n) => notify(t("app.savedFlows", { n, path })), fail);
  };
  const importHar = async (replace: boolean) => {
    const path = await open({ filters: har(), multiple: false, directory: false });
    if (typeof path === "string") api.importHar(path, replace).then((n) => notify(t("app.loadedFlows", { n })), fail);
  };
  const copy = (text: string, done: string) => navigator.clipboard.writeText(text).then(() => notify(done));
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
  /** Per-host toggle: enable adds the host to Include; disable removes it, excluding it if a wildcard still matches. */
  const sslForHost = (host: string, on: boolean) => {
    if (!ssl) return;
    const other = (l: string[]) => l.filter((h) => h.toLowerCase() !== host.toLowerCase());
    const glob = (p: string) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    const include = on ? [...other(ssl.include), host] : other(ssl.include);
    const exclude = on || !include.some((p) => glob(p).test(host)) ? other(ssl.exclude) : [...other(ssl.exclude), host];
    api.setSsl({ ...ssl, include, exclude })
      .then(() => notify(t(on ? (ssl.enabled ? "app.sslEnabledRetry" : "app.sslEnabledOff") : "app.sslDisabled", { host })), fail)
      .finally(refresh);
  };
  // Stable handlers so the memoized detail pane skips the re-render of every flow batch.
  const sslRef = useRef(sslForHost);
  sslRef.current = sslForHost;
  const onSsl = useCallback((host: string, on: boolean) => sslRef.current(host, on), []);
  const onPin = useCallback((id: number, pinned: boolean) => { api.pin(id, pinned); }, []);
  /** Start the proxy (at launch and from the Start button) and take over the system proxy if the
   *  user wants that (Settings → General, on by default). */
  const start = () => {
    setPhase("starting");
    return api.start()
      .then(async () => {
        setError(null);
        const s = await api.status();
        if (s.auto_system_proxy && !s.system_proxy) await api.setSystemProxy(true);
      })
      .catch((e) => setError(String(e)))
      .finally(() => refresh().finally(() => setPhase(null)));
  };
  // Restoring the OS proxy settings takes a few seconds (networksetup per network service).
  const stop = () => {
    setPhase("stopping");
    return api.stop().finally(() => refresh().finally(() => setPhase(null)));
  };
  const setSystemProxy = (on: boolean) => {
    setPhase("proxy");
    api.setSystemProxy(on).then(() => setError(null), (err) => setError(String(err))).finally(() => refresh().finally(() => setPhase(null)));
  };
  /** What the UI shows: a transition in flight wins over the last known status. */
  const proxyState = phase === "starting" || phase === "stopping" ? phase : status?.running ? "running" : status ? "stopped" : "starting";
  const running = proxyState === "running";
  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }));

  useEffect(() => {
    api.status().then((s) => (s.running ? refresh().finally(() => setPhase(null)) : start()));
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

  /** Deleting the selected flow selects its neighbour, so ⌫ can be pressed repeatedly. */
  const remove = (ids: number[]) => {
    api.remove(ids);
    const gone = new Set(ids);
    if (selected == null || !gone.has(selected)) return;
    const i = visible.findIndex((f) => f.id === selected);
    const next = [...visible.slice(i + 1), ...visible.slice(0, Math.max(i, 0)).reverse()].find((f) => !gone.has(f.id));
    setSelected(next?.id ?? null);
  };

  // Keyboard shortcuts; the same list feeds the ⌘P palette.
  const commands: (Command & { key?: string; shift?: boolean; inInput?: boolean })[] = [
    { label: t("cmd.repeat"), key: "r", shortcut: "⌘R", run: () => { if (selected != null) api.repeat(selected).then((st) => notify(t("app.repeated", { status: st })), fail); } },
    { label: t("cmd.editRepeat"), key: "e", shortcut: "⌘E", run: () => { if (selected != null) requestOf(selected).then(setCompose); } },
    { label: t("cmd.copyCurl"), key: "c", shift: true, shortcut: "⇧⌘C", run: () => { if (selected != null) requestOf(selected).then((r) => copy(toCurl(r), t("app.copiedCurl"))); } },
    { label: t("cmd.compose"), key: "n", shortcut: "⌘N", run: () => setCompose(null) },
    { label: t("cmd.clear"), key: "k", shortcut: "⌘K", run: () => { api.clear(); setSelected(null); } },
    { label: t("cmd.filter"), key: "f", shortcut: "⌘F", inInput: true, run: () => filterRef.current?.focus() },
    { label: t("app.rules"), key: "l", shortcut: "⌘L", run: () => setRulesDraft(null) },
    { label: t("app.settings"), key: ",", shortcut: "⌘,", run: () => setShowSettings(true) },
    { label: t("cmd.devices"), run: () => setShowDevices(true) },
    { label: t("cmd.exportHar"), key: "s", shortcut: "⌘S", inInput: true, run: () => exportHar() },
    { label: t("cmd.openHar"), key: "o", shortcut: "⌘O", inInput: true, run: () => importHar(true) },
    { label: t("cmd.console"), run: () => setShowConsole((v) => !v) },
    { label: t("cmd.top"), shortcut: "Home", run: () => listCommand("top") },
    { label: t("cmd.bottom"), shortcut: "End", run: () => listCommand("bottom") },
    { label: t("cmd.order"), run: () => listCommand("order") },
    { label: t("app.searchOrRun"), key: "p", shortcut: "⌘P", inInput: true, run: () => setPalette(true) },
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
  }, [selected, visible]);

  const menuFlow = menu ? flows.get(menu.id) : undefined;

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region>
        <span className="brand"><Logo /> Sniffo</span>
        <span className={`dot ${running ? "on" : proxyState === "stopped" ? "off" : "busy"}`} title={running ? t("app.listening", { address: status!.address ?? "" }) : t(PROXY_LABEL[proxyState])} />
        {running && status && (
          <button className="lan" onClick={() => setShowDevices(true)} title={t("app.lanHint")}>
            {status.allow_lan && status.lan[0] ? <><Icon name="phone" /> {status.lan_name ?? status.lan[0].ip}:{status.port}</> : <><Icon name="phone" /> {t("app.devices")}</>}
          </button>
        )}
        {proxyState === "starting" || proxyState === "stopping" ? (
          <button disabled>{t(PROXY_LABEL[proxyState])}</button>
        ) : running ? (
          <button className="danger" onClick={stop}>{t("app.stop")}</button>
        ) : (
          <button className="primary" onClick={start}>{t("app.start")}</button>
        )}
        <label className="check" title={t("app.systemProxyHint")}>
          <input
            type="checkbox"
            checked={!!status?.system_proxy}
            disabled={!running || phase !== null}
            onChange={(e) => setSystemProxy(e.target.checked)}
          /> {phase === "proxy" ? t("app.applying") : t("app.systemProxy")}
        </label>
        {status && !status.ca_trusted && (
          <button className="warn" onClick={() => setShowSettings(true)}>{t("app.caNotTrusted")}</button>
        )}
        <button onClick={() => { api.clear(); setSelected(null); }} title={`${t("app.clearHint")} (⌘K)`}>{t("app.clear")}</button>
        <span className="spacer" />
        <button className="palette-open" onClick={() => setPalette(true)}><Icon name="search" /> {t("app.searchOrRun")}<kbd>⌘P</kbd></button>
        <span className="spacer" />
        <button className="primary" onClick={() => setCompose(null)} title={t("app.composeHint")}>{t("app.compose")}</button>
        <div className="dropdown">
          <button onClick={(e) => { e.stopPropagation(); setFileMenu(!fileMenu); }}>{t("app.file")} ▾</button>
          {fileMenu && (
            <div className="menu right" onClick={() => setFileMenu(false)}>
              <div onClick={() => importHar(true)}>{t("app.openSession")}  ⌘O</div>
              <div onClick={() => exportHar()}>{t("app.saveSession")}  ⌘S</div>
              <hr />
              <div onClick={() => importHar(false)}>{t("app.importHar")}</div>
              <div onClick={() => exportHar(visible.map((f) => f.id))}>{t("app.exportVisible")}</div>
            </div>
          )}
        </div>
        <button onClick={() => setRulesDraft(null)} title={`${t("app.rules")} (⌘L)`}>{t("app.rules")}</button>
        <button onClick={() => setShowSettings(true)} title={`${t("app.settings")} (⌘,)`}>{t("app.settings")}</button>
      </header>
      <div className="filterbar">
        <input
          ref={filterRef}
          className={`filter ${typeof predicate === "string" ? "invalid" : ""}`}
          placeholder={searchBodies ? t("app.filterBodies") : filter.regex ? t("app.filterRegex") : `${t("app.filter")}  (⌘F)`}
          title={typeof predicate === "string" ? predicate : undefined}
          value={filter.text}
          onChange={(e) => set({ text: e.target.value })}
        />
        <button className={`chip ${filter.regex ? "on" : ""}`} disabled={searchBodies} onClick={() => set({ regex: !filter.regex })} title={t("app.regex")}>.*</button>
        <button className={`chip ${searchBodies ? "on" : ""}`} onClick={() => setSearchBodies(!searchBodies)} title={t("app.bodyHint")}>{t("app.body")}</button>
        <span className="sep" />
        {TYPES.map((ty) => (
          <button key={ty} className={`chip ${filter.types.has(ty) ? "on" : ""}`} onClick={() => set({ types: toggle(filter.types, ty) })}>{kindLabel(ty)}</button>
        ))}
        <span className="sep" />
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${filter.statuses.has(s) ? "on" : ""}`} onClick={() => set({ statuses: toggle(filter.statuses, s) })}>{kindLabel(s)}</button>
        ))}
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t("app.autoScroll")}</label>
      </div>
      {rulesDraft !== undefined && <RulesEditor draft={rulesDraft} onClose={() => { setRulesDraft(undefined); refresh(); }} />}
      {hits.length > 0 && <BreakpointEditor hits={hits} onDone={doneHit} />}
      {compose !== undefined && <Compose initial={compose ?? undefined} onClose={() => setCompose(undefined)} />}
      {diff && <Diff left={diff[0]} right={diff[1]} onClose={() => setDiff(null)} />}
      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === "err" ? "alert" : "status"} onClick={() => setToast(null)}>
          {toast.kind === "ok" && <Icon name="check" size={13} />}
          {toast.kind === "err" && <Icon name="alert" size={13} />}
          <span className="ellipsis">{toast.text}</span>
        </div>
      )}
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
            onEnableSsl={(host) => sslForHost(host, true)}
            decrypts={decrypts}
          />
          <div className="split" onMouseDown={startSplit} title={t("app.dragResize")} />
          {sel ? (
            <FlowDetail summary={sel} onSsl={onSsl} decrypts={decrypts} onPin={onPin} />
          ) : (
            <div className="detail empty">
              {flows.size === 0 && <Logo size={104} tile />}
              {flows.size === 0 && <div className="empty-title">{running ? t("app.waiting") : t(PROXY_LABEL[proxyState])}</div>}
              <div className="muted">
                {running && status
                  ? t("app.setupHint", { address: status.address ?? "", ca: status.ca_path })
                  : proxyState === "stopped" ? t("app.startHint") : t("app.oneMoment")}
              </div>
              {flows.size === 0 && running && (
                <div className="row">
                  <button className="primary" onClick={() => setShowDevices(true)}>{t("app.connectDevice")}</button>
                  <button onClick={() => setCompose(null)}>{t("cmd.compose")}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {showConsole && (
        <div className="console">
          <div className="console-head">
            <strong>{t("app.scriptConsole")}</strong>
            <span className="spacer" />
            <button onClick={clearLogs}>{t("app.clear")}</button>
            <button onClick={() => setShowConsole(false)} aria-label={t("app.closeConsole")}><Icon name="x" size={12} /></button>
          </div>
          <div className="console-body">
            {!logs.length && <div className="muted">{t("app.consoleEmpty")}</div>}
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
        <span className="item"><span className={`dot ${running ? "on" : proxyState === "stopped" ? "off" : "busy"}`} />{running ? `Proxy ${status!.address}` : t(PROXY_LABEL[proxyState])}</span>
        {running && status && status.allow_lan && status.lan[0] && (
          <span className="item" title={status.lan.map((a) => `${a.interface}: ${a.ip}`).join("\n")}><span className="label">LAN</span> {status.lan_name ?? status.lan[0].ip}:{status.port}</span>
        )}
        <span className="item"><span className="label">{t("app.systemProxy")}</span> {status?.system_proxy ? <span className="ok">{t("app.on")}</span> : t("app.off")}</span>
        {status?.system_proxy && status.vpn.state === "applied" && <span className="item ok" title={t("app.vpnRoutedHint")}>{t("app.vpnRouted")}</span>}
        {status?.system_proxy && status.vpn.state === "helper_missing" && (
          <button className="linkish err" title={t("app.vpnHelperHint")}
            onClick={() => api.installVpnHelper().then(() => notify(t("app.vpnHelperInstalled")), fail).finally(refresh)}>
            {t("app.vpnBypass")}
          </button>
        )}
        {status?.system_proxy && status.vpn.state === "failed" && <span className="item err" title={status.vpn.detail}>{t("app.vpnFailed")}</span>}
        <span className="item"><span className="label">{t("app.certificate")}</span> {status?.ca_trusted ? <span className="ok">{t("app.trusted")}</span> : <span className="err">{t("app.notTrusted")}</span>}</span>
        <span className="item"><span className="label">{t("app.sslProxying")}</span> {!ssl?.enabled ? t("app.off") : ssl.include.includes("*") ? t("app.allHosts") : tn("app.hosts", ssl.include.length)}{ssl?.exclude.length ? ` (−${ssl.exclude.length})` : ""}</span>
        <span className="item"><span className="label">{t("app.rules")}</span> {t("app.active", { n: activeRules })}</span>
        {rules?.allow_list.enabled && <span className="item warn">{t("app.allowListOn")}</span>}
        {rules?.no_caching && <span className="item warn">{t("app.noCaching")}</span>}
        <span className="spacer" />
        {stats.paused > 0 && <span className="item warn"><Icon name="pause" size={11} /> {t("app.paused", { n: stats.paused })}</span>}
        <button className={`linkish ${logs.some((l) => l.error) ? "err" : ""}`} onClick={() => setShowConsole(!showConsole)}>{t("app.console")} ({logs.length})</button>
        <span className="item"><span className="label">{t("app.errors")}</span> {stats.errors}</span>
        <span className="item"><span className="label">↑</span> {formatBytes(stats.up)} <span className="label">↓</span> {formatBytes(stats.down)}</span>
        <span className="item">{t("app.flowCount", { shown: visible.length, n: flows.size })}</span>
      </footer>
      {menu && menuFlow && (
        <div className="menu" style={{ left: menu.x, top: menu.y }}>
          {isTunnel(menuFlow) ? (
            <div onClick={() => sslForHost(menuFlow.host, true)}>{t("app.enableSsl", { host: menuFlow.host })}</div>
          ) : (
            <>
              <div onClick={() => api.repeat(menuFlow.id).then((s) => notify(t("app.repeated", { status: s })), fail)}>{t("app.repeat")}</div>
              <div onClick={() => requestOf(menuFlow.id).then(setCompose)}>{t("app.editRepeat")}</div>
              {(menuFlow.scheme === "https" || menuFlow.scheme === "wss") && <div onClick={() => sslForHost(menuFlow.host, false)}>{t("app.disableSsl", { host: menuFlow.host })}</div>}
            </>
          )}
          <hr />
          <div onClick={() => api.pin(menuFlow.id, !menuFlow.pinned)}>{menuFlow.pinned ? t("app.unpin") : t("app.pin")}</div>
          <div className="swatches" onClick={(e) => e.stopPropagation()}>
            {Object.entries(HIGHLIGHTS).map(([name, c]) => (
              <span key={name} title={t(`highlight.${name}` as Key)} style={{ background: c.replace(/0\.2\d\)/, "0.9)") }} onClick={() => { api.mark(menuFlow.id, name, menuFlow.comment); setMenu(null); }} />
            ))}
            <span title={t("app.noHighlight")} className="none" onClick={() => { api.mark(menuFlow.id, null, menuFlow.comment); setMenu(null); }}><Icon name="x" size={10} /></span>
          </div>
          <div onClick={() => copy(menuFlow.url, t("app.copiedUrl"))}>{t("app.copyUrl")}</div>
          {!isTunnel(menuFlow) && <>
          <div onClick={() => requestOf(menuFlow.id).then((r) => copy(toCurl(r), t("app.copiedCurl")))}>{t("app.copyCurl")}</div>
          <div onClick={() => requestOf(menuFlow.id).then((r) => copy(toFetch(r), t("app.copiedFetch")))}>{t("app.copyFetch")}</div>
          <div onClick={() => requestOf(menuFlow.id).then((r) => copy(toPython(r), t("app.copiedPython")))}>{t("app.copyPython")}</div>
          <div onClick={() => exportHar([menuFlow.id])}>{t("app.exportHar")}</div>
          <hr />
          {diffBase != null && diffBase !== menuFlow.id
            ? <div onClick={() => { setDiff([diffBase, menuFlow.id]); setDiffBase(null); }}>{t("app.compareWith", { id: diffBase })}</div>
            : <div onClick={() => { setDiffBase(menuFlow.id); notify(t("app.markedForDiff", { id: menuFlow.id })); }}>{t("app.markDiff")}</div>}
          </>}
          <div onClick={() => set({ host: menuFlow.host, pinnedOnly: false })}>{t("app.showOnly", { host: menuFlow.host })}</div>
          {!isTunnel(menuFlow) && <>
          <hr />
          <div onClick={() => setRulesDraft(newRule(menuFlow.url.split("?")[0] + "*", defaultAction("breakpoint")))}>{t("app.ruleBreakpoint")}</div>
          <div onClick={async () => {
            const body = new TextDecoder().decode(await api.getBody(menuFlow.id, true));
            const flow = await api.getFlow(menuFlow.id);
            const headers = (flow?.response?.headers ?? []).filter(([k]) => !["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(k.toLowerCase()));
            setRulesDraft(newRule(menuFlow.url.split("?")[0] + "*", { type: "map_local", status: flow?.status ?? 200, headers, body, file: null }));
          }}>{t("app.ruleMapLocal")}</div>
          <div onClick={() => setRulesDraft(newRule(`${menuFlow.url.split("://")[0]}://${menuFlow.host}/*`, defaultAction("map_remote")))}>{t("app.ruleMapRemote")}</div>
          <div onClick={() => setRulesDraft(newRule(menuFlow.url.split("?")[0] + "*", defaultAction("rewrite")))}>{t("app.ruleRewrite")}</div>
          <div onClick={() => setRulesDraft(newRule(menuFlow.url.split("?")[0] + "*", defaultAction("script")))}>{t("app.ruleScript")}</div>
          <div onClick={() => setRulesDraft(newRule(`*://${menuFlow.host}/*`, defaultAction("throttle")))}>{t("app.ruleThrottle")}</div>
          <div onClick={() => setRulesDraft(newRule(`*://${menuFlow.host}/*`, defaultAction("block")))}>{t("app.ruleBlock")}</div>
          </>}
          <hr />
          <div className="danger" onClick={() => remove([menuFlow.id])}>{t("app.delete")}</div>
        </div>
      )}
    </div>
  );
}
