// Browser-only dev harness: `pnpm dev` + open http://localhost:1420 to iterate on the UI
// without the Tauri shell. Never bundled into the app (imported only when not in Tauri).
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Flow, FlowSummary } from "./api";

const enc = new TextEncoder();
const samples: [string, string, number, string, string][] = [
  ["GET", "https://api.example.com/v1/users?page=2&sort=name", 200, "application/json", JSON.stringify({ users: [{ id: 1, name: "Ada", tags: ["admin"] }, { id: 2, name: "Linus", active: true }], total: 2 })],
  ["POST", "https://api.example.com/v1/login", 401, "application/json", '{"error":"invalid credentials"}'],
  ["GET", "wss://stream.example.com/live", 101, "", ""],
  ["POST", "https://api.example.com/graphql", 200, "application/json", '{"data":{"user":{"name":"Ada"}}}'],
  ["GET", "https://www.example.org/feed.xml", 200, "application/xml", "<rss><channel><title>Feed</title><item><title>One</title></item></channel></rss>"],
  ["PUT", "https://api.example.com/v1/items/9", 500, "text/plain", "boom"],
  ["CONNECT", "https://www.googleapis.com:443/", 200, "", ""],
  ["POST", "https://api.example.com/demo.UserService/Get", 200, "application/grpc", String.fromCharCode(0, 0, 0, 0, 7, 8, 7, 18, 3, 97, 100, 97)],
  ["GET", "https://www.example.org/", 304, "text/html", ""],
  // Tunnels: SSL Proxying not enabled for these hosts (no status, no response).
  ["CONNECT", "https://fonts.googleapis.com:443", 0, "", ""],
  ["CONNECT", "https://www.google.com:443", 0, "", ""],
];

const flows: Flow[] = samples.map(([method, url, status, ct, body], i) => {
  const u = new URL(url);
  if (method === "CONNECT") return {
    id: i + 1, client_addr: "127.0.0.1:52000", started_ms: Date.now() - (6 - i) * 1000, ttfb_ms: null, duration_ms: null,
    method, url, scheme: "https", host: u.hostname, path: "", http_version: "HTTP/1.1",
    request: { headers: [["host", u.host], ["user-agent", "Google Drive/112.0"]], body_size: 0 },
    status: null, response: null, state: "complete", error: null, ws_messages: [], ws_dropped: 0, graphql: null,
  };
  return {
    id: i + 1, client_addr: "127.0.0.1:52000", started_ms: Date.now() - (6 - i) * 1000, ttfb_ms: 40 + i * 10, duration_ms: 60 + i * 15,
    method, url, scheme: "https", host: u.host, path: u.pathname + u.search, http_version: "HTTP/1.1",
    request: { headers: [["host", u.host], ["cookie", "sid=abc123; theme=dark"], ["content-type", "application/x-www-form-urlencoded"]], body_size: method === "GET" ? 0 : 13 },
    status, response: { headers: [["content-type", ct], ["set-cookie", "sid=abc123; Path=/; HttpOnly"]], body_size: body.length },
    state: "complete", error: null,
    ws_messages: i === 2 ? [
      { outgoing: true, time_ms: 1000, kind: "text", size: 17, data: '{"op":"subscribe"}', injected: false },
      { outgoing: false, time_ms: 1042, kind: "text", size: 25, data: '{"event":"tick","v":42}', injected: false },
      { outgoing: false, time_ms: 2100, kind: "binary", size: 3, data: "AQID", injected: false },
      { outgoing: true, time_ms: 2500, kind: "text", size: 12, data: '{"op":"ping"}', injected: true },
    ] : [],
    ws_dropped: 0,
    graphql: url.endsWith("/graphql") ? "query GetUser" : null,
  };
});
const bodies = new Map(samples.map((s, i) => [i + 1, enc.encode(s[4])]));
const pinned = new Set<number>();
const marks = new Map<number, { color: string | null; comment: string | null }>([[4, { color: "yellow", comment: "Slow on 3G" }]]);
let ssl = { enabled: true, include: ["api.example.com", "www.example.org", "stream.example.com"], exclude: [] as string[] };
let rules: unknown = { rules: [], allow_list: { enabled: false, patterns: [] }, no_caching: false };

const summary = (f: Flow): FlowSummary => ({
  id: f.id, started_ms: f.started_ms, ttfb_ms: f.ttfb_ms, duration_ms: f.duration_ms, method: f.method, url: f.url, host: f.host, path: f.path,
  scheme: f.scheme, http_version: f.id % 2 ? "HTTP/2.0" : "HTTP/1.1", client_ip: f.id === 6 ? "192.168.1.40" : "127.0.0.1",
  client_app: f.method === "CONNECT" ? "Google Drive" : f.id === 6 ? null : f.id % 3 ? "Google Chrome" : "curl", request_type: null,
  status: f.status, state: f.state, content_type: f.response?.headers[0][1] ?? null, request_size: f.request.body_size,
  response_size: f.response?.body_size ?? null, error: f.error, pinned: pinned.has(f.id), color: marks.get(f.id)?.color ?? null, comment: marks.get(f.id)?.comment ?? null, tags: f.id === 2 ? ["Map Local /login"] : [], ws_count: f.ws_messages.length, graphql: f.graphql,
});

