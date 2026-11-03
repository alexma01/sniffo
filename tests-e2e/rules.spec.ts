// Rules editor, and each rule type's effect on real traffic.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, read, row, test } from "./fixtures";

const modal = (page: Page) => page.locator(".modal");

/** Opens Rules, adds a rule through the editor, saves it. `fill` sets the action's fields. */
async function addRule(page: Page, opts: { name?: string; url: string; methods?: string; regex?: boolean; action: string; fill?: (m: ReturnType<typeof modal>) => Promise<void> }) {
  if (!(await modal(page).isVisible())) await page.getByRole("button", { name: "Rules" }).click();
  const m = modal(page);
  await m.getByRole("button", { name: "Add rule" }).click();
  if (opts.name) await m.getByLabel("Name").fill(opts.name);
  await m.getByLabel("URL").fill(opts.url);
  if (opts.regex) await m.getByLabel("Regex").check();
  if (opts.methods) await m.getByLabel("Methods (comma separated, empty = any)").fill(opts.methods);
  await m.getByLabel("Action").selectOption({ label: opts.action });
  await opts.fill?.(m);
  await m.getByRole("button", { name: "Save rule" }).click();
}

const closeRules = (page: Page) => modal(page).getByRole("button", { name: "Close" }).click();

test("editor: add, toggle, reorder, edit, delete, validation", async ({ sniffo }) => {
  const { page } = sniffo;
  await page.getByRole("button", { name: "Rules" }).click();
  const m = modal(page);
  await expect(m).toContainText("No rules yet.");
  await addRule(page, { name: "First", url: "*/a*", action: "Block" });
  await addRule(page, { name: "Second", url: "*/b*", methods: "get, post", action: "Breakpoint" });
  const rows = m.locator("table.rules tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Breakpoint");
  await expect(rows.nth(1)).toContainText("GET,POST */b*");
  let rules = (await sniffo.call("get_rules")).rules;
  expect(rules.map((r: any) => [r.name, r.matcher.methods, r.action.type])).toEqual([["First", [], "block"], ["Second", ["GET", "POST"], "breakpoint"]]);

  await rows.nth(1).getByTitle("Move up").click();
  await expect(rows.nth(0)).toContainText("Second");
  await rows.nth(0).getByTitle("Move up").click(); // already first: no-op
  await rows.nth(1).getByTitle("Move down").click(); // already last: no-op
  expect((await sniffo.call("get_rules")).rules.map((r: any) => r.name)).toEqual(["Second", "First"]);

  // List checkboxes reflect the saved rules: they flip once the backend has them.
  await rows.nth(0).locator("input[type=checkbox]").click();
  await expect(rows.nth(0)).toHaveClass(/disabled/);
  expect((await sniffo.call("get_rules")).rules[0].enabled).toBe(false);

  await rows.nth(1).getByRole("button", { name: "Edit" }).click();
  await m.getByLabel("Name").fill("First renamed");
  // Cancel discards.
  await m.getByRole("button", { name: "Cancel" }).click();
  await expect(rows.nth(1)).toContainText("First");
  await rows.nth(1).getByRole("button", { name: "Edit" }).click();
  await m.getByLabel("Name").fill("First renamed");
  await m.getByRole("button", { name: "Save rule" }).click();
  await expect(rows.nth(1)).toContainText("First renamed");

  // An invalid regex is caught before saving.
  await m.getByRole("button", { name: "Add rule" }).click();
  await m.getByLabel("URL").fill("(unclosed");
  await m.getByLabel("Regex").check();
  await m.getByRole("button", { name: "Save rule" }).click();
  await expect(m.locator("p.err")).toContainText("Invalid regular expression");
  await m.getByRole("button", { name: "Cancel" }).click();

  await rows.nth(0).getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveCount(1);
  rules = (await sniffo.call("get_rules")).rules;
  expect(rules.map((r: any) => r.name)).toEqual(["First renamed"]);
  await closeRules(page);
  await expect(page.locator(".statusbar")).toContainText("Rules 1 active");
});

