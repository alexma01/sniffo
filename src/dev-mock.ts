// Browser-only dev harness: `pnpm dev` + open http://localhost:1420 to iterate on the UI
// without the Tauri shell. Never bundled into the app (imported only when not in Tauri).
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Flow, FlowSummary } from "./api";

const enc = new TextEncoder();
const samples: [string, string, number, string, string][] = [
  ["GET", "https://api.example.com/v1/users?page=2&sort=name", 200, "application/json", JSON.stringify({ users: [{ id: 1, name: "Ada", tags: ["admin"] }, { id: 2, name: "Linus", active: true }], total: 2 })],
  ["POST", "https://api.example.com/v1/login", 401, "application/json", '{"error":"invalid credentials"}'],
  ["GET", "https://cdn.example.com/app.js", 200, "application/javascript", "console.log('hi')"],
  ["GET", "https://www.example.org/feed.xml", 200, "application/xml", "<rss><channel><title>Feed</title><item><title>One</title></item></channel></rss>"],
  ["PUT", "https://api.example.com/v1/items/9", 500, "text/plain", "boom"],
  ["GET", "https://www.example.org/", 304, "text/html", ""],
];

const flows: Flow[] = samples.map(([method, url, status, ct, body], i) => {
  const u = new URL(url);
  return {
    id: i + 1, client_addr: "127.0.0.1:52000", started_ms: Date.now() - (6 - i) * 1000, ttfb_ms: 40 + i * 10, duration_ms: 60 + i * 15,
    method, url, scheme: "https", host: u.host, path: u.pathname + u.search, http_version: "HTTP/1.1",
    request: { headers: [["host", u.host], ["cookie", "sid=abc123; theme=dark"], ["content-type", "application/x-www-form-urlencoded"]], body_size: method === "GET" ? 0 : 13 },
    status, response: { headers: [["content-type", ct], ["set-cookie", "sid=abc123; Path=/; HttpOnly"]], body_size: body.length },
    state: status >= 500 ? "complete" : "complete", error: null,
  };
});
const bodies = new Map(samples.map((s, i) => [i + 1, enc.encode(s[4])]));
const pinned = new Set<number>();

const summary = (f: Flow): FlowSummary => ({
  id: f.id, started_ms: f.started_ms, duration_ms: f.duration_ms, method: f.method, url: f.url, host: f.host, path: f.path,
  status: f.status, state: f.state, content_type: f.response?.headers[0][1] ?? null, request_size: f.request.body_size,
  response_size: f.response?.body_size ?? null, error: f.error, pinned: pinned.has(f.id),
});

mockIPC((cmd, args) => {
  const a = (args ?? {}) as Record<string, any>;
  switch (cmd) {
    case "proxy_status": return { running: true, address: "127.0.0.1:9191", ca_path: "~/sniffo-ca.pem", ca_trusted: false, system_proxy: false };
    case "list_flows": return flows.map(summary);
    case "get_flow": return flows.find((f) => f.id === a.id) ?? null;
    case "get_body": return a.response ? (bodies.get(a.id) ?? new Uint8Array()).buffer : enc.encode("user=ada&remember=1").buffer;
    case "search_flows": return flows.filter((f) => new TextDecoder().decode(bodies.get(f.id)).toLowerCase().includes(String(a.query).toLowerCase())).map((f) => f.id);
    case "pin_flow": a.pinned ? pinned.add(a.id) : pinned.delete(a.id); emit("flows", [{ type: "upsert", data: summary(flows.find((f) => f.id === a.id)!) }]); return;
    case "get_ssl_proxying": return { enabled: true, include: ["*"], exclude: [] };
    default: return null;
  }
}, { shouldMockEvents: true });