mockIPC((cmd, args) => {
  const a = (args ?? {}) as Record<string, any>;
  switch (cmd) {
    case "proxy_status": return { running: true, address: "127.0.0.1:9191", port: 9191, allow_lan: true, auto_system_proxy: true, vpn: { state: "helper_missing" }, lan: [{ interface: "en0", ip: "192.168.1.12" }, { interface: "utun4", ip: "10.8.0.2" }], lan_name: "sniffo.local", ca_path: "~/sniffo-ca.pem", ca_trusted: false, system_proxy: false };
    case "list_flows": return flows.map(summary);
    case "get_flow": return flows.find((f) => f.id === a.id) ?? null;
    case "get_ws_messages": { const f = flows.find((x) => x.id === a.id); return f ? [a.from, f.ws_messages.slice(a.from)] : null; }
    case "get_body": return a.response ? (bodies.get(a.id) ?? new Uint8Array()).buffer
      : flows.find((f) => f.id === a.id)?.graphql ? enc.encode('{"query":"query GetUser($id: ID!) {\\n  user(id: $id) { name }\\n}","variables":{"id":7}}').buffer
      : enc.encode("user=ada&remember=1").buffer;
    case "search_flows": return flows.filter((f) => new TextDecoder().decode(bodies.get(f.id)).toLowerCase().includes(String(a.query).toLowerCase())).map((f) => f.id);
    case "pin_flow": a.pinned ? pinned.add(a.id) : pinned.delete(a.id); emit("flows", [{ type: "upsert", data: summary(flows.find((f) => f.id === a.id)!) }]); return;
    case "mark_flow": marks.set(a.id, { color: a.color || null, comment: a.comment?.trim() || null }); emit("flows", [{ type: "upsert", data: summary(flows.find((f) => f.id === a.id)!) }]); return;
    case "get_rules": return rules;
    case "set_rules": rules = a.rules; return;
    // Open http://localhost:1420/#ws-breakpoint to preview the WebSocket frame editor.
    case "list_breakpoints": return location.hash === "#ws-breakpoint"
      ? [{ id: 3, response: true, ws: "text", message: { method: "", url: "https://stream.example.com/live", status: 0, headers: [], body: '{"event":"tick","v":43}' } }] : [];
    case "list_devices": return [
      { id: "SIM1", name: "iPhone 18 Pro", platform: "ios_simulator", state: "Booted", os: "iOS 27.0", emulator: true },
      { id: "emulator-5554", name: "sdk gphone64 arm64", platform: "android", state: "device", os: "Android 15", emulator: true },
      { id: "PHONE", name: "iPhone 14", platform: "ios_device", state: "connected", os: "iOS 26.6.1", emulator: false },
      { id: "Medium_Phone", name: "Medium Phone", platform: "android_avd", state: "Shutdown", os: "Android emulator", emulator: true },
    ];
    case "device_command": return "done (mock)";
    case "list_browsers": return [{ id: "chrome", name: "Google Chrome" }, { id: "firefox", name: "Firefox" }];
    case "launch_browser": return;
    case "terminal_env": return [["HTTPS_PROXY", "http://127.0.0.1:9191"], ["NODE_EXTRA_CA_CERTS", "~/sniffo-ca.pem"], ["SSL_CERT_FILE", "~/sniffo-ca-bundle.pem"]];
    case "repeat_flow": case "compose_request": return 200;
    case "get_network": return { upstream: null, dns: [["api.myapp.test", "127.0.0.1"]], ignore_upstream_tls_errors: false };
    case "get_reverse": return [{ enabled: true, port: 9300, target: "https://api.example.com" }];
    case "set_reverse": return a.reverse.map(() => null);
    case "get_proto_schemas": return { files: ["/Users/me/protos/user.proto"], messages: ["demo.User", "demo.UserList"] };
    case "decode_proto": return [{ id: 7, name: "Ada", status: "ACTIVE" }];
    case "send_ws_message": {
      const f = flows.find((f) => f.id === a.id)!;
      if (a.binary && !/^[A-Za-z0-9+/=\s]*$/.test(a.data)) throw "invalid base64";
      f.ws_messages.push({ outgoing: a.toServer, time_ms: Date.now() - f.started_ms, kind: a.binary ? "binary" : "text", size: a.data.length, data: a.data, injected: true });
      emit("flows", [{ type: "upsert", data: summary(f) }]);
      return;
    }
    case "get_ssl_proxying": return ssl;
    case "set_ssl_proxying": ssl = a.ssl; return;
    default: return null;
  }
}, { shouldMockEvents: true });

// ?stream: a new flow every second, to try auto-scroll and live updates.
if (new URLSearchParams(location.search).has("stream")) {
  setInterval(() => {
    const base = flows[1 + (flows.length % 4)];
    const f = { ...base, id: flows.length + 1, started_ms: Date.now(), path: `${base.path}?n=${flows.length + 1}` };
    flows.push(f);
    emit("flows", [{ type: "upsert", data: summary(f) }]);
  }, 1000);
}
