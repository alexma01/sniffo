import { useEffect, useState } from "react";
import { api, UpdateInfo } from "./api";

const ENABLED = "sniffo.updateCheck";
const SKIPPED = "sniffo.skipVersion";
const CHANGED = "sniffo:update-pref";
const DAY = 24 * 60 * 60 * 1000;

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable: applies to this session only */ }
  window.dispatchEvent(new Event(CHANGED));
};

export const updateCheckEnabled = () => read(ENABLED) !== "0";
export const setUpdateCheck = (on: boolean) => write(ENABLED, on ? "1" : "0");
export const skipVersion = (v: string) => write(SKIPPED, v);

/** A newer release to tell the user about: checked at launch and daily, silent on failure, off by preference. */
export function useUpdate(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    const check = () => {
      if (!updateCheckEnabled()) return setUpdate(null);
      api.checkUpdate().then((u) => setUpdate(u && u.version !== read(SKIPPED) ? u : null), () => {});
    };
    check();
    const timer = setInterval(check, DAY);
    window.addEventListener(CHANGED, check);
    return () => { clearInterval(timer); window.removeEventListener(CHANGED, check); };
  }, []);
  return update;
}
