import type { Headers } from "./api";

export interface Req { method: string; url: string; headers: Headers; body: string }

const SKIP = new Set(["host", "content-length", "connection", "proxy-connection", "accept-encoding"]);
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const kept = (h: Headers) => h.filter(([k]) => !SKIP.has(k.toLowerCase()));

export function toCurl(r: Req): string {
  const parts = [`curl -X ${r.method} ${sh(r.url)}`];
  for (const [k, v] of kept(r.headers)) parts.push(`-H ${sh(`${k}: ${v}`)}`);
  if (r.body) parts.push(`--data-raw ${sh(r.body)}`);
  return parts.join(" \\\n  ");
}

export function toFetch(r: Req): string {
  const init: Record<string, unknown> = { method: r.method, headers: Object.fromEntries(kept(r.headers)) };
  if (r.body) init.body = r.body;
  return `await fetch(${JSON.stringify(r.url)}, ${JSON.stringify(init, null, 2)});`;
}

export function toPython(r: Req): string {
  const lines = ["import requests", "", `response = requests.request(`, `    ${JSON.stringify(r.method)},`, `    ${JSON.stringify(r.url)},`,
    `    headers=${JSON.stringify(Object.fromEntries(kept(r.headers)))},`];
  if (r.body) lines.push(`    data=${JSON.stringify(r.body)},`);
  lines.push(")", "print(response.status_code, response.text)");
  return lines.join("\n");
}

/** Splits a shell command into words, honouring quotes and line continuations. */
function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = "", quote: string | null = null, has = false;
  const s = cmd.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { quote = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; }
    else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Parses the common subset of curl flags people paste (DevTools "Copy as cURL"). */
export function parseCurl(cmd: string): Req {
  const w = words(cmd.trim());
  if (w[0] !== "curl") throw new Error("Not a curl command");
  const r: Req = { method: "", url: "", headers: [], body: "" };
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i] ?? "";
    if (a === "-X" || a === "--request") r.method = next().toUpperCase();
    else if (a === "-H" || a === "--header") {
      const h = next(), j = h.indexOf(":");
      if (j > 0) r.headers.push([h.slice(0, j).trim(), h.slice(j + 1).trim()]);
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"].includes(a)) r.body += (r.body ? "&" : "") + next();
    else if (a === "--json") { r.body = next(); r.headers.push(["content-type", "application/json"]); }
    else if (a === "-b" || a === "--cookie") r.headers.push(["cookie", next()]);
    else if (a === "-A" || a === "--user-agent") r.headers.push(["user-agent", next()]);
    else if (a === "-u" || a === "--user") r.headers.push(["authorization", `Basic ${btoa(next())}`]);
    else if (a === "--url") r.url = next();
    else if (a.startsWith("-")) {
      // Flags with a value we don't model; skip the value so it isn't taken as the URL.
      if (["-o", "--output", "-x", "--proxy", "--connect-timeout", "-m", "--max-time", "-w", "--write-out", "-e", "--referer"].includes(a)) next();
    } else if (!r.url) r.url = a;
  }
  r.method ||= r.body ? "POST" : "GET";
  return r;
}
