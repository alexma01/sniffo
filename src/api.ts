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
  ws_count: number;
  graphql: string | null;
}

export interface WsMessage { outgoing: boolean; time_ms: number; kind: string; size: number; data: string }

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
  ws_messages: WsMessage[];
  graphql: string | null;
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
  auto_system_proxy: boolean;
  lan: { interface: string; ip: string }[];
  ca_path: string;
  ca_trusted: boolean;
  system_proxy: boolean;
}

export type FlowEvent =
  | { type: "upsert"; data: FlowSummary }
  | { type: "removed"; data: number[] }
  | { type: "cleared" }
  | { type: "breakpoint"; data: BreakpointHit }
  | { type: "log"; data: ScriptLog };

export interface ScriptLog { id: number; rule: string; message: string; error: boolean; time_ms: number }

export interface Matcher { url: string; regex: boolean; methods: string[] }

export type Action =
  | { type: "map_local"; status: number; headers: Headers; body: string; file: string | null }
  | { type: "map_local_dir"; dir: string }
  | { type: "map_remote"; scheme: string | null; host: string | null; port: number | null; path: string | null }
  | { type: "block" }
  | { type: "breakpoint"; request: boolean; response: boolean }
  | { type: "throttle"; latency_ms: number; download_kbps: number; upload_kbps: number }
  | { type: "script"; code: string };

export interface Rule { id: string; name: string; enabled: boolean; matcher: Matcher; action: Action }
export interface Rules { rules: Rule[]; allow_list: { enabled: boolean; patterns: string[] }; no_caching: boolean }

export interface Editable { method: string; url: string; status: number; headers: Headers; body: string | null }
export interface BreakpointHit { id: number; response: boolean; message: Editable }
export type Decision = { type: "continue"; message: Editable } | { type: "abort" };

export type Platform = "ios_simulator" | "ios_device" | "android" | "android_avd";
export interface Device { id: string; name: string; platform: Platform; state: string; os: string; emulator: boolean }
export type DeviceCommand =
  | { type: "install_ca" } | { type: "install_system_ca" } | { type: "set_proxy" } | { type: "clear_proxy" }
  | { type: "restart" } | { type: "boot" } | { type: "shutdown" } | { type: "open_url"; value: string };

export interface Upstream { kind: "http" | "socks5"; host: string; port: number; username: string; password: string }
export interface NetworkOptions { upstream: Upstream | null; dns: [string, string][]; ignore_upstream_tls_errors: boolean }
export interface ReverseProxy { enabled: boolean; port: number; target: string }

export interface ProtoSchemas { files: string[]; messages: string[] }

export const api = {
  getProtoSchemas: () => invoke<ProtoSchemas>("get_proto_schemas"),
  setProtoFiles: (files: string[]) => invoke<ProtoSchemas>("set_proto_files", { files }),
  decodeProto: (id: number, response: boolean, messageType: string) => invoke<unknown[]>("decode_proto", { id, response, messageType }),
  getNetwork: () => invoke<NetworkOptions>("get_network"),
  setNetwork: (network: NetworkOptions) => invoke<void>("set_network", { network }),
  getReverse: () => invoke<ReverseProxy[]>("get_reverse"),
  setReverse: (reverse: ReverseProxy[]) => invoke<(string | null)[]>("set_reverse", { reverse }),
  listDevices: () => invoke<Device[]>("list_devices"),
  deviceCommand: (device: string, command: DeviceCommand) => invoke<string>("device_command", { device, command }),
  status: () => invoke<ProxyStatus>("proxy_status"),
  start: (port?: number) => invoke<string>("start_proxy", { port }),
  stop: () => invoke<void>("stop_proxy"),
  setAllowLan: (allow: boolean) => invoke<void>("set_allow_lan", { allow }),
  setAutoSystemProxy: (enabled: boolean) => invoke<void>("set_auto_system_proxy", { enabled }),
  setSystemProxy: (enabled: boolean) => invoke<void>("set_system_proxy", { enabled }),
  trustCa: () => invoke<void>("trust_ca"),
  revealCa: () => invoke<void>("reveal_ca"),
  repeat: (id: number) => invoke<number>("repeat_flow", { id }),
  compose: (method: string, url: string, headers: Headers, body: string) => invoke<number>("compose_request", { method, url, headers, body }),
  exportHar: (path: string, ids: number[] = []) => invoke<number>("export_har", { path, ids }),
  importHar: (path: string, replace: boolean) => invoke<number>("import_har", { path, replace }),
  listFlows: () => invoke<FlowSummary[]>("list_flows"),
  getFlow: (id: number) => invoke<Flow | null>("get_flow", { id }),
  getBody: (id: number, response: boolean) => invoke<ArrayBuffer>("get_body", { id, response }),
  clear: () => invoke<void>("clear_flows"),
  remove: (ids: number[]) => invoke<void>("remove_flows", { ids }),
  pin: (id: number, pinned: boolean) => invoke<void>("pin_flow", { id, pinned }),
  search: (query: string) => invoke<number[]>("search_flows", { query }),
  getRules: () => invoke<Rules>("get_rules"),
  setRules: (rules: Rules) => invoke<void>("set_rules", { rules }),
  exportRules: (path: string) => invoke<number>("export_rules", { path }),
  importRules: (path: string) => invoke<number>("import_rules", { path }),
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
