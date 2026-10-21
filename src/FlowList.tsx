import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "./icons";
import { ReactNode, useEffect, useRef, useState } from "react";
import { FlowSummary, formatBytes } from "./api";
import { AppIcon } from "./AppIcon";
import { clientDisplay, clientIconName, useClientsVersion } from "./clients";

const ROW = 28;

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

const time = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
};
const ms = (v: number | null) => (v != null ? `${v} ms` : "");

/** What a cell needs besides its flow. */
interface CellContext { decrypts: (host: string) => boolean }

interface Column { id: string; label: string; width: number | "flex"; align?: "right"; cell: (f: FlowSummary, ctx: CellContext) => ReactNode; title?: (f: FlowSummary) => string }

export const COLUMNS: Column[] = [
  { id: "id", label: "#", width: 52, cell: (f) => (f.pinned ? <Icon name="pin" label="Pinned" /> : f.id) },
  { id: "time", label: "Time", width: 96, cell: (f) => time(f.started_ms) },
  { id: "client", label: "Client", width: 140, cell: (f) => <><AppIcon name={clientIconName(f)} />{clientDisplay(f)}</>, title: (f) => `${clientDisplay(f)} — ${f.client_ip}` },
  { id: "method", label: "Method", width: 72, cell: (f) => <span className={`method m-${f.method}`}>{f.method}</span> },
  { id: "status", label: "Code", width: 46, cell: (f) => (f.state === "failed" ? "ERR" : f.state === "paused" ? <Icon name="pause" label="Paused" /> : isTunnel(f) ? "" : f.status ?? "…") },
  { id: "tls", label: "TLS", width: 30, cell: (f) => (f.scheme === "https" || f.scheme === "wss" ? <Icon name="lock" label="TLS" /> : ""), title: (f) => f.scheme },
  { id: "host", label: "Host", width: 190, cell: (f) => f.host },
  {
    id: "path", label: "Path", width: "flex", title: (f) => f.error ?? f.url,
    cell: (f, ctx) => (
      <>
        {f.state === "paused" && <span className="badge warn"><Icon name="pause" size={10} /> paused</span>}
        {isTunnel(f) && ctx.decrypts(f.host) && <span className="badge" title={`SSL Proxying is on for ${f.host}: this row is the old tunnel, new connections are decrypted`}><Icon name="unlock" size={10} /> SSL on</span>}
        {isTunnel(f) && !ctx.decrypts(f.host) && <button className="badge ssl-off" data-ssl-host={f.host} title={`Decrypt ${f.host}: Sniffo re-signs it with its own CA (the device must trust the Sniffo Root CA)`}><Icon name="lock" size={10} /> Enable SSL Proxying</button>}
        {f.ws_count > 0 && <span className="badge">WS {f.ws_count}</span>}
        {f.graphql && <span className="badge gql">{f.graphql}</span>}
        {f.tags.map((t) => <span key={t} className="badge">{t}</span>)}
        {f.path}
      </>
    ),
  },
  { id: "version", label: "Protocol", width: 72, cell: (f) => f.http_version.replace("HTTP/", "h") },
  { id: "reqtype", label: "Req type", width: 120, cell: (f) => f.request_type?.split(";")[0] ?? "" },
  { id: "type", label: "Type", width: 130, cell: (f) => (f.status === 101 ? "websocket" : f.content_type?.split(";")[0] ?? "") },
  { id: "reqsize", label: "Req", width: 64, align: "right", cell: (f) => (f.request_size ? formatBytes(f.request_size) : "") },
  { id: "size", label: "Size", width: 68, align: "right", cell: (f) => formatBytes(f.response_size) },
  { id: "ttfb", label: "TTFB", width: 64, align: "right", cell: (f) => ms(f.ttfb_ms) },
  { id: "duration", label: "Duration", width: 72, align: "right", cell: (f) => ms(f.duration_ms) },
  { id: "timeline", label: "Timeline", width: 120, cell: (f) => <Timeline f={f} />, title: (f) => (f.duration_ms != null ? `TTFB ${f.ttfb_ms ?? "?"} ms · total ${f.duration_ms} ms` : "In progress") },
];

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

