// Flow context menu, keyboard shortcuts, Compose, Diff, File menu (sessions / HAR).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, read, row, test } from "./fixtures";

const paths = (page: import("@playwright/test").Page) => page.locator(".flow-row:not(.head) .c-path");
const menu = (page: import("@playwright/test").Page, label: string | RegExp) => page.locator(".menu > div", { hasText: label });
const clip = (page: import("@playwright/test").Page) => page.evaluate(() => navigator.clipboard.readText());

test("repeat, edit & repeat, pin, highlight, delete", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/orig?x=1", { method: "PUT", headers: { "content-type": "text/plain", "x-token": "t1" }, body: "payload" });
  const orig = row(page, "/orig");
  await orig.click({ button: "right" });
  await menu(page, /^Repeat$/).click();
  await expect(page.locator(".toast")).toHaveText("Repeated — 200");
  await expect(paths(page)).toHaveText(["/orig?x=1", "/orig?x=1"]);
  expect(sniffo.up.seen.filter((s) => s.path === "/orig?x=1").map((s) => [s.method, s.body, s.headers["x-token"]])).toEqual([["PUT", "payload", "t1"], ["PUT", "payload", "t1"]]);

  await orig.first().click({ button: "right" });
  await menu(page, "Edit & Repeat…").click();
  const modal = page.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Compose request");
  await expect(modal.locator("select")).toHaveValue("PUT");
  await expect(modal.locator("input.input")).toHaveValue(sniffo.url("/orig?x=1"));
  await expect(modal.locator("textarea").nth(0)).toHaveValue(/x-token: t1/);
  await expect(modal.locator("textarea").nth(1)).toHaveValue("payload");
  await modal.locator("select").selectOption("POST");
  await modal.locator("input.input").fill(sniffo.url("/edited"));
  await modal.locator("textarea").nth(1).fill("changed");
  await modal.getByRole("button", { name: "Send" }).click();
  await expect(modal.locator("p.ok")).toHaveText("Sent — 200. The request is in the list.");
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(row(page, "/edited").locator(".c-method")).toHaveText("POST");
  expect(sniffo.up.seen.at(-1)).toMatchObject({ method: "POST", path: "/edited", body: "changed" });

  // Pin / Unpin from the menu.
  await row(page, "/edited").click({ button: "right" });
  await menu(page, /^Pin$/).click();
  await expect(row(page, "/edited").locator(".c-id")).toHaveText("📌");
  await row(page, "/edited").click({ button: "right" });
  await menu(page, /^Unpin$/).click();
  await expect(row(page, "/edited").locator(".c-id")).not.toHaveText("📌");

  // Highlight colours (visible when the row isn't selected), and clearing them.
  await orig.first().click({ button: "right" });
  await page.locator(".menu .swatches span[title=Green]").click();
  await row(page, "/edited").click();
  await expect(orig.first()).toHaveAttribute("style", /background: rgba\(52, 199, 89, 0\.22\)/);
  await orig.first().click({ button: "right" });
  await page.locator(".menu .swatches span.none").click();
  await row(page, "/edited").click();
  await expect(orig.first()).not.toHaveAttribute("style", /background/);

  await row(page, "/edited").click({ button: "right" });
  await menu(page, /^Delete$/).click();
  await expect(paths(page)).toHaveText(["/orig?x=1", "/orig?x=1"]);
  await expect(page.locator(".detail.empty")).toBeVisible();
});

