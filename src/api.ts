import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type FlowState = "pending" | "paused" | "complete" | "failed";
export type Headers = [string, string][];

export interface FlowSummary {
  id: number;
  started_ms: number;
  ttfb_ms: number | null;
  duration_ms: number | null;
  method: string;
  url: string;
  scheme: string;
  http_version: string;
  host: string;
  path: string;
  client_ip: string;
  client_app: string | null;
  request_type: string | null;
  status: number | null;
  state: FlowState;
  content_type: string | null;
  request_size: number;
  response_size: number | null;
  error: string | null;
  pinned: boolean;
  tags: string[];
}

export interface Message {
  headers: Headers;
  body_size: number;
}

export interface Flow {
  id: number;
  client_addr: string;
  started_ms: number;
  ttfb_ms: number | null;
  duration_ms: number | null;
  method: string;
  url: string;
  scheme: string;
  host: string;
  path: string;
  http_version: string;
  request: Message;
  status: number | null;
  response: Message | null;
  state: FlowState;
  error: string | null;
}

export interface SslProxying {
  enabled: boolean;
  include: string[];
  exclude: string[];
}

export interface ProxyStatus {
  running: boolean;
  address: string | null;
  port: number | null;
  allow_lan: boolean;
  lan: { interface: string; ip: string }[];
  ca_path: string;
  ca_trusted: boolean;
  system_proxy: boolean;
}

export type FlowEvent =
  | { type: "upsert"; data: FlowSummary }
  | { type: "removed"; data: number[] }
  | { type: "cleared" }
  | { type: "breakpoint"; data: BreakpointHit };

export interface Matcher { url: string; regex: boolean; methods: string[] }

export type Action =
  | { type: "map_local"; status: number; headers: Headers; body: string; file: string | null }
  | { type: "map_remote"; scheme: string | null; host: string | null; port: number | null; path: string | null }
  | { type: "block" }
  | { type: "breakpoint"; request: boolean; response: boolean }
  | { type: "throttle"; latency_ms: number; download_kbps: number; upload_kbps: number };

export interface Rule { id: string; name: string; enabled: boolean; matcher: Matcher; action: Action }
export interface Rules { rules: Rule[]; allow_list: { enabled: boolean; patterns: string[] } }

export interface Editable { method: string; url: string; status: number; headers: Headers; body: string | null }
export interface BreakpointHit { id: number; response: boolean; message: Editable }
export type Decision = { type: "continue"; message: Editable } | { type: "abort" };

export const api = {
  status: () => invoke<ProxyStatus>("proxy_status"),
  start: (port?: number) => invoke<string>("start_proxy", { port }),
  stop: () => invoke<void>("stop_proxy"),
  setAllowLan: (allow: boolean) => invoke<void>("set_allow_lan", { allow }),
  setSystemProxy: (enabled: boolean) => invoke<void>("set_system_proxy", { enabled }),
  trustCa: () => invoke<void>("trust_ca"),
  revealCa: () => invoke<void>("reveal_ca"),
  listFlows: () => invoke<FlowSummary[]>("list_flows"),
  getFlow: (id: number) => invoke<Flow | null>("get_flow", { id }),
  getBody: (id: number, response: boolean) => invoke<ArrayBuffer>("get_body", { id, response }),
  clear: () => invoke<void>("clear_flows"),
  remove: (ids: number[]) => invoke<void>("remove_flows", { ids }),
  pin: (id: number, pinned: boolean) => invoke<void>("pin_flow", { id, pinned }),
  search: (query: string) => invoke<number[]>("search_flows", { query }),
  getRules: () => invoke<Rules>("get_rules"),
  setRules: (rules: Rules) => invoke<void>("set_rules", { rules }),
  listBreakpoints: () => invoke<BreakpointHit[]>("list_breakpoints"),
  resume: (id: number, decision: Decision) => invoke<boolean>("resume_breakpoint", { id, decision }),
  getSsl: () => invoke<SslProxying>("get_ssl_proxying"),
  setSsl: (ssl: SslProxying) => invoke<void>("set_ssl_proxying", { ssl }),
  onFlows: (cb: (events: FlowEvent[]) => void) => listen<FlowEvent[]>("flows", (e) => cb(e.payload)),
  onResync: (cb: () => void) => listen("flows:resync", () => cb()),
};

export function header(headers: Headers, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === n)?.[1];
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
