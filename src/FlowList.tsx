import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "./icons";
import { CSSProperties, memo, MutableRefObject, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FlowSummary, formatBytes } from "./api";
import { AppIcon } from "./AppIcon";
import { clientDisplay, clientIconName, useClientsVersion } from "./clients";
import { Key, t, useLang } from "./i18n";

const ROW = 28;

/** Row highlight colours, by the name stored on the flow; labels are "highlight.<name>". */
export const HIGHLIGHTS: Record<string, string> = {
  red: "rgb(255 59 48 / 0.22)", orange: "rgb(255 149 0 / 0.22)", yellow: "rgb(255 204 0 / 0.25)",
  green: "rgb(52 199 89 / 0.22)", blue: "rgb(0 122 255 / 0.20)", purple: "rgb(175 82 222 / 0.22)",
};

/** HTTPS tunnel passed through without decryption (SSL Proxying not enabled for its host). */
export const isTunnel = (f: FlowSummary) => f.method === "CONNECT";

function statusClass(f: FlowSummary) {
  if (f.state === "failed") return "s-err";
  if (isTunnel(f)) return "s-pending";
  if (f.status == null) return "s-pending";
  if (f.status >= 500) return "s-err";
  if (f.status >= 400) return "s-warn";
  if (f.status >= 300) return "s-redirect";
  return "s-ok";
}

// One formatter for every cell: toLocaleTimeString builds a new one per call.
const HMS = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const time = (ms: number) => HMS.format(ms) + "." + String(ms % 1000).padStart(3, "0");
const ms = (v: number | null) => (v != null ? `${v} ms` : "");

/** What a cell needs besides its flow. */
interface CellContext { decrypts: (host: string) => boolean }

interface Column { id: string; label: Key | "#" | "TLS" | "TTFB"; width: number | "flex"; align?: "right"; cell: (f: FlowSummary, ctx: CellContext) => ReactNode; title?: (f: FlowSummary) => string }

export const COLUMNS: Column[] = [
  { id: "id", label: "#", width: 52, cell: (f) => (f.pinned ? <Icon name="pin" label={t("list.pinned")} /> : f.id) },
  { id: "time", label: "list.col.time", width: 96, cell: (f) => time(f.started_ms) },
  { id: "client", label: "list.col.client", width: 140, cell: (f) => <><AppIcon name={clientIconName(f)} />{clientDisplay(f)}</>, title: (f) => `${clientDisplay(f)} — ${f.client_ip}` },
  { id: "method", label: "list.col.method", width: 72, cell: (f) => <span className={`method m-${f.method}`}>{f.method}</span> },
  { id: "status", label: "list.col.status", width: 46, cell: (f) => (f.state === "failed" ? "ERR" : f.state === "paused" ? <Icon name="pause" label={t("list.paused")} /> : isTunnel(f) ? "" : f.status ?? "…") },
  { id: "tls", label: "TLS", width: 30, cell: (f) => (f.scheme === "https" || f.scheme === "wss" ? <Icon name="lock" label="TLS" /> : ""), title: (f) => f.scheme },
  { id: "host", label: "list.col.host", width: 190, cell: (f) => f.host },
  {
    id: "path", label: "list.col.path", width: "flex", title: (f) => f.error ?? f.url,
    cell: (f, ctx) => (
      <>
        {f.state === "paused" && <span className="badge warn"><Icon name="pause" size={10} /> {t("list.badge.paused")}</span>}
        {isTunnel(f) && ctx.decrypts(f.host) && <span className="badge" title={t("list.badge.sslOnTitle", { host: f.host })}><Icon name="unlock" size={10} /> {t("list.badge.sslOn")}</span>}
        {isTunnel(f) && !ctx.decrypts(f.host) && <button className="badge ssl-off" data-ssl-host={f.host} title={t("list.badge.enableSslTitle", { host: f.host })}><Icon name="lock" size={10} /> {t("list.badge.enableSsl")}</button>}
        {f.ws_count > 0 && <span className="badge">WS {f.ws_count}</span>}
        {f.graphql && <span className="badge gql">{f.graphql}</span>}
        {f.comment && <span className="badge" title={f.comment}><Icon name="note" size={10} /> {f.comment.length > 24 ? f.comment.slice(0, 24) + "…" : f.comment}</span>}
        {f.tags.map((t) => <span key={t} className="badge">{t}</span>)}
        {f.path}
      </>
    ),
  },
  { id: "version", label: "list.col.version", width: 72, cell: (f) => f.http_version.replace("HTTP/", "h") },
  { id: "reqtype", label: "list.col.reqtype", width: 120, cell: (f) => f.request_type?.split(";")[0] ?? "" },
  { id: "type", label: "list.col.type", width: 130, cell: (f) => (f.status === 101 ? "websocket" : f.content_type?.split(";")[0] ?? "") },
  { id: "reqsize", label: "list.col.reqsize", width: 64, align: "right", cell: (f) => (f.request_size ? formatBytes(f.request_size) : "") },
  { id: "size", label: "list.col.size", width: 68, align: "right", cell: (f) => formatBytes(f.response_size) },
  { id: "ttfb", label: "TTFB", width: 64, align: "right", cell: (f) => ms(f.ttfb_ms) },
  { id: "duration", label: "list.col.duration", width: 72, align: "right", cell: (f) => ms(f.duration_ms) },
  { id: "timeline", label: "list.col.timeline", width: 120, cell: (f) => <Timeline f={f} />, title: (f) => (f.duration_ms != null ? t("list.timeline.title", { ttfb: f.ttfb_ms ?? "?", total: f.duration_ms }) : t("list.timeline.pending")) },
];

