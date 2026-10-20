import { useState } from "react";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function Leaf({ v }: { v: Json }) {
  if (v === null) return <span className="j-null">null</span>;
  if (typeof v === "string") return <span className="j-str">"{v}"</span>;
  if (typeof v === "number") return <span className="j-num">{v}</span>;
  return <span className="j-bool">{String(v)}</span>;
}

function Node({ name, v, depth }: { name?: string; v: Json; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined && <span className="j-key">{name}: </span>;
  if (v === null || typeof v !== "object") {
    return <div className="j-row">{label}<Leaf v={v} /></div>;
  }
  const entries: [string, Json][] = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  const [l, r] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  return (
    <div className="j-row">
      <span className="j-toggle" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"}</span>
      {label}
      {l}
      {!open && <span className="muted" onClick={() => setOpen(true)}> {entries.length} {Array.isArray(v) ? "items" : "keys"} </span>}
      {open && <div className="j-children">{entries.map(([k, x]) => <Node key={k} name={k} v={x} depth={depth + 1} />)}</div>}
      {r}
    </div>
  );
}

export function JsonTree({ value }: { value: unknown }) {
  return <div className="json-tree"><Node v={value as Json} depth={0} /></div>;
}
