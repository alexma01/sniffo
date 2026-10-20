import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { FlowSummary, formatBytes } from "./api";

const ROW = 24;

function statusClass(f: FlowSummary) {
  if (f.state === "failed") return "s-err";
  if (f.status == null) return "s-pending";
  if (f.status >= 500) return "s-err";
  if (f.status >= 400) return "s-warn";
  if (f.status >= 300) return "s-redirect";
  return "s-ok";
}

export function FlowList(props: {
  flows: FlowSummary[];
  selected: number | null;
  onSelect: (id: number) => void;
  follow: boolean;
}) {
  const { flows, selected, onSelect, follow } = props;
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: flows.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 20 });

  useEffect(() => {
    if (follow && flows.length) v.scrollToIndex(flows.length - 1);
  }, [flows.length, follow]);

  const move = (delta: number) => {
    const i = flows.findIndex((f) => f.id === selected);
    const next = flows[Math.max(0, Math.min(flows.length - 1, (i < 0 ? -1 : i) + delta))];
    if (next) {
      onSelect(next.id);
      v.scrollToIndex(flows.indexOf(next));
    }
  };

  return (
    <div className="flow-list">
      <div className="flow-row head">
        <span className="c-id">#</span>
        <span className="c-method">Method</span>
        <span className="c-status">Code</span>
        <span className="c-host">Host</span>
        <span className="c-path">Path</span>
        <span className="c-type">Type</span>
        <span className="c-size">Size</span>
        <span className="c-time">Time</span>
      </div>
      <div
        className="flow-scroll"
        ref={parent}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}
      >
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((row) => {
            const f = flows[row.index];
            return (
              <div
                key={f.id}
                className={`flow-row ${f.id === selected ? "selected" : ""} ${statusClass(f)}`}
                style={{ position: "absolute", top: 0, transform: `translateY(${row.start}px)`, height: ROW, width: "100%" }}
                onClick={() => onSelect(f.id)}
              >
                <span className="c-id">{f.id}</span>
                <span className="c-method">{f.method}</span>
                <span className="c-status">{f.state === "failed" ? "ERR" : f.status ?? "…"}</span>
                <span className="c-host" title={f.host}>{f.host}</span>
                <span className="c-path" title={f.error ?? f.url}>{f.path}</span>
                <span className="c-type">{f.content_type?.split(";")[0] ?? ""}</span>
                <span className="c-size">{formatBytes(f.response_size)}</span>
                <span className="c-time">{f.duration_ms != null ? `${f.duration_ms} ms` : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