test("copy URL, cURL, fetch and Python", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/copy?q=1", { method: "POST", headers: { "content-type": "application/json", "x-a": "it's" }, body: '{"k":1}' });
  const r = row(page, "/copy");
  const url = sniffo.url("/copy?q=1");
  await r.click({ button: "right" });
  await menu(page, "Copy URL").click();
  await expect(page.locator(".toast")).toHaveText("Copied URL");
  expect(await clip(page)).toBe(url);
  await r.click({ button: "right" });
  await menu(page, "Copy as cURL").click();
  await expect(page.locator(".toast")).toHaveText("Copied as cURL");
  const curl = await clip(page);
  expect(curl).toContain(`curl -X POST '${url}'`);
  expect(curl).toContain(`-H 'x-a: it'\\''s'`);
  expect(curl).toContain(`--data-raw '{"k":1}'`);
  expect(curl).not.toContain("host:");
  await r.click({ button: "right" });
  await menu(page, "Copy as fetch").click();
  await expect(page.locator(".toast")).toHaveText("Copied as fetch");
  expect(await clip(page)).toContain(`await fetch("${url}", {\n  "method": "POST"`);
  await r.click({ button: "right" });
  await menu(page, "Copy as Python requests").click();
  await expect(page.locator(".toast")).toHaveText("Copied as Python");
  const py = await clip(page);
  expect(py).toContain("import requests");
  expect(py).toContain(`data="{\\"k\\":1}"`);
  // ⌘⇧C copies the selected flow as cURL too.
  await r.click();
  await page.keyboard.press("ControlOrMeta+Shift+C");
  await expect(page.locator(".toast")).toHaveText("Copied as cURL");
  expect(await clip(page)).toBe(curl);
});

test("diff two flows", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/echo", { method: "POST", headers: { "x-v": "1" }, body: '{"a":1,"same":true}' });
  await sniffo.get("/echo", { method: "POST", headers: { "x-v": "2" }, body: '{"a":2,"same":true}' });
  const [a, b] = [page.locator(".flow-row:not(.head)").nth(0), page.locator(".flow-row:not(.head)").nth(1)];
  await a.click({ button: "right" });
  await menu(page, "Mark for diff").click();
  await expect(page.locator(".toast")).toHaveText("#1 marked — right-click another flow to compare");
  await b.click({ button: "right" });
  await menu(page, "Compare with #1").click();
  const modal = page.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Diff #1 → #2");
  const diff = modal.locator(".diff");
  await expect(diff.locator(".del", { hasText: '"body"' })).toContainText('-   "body": "{\\"a\\":1,\\"same\\":true}"');
  await expect(diff.locator(".add", { hasText: '"body"' })).toContainText('+   "body": "{\\"a\\":2,\\"same\\":true}"');
  await modal.getByRole("button", { name: "Request" }).click();
  await expect(diff.locator(".del", { hasText: "x-v" })).toHaveText("- x-v: 1\n");
  await expect(diff.locator(".add", { hasText: "x-v" })).toHaveText("+ x-v: 2\n");
  await expect(diff.locator(".del", { hasText: '"a"' })).toContainText('-   "a": 1,');
  await expect(diff).toContainText('    "same": true');
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(modal).toHaveCount(0);
});

test("rule shortcuts from a flow", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/json?page=1");
  const base = sniffo.url("/json");
  const expectations: [string, string, string][] = [
    ["Breakpoint…", "breakpoint", `${base}*`],
    ["Map Local…", "map_local", `${base}*`],
    ["Map Remote…", "map_remote", `http://127.0.0.1/*`],
    ["Script…", "script", `${base}*`],
    ["Throttle host…", "throttle", `*://127.0.0.1/*`],
    ["Block host…", "block", `*://127.0.0.1/*`],
  ];
  for (const [label, type, url] of expectations) {
    await row(page, "/json").click({ button: "right" });
    await menu(page, label).click();
    const modal = page.locator(".modal");
    await expect(modal.locator("select").first()).toHaveValue(type);
    await expect(modal.locator("input.input.wide").nth(1)).toHaveValue(url);
    if (type === "map_local") {
      // Prefilled with the captured response.
      await expect(modal.getByLabel("Status")).toHaveValue("200");
      const headers = modal.locator("textarea").nth(0);
      await expect(headers).toHaveValue(/^content-type: application\/json$/m);
      // Framing and hop-by-hop headers of the original response are not replayed.
      await expect(headers).not.toHaveValue(/content-length|connection|keep-alive/i);
      await expect(modal.locator("textarea").nth(1)).toHaveValue(/"name":"Ada"/);
    }
    await modal.getByRole("button", { name: "Cancel" }).click();
    await modal.getByRole("button", { name: "Close" }).click();
  }
  // "Show only <host>" filters the list.
  await sniffo.get("/other");
  await row(page, "/json").click({ button: "right" });
  await menu(page, "Show only 127.0.0.1").click();
  await expect(page.locator(".sidebar .side-item.active")).toContainText("127.0.0.1");
});

