import { ReactNode, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { Action, FlowSummary, Rule } from "./api";
import { clientLabel, Filter } from "./filters";
import { AppIcon } from "./AppIcon";
import { deviceName, isLocal, renameDevice, useClientsVersion } from "./clients";
import { defaultAction, newRule } from "./RulesEditor";
import { t, useLang } from "./i18n";

// Domains only: per-endpoint rows explode on REST APIs with ids in paths (/items/9, /users/123…),
// so endpoint actions live in the flow list's context menu instead.
interface Pin { host: string }

const load = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };
interface Target { host: string; x: number; y: number }

// Sidebar sparklines: flows per client in the last 2 minutes of capture, 10 s per point.
const SPARK_BUCKETS = 12;
const SPARK_STEP_MS = 10_000;

function Sparkline({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  const points = counts.map((c, i) => `${(i * 33) / (counts.length - 1)},${11 - (c / max) * 10}`).join(" ");
  return <svg className="spark" width="34" height="12" viewBox="0 0 34 12" aria-hidden="true"><polyline points={points} /></svg>;
}

// Module level: a component defined inside Sidebar would remount (losing focus and clicks) on every render.
function Section({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="side-section">
      <div className="side-title acc" onClick={onToggle}>
        <span>{open ? "▾" : "▸"} {title}</span> <span className="muted">{count}</span>
      </div>
      {open && children}
    </div>
  );
}

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
  useLang();
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

  const { domains, apps, pinnedFlows, spark } = useMemo(() => {
    const domains = new Map<string, number>();
    const apps = new Map<string, number>();
    const spark = new Map<string, number[]>();
    let pinnedFlows = 0;
    let latest = 0;
    for (const f of flows.values()) latest = Math.max(latest, f.started_ms);
    for (const f of flows.values()) {
      const bucket = SPARK_BUCKETS - 1 - Math.floor((latest - f.started_ms) / SPARK_STEP_MS);
      if (bucket >= 0) {
        const key = clientLabel(f);
        const counts = spark.get(key) ?? new Array(SPARK_BUCKETS).fill(0);
        counts[bucket]++;
        spark.set(key, counts);
      }
      domains.set(f.host, (domains.get(f.host) ?? 0) + 1);
      apps.set(clientLabel(f), (apps.get(clientLabel(f)) ?? 0) + 1);
      if (f.pinned) pinnedFlows++;
    }
    return { domains, apps, pinnedFlows, spark };
  }, [flows]);

  const q = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const domainList = [...domains.entries()].filter(([h]) => matches(h)).sort((a, b) => a[0].localeCompare(b[0]));
  useClientsVersion();
  // Client keys are app names (local, resolved) or IPs (unresolved local traffic / remote devices).
  const label = (key: string) => (isLocal(key) ? t("client.thisMacOther") : deviceName(key) ?? key);
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
    <div key={a} className={`side-item ${filter.client === a ? "active" : ""}`} onClick={() => set({ client: filter.client === a ? null : a })} title={isDevice(a) ? t("sidebar.renameTitle", { ip: a }) : a}
      onContextMenu={isDevice(a) ? (e) => { e.preventDefault(); e.stopPropagation(); setDeviceMenu({ ip: a, x: e.clientX, y: e.clientY }); } : undefined}
      onDoubleClick={isDevice(a) ? () => rename(a) : undefined}>
      <AppIcon name={isLocal(a) ? "This Mac" : a} />
      {editing === a ? (
        <input className="rename" autoFocus defaultValue={deviceName(a) ?? ""} placeholder={t("sidebar.namePlaceholder", { ip: a })}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { renameDevice(a, e.currentTarget.value); setEditing(null); }
            if (e.key === "Escape") setEditing(null);
          }}
          onBlur={(e) => { renameDevice(a, e.currentTarget.value); setEditing(null); }} />
      ) : (
        <span className="ellipsis grow">{label(a)}</span>
      )}
      {spark.has(a) && <Sparkline counts={spark.get(a)!} />}
      <span className="muted">{n}</span>
    </div>
  );
  const pinList = pins.filter((p) => matches(p.host));

  const idsFor = (host: string) => [...flows.values()].filter((f) => f.host === host).map((f) => f.id);
  const isActive = (host: string) => filter.host === host;
  const select = (host: string) => set(isActive(host) ? { host: null } : { host, pinnedOnly: false, client: null });
  const isPinned = (host: string) => pins.some((p) => p.host === host);
  const togglePin = (host: string) => setPins((ps) => (isPinned(host) ? ps.filter((p) => p.host !== host) : [...ps, { host }]));

  const sectionProps = (id: string) => ({ open: !collapsed[id] || !!q, onToggle: () => setCollapsed((c) => ({ ...c, [id]: !c[id] })) });

  const item = (host: string, keyPrefix: string) => (
    <div
      key={keyPrefix + host}
      className={`side-item ${isActive(host) ? "active" : ""}`}
      onClick={() => select(host)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ host, x: e.clientX, y: e.clientY }); }}
      title={t("sidebar.hostTitle", { host })}
    >
      {lock(host)}
      <span className="ellipsis grow">{host}</span>
      <span className="muted">{domains.get(host) ?? 0}</span>
    </div>
  );

  const lock = (h: string) => {
    const on = decrypts(h);
    return (
      <button className={`lock ${on ? "on" : ""}`} title={t(on ? "sidebar.decrypting" : "sidebar.encrypted", { host: h })}
        onClick={(e) => { e.stopPropagation(); sslForHost(h, !on); }}><Icon name={on ? "unlock" : "lock"} size={12} /></button>
    );
  };

  const rule = (host: string, type: Action["type"]) => onRule(newRule(`*://${host}/*`, defaultAction(type)));

  return (
    <aside className="sidebar">
      <div className="side-search">
        <input placeholder={t("sidebar.filter")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className={`side-item ${!filter.host && !filter.pinnedOnly && !filter.client ? "active" : ""}`} onClick={() => set({ host: null, pinnedOnly: false, client: null })}>
        <span className="grow">{t("sidebar.all")}</span> <span className="muted">{flows.size}</span>
      </div>

      <Section {...sectionProps("pinned")} title={t("sidebar.pinned")} count={pinList.length + (pinnedFlows ? 1 : 0)}>
        <div className={`side-item ${filter.pinnedOnly ? "active" : ""}`} onClick={() => set({ host: null, pinnedOnly: !filter.pinnedOnly })}>
          <span className="grow"><Icon name="pin" size={12} /> {t("sidebar.pinnedFlows")}</span> <span className="muted">{pinnedFlows}</span>
        </div>
        {pinList.map((p) => item(p.host, "pin:"))}
        {!pinList.length && !q && <div className="muted side-hint">{t("sidebar.pinHint")}</div>}
      </Section>

      <Section {...sectionProps("mac")} title={t("client.thisMac")} count={macApps.length}>
        {macApps.map(([a, n]) => clientRow(a, n))}
      </Section>

      <Section {...sectionProps("devices")} title={t("sidebar.devices")} count={devices.length}>
        {devices.map(([a, n]) => clientRow(a, n))}
        {!devices.length && !q && <div className="muted side-hint">{t("sidebar.devicesHint")}</div>}
      </Section>

      {deviceMenu && (
        <div className="menu" style={{ left: deviceMenu.x, top: deviceMenu.y }}>
          <div className="menu-label">{deviceMenu.ip}</div>
          <div onClick={() => rename(deviceMenu.ip)}>{t("sidebar.rename")}</div>
          <div onClick={() => set({ client: deviceMenu.ip })}>{t("sidebar.onlyDevice")}</div>
          <div onClick={() => onExport([...flows.values()].filter((f) => f.client_ip === deviceMenu.ip).map((f) => f.id))}>{t("sidebar.exportHar")}</div>
          <div className="danger" onClick={() => onRemove([...flows.values()].filter((f) => f.client_ip === deviceMenu.ip).map((f) => f.id))}>{t("sidebar.deleteDevice")}</div>
        </div>
      )}

      <Section {...sectionProps("domains")} title={t("sidebar.domains")} count={domainList.length}>
        {domainList.map(([h]) => item(h, "dom:"))}
      </Section>

      {menu && (
        <div className="menu" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 380) }}>
          <div className="menu-label">{menu.host}</div>
          <div onClick={() => togglePin(menu.host)}>{t(isPinned(menu.host) ? "sidebar.unpinDomain" : "sidebar.pinDomain")}</div>
          <div onClick={() => select(menu.host)}>{t("sidebar.onlyDomain")}</div>
          <hr />
          {decrypts(menu.host)
            ? <div onClick={() => sslForHost(menu.host, false)}>{t("sidebar.disableSsl", { host: menu.host })}</div>
            : <div onClick={() => sslForHost(menu.host, true)}>{t("sidebar.enableSsl", { host: menu.host })}</div>}
          <hr />
          <div onClick={() => rule(menu.host, "breakpoint")}>{t("sidebar.breakpoint")}</div>
          <div onClick={() => rule(menu.host, "map_remote")}>{t("sidebar.mapRemote")}</div>
          <div onClick={() => rule(menu.host, "script")}>{t("sidebar.script")}</div>
          <div onClick={() => rule(menu.host, "throttle")}>{t("sidebar.throttle")}</div>
          <div onClick={() => rule(menu.host, "block")}>{t("sidebar.block")}</div>
          <hr />
          <div onClick={() => navigator.clipboard.writeText(menu.host).then(() => notify(t("sidebar.copied")))}>{t("sidebar.copyDomain")}</div>
          <div onClick={() => onExport(idsFor(menu.host))}>{t("sidebar.exportHar")}</div>
          <div className="danger" onClick={() => onRemove(idsFor(menu.host))}>{t("sidebar.deleteFlows")}</div>
        </div>
      )}
    </aside>
  );
}
