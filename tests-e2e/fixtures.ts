// One fresh app per test: the ui_bridge process (real commands, proxy and events on Tauri's mock
// runtime, fake OS tools, its own data folder), an upstream server, and the UI pointed at both.
import { test as base, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request, startUpstream, type Reply, type Upstream } from "./upstream";

const BRIDGE = join(import.meta.dirname, "../target/debug/examples", process.platform === "win32" ? "ui_bridge.exe" : "ui_bridge");

async function freePort(): Promise<number> {
  for (;;) {
    const port = 30000 + Math.floor(Math.random() * 15000);
    const ok = await new Promise<boolean>((done) => {
      const s = createServer().once("error", () => done(false)).listen(port, "0.0.0.0", () => s.close(() => done(true)));
    });
    if (ok) return port;
  }
}

export interface Sniffo {
  page: Page;
  /** Proxy port the UI started the proxy on. */
  port: number;
  bridge: string;
  dataDir: string;
  caPath: string;
  /** Folder of the fake OS tools (calls.log lives there). */
  fakesDir: string;
  /** Sends a signal to the app process (e.g. SIGTERM, as a logout or `tauri dev` restart would). */
  signal: (sig: NodeJS.Signals) => Promise<number | null>;
  up: Upstream;
  /** Invokes a command directly on the backend (setup / assertions, not UI actions). */
  call: <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** Fake OS tool invocations so far. */
  osCalls: () => Promise<string>;
  /** Steers the fake OS tools, e.g. "trusted/1", "deny/1", "proxy/10.0.0.1:8080". */
  fake: (what: string) => Promise<void>;
  /** Queues answers for the next native file dialogs (a path, a list of paths, or null). */
  dialog: (...answers: unknown[]) => Promise<void>;
  /** invoke() calls the UI made, optionally only one command. */
  uiCalls: (cmd?: string) => Promise<{ cmd: string; args: Record<string, unknown> }[]>;
  /** Plain HTTP request to the upstream through the proxy. */
  get: (path: string, opts?: { method?: string; headers?: Record<string, string>; body?: string | Buffer }) => Promise<Reply>;
  /** Upstream URL for a path. */
  url: (path: string) => string;
}

export const test = base.extend<{ sniffo: Sniffo }>({
  sniffo: async ({ page, context }, use) => {
    const port = await freePort();
    const child = spawn(BRIDGE, ["0"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d) => { stderr += d; });
    const bridgePort = await new Promise<number>((ok, fail) => {
      child.stdout!.on("data", (d: Buffer) => { const m = /READY (\d+)/.exec(d.toString()); if (m) ok(Number(m[1])); });
      child.once("exit", (code) => fail(new Error(`bridge exited ${code}: ${stderr}`)));
    });
    const bridge = `http://127.0.0.1:${bridgePort}`;
    const up = await startUpstream();
    const info = await (await fetch(`${bridge}/info`)).json();
    // Chromium needs these for navigator.clipboard; WebKit has no such permissions to grant.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const call = async (cmd: string, args: Record<string, unknown> = {}) => {
      const r = await (await fetch(`${bridge}/invoke/${cmd}`, { method: "POST", body: JSON.stringify(args) })).json();
      if ("err" in r) throw new Error(r.err);
      return r.ok;
    };
    // Uncaught errors in the UI fail the test.
    const errors: string[] = [];
    let collecting = true;
    page.on("pageerror", (e) => { if (collecting) errors.push(e.stack ?? String(e)); });
    // Records what the app copies, through the real clipboard API: WebKit can't read the
    // clipboard back under automation, but a write it refuses still fails (no toast).
    await page.addInitScript(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => write(text).then(() => { (window as any).__copied = text; });
    });
    await page.goto(`/?bridge=${encodeURIComponent(bridge)}&port=${port}`);
    // Launch = start the proxy and (default) take over the system proxy.
    await expect(page.locator(".statusbar")).toContainText(`Proxy 127.0.0.1:${port}`);
    await use({
      page, port, bridge, up, call,
      dataDir: info.data_dir,
      caPath: info.ca_path,
      fakesDir: info.fakes_dir,
      signal: (sig) => new Promise((ok) => { child.once("exit", (code) => ok(code)); child.kill(sig); }),
      osCalls: async () => (await fetch(`${bridge}/calls`)).text(),
      fake: async (what) => { await fetch(`${bridge}/fake/${what}`, { method: "POST" }); },
      dialog: async (...answers) => page.evaluate((a) => (window as any).__sniffoTest.dialogs.push(...a), answers),
      uiCalls: async (cmd) => (await page.evaluate(() => (window as any).__sniffoTest.calls)).filter((c: { cmd: string }) => !cmd || c.cmd === cmd),
      get: (path, opts = {}) => request(port, opts.method ?? "GET", `${up.http}${path}`, opts),
      url: (path) => `${up.http}${path}`,
    });
    collecting = false; // requests cut off by closing the page aren't app errors
    await page.close();
    child.kill();
    await up.close();
    expect(errors, "uncaught errors in the UI").toEqual([]);
  },
});

export { expect };

/** The flow list row whose path cell contains `text`. */
export const row = (page: Page, text: string) => page.locator(".flow-row:not(.head)", { has: page.locator(".c-path", { hasText: text }) });

export const read = (path: string) => readFileSync(path, "utf8");

/** What the app last copied: the clipboard itself where readable (Chromium), else what the
 * real writeText accepted (WebKit). */
export const copied = (page: Page) =>
  page.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch { return (window as any).__copied as string; } });