test("keyboard shortcuts", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/one");
  await sniffo.get("/two");
  await sniffo.get("/three");
  // Arrow keys move the selection in the list.
  await row(page, "/one").click();
  await page.locator(".flow-scroll").press("ArrowDown");
  await expect(row(page, "/two")).toHaveClass(/selected/);
  await page.locator(".flow-scroll").press("ArrowDown");
  await page.locator(".flow-scroll").press("ArrowUp");
  await expect(row(page, "/two")).toHaveClass(/selected/);

  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.locator(".toast")).toHaveText("Repeated — 200");
  await expect(paths(page)).toHaveText(["/one", "/two", "/three", "/two"]);

  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator(".modal input.input")).toHaveValue(sniffo.url("/two"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.locator(".modal input.input")).toHaveValue("https://");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.locator(".modal h3")).toHaveText("Rules");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.locator(".modal h3")).toHaveText("Settings");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator("input.filter")).toBeFocused();
  // Typing in the filter doesn't trigger shortcuts (Backspace edits text).
  await page.keyboard.type("on");
  await page.keyboard.press("Backspace");
  await expect(page.locator("input.filter")).toHaveValue("o");
  await expect(paths(page)).toHaveText(["/one", "/two", "/two"]);
  await page.locator("input.filter").fill("");

  // Backspace / Delete delete the selected flow; ⌘K clears all but pinned ones.
  await row(page, "/three").click();
  await page.keyboard.press("Delete");
  await sniffo.get("/three");
  await expect(paths(page)).toHaveText(["/one", "/two", "/two", "/three"]);
  await row(page, "/three").click();
  await page.keyboard.press("Backspace");
  await expect(paths(page)).toHaveText(["/one", "/two", "/two"]);
  await row(page, "/one").click();
  await page.locator(".detail-url .pin").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(paths(page)).toHaveText(["/one"]);

  // ⌘S saves the session, ⌘O opens one (replacing the list).
  const file = join(sniffo.dataDir, "session.har");
  await sniffo.dialog(file);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".toast")).toHaveText(`Saved 1 flows to ${file}`);
  await sniffo.get("/after-save");
  await expect(paths(page)).toHaveText(["/one", "/after-save"]);
  await sniffo.dialog(file);
  await page.keyboard.press("ControlOrMeta+o");
  await expect(page.locator(".toast")).toHaveText("Loaded 1 flows");
  // Opening replaces unpinned flows (the pinned one stays, plus the loaded copy).
  await expect(paths(page)).toHaveText(["/one", "/one"]);
  // A cancelled dialog does nothing.
  await sniffo.dialog(null);
  await page.keyboard.press("ControlOrMeta+o");
  await expect(paths(page)).toHaveText(["/one", "/one"]);
});

test("clear button keeps pinned flows", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/keep");
  await sniffo.get("/drop");
  await row(page, "/keep").click();
  await page.locator(".detail-url .pin").click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(paths(page)).toHaveText(["/keep"]);
  await expect(page.locator(".statusbar")).toContainText("1 / 1 flows");
});

