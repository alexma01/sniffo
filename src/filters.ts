import { FlowSummary } from "./api";

export const TYPES = ["JSON", "XML", "HTML", "JS", "CSS", "Image", "Media", "Font", "Form", "Other"] as const;
export type ContentKind = (typeof TYPES)[number];
export const STATUSES = ["1xx", "2xx", "3xx", "4xx", "5xx", "Error"] as const;
export type StatusKind = (typeof STATUSES)[number];

export function contentKind(ct: string | null): ContentKind {
  const t = (ct ?? "").toLowerCase();
  if (t.includes("json")) return "JSON";
  if (t.includes("xml")) return "XML";
  if (t.includes("html")) return "HTML";
  if (t.includes("javascript") || t.includes("ecmascript")) return "JS";
  if (t.includes("css")) return "CSS";
  if (t.startsWith("image/")) return "Image";
  if (t.startsWith("video/") || t.startsWith("audio/")) return "Media";
  if (t.startsWith("font/") || t.includes("woff")) return "Font";
  if (t.includes("form")) return "Form";
  return "Other";
}

export function statusKind(f: FlowSummary): StatusKind | null {
  if (f.state === "failed") return "Error";
  if (f.status == null) return null;
  return `${Math.floor(f.status / 100)}xx` as StatusKind;
}

export interface Filter {
  text: string;
  regex: boolean;
  /** When set, `text` is matched against bodies/headers server-side and these are the hits. */
  bodyHits: Set<number> | null;
  types: Set<ContentKind>;
  statuses: Set<StatusKind>;
  pinnedOnly: boolean;
  host: string | null;
  /** Client app name, or device IP for remote clients. */
  client: string | null;
}

export const emptyFilter: Filter = { text: "", regex: false, bodyHits: null, types: new Set(), statuses: new Set(), pinnedOnly: false, host: null, client: null };

/** Returns a predicate, or an error message when the regex is invalid. */
export function compile(f: Filter): ((x: FlowSummary) => boolean) | string {
  let textMatch: (x: FlowSummary) => boolean = () => true;
  if (f.bodyHits) {
    const hits = f.bodyHits;
    textMatch = (x) => hits.has(x.id);
  } else if (f.text && f.regex) {
    let re: RegExp;
    try { re = new RegExp(f.text, "i"); } catch (e) { return String(e); }
    textMatch = (x) => re.test(x.url) || re.test(x.method) || re.test(String(x.status ?? ""));
  } else if (f.text) {
    const s = f.text.toLowerCase();
    textMatch = (x) => x.url.toLowerCase().includes(s) || x.method.toLowerCase() === s || String(x.status ?? "").startsWith(s);
  }
  return (x) =>
    (!f.host || x.host === f.host) &&
    (!f.client || clientLabel(x) === f.client) &&
    (!f.pinnedOnly || x.pinned) &&
    (!f.types.size || f.types.has(contentKind(x.content_type))) &&
    (!f.statuses.size || f.statuses.has(statusKind(x)!)) &&
    textMatch(x);
}

export function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

export const clientLabel = (f: FlowSummary) => f.client_app ?? f.client_ip;
