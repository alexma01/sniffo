// Run with: node tests-ui/backend-codes.test.ts
// Every code the Rust side sends (sniffo_core::Error / Message) has an English and Italian text.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { en, it } from "../src/locales/parts/backend.ts";

const dirs = ["crates/sniffo-core/src", "src-tauri/src"];
const rust = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".rs")).map((f) => readFileSync(`${d}/${f}`, "utf8"))).join("\n");
const codes = new Set([...rust.matchAll(/(?:Error|Message)::new\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((c) => c[1])));
assert.ok(codes.size > 30, `found ${codes.size} codes`);
for (const c of codes) {
  assert.ok(`backend.${c}` in en, `missing en text for ${c}`);
  assert.ok(`backend.${c}` in it, `missing it text for ${c}`);
}
console.log("backend codes ok");
