import { useEffect, useReducer } from "react";
import type { FlowSummary } from "./api";
import { t } from "./i18n";

// Traffic from this computer (loopback or its own LAN addresses) is "This Mac"; anything else is a
// device on the network, shown by the name the user gave it (iPhones don't publish one we can read).

let localIps = new Set(["127.0.0.1", "::1"]);
const NAMES_KEY = "sniffo.deviceNames";
const EVENT = "sniffo:clients";

function loadNames(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}"); } catch { return {}; }
}
let names = loadNames();

export function setLocalIps(ips: string[]) {
  const next = new Set(["127.0.0.1", "::1", ...ips]);
  if ([...next].join() === [...localIps].join()) return;
  localIps = next;
  window.dispatchEvent(new Event(EVENT));
}

export const isLocal = (ip: string) => localIps.has(ip);
export const deviceName = (ip: string): string | undefined => names[ip];

export function renameDevice(ip: string, name: string) {
  if (name.trim()) names = { ...names, [ip]: name.trim() };
  else { const { [ip]: _, ...rest } = names; names = rest; }
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVENT));
}

/** What to show for a flow's client: the app, "This Mac", or the device's name/IP. */
export const clientDisplay = (f: FlowSummary) =>
  f.client_app ?? (isLocal(f.client_ip) ? t("client.thisMac") : deviceName(f.client_ip) ?? f.client_ip);

/** Name AppIcon looks up (untranslated "This Mac" is its laptop glyph): real app names get their icon, the rest a fallback glyph. */
export const clientIconName = (f: FlowSummary) => f.client_app ?? (isLocal(f.client_ip) ? "This Mac" : f.client_ip);

/** Re-render when device names or local addresses change. */
export function useClientsVersion() {
  const [v, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    window.addEventListener(EVENT, bump);
    return () => window.removeEventListener(EVENT, bump);
  }, []);
  return v;
}
