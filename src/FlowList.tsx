import { useVirtualizer } from "@tanstack/react-virtual";
import { ReactNode, useEffect, useRef, useState } from "react";
import { FlowSummary, formatBytes } from "./api";

const ROW = 24;

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

interface Column { id: string; label: string; width: number | "flex"; align?: "right"; cell: (f: FlowSummary) => ReactNode; title?: (f: FlowSummary) => string }

export const COLUMNS: Column[] = [
  { id: "id", label: "#", width: 52, cell: (f) => (f.pinned ? "📌" : f.id) },
  { id: "time", label: "Time", width: 96, cell: (f) => time(f.started_ms) },
  { id: "client", label: "Client", width: 130, cell: (f) => f.client_app ?? f.client_ip, title: (f) => `${f.client_app ?? ""} ${f.client_ip}` },
  { id: "method", label: "Method", width: 72, cell: (f) => <b>{f.method}</b> },
  { id: "status", label: "Code", width: 46, cell: (f) => (f.state === "failed" ? "ERR" : f.state === "paused" ? "⏸" : isTunnel(f) ? "" : f.status ?? "…") },
  { id: "tls", label: "🔒", width: 22, cell: (f) => (f.scheme === "https" || f.scheme === "wss" ? "🔒" : ""), title: (f) => f.scheme },
  { id: "host", label: "Host", width: 190, cell: (f) => f.host },
  {
    id: "path", label: "Path", width: "flex", title: (f) => f.error ?? f.url,
    cell: (f) => (
      <>
        {f.state === "paused" && <span className="badge warn">⏸ paused</span>}
        {isTunnel(f) && <span className="badge muted" title="Right-click → Enable SSL Proxying to decrypt this host">SSL Proxying not enabled</span>}
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
];

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
}) {
  const { flows, selected, onSelect, onContextMenu, follow, colors } = props;
  const [widths, setWidths] = useState<Record<string, number>>(() => load("sniffo.columnWidths", {}));
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
                onClick={() => onSelect(f.id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(f.id, e.clientX, e.clientY); }}
              >
                {cols.map((c) => <span key={c.id} className={`c-${c.id}`} style={style(c)} title={c.title?.(f)}>{c.cell(f)}</span>)}
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
              }} /> {c.label === "🔒" ? "TLS" : c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