test("block, map local (body and file), map local directory, map remote", async ({ sniffo }) => {
  const { page } = sniffo;
  const file = join(sniffo.dataDir, "mock.json");
  writeFileSync(file, '{"from":"file"}');
  const dir = join(sniffo.dataDir, "site");
  mkdirSync(join(dir, "js"), { recursive: true });
  writeFileSync(join(dir, "js/app.js"), "console.log('local')");
  writeFileSync(join(dir, "index.html"), "<h1>index</h1>");

  await addRule(page, { url: "*/blocked*", action: "Block" });
  await addRule(page, { name: "Mock body", url: "*/mock-body", action: "Map Local", fill: async (m) => {
    await m.getByLabel("Status").fill("418");
    await m.getByLabel("Headers").fill("content-type: text/plain\nx-mocked: yes");
    await m.locator("textarea").last().fill("i am a teapot");
  } });
  await addRule(page, { url: "*/mock-file", action: "Map Local", fill: async (m) => {
    await m.getByLabel("Body file (optional, overrides body)").fill(file);
    await expect(m.locator("textarea").last()).toBeDisabled();
  } });
  await addRule(page, { url: `${sniffo.url("/static")}/*`, action: "Map Local Directory", fill: async (m) => {
    await sniffo.dialog(dir);
    await m.getByRole("button", { name: "Choose…" }).click();
    await expect(m.locator("input.input.wide.grow")).toHaveValue(dir);
  } });
  await addRule(page, { url: "*/old/*", action: "Map Remote", fill: async (m) => {
    await m.getByLabel("Host").fill("127.0.0.1");
    await m.getByLabel("Port").fill(new URL(sniffo.up.http).port);
    await m.getByLabel("Path").fill("/json");
  } });
  await closeRules(page);

  const blocked = await sniffo.get("/blocked/x");
  expect(blocked.status).toBe(403);
  const body = await sniffo.get("/mock-body");
  expect([body.status, body.headers["x-mocked"], body.body.toString()]).toEqual([418, "yes", "i am a teapot"]);
  expect((await sniffo.get("/mock-file")).body.toString()).toBe('{"from":"file"}');
  expect((await sniffo.get("/static/js/app.js")).body.toString()).toBe("console.log('local')");
  expect((await sniffo.get("/static/")).body.toString()).toBe("<h1>index</h1>");
  expect((await sniffo.get("/static/../../etc/passwd")).status).toBeGreaterThanOrEqual(400);
  // Map Remote: /old/anything on a dead port goes to the upstream's /json.
  const { request } = await import("./upstream");
  const remote = await request(sniffo.port, "GET", "http://127.0.0.1:1/old/thing");
  expect(JSON.parse(remote.body.toString()).total).toBe(1);
  expect(sniffo.up.seen.map((s) => s.path)).toEqual(["/json"]);

  // Matched rules are tagged on the rows.
  await expect(row(page, "/mock-body").locator(".badge")).toHaveText("Mock body");
  await expect(row(page, "/blocked/x").locator(".c-status")).toHaveText("403");
});

test("throttle presets and latency", async ({ sniffo }) => {
  const { page } = sniffo;
  await addRule(page, { url: "*/slowed", action: "Throttle", fill: async (m) => {
    await m.getByRole("button", { name: "Edge" }).click();
    await expect(m.getByLabel("Latency ms")).toHaveValue("500");
    await expect(m.getByLabel("Download KB/s")).toHaveValue("30");
    await expect(m.getByLabel("Upload KB/s")).toHaveValue("10");
    await m.getByRole("button", { name: "3G" }).click();
    await expect(m.getByLabel("Latency ms")).toHaveValue("300");
    await m.getByLabel("Latency ms").fill("700");
    await m.getByLabel("Download KB/s").fill("0");
    await m.getByLabel("Upload KB/s").fill("0");
  } });
  await closeRules(page);
  expect((await sniffo.call("get_rules")).rules[0].action).toEqual({ type: "throttle", latency_ms: 700, download_kbps: 0, upload_kbps: 0 });
  const slow = await sniffo.get("/slowed");
  expect(slow.ms).toBeGreaterThanOrEqual(650);
  const fast = await sniffo.get("/fast");
  expect(fast.ms).toBeLessThan(500);
});

