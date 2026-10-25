import { memo, useState } from "react";
import { tn, useLang } from "./i18n";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function Leaf({ v }: { v: Json }) {
  if (v === null) return <span className="j-null">null</span>;
  if (typeof v === "string") return <span className="j-str">"{v}"</span>;
  if (typeof v === "number") return <span className="j-num">{v}</span>;
  return <span className="j-bool">{String(v)}</span>;
}

/** Children rendered per page: a 100k-item array must not mount 100k rows at once. */
const PAGE = 200;

const Node = memo(function Node({ name, v, depth }: { name?: string; v: Json; depth: number }) {
  useLang();
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(PAGE);
  const label = name !== undefined && <><span className="j-key">{name}</span><span className="j-punct">: </span></>;
  if (v === null || typeof v !== "object") {
    return <div className="j-row">{label}<Leaf v={v} /></div>;
  }
  const count = Array.isArray(v) ? v.length : Object.keys(v).length;
  const entries: [string, Json][] = !open ? [] : Array.isArray(v) ? v.slice(0, shown).map((x, i) => [String(i), x]) : Object.entries(v).slice(0, shown);
  const [l, r] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  return (
    <div className="j-row">
      <span className="j-toggle" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"}</span>
      {label}
      <span className="j-punct">{l}</span>
      {!open && <span className="muted" onClick={() => setOpen(true)}> {tn(Array.isArray(v) ? "json.items" : "json.keys", count)} </span>}
      {open && (
        <div className="j-children">
          {entries.map(([k, x]) => <Node key={k} name={k} v={x} depth={depth + 1} />)}
          {count > shown && <div className="j-row muted j-more" onClick={() => setShown(shown + PAGE * 5)}>{tn("json.more", count - shown)}</div>}
        </div>
      )}
      <span className="j-punct">{r}</span>
    </div>
  );
});

export function JsonTree({ value }: { value: unknown }) {
  return <div className="json-tree"><Node v={value as Json} depth={0} /></div>;
}