test("compose: send, import cURL, errors", async ({ sniffo }) => {
  const { page } = sniffo;
  await page.getByRole("button", { name: "Compose" }).click();
  const modal = page.locator(".modal");
  await modal.locator("summary", { hasText: "Import from cURL" }).click();
  await modal.locator("textarea").nth(2).fill(`curl '${sniffo.url("/imported")}' -H 'x-from: curl' --data-raw 'a=1'`);
  await modal.getByRole("button", { name: "Import" }).click();
  await expect(modal.locator("select")).toHaveValue("POST");
  await expect(modal.locator("input.input")).toHaveValue(sniffo.url("/imported"));
  await expect(modal.locator("textarea").nth(0)).toHaveValue("x-from: curl");
  await expect(modal.locator("textarea").nth(1)).toHaveValue("a=1");
  // Enter in the URL sends.
  await modal.locator("input.input").press("Enter");
  await expect(modal.locator("p.ok")).toContainText("Sent — 200");
  expect(sniffo.up.seen.at(-1)).toMatchObject({ method: "POST", path: "/imported", body: "a=1", headers: { "x-from": "curl" } });
  await expect(row(page, "/imported")).toBeVisible();

  // Methods outside the list are kept.
  await modal.locator("textarea").nth(2).fill(`curl -X PURGE '${sniffo.url("/cache")}'`);
  await modal.getByRole("button", { name: "Import" }).click();
  await expect(modal.locator("select")).toHaveValue("other");
  await expect(modal.locator("select option:checked")).toHaveText("PURGE");
  await modal.getByRole("button", { name: "Send" }).click();
  await expect(modal.locator("p.ok")).toContainText("Sent — 200");
  expect(sniffo.up.seen.at(-1)).toMatchObject({ method: "PURGE", path: "/cache" });

  await modal.locator("textarea").nth(2).fill("wget http://x");
  await modal.getByRole("button", { name: "Import" }).click();
  await expect(modal.locator("p.err")).toHaveText("Error: Not a curl command");

  await modal.locator("input.input").fill("not a url");
  await modal.getByRole("button", { name: "Send" }).click();
  await expect(modal.locator("p.err")).not.toBeEmpty();
  // Clicking the backdrop closes.
  await page.locator(".modal-back").click({ position: { x: 5, y: 5 } });
  await expect(modal).toHaveCount(0);
});

test("file menu: sessions and HAR", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/json");
  await sniffo.get("/xml");
  const file = (n: string) => join(sniffo.dataDir, n);
  const fileMenu = async (item: string) => {
    await page.getByRole("button", { name: "File ▾" }).click();
    await page.locator(".menu.right > div", { hasText: item }).click();
  };
  await sniffo.dialog(file("all.har"));
  await fileMenu("Save session…");
  await expect(page.locator(".toast")).toHaveText(`Saved 2 flows to ${file("all.har")}`);
  expect(JSON.parse(read(file("all.har"))).log.entries).toHaveLength(2);

  await page.locator("input.filter").fill("xml");
  await sniffo.dialog(file("visible.har"));
  await fileMenu("Export visible as HAR…");
  await expect(page.locator(".toast")).toHaveText(`Saved 1 flows to ${file("visible.har")}`);
  expect(JSON.parse(read(file("visible.har"))).log.entries[0].request.url).toBe(sniffo.url("/xml"));
  await page.locator("input.filter").fill("");

  await sniffo.dialog(file("visible.har"));
  await fileMenu("Import HAR…");
  await expect(page.locator(".toast")).toHaveText("Loaded 1 flows");
  await expect(paths(page)).toHaveText(["/json", "/xml", "/xml"]);

  await sniffo.dialog(file("all.har"));
  await fileMenu("Open session…");
  await expect(paths(page)).toHaveText(["/json", "/xml"]);
  // Bodies survive the round trip.
  await row(page, "/json").click();
  await expect(page.locator(".pane").nth(1).locator(".json-tree")).toContainText("total: 1");

  // A broken file is reported.
  writeFileSync(file("bad.har"), "{}");
  await sniffo.dialog(file("bad.har"));
  await fileMenu("Open session…");
  await expect(page.locator(".banner")).not.toBeEmpty();
  await expect(paths(page)).toHaveText(["/json", "/xml"]);

  // Export a single flow from its menu.
  await sniffo.dialog(file("one.har"));
  await row(page, "/xml").click({ button: "right" });
  await menu(page, "Export as HAR…").click();
  await expect(page.locator(".toast")).toHaveText(`Saved 1 flows to ${file("one.har")}`);
  const dialogs = (await sniffo.uiCalls("plugin:dialog|save")).map((c) => (c.args.options as { defaultPath: string }).defaultPath);
  expect(dialogs.at(-1)).toMatch(/^flow-\d+\.har$/);
});
