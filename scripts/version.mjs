// Shared by `pnpm release` and the Release workflow: the files that carry the version.
import { readFileSync, writeFileSync } from "node:fs";

const FILES = [
  ["package.json", /("version": ")[^"]+/],
  ["src-tauri/tauri.conf.json", /("version": ")[^"]+/],
  ["src-tauri/Cargo.toml", /^(version = ")[^"]+/m],
  ["crates/sniffo-core/Cargo.toml", /^(version = ")[^"]+/m],
  ["src-tauri/Cargo.toml", /(sniffo-core = \{ version = ")[^"]+/], // path dependency pins the core version
];

export const versions = () => FILES.map(([f, re]) => [f, readFileSync(f, "utf8").match(re)?.[0].split(/"$|[" ]/).pop()]);

export function setVersion(v) {
  for (const [f, re] of FILES) writeFileSync(f, readFileSync(f, "utf8").replace(re, `$1${v}`));
}

if (process.argv[1]?.endsWith("version.mjs")) {
  const all = versions();
  const distinct = new Set(all.map(([, v]) => v));
  if (distinct.size !== 1) { console.error("version mismatch:", all); process.exit(1); }
  console.log([...distinct][0]);
}
