import { useMemo, useState } from "react";
import { FlowSummary } from "./api";
import { backdrop } from "./backdrop";
import { t, tn, useLang } from "./i18n";

export interface Command { label: string; shortcut?: string; run: () => void }

type Item = { kind: "action" | "host" | "flow"; tag: string; label: string; hint: string; run: () => void };

/** ⌘P: one search box for actions, hosts and flows. */
export function Palette(props: {
  commands: Command[];
  flows: FlowSummary[];
  onHost: (host: string) => void;
  onFlow: (id: number) => void;
  onClose: () => void;
}) {
  const { commands, flows, onHost, onFlow, onClose } = props;
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const has = (s: string) => s.toLowerCase().includes(q);
    const actions: Item[] = commands.filter((c) => has(c.label))
      .map((c) => ({ kind: "action", tag: t("palette.action"), label: c.label, hint: c.shortcut ?? "", run: c.run }));
    if (!q) return [[t("palette.actions"), actions]] as const;
    const hostCounts = new Map<string, number>();
    for (const f of flows) if (has(f.host)) hostCounts.set(f.host, (hostCounts.get(f.host) ?? 0) + 1);
    const hosts: Item[] = [...hostCounts].slice(0, 5)
      .map(([h, n]) => ({ kind: "host", tag: t("palette.host"), label: h, hint: tn("palette.flows", n), run: () => onHost(h) }));
    const matched: Item[] = flows.filter((f) => has(f.url)).slice(-20).reverse()
      .map((f) => ({ kind: "flow", tag: f.method, label: f.url.replace(/^\w+:\/\//, ""), hint: `#${f.id}`, run: () => onFlow(f.id) }));
    return [[t("palette.actions"), actions], [t("palette.hosts"), hosts], [t("palette.flowsGroup"), matched]] as const;
  }, [query, commands, flows, lang]);

  const items = groups.flatMap(([, list]) => list);
  const pick = (item?: Item) => { if (!item) return; onClose(); item.run(); };

  return (
    <div className="modal-back palette-back" {...backdrop(onClose)}>
      <div className="palette" role="dialog" aria-label={t("palette.label")} onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={query} placeholder={t("palette.placeholder")} aria-label={t("app.searchOrRun")}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") pick(items[index]);
          }} />
        <div className="palette-list" role="listbox">
          {groups.map(([title, list]) => list.length > 0 && (
            <div key={title}>
              <div className="palette-group">{title}</div>
              {list.map((it) => {
                const i = items.indexOf(it);
                return (
                  <div key={`${it.kind}-${it.label}-${it.hint}`} role="option" aria-selected={i === index}
                    className={`palette-item ${i === index ? "active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => pick(it)}>
                    <span className={`palette-tag ${it.kind === "flow" ? `method m-${it.tag}` : it.kind}`}>{it.tag}</span>
                    <span className="grow ellipsis">{it.label}</span>
                    <span className="muted">{it.hint}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {items.length === 0 && <div className="palette-group">{t("palette.nothing", { query })}</div>}
        </div>
        <div className="palette-foot"><span>↑↓ {t("palette.navigate")}</span><span>↵ {t("palette.run")}</span><span>esc {t("palette.close")}</span></div>
      </div>
    </div>
  );
}