test("script rule rewrites traffic and logs to the console", async ({ sniffo }) => {
  const { page } = sniffo;
  await addRule(page, { name: "Rewrite", url: "*/scripted*", action: "Script", fill: async (m) => {
    const editor = m.locator("textarea.code-editor");
    await expect(editor).toHaveValue(/function onRequest\(context, request\)/);
    // Tab indents instead of leaving the editor.
    await editor.fill("");
    await editor.press("Tab");
    await expect(editor).toHaveValue("  ");
    await editor.fill(`function onRequest(ctx, req) { req.headers["x-script"] = "on"; sharedState.n = (sharedState.n || 0) + 1; return req; }
function onResponse(ctx, req, res) { console.log("seen", req.url, sharedState.n); res.body.scripted = true; res.status = 299; return res; }`);
  } });
  await addRule(page, { name: "Broken", url: "*/broken-script", action: "Script", fill: async (m) => {
    await m.locator("textarea.code-editor").fill("function onRequest() { throw new Error('kaput') }");
  } });
  await closeRules(page);

  const r = await sniffo.get("/scripted");
  expect(r.status).toBe(299);
  const json = JSON.parse(r.body.toString());
  expect([json.scripted, json.headers["x-script"]]).toEqual([true, "on"]);
  await sniffo.get("/scripted");
  // A failing script lets traffic through and reports the error.
  expect((await sniffo.get("/broken-script")).status).toBe(200);

  const toggle = page.locator(".statusbar button", { hasText: /^Console/ });
  await expect(toggle).toHaveText("Console (3)");
  await expect(toggle).toHaveClass(/err/);
  await toggle.click();
  const consoleBody = page.locator(".console-body");
  await expect(consoleBody.locator("div").nth(0)).toContainText(`[Rewrite] #1 seen ${sniffo.url("/scripted")} 1`);
  await expect(consoleBody.locator("div").nth(1)).toContainText("seen");
  await expect(consoleBody.locator("div.err")).toContainText("[Broken] #3 onRequest: Error: kaput");
  await expect(consoleBody.locator("div.err")).not.toContainText("converting");
  await consoleBody.getByRole("link", { name: "#3" }).click();
  await expect(page.locator(".detail-url")).toContainText("/broken-script");
  await page.locator(".console-head").getByRole("button", { name: "Clear" }).click();
  await expect(consoleBody).toContainText("console.log output and script errors appear here.");
  await expect(toggle).toHaveText("Console (0)");
  await page.locator(".console-head").getByRole("button", { name: "✕" }).click();
  await expect(page.locator(".console")).toHaveCount(0);
});