const label = (c: Column) => (c.label.includes(".") ? t(c.label as Key) : c.label);

// ponytail: per-row duration on a log scale up to 5 s, not a shared waterfall; enough to spot slow calls at a glance.
const scale = (v: number) => Math.min(100, Math.max(3, (Math.log1p(v) / Math.log1p(5000)) * 100));

/** Duration bar; the darker head is the time to first byte. */
function Timeline({ f }: { f: FlowSummary }) {
  if (isTunnel(f)) return null;
  if (f.duration_ms == null) return <span className="tl"><span className="tl-bar pending" /></span>;
  const total = scale(f.duration_ms);
  const ttfb = f.ttfb_ms != null ? Math.min(100, (scale(f.ttfb_ms) / total) * 100) : 0;
  return <span className="tl"><span className="tl-bar" style={{ width: `${total}%` }}><span className="tl-ttfb" style={{ width: `${ttfb}%` }} /></span></span>;
}

const DEFAULT_HIDDEN = ["reqtype", "ttfb"];

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function loadHidden(): Set<string> {
  try {
    const v = localStorage.getItem("sniffo.hiddenColumns");
    return new Set(v ? JSON.parse(v) : DEFAULT_HIDDEN);
  } catch {
    return new Set(DEFAULT_HIDDEN);
  }
}

interface Handlers {
  onSelect: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  onEnableSsl: (host: string) => void;
}

/** One row; memoized so a batch of flow updates re-renders only the rows that changed. */
const Row = memo(function Row({ f, top, alt, selected, color, cells, decrypts, handlers }: {
  f: FlowSummary; top: number; alt: boolean; selected: boolean; color?: string;
  cells: { c: Column; style: CSSProperties }[]; decrypts: (host: string) => boolean;
  /** Latest handlers behind a stable ref: the parent's are new functions on every render. */
  handlers: MutableRefObject<Handlers>;
  /** Re-render when device names change. */
  clients: number;
}) {
  useLang();
  return (
    <div
      className={`flow-row ${alt ? "alt" : ""} ${selected ? "selected" : ""} ${statusClass(f)}`}
      style={{ position: "absolute", top: 0, transform: `translateY(${top}px)`, height: ROW, width: "100%", ...(color && !selected ? { background: color } : {}) }}
      onClick={(e) => {
        const host = (e.target as HTMLElement).closest<HTMLElement>("[data-ssl-host]")?.dataset.sslHost;
        if (host) { e.stopPropagation(); handlers.current.onEnableSsl(host); return; }
        handlers.current.onSelect(f.id);
      }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handlers.current.onContextMenu(f.id, e.clientX, e.clientY); }}
    >
      {cells.map(({ c, style }) => <span key={c.id} className={`c-${c.id}`} style={style} title={c.title?.(f)}>{c.cell(f, { decrypts })}</span>)}
    </div>
  );
});