export function FlowList(props: {
  flows: FlowSummary[];
  selected: number | null;
  onSelect: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  follow: boolean;
  /** Row highlight colours set from the context menu. */
  colors: Map<number, string>;
  /** Called by the inline "Enable SSL Proxying" badge on tunnel rows. */
  onEnableSsl: (host: string) => void;
  /** Whether SSL Proxying now covers a host (tunnel rows recorded before it was enabled). */
  decrypts: (host: string) => boolean;
}) {
  const { flows, selected, onSelect, onContextMenu, follow, colors, onEnableSsl, decrypts } = props;
  const [widths, setWidths] = useState<Record<string, number>>(() => load("sniffo.columnWidths", {}));
  useClientsVersion(); // client labels change when a device is renamed
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: flows.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 20, scrollMargin: ROW, scrollPaddingStart: ROW });
  const [hidden, setHidden] = useState(loadHidden);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const cols = COLUMNS.filter((c) => !hidden.has(c.id));

  useEffect(() => save("sniffo.hiddenColumns", [...hidden]), [hidden]);

  useEffect(() => {
    if (follow && flows.length) v.scrollToIndex(flows.length - 1);
  }, [flows.length, follow]);

  useEffect(() => {
    if (!picker) return;
    const close = () => setPicker(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [picker]);

  const move = (delta: number) => {
    const i = flows.findIndex((f) => f.id === selected);
    const next = flows[Math.max(0, Math.min(flows.length - 1, (i < 0 ? -1 : i) + delta))];
    if (next) {
      onSelect(next.id);
      v.scrollToIndex(flows.indexOf(next));
    }
  };

  const style = (c: Column) => {
    const w: number | "flex" = c.id in widths ? widths[c.id] : c.width;
    return w === "flex" ? { flex: 1, minWidth: 120 } : { width: w, flex: "none" as const, textAlign: c.align };
  };

  // Row padding (20) + 8px gap between cells + every fixed column + the flexible path column's minimum.
  const minWidth = 20 + 8 * (cols.length - 1) + cols.reduce((sum, c) => {
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
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}
      >
        {/* The header occupies the first ROW px of the scroller: hence scrollMargin/scrollPaddingStart above. */}
        <div className="flow-row head" style={{ minWidth }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPicker({ x: e.clientX, y: e.clientY }); }} title="Right-click to choose columns">
          {cols.map((c) => (
            <span key={c.id} style={style(c)} className="th">
              {c.label}
              <span className="resizer" onMouseDown={(e) => startResize(c, e)} onDoubleClick={() => { const { [c.id]: _, ...rest } = widths; setWidths(rest); save("sniffo.columnWidths", rest); }} title="Drag to resize, double-click to reset" />
            </span>
          ))}
        </div>
        <div style={{ height: v.getTotalSize(), position: "relative", minWidth }}>
          {v.getVirtualItems().map((row) => {
            const f = flows[row.index];
            return (
              <div
                key={f.id}
                className={`flow-row ${f.id === selected ? "selected" : ""} ${statusClass(f)}`}
                style={{ position: "absolute", top: 0, transform: `translateY(${row.start - ROW}px)`, height: ROW, width: "100%", ...(colors.has(f.id) && f.id !== selected ? { background: colors.get(f.id) } : {}) }}
                onClick={(e) => {
                  const host = (e.target as HTMLElement).closest<HTMLElement>("[data-ssl-host]")?.dataset.sslHost;
                  if (host) { e.stopPropagation(); onEnableSsl(host); return; }
                  onSelect(f.id);
                }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(f.id, e.clientX, e.clientY); }}
              >
                {cols.map((c) => <span key={c.id} className={`c-${c.id}`} style={style(c)} title={c.title?.(f)}>{c.cell(f, { decrypts })}</span>)}
              </div>
            );
          })}
        </div>
      </div>
      {picker && (
        <div className="menu" style={{ left: picker.x, top: picker.y }} onClick={(e) => e.stopPropagation()}>
          {COLUMNS.map((c) => (
            <label key={c.id} className="menu-check">
              <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => {
                const next = new Set(hidden);
                if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                setHidden(next);
              }} /> {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
