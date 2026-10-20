import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type FlowState = "pending" | "complete" | "failed";
export type Headers = [string, string][];

export interface FlowSummary {
  id: number;
  started_ms: number;
  duration_ms: number | null;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  state: FlowState;
  content_type: string | null;
  request_size: number;
  response_size: number | null;
  error: string | null;
}

export interface Message {
  headers: Headers;
  body_size: number;
}

export interface Flow {
  id: number;
  client_addr: string;
  started_ms: number;
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
  ca_path: string;
}

export type FlowEvent = { type: "upsert"; flow: FlowSummary } | { type: "cleared" };

export const api = {
  status: () => invoke<ProxyStatus>("proxy_status"),
  start: (port?: number) => invoke<string>("start_proxy", { port }),
  stop: () => invoke<void>("stop_proxy"),
  listFlows: () => invoke<FlowSummary[]>("list_flows"),
  getFlow: (id: number) => invoke<Flow | null>("get_flow", { id }),
  getBody: (id: number, response: boolean) => invoke<ArrayBuffer>("get_body", { id, response }),
  clear: () => invoke<void>("clear_flows"),
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