/** Window event that drives the list from outside (palette): jump to an edge or flip the order. */
export const LIST_EVENT = "sniffo:list";
export type ListCommand = "top" | "bottom" | "order";
export const listCommand = (what: ListCommand) => window.dispatchEvent(new CustomEvent(LIST_EVENT, { detail: what }));

export function FlowList(props: {
  flows: FlowSummary[];
  selected: number | null;
  onSelect: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  follow: boolean;
  /** Scrolling up pauses auto-scroll; scrolling back to the bottom resumes it. */
  onFollowChange: (follow: boolean) => void;
  /** Called by the inline "Enable SSL Proxying" badge on tunnel rows. */
  onEnableSsl: (host: string) => void;
  /** Whether SSL Proxying now covers a host (tunnel rows recorded before it was enabled). */
  decrypts: (host: string) => boolean;
}) {
  const { flows, selected, onSelect, onContextMenu, follow, onFollowChange, onEnableSsl, decrypts } = props;
  const lang = useLang();
  const [widths, setWidths] = useState<Record<string, number>>(() => load("sniffo.columnWidths", {}));
  const clients = useClientsVersion(); // client labels change when a device is renamed
  const handlers = useRef<Handlers>({ onSelect, onContextMenu, onEnableSsl });
  handlers.current = { onSelect, onContextMenu, onEnableSsl };
  const parent = useRef<HTMLDivElement>(null);
  // Newest first is a view option: the list (and auto-scroll) then follow the top edge.
  const [newestFirst, setNewestFirst] = useState<boolean>(() => load("sniffo.newestFirst", false));
  const rows = useMemo(() => (newestFirst ? [...flows].reverse() : flows), [flows, newestFirst]);
  const [edges, setEdges] = useState({ top: true, bottom: true });
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 20, scrollMargin: ROW, scrollPaddingStart: ROW });
  const [hidden, setHidden] = useState(loadHidden);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const cols = COLUMNS.filter((c) => !hidden.has(c.id));

  useEffect(() => save("sniffo.hiddenColumns", [...hidden]), [hidden]);

  useEffect(() => save("sniffo.newestFirst", newestFirst), [newestFirst]);

  const jump = (to: "top" | "bottom") => parent.current?.scrollTo({ top: to === "top" ? 0 : parent.current.scrollHeight });

  useEffect(() => {
    if (follow && rows.length) jump(newestFirst ? "top" : "bottom");
  }, [rows.length, follow, newestFirst]);

  // Palette commands and shortcuts elsewhere in the app.
  useEffect(() => {
    const on = (e: Event) => {
      const what = (e as CustomEvent<ListCommand>).detail;
      if (what === "order") setNewestFirst((n) => !n);
      else jump(what);
    };
    window.addEventListener(LIST_EVENT, on);
    return () => window.removeEventListener(LIST_EVENT, on);
  }, []);

  useEffect(() => {
    if (!picker) return;
    const close = () => setPicker(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [picker]);

  const move = (delta: number) => {
    const i = rows.findIndex((f) => f.id === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + delta))];
    if (next) {
      onSelect(next.id);
      v.scrollToIndex(rows.indexOf(next));
    }
  };

  const style = (c: Column) => {
    const w: number | "flex" = c.id in widths ? widths[c.id] : c.width;
    return w === "flex" ? { flex: 1, minWidth: 120 } : { width: w, flex: "none" as const, textAlign: c.align };
  };

  const cells = useMemo(() => cols.map((c) => ({ c, style: style(c) })), [hidden, widths, lang]);

  // Row padding (2×12) + 10px gap between cells (.flow-row in App.css) + every fixed column + the flexible path column's minimum.
  const minWidth = 24 + 10 * (cols.length - 1) + cols.reduce((sum, c) => {
    const w: number | "flex" = c.id in widths ? widths[c.id] : c.width;
    return sum + (w === "flex" ? 120 : w);
  }, 0);

  /** Drag the right edge of a header cell to resize that column. */
  const startResize = (c: Column, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
    let latest = widths;
    const move = (ev: MouseEvent) => {
      latest = { ...latest, [c.id]: Math.max(30, Math.round(startW + ev.clientX - startX)) };
      setWidths(latest);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      save("sniffo.columnWidths", latest);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="flow-list">
      {/* One scroller for both axes: the sticky header scrolls sideways with the rows. */}
      <div
        className="flow-scroll"
        ref={parent}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          const top = el.scrollTop < ROW * 1.5;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 1.5;
          if (top !== edges.top || bottom !== edges.bottom) setEdges({ top, bottom });
          const atLatest = newestFirst ? top : bottom;
          if (atLatest !== follow) onFollowChange(atLatest);
        }}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (e.key === "Home" || (mod && e.key === "ArrowUp")) { e.preventDefault(); jump("top"); return; }
          if (e.key === "End" || (mod && e.key === "ArrowDown")) { e.preventDefault(); jump("bottom"); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}
      >
        {/* The header occupies the first ROW px of the scroller: hence scrollMargin/scrollPaddingStart above. */}
        <div className="flow-row head" style={{ minWidth }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPicker({ x: e.clientX, y: e.clientY }); }} title={t("list.head.title")}>
          {cols.map((c) => (
            <span key={c.id} style={style(c)} className={`th ${c.id === "id" ? "sortable" : ""}`}
              onClick={c.id === "id" ? (e) => { if (!(e.target as HTMLElement).classList.contains("resizer")) setNewestFirst(!newestFirst); } : undefined}
              title={c.id === "id" ? t(newestFirst ? "list.sort.newest" : "list.sort.oldest") : undefined}>
              {label(c)}{c.id === "id" && <span className="sort">{newestFirst ? "↓" : "↑"}</span>}
              <span className="resizer" onMouseDown={(e) => startResize(c, e)} onDoubleClick={() => { const { [c.id]: _, ...rest } = widths; setWidths(rest); save("sniffo.columnWidths", rest); }} title={t("list.resize")} />
            </span>
          ))}
        </div>
        <div style={{ height: v.getTotalSize(), position: "relative", minWidth }}>
          {v.getVirtualItems().map((row) => {
            const f = rows[row.index];
            return (
              <Row key={f.id} f={f} top={row.start - ROW} alt={row.index % 2 === 1} selected={f.id === selected} color={f.color ? HIGHLIGHTS[f.color] : undefined}
                cells={cells} decrypts={decrypts} handlers={handlers} clients={clients} />
            );
          })}
        </div>
      </div>
      <div className="list-jump">
        {!edges.top && <button onClick={() => jump("top")} title={t("list.topTitle")}>{t("list.top")}</button>}
        {!edges.bottom && <button onClick={() => jump("bottom")} title={t("list.bottomTitle")}>{t("list.bottom")}</button>}
      </div>
      {picker && (
        <div className="menu" style={{ left: picker.x, top: picker.y }} onClick={(e) => e.stopPropagation()}>
          {COLUMNS.map((c) => (
            <label key={c.id} className="menu-check">
              <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => {
                const next = new Set(hidden);
                if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                setHidden(next);
              }} /> {label(c)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
