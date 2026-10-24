// UI strings: t("key", { var }) reads the current language; components call useLang() so they re-render on change.
import { createElement, ReactNode, useSyncExternalStore } from "react";
import { en } from "./locales/en";
import { it } from "./locales/it";

export const LANGS = { en: "English", it: "Italiano" } as const;
export type Lang = keyof typeof LANGS;
export type Key = keyof typeof en;
const DICTS: Record<Lang, Record<Key, string>> = { en, it };
const STORE = "sniffo:lang";

const pick = (l: string | null | undefined) => (Object.keys(LANGS) as Lang[]).find((k) => l?.toLowerCase().startsWith(k));
const stored = () => { try { return localStorage.getItem(STORE); } catch { return null; } };

let lang: Lang = pick(new URLSearchParams(location.search).get("lang")) ?? pick(stored()) ?? pick(navigator.language) ?? "en";
document.documentElement.lang = lang;
const listeners = new Set<() => void>();

export const getLang = () => lang;
export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l;
  try { localStorage.setItem(STORE, l); } catch { /* private mode: this session only */ }
  listeners.forEach((f) => f());
}
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const useLang = () => useSyncExternalStore(subscribe, getLang);

export function t(key: Key, vars?: Record<string, string | number>) {
  const s = DICTS[lang][key] ?? en[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Plural: needs "<key>.one" and "<key>.other", both may use {n}. */
export const tn = (key: string, n: number) =>
  t(`${key}.${new Intl.PluralRules(lang).select(n) === "one" ? "one" : "other"}` as Key, { n });

/** Translations with inline <b>, <i>, <code> (no attributes, no nesting) rendered as elements. */
export const rich = (s: string): ReactNode[] =>
  s.split(/<(b|i|code)>(.*?)<\/\1>/).map((p, i, a) => (i % 3 === 1 ? createElement(p, { key: i }, a[i + 1]) : i % 3 === 2 ? null : p));
