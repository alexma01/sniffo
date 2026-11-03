import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon, IconName } from "./icons";

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

const glyph = (name: string): IconName | null =>
  name === "This Mac" ? "laptop" : /^[\d.:a-f]+$/i.test(name) ? "phone" : name.startsWith("Android") ? "android" : null;

export function AppIcon({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (name === "This Mac" || /^[\d.:a-f]+$/i.test(name)) { setUrl(null); return; }
    let live = true;
    iconUrl(name).then((u) => live && setUrl(u));
    return () => { live = false; };
  }, [name]);
  return url ? <img className="app-icon" src={url} alt="" /> : <span className="app-icon fallback" data-glyph={glyph(name) ?? undefined}>{glyph(name) ? <Icon name={glyph(name)!} size={12} /> : name.charAt(0).toUpperCase()}</span>;
}
