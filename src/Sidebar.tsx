import { ReactNode, useEffect, useMemo, useState } from "react";
import { Action, FlowSummary, Rule } from "./api";
import { clientLabel, Filter } from "./filters";
import { AppIcon } from "./AppIcon";
import { deviceName, isLocal, renameDevice, useClientsVersion } from "./clients";
import { defaultAction, newRule } from "./RulesEditor";

// Domains only: per-endpoint rows explode on REST APIs with ids in paths (/items/9, /users/123…),
// so endpoint actions live in the flow list's context menu instead.
interface Pin { host: string }

const load = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };
interface Target { host: string; x: number; y: number }

export function Sidebar(props: {
  flows: Map<number, FlowSummary>;
  filter: Filter;
  set: (patch: Partial<Filter>) => void;
  decrypts: (host: string) => boolean;
  sslForHost: (host: string, on: boolean) => void;
  onRule: (rule: Rule) => void;
  onExport: (ids: number[]) => void;
  onRemove: (ids: number[]) => void;
  notify: (text: string) => void;
}) {
  const { flows, filter, set, decrypts, sslForHost, onRule, onExport, onRemove, notify } = props;
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<Pin[]>(() => load("sniffo.sidebarPins", []));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => load("sniffo.sidebarCollapsed", {}));
  const [menu, setMenu] = useState<Target | null>(null);

  useEffect(() => save("sniffo.sidebarPins", pins), [pins]);
  useEffect(() => save("sniffo.sidebarCollapsed", collapsed), [collapsed]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const { domains, apps, pinnedFlows } = useMemo(() => {
    const domains = new Map<string, number>();
    const apps = new Map<string, number>();
    let pinnedFlows = 0;
    for (const f of flows.values()) {
      domains.set(f.host, (domains.get(f.host) ?? 0) + 1);
      apps.set(clientLabel(f), (apps.get(clientLabel(f)) ?? 0) + 1);
      if (f.pinned) pinnedFlows++;
    }
    return { domains, apps, pinnedFlows };
  }, [flows]);

  const q = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const domainList = [...domains.entries()].filter(([h]) => matches(h)).sort((a, b) => a[0].localeCompare(b[0]));
  useClientsVersion();
  // Client keys are app names (local, resolved) or IPs (unresolved local traffic / remote devices).
  const label = (key: string) => (isLocal(key) ? "This Mac (other)" : deviceName(key) ?? key);
  const appList = [...apps.entries()].filter(([a]) => matches(a, label(a))).sort((a, b) => b[1] - a[1]);
  const isDevice = (key: string) => /^[\d.:a-f]+$/i.test(key) && !isLocal(key);
  const macApps = appList.filter(([a]) => !isDevice(a));
  const devices = appList.filter(([a]) => isDevice(a));
  const [deviceMenu, setDeviceMenu] = useState<{ ip: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!deviceMenu) return;
    const close = () => setDeviceMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [deviceMenu]);
  const [editing, setEditing] = useState<string | null>(null);
  const rename = (ip: string) => setEditing(ip);
  const clientRow = (a: string, n: number) => (
    <div key={a} className={`side-item ${filter.client === a ? "active" : ""}`} onClick={() => set({ client: filter.client === a ? null : a })} title={isDevice(a) ? `${a} — right-click to rename` : a}
      onContextMenu={isDevice(a) ? (e) => { e.preventDefault(); e.stopPropagation(); setDeviceMenu({ ip: a, x: e.clientX, y: e.clientY }); } : undefined}
      onDoubleClick={isDevice(a) ? () => rename(a) : undefined}>
      <AppIcon name={isLocal(a) ? "This Mac" : a} />
      {editing === a ? (
        <input className="rename" autoFocus defaultValue={deviceName(a) ?? ""} placeholder={`Name for ${a}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { renameDevice(a, e.currentTarget.value); setEditing(null); }
            if (e.key === "Escape") setEditing(null);
          }}
          onBlur={(e) => { renameDevice(a, e.currentTarget.value); setEditing(null); }} />
      ) : (
        <span className="ellipsis grow">{label(a)}</span>
      )}
      <span className="muted">{n}</span>
    </div>
  );
  const pinList = pins.filter((p) => matches(p.host));

  const idsFor = (host: string) => [...flows.values()].filter((f) => f.host === host).map((f) => f.id);
  const isActive = (host: string) => filter.host === host;
  const select = (host: string) => set(isActive(host) ? { host: null } : { host, pinnedOnly: false, client: null });
  const isPinned = (host: string) => pins.some((p) => p.host === host);
  const togglePin = (host: string) => setPins((ps) => (isPinned(host) ? ps.filter((p) => p.host !== host) : [...ps, { host }]));

  const Section = ({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) => (
    <div className="side-section">
      <div className="side-title acc" onClick={() => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}>
        <span>{collapsed[id] && !q ? "▸" : "▾"} {title}</span> <span className="muted">{count}</span>
      </div>
      {(!collapsed[id] || q) && children}
    </div>
  );

  const item = (host: string, keyPrefix: string) => (
    <div
      key={keyPrefix + host}
      className={`side-item ${isActive(host) ? "active" : ""}`}
      onClick={() => select(host)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ host, x: e.clientX, y: e.clientY }); }}
      title={`${host} — right-click for actions`}
    >
      {lock(host)}
      <span className="ellipsis grow">{host}</span>
      <span className="muted">{domains.get(host) ?? 0}</span>
    </div>
  );

  const lock = (h: string) => {
    const on = decrypts(h);
    return (
      <button className={`lock ${on ? "on" : ""}`} title={on ? `Decrypting ${h} — click to stop` : `Encrypted — click to enable SSL Proxying for ${h}`}
        onClick={(e) => { e.stopPropagation(); sslForHost(h, !on); }}>{on ? "🔓" : "🔒"}</button>
    );
  };

  const rule = (host: string, type: Action["type"]) => onRule(newRule(`*://${host}/*`, defaultAction(type)));

  return (
    <aside className="sidebar">
      <div className="side-search">
        <input placeholder="Filter sidebar" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className={`side-item ${!filter.host && !filter.pinnedOnly && !filter.client ? "active" : ""}`} onClick={() => set({ host: null, pinnedOnly: false, client: null })}>
        <span className="grow">All</span> <span className="muted">{flows.size}</span>
      </div>

      <Section id="pinned" title="Pinned" count={pinList.length + (pinnedFlows ? 1 : 0)}>
        <div className={`side-item ${filter.pinnedOnly ? "active" : ""}`} onClick={() => set({ host: null, pinnedOnly: !filter.pinnedOnly })}>
          <span className="grow">📌 Pinned flows</span> <span className="muted">{pinnedFlows}</span>
        </div>
        {pinList.map((p) => item(p.host, "pin:"))}
        {!pinList.length && !q && <div className="muted side-hint">Right-click a domain → Pin</div>}
      </Section>

      <Section id="mac" title="This Mac" count={macApps.length}>
        {macApps.map(([a, n]) => clientRow(a, n))}
      </Section>

      <Section id="devices" title="Devices" count={devices.length}>
        {devices.map(([a, n]) => clientRow(a, n))}
        {!devices.length && !q && <div className="muted side-hint">Phones using this proxy appear here (Devices button in the toolbar)</div>}
      </Section>

      {deviceMenu && (
        <div className="menu" style={{ left: deviceMenu.x, top: deviceMenu.y }}>
          <div className="menu-label">{deviceMenu.ip}</div>
          <div onClick={() => rename(deviceMenu.ip)}>Rename…</div>
          <div onClick={() => set({ client: deviceMenu.ip })}>Show only this device</div>
          <div onClick={() => onExport([...flows.values()].filter((f) => f.client_ip === deviceMenu.ip).map((f) => f.id))}>Export as HAR…</div>
          <div className="danger" onClick={() => onRemove([...flows.values()].filter((f) => f.client_ip === deviceMenu.ip).map((f) => f.id))}>Delete its flows</div>
        </div>
      )}

      <Section id="domains" title="Domains" count={domainList.length}>
        {domainList.map(([h]) => item(h, "dom:"))}
      </Section>

      {menu && (
        <div className="menu" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 380) }}>
          <div className="menu-label">{menu.host}</div>
          <div onClick={() => togglePin(menu.host)}>{isPinned(menu.host) ? "Unpin" : "Pin"} domain</div>
          <div onClick={() => select(menu.host)}>Show only this domain</div>
          <hr />
          {decrypts(menu.host)
            ? <div onClick={() => sslForHost(menu.host, false)}>Disable SSL Proxying for {menu.host}</div>
            : <div onClick={() => sslForHost(menu.host, true)}>Enable SSL Proxying for {menu.host}</div>}
          <hr />
          <div onClick={() => rule(menu.host, "breakpoint")}>Breakpoint…</div>
          <div onClick={() => rule(menu.host, "map_remote")}>Map Remote…</div>
          <div onClick={() => rule(menu.host, "script")}>Script…</div>
          <div onClick={() => rule(menu.host, "throttle")}>Throttle…</div>
          <div onClick={() => rule(menu.host, "block")}>Block…</div>
          <hr />
          <div onClick={() => navigator.clipboard.writeText(menu.host).then(() => notify("Copied"))}>Copy domain</div>
          <div onClick={() => onExport(idsFor(menu.host))}>Export as HAR…</div>
          <div className="danger" onClick={() => onRemove(idsFor(menu.host))}>Delete these flows</div>
        </div>
      )}
    </aside>
  );
}