test("request and response breakpoints: edit, execute, abort, queue", async ({ sniffo }) => {
  const { page } = sniffo;
  await addRule(page, { url: "*/held*", action: "Breakpoint", fill: async (m) => {
    await expect(m.getByRole("checkbox", { name: /^Request/ })).toBeChecked();
    await m.getByRole("checkbox", { name: /^Response/ }).check();
  } });
  await closeRules(page);

  const pending = sniffo.get("/held?v=1", { method: "POST", headers: { "content-type": "text/plain" }, body: "original" });
  const m = modal(page);
  await expect(m.locator("h3")).toHaveText(/Breakpoint — Request #1/);
  await expect(page.locator(".statusbar")).toContainText("⏸ 1 paused");
  await expect(row(page, "/held").locator(".badge.warn")).toHaveText("⏸ paused");
  await expect(m.getByLabel("Method")).toHaveValue("POST");
  await m.getByLabel("Method").fill("put");
  await expect(m.getByLabel("Method")).toHaveValue("PUT");
  await m.getByLabel("URL").fill(sniffo.url("/held-edited"));
  await m.getByLabel("Headers").fill("content-type: text/plain\nx-added: 1");
  await m.locator("textarea").nth(1).fill("edited body");
  await m.getByRole("button", { name: "Execute" }).click();

  await expect(m.locator("h3")).toHaveText(/Breakpoint — Response #1/);
  await m.getByLabel("Status").fill("201");
  await m.locator("textarea").nth(1).fill('{"edited":"response"}');
  await m.getByRole("button", { name: "Execute" }).click();
  const r = await pending;
  expect([r.status, r.body.toString()]).toEqual([201, '{"edited":"response"}']);
  expect(sniffo.up.seen.at(-1)).toMatchObject({ method: "PUT", path: "/held-edited", body: "edited body", headers: { "x-added": "1" } });
  await expect(page.locator(".statusbar")).not.toContainText("paused");

  // Two at once: the editor shows the first and how many wait; abort answers without the server.
  const a = sniffo.get("/held-a").catch((e) => e);
  await expect(m.locator("h3")).toHaveText(/Request #2/);
  const b = sniffo.get("/held-b").catch((e) => e);
  await expect(m.locator("h3")).toContainText("(1 more waiting)");
  await expect(page.locator(".statusbar")).toContainText("⏸ 2 paused");
  await m.getByRole("button", { name: "Abort" }).click();
  expect((await a).status).toBeGreaterThanOrEqual(400);
  await expect(m.locator("h3")).toHaveText(/Request #3/);
  await m.getByRole("button", { name: "Abort" }).click();
  expect((await b).status).toBeGreaterThanOrEqual(400);
  await expect(m).toHaveCount(0);
  expect(sniffo.up.seen.map((s) => s.path)).toEqual(["/held-edited"]);
});

test("breakpoints waiting before the UI opened are shown", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.call("set_rules", { rules: { rules: [{ id: "b", name: "b", enabled: true, matcher: { url: "*/early*", regex: false, methods: [] }, action: { type: "breakpoint", request: true, response: false } }], allow_list: { enabled: false, patterns: [] }, no_caching: false } });
  const pending = sniffo.get("/early");
  await expect(modal(page).locator("h3")).toHaveText(/Request #1/);
  await page.reload();
  await expect(modal(page).locator("h3")).toHaveText(/Request #1/);
  await modal(page).getByRole("button", { name: "Execute" }).click();
  expect((await pending).status).toBe(200);
});

test("no caching, allow list, import and export", async ({ sniffo }) => {
  const { page } = sniffo;
  await page.getByRole("button", { name: "Rules" }).click();
  const m = modal(page);
  await m.getByLabel(/Strip caching headers/).click();
  await expect(m.getByLabel(/Strip caching headers/)).toBeChecked();
  const cached = await sniffo.get("/cached", { headers: { "if-none-match": '"v1"' } });
  expect(cached.body.toString()).toBe("if-none-match=none");
  expect(cached.headers.etag).toBeUndefined();

  await m.locator("textarea").fill("*keep*");
  await m.getByLabel(/Record only matching URLs/).click();
  await expect(m.getByLabel(/Record only matching URLs/)).toBeChecked();
  expect((await sniffo.call("get_rules")).allow_list).toEqual({ enabled: true, patterns: ["*keep*"] });
  await sniffo.get("/keep-me");
  await sniffo.get("/ignored");
  await expect(page.locator(".flow-row:not(.head) .c-path")).toHaveText(["/cached", "/keep-me"]);
  expect(sniffo.up.seen.map((s) => s.path)).toContain("/ignored");

  // Export, then import appends copies with fresh ids.
  await addRule(page, { name: "Exported", url: "*", action: "Block", fill: async (mm) => { await mm.getByLabel("Action").selectOption({ label: "Block" }); } });
  await m.locator("table.rules input[type=checkbox]").click();
  await expect(m.locator("table.rules tr")).toHaveClass(/disabled/);
  const file = join(sniffo.dataDir, "rules.json");
  await sniffo.dialog(file);
  await m.getByRole("button", { name: "Export…" }).click();
  await expect(m.locator("p.err")).toHaveText("Exported 1 rules");
  expect(JSON.parse(read(file)).rules[0].name).toBe("Exported");
  await sniffo.dialog(file);
  await m.getByRole("button", { name: "Import…" }).click();
  await expect(m.locator("p.err")).toHaveText("Imported 1 rules");
  await expect(m.locator("table.rules tr")).toHaveCount(2);
  const bad = join(sniffo.dataDir, "bad.json");
  writeFileSync(bad, "[]");
  await sniffo.dialog(bad);
  await m.getByRole("button", { name: "Import…" }).click();
  await expect(m.locator("p.err")).toContainText("not a Sniffo rules file");
  await sniffo.dialog(null);
  await m.getByRole("button", { name: "Export…" }).click();
  await expect(m.locator("table.rules tr")).toHaveCount(2);
  // The status bar catches up when the editor closes.
  await closeRules(page);
  await expect(page.locator(".statusbar")).toContainText("No caching");
  await expect(page.locator(".statusbar")).toContainText("Allow list on");
  await expect(page.locator(".statusbar")).toContainText("Rules 0 active");
});

test("matching: methods, regex, disabled rules; map remote scheme; binary bodies at breakpoints", async ({ sniffo }) => {
  const { page } = sniffo;
  await addRule(page, { name: "Only POST", url: "*/m*", methods: "post", action: "Block" });
  await addRule(page, { name: "Regex", url: "/num/\\d+$", regex: true, action: "Map Local", fill: async (m) => {
    await m.locator("textarea").last().fill("regex hit");
  } });
  await addRule(page, { name: "Off", url: "*/off", action: "Block" });
  await modal(page).locator("table.rules tr", { hasText: "Off" }).locator("input[type=checkbox]").click();
  await expect(modal(page).locator("table.rules tr", { hasText: "Off" })).toHaveClass(/disabled/);
  // Scheme rewrite: https://… is sent as plain http to the upstream.
  const port = new URL(sniffo.up.http).port;
  await addRule(page, { name: "To http", url: "*://secure.test/*", action: "Map Remote", fill: async (m) => {
    await m.getByLabel("Scheme").fill("http");
    await m.getByLabel("Host").fill("127.0.0.1");
    await m.getByLabel("Port").fill(port);
  } });
  await addRule(page, { name: "Hold binary", url: "*/bin-up", action: "Breakpoint" });
  await closeRules(page);

  expect((await sniffo.get("/m1", { method: "POST" })).status).toBe(403);
  expect((await sniffo.get("/m1")).status).toBe(200);
  expect((await sniffo.get("/num/42")).body.toString()).toBe("regex hit");
  expect((await sniffo.get("/num/42x")).status).toBe(200);
  expect(JSON.parse((await sniffo.get("/num/42x")).body.toString()).path).toBe("/num/42x");
  expect((await sniffo.get("/off")).status).toBe(200);
  await sniffo.call("set_ssl_proxying", { ssl: { enabled: true, include: ["secure.test"], exclude: [] } });
  const { curlHttps } = await import("./upstream");
  const r = await curlHttps(sniffo.port, "https://secure.test/via-scheme", sniffo.caPath, ["--resolve", "secure.test:443:127.0.0.1"]);
  expect([r.status, JSON.parse(r.body).path]).toEqual([200, "/via-scheme"]);

  // A binary request body can't be edited as text; it's forwarded untouched.
  const pending = sniffo.get("/bin-up", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from([0, 1, 2, 255]) });
  await expect(modal(page)).toContainText("Binary body — forwarded unchanged.");
  await modal(page).getByRole("button", { name: "Execute" }).click();
  expect((await pending).status).toBe(200);
  expect(Buffer.from(sniffo.up.seen.at(-1)!.body, "latin1")).toBeTruthy();
});
