import { useEffect, useState } from "react";
import { api } from "./api";

// One lookup per app name for the whole session; null = no icon (CLI tools, devices, non-macOS).
const cache = new Map<string, Promise<string | null>>();

function iconUrl(name: string) {
  let p = cache.get(name);
  if (!p) {
    p = api.appIcon(name).then(
      (buf) => (buf.byteLength ? URL.createObjectURL(new Blob([buf], { type: "image/png" })) : null),
      () => null,
    );
    cache.set(name, p);
    // Not resolved yet (connection still being matched): allow a retry later.
    p.then((u) => { if (!u) setTimeout(() => cache.delete(name), 15_000); });
  }
  return p;
}

const fallback = (name: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(name) ? "📱" : name.startsWith("Android") ? "🤖" : "▣");

export function AppIcon({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let live = true; iconUrl(name).then((u) => live && setUrl(u)); return () => { live = false; }; }, [name]);
  return url ? <img className="app-icon" src={url} alt="" /> : <span className="app-icon fallback">{fallback(name)}</span>;
}
