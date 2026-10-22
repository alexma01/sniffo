// Filter bar, sidebar (domains, apps, devices, pins) and their menus.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copied, expect, read, row, test } from "./fixtures";
import { request } from "./upstream";

const paths = (page: import("@playwright/test").Page) => page.locator(".flow-row:not(.head) .c-path");

test("text, regex and body search", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/json");
  await sniffo.get("/xml");
  await sniffo.get("/echo", { method: "POST", body: "secret-needle" });
  await sniffo.get("/status/404");
  const filter = page.locator("input.filter");
  await filter.fill("xml");
  await expect(paths(page)).toHaveText(["/xml"]);
  await expect(page.locator(".statusbar")).toContainText("1 / 4 flows");
  await filter.fill("post");
  await expect(paths(page)).toHaveText(["/echo"]);
  await filter.fill("404");
  await expect(paths(page)).toHaveText(["/status/404"]);

  await page.locator(".chip", { hasText: ".*" }).click();
  await expect(filter).toHaveAttribute("placeholder", "Regex on URL, method, status");
  await filter.fill("/(json|xml)$");
  await expect(paths(page)).toHaveText(["/json", "/xml"]);
  await filter.fill("(unclosed");
  await expect(filter).toHaveClass(/invalid/);
  await expect(filter).toHaveAttribute("title", /Invalid regular expression/);
  await expect(paths(page)).toHaveCount(0);
  await page.locator(".chip", { hasText: ".*" }).click();
  await expect(filter).not.toHaveClass(/invalid/);

  // Body search runs in the backend (headers and bodies too).
  await page.locator(".chip", { hasText: "Body" }).click();
  await expect(page.locator(".chip", { hasText: ".*" })).toBeDisabled();
  await filter.fill("SECRET-NEEDLE");
  await expect(paths(page)).toHaveText(["/echo"]);
  await filter.fill("Ada");
  await expect(paths(page)).toHaveText(["/json"]);
  // New matching traffic shows up while the search is active.
  await sniffo.get("/echo2", { method: "POST", body: "ada again" });
  await expect(paths(page)).toHaveText(["/json", "/echo2"]);
  await filter.fill("");
  await expect(paths(page)).toHaveCount(5);
});

test("content type and status chips", async ({ sniffo }) => {
  const { page } = sniffo;
  for (const p of ["/json", "/xml", "/html", "/app.js", "/style.css", "/image.png", "/font.woff2", "/binary", "/status/404", "/status/500"]) await sniffo.get(p);
  await sniffo.get("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: '{"query":"query Q { a }"}' });
  await request(sniffo.port, "GET", "http://127.0.0.1:1/down");
  await expect(paths(page)).toHaveCount(12);
  const chip = (name: string) => page.locator(".filterbar .chip", { hasText: new RegExp(`^${name}$`) });
  const only = async (name: string, expected: string[]) => {
    await chip(name).click();
    await expect(paths(page)).toHaveText(expected);
    await chip(name).click();
  };
  await only("JSON", ["/json", "query Q/graphql"]);
  await sniffo.get("/video.mp4");
  await sniffo.get("/form-reply");
  await sniffo.get("/status/302");
  await only("Media", ["/video.mp4"]);
  await only("Form", ["/form-reply"]);
  await only("3xx", ["/status/302"]);
  await only("XML", ["/xml"]);
  await only("HTML", ["/html"]);
  await only("JS", ["/app.js"]);
  await only("CSS", ["/style.css"]);
  await only("Image", ["/image.png"]);
  await only("Font", ["/font.woff2"]);
  // The path cell carries the operation badge.
  await only("GraphQL", ["query Q/graphql"]);
  // text/plain and unknown types are "Other".
  await only("Other", ["/binary", "/status/404", "/status/500", "/down", "/status/302"]);
  await only("4xx", ["/status/404"]);
  await only("5xx", ["/status/500"]);
  await only("Error", ["/down"]);
  // 1xx: a WebSocket upgrade (101).
  const { wsConnect } = await import("./upstream");
  const ws = await wsConnect(sniffo.port, sniffo.up.wsPort);
  await chip("1xx").click();
  await expect(paths(page)).toHaveText([/\/ws$/]);
  await chip("1xx").click();
  ws.close();
  // Chips combine: JSON or XML, and 2xx.
  await chip("JSON").click();
  await chip("XML").click();
  await chip("2xx").click();
  await expect(paths(page)).toHaveText(["/json", "/xml", "query Q/graphql"]);
  await expect(chip("JSON")).toHaveClass(/on/);
});

test("sidebar: domains, search, collapse and pins", async ({ sniffo }) => {
  const { page } = sniffo;
  const localhost = sniffo.up.http.replace("127.0.0.1", "localhost");
  await sniffo.get("/a");
  await sniffo.get("/b");
  await request(sniffo.port, "GET", `${localhost}/c`);
  const side = page.locator(".sidebar");
  const domain = (h: string) => side.locator(".side-section", { hasText: "Domains" }).locator(".side-item", { hasText: h });
  await expect(domain("127.0.0.1").locator(".muted")).toHaveText("2");
  await expect(domain("localhost").locator(".muted")).toHaveText("1");
  await expect(side.locator(".side-item", { hasText: "All" }).locator(".muted")).toHaveText("3");

  await domain("localhost").click();
  await expect(paths(page)).toHaveText(["/c"]);
  await expect(domain("localhost")).toHaveClass(/active/);
  await domain("localhost").click();
  await expect(paths(page)).toHaveCount(3);

  await side.locator(".side-search input").fill("local");
  await expect(side.locator(".side-section", { hasText: "Domains" }).locator(".side-item")).toHaveText([/localhost/]);
  await side.locator(".side-search input").fill("");

  // Collapsing a section is remembered.
  await side.locator(".side-title", { hasText: "Domains" }).click();
  await expect(domain("localhost")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".side-title", { hasText: "Domains" })).toContainText("▸");
  await page.locator(".side-title", { hasText: "Domains" }).click();
  await expect(domain("localhost")).toBeVisible();

  // Pin a domain from its menu; it's listed under Pinned (and remembered).
  await domain("localhost").click({ button: "right" });
  await page.locator(".menu .menu-label", { hasText: "localhost" }).waitFor();
  await page.locator(".menu > div", { hasText: "Pin domain" }).click();
  const pinned = side.locator(".side-section", { hasText: "Pinned" });
  await expect(pinned.locator(".side-item", { hasText: "localhost" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".sidebar .side-section", { hasText: "Pinned" }).locator(".side-item", { hasText: "localhost" })).toBeVisible();
  await page.locator(".sidebar .side-section", { hasText: "Pinned" }).locator(".side-item", { hasText: "localhost" }).click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Unpin domain" }).click();
  await expect(page.locator(".sidebar .side-section", { hasText: "Pinned" }).locator(".side-item", { hasText: "localhost" })).toHaveCount(0);

  // Pinned flows filter.
  await row(page, "/b").click();
  await page.locator(".detail-url .pin").click();
  await page.locator(".side-item", { hasText: "📌 Pinned flows" }).click();
  await expect(paths(page)).toHaveText(["/b"]);
  await expect(page.locator(".side-item", { hasText: "📌 Pinned flows" }).locator(".muted")).toHaveText("1");
  await page.locator(".sidebar .side-item", { hasText: "All" }).first().click();
  await expect(paths(page)).toHaveCount(3);
});

test("sidebar domain menu actions", async ({ sniffo }) => {
  const { page } = sniffo;
  const localhost = sniffo.up.http.replace("127.0.0.1", "localhost");
  await sniffo.get("/keep");
  await request(sniffo.port, "GET", `${localhost}/one`);
  await request(sniffo.port, "GET", `${localhost}/two`);
  const open = async () => {
    await page.locator(".sidebar .side-section", { hasText: "Domains" }).locator(".side-item", { hasText: "localhost" }).click({ button: "right" });
    return page.locator(".menu");
  };
  await (await open()).locator("div", { hasText: "Show only this domain" }).click();
  await expect(paths(page)).toHaveText(["/one", "/two"]);
  await page.locator(".sidebar .side-item", { hasText: "All" }).first().click();

  await (await open()).locator("div", { hasText: /^Copy domain$/ }).click();
  await expect(page.locator(".toast")).toHaveText("Copied");
  expect(await copied(page)).toBe("localhost");

  for (const [label, type, title] of [["Breakpoint…", "breakpoint", "Breakpoint"], ["Map Remote…", "map_remote", "Map Remote"], ["Script…", "script", "Script"], ["Throttle…", "throttle", "Throttle"], ["Block…", "block", "Block"]] as const) {
    await (await open()).locator("div", { hasText: new RegExp(`^${label}$`) }).click();
    const modal = page.locator(".modal");
    await expect(modal.locator("select").first()).toHaveValue(type);
    await expect(modal.locator("input.input.wide").nth(1)).toHaveValue("*://localhost/*");
    await expect(modal.locator("input.input.wide").first()).toHaveValue(`${title} *://localhost/*`);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  }

  const file = join(sniffo.dataDir, "domain.har");
  await sniffo.dialog(file);
  await (await open()).locator("div", { hasText: "Export as HAR…" }).click();
  await expect(page.locator(".toast")).toHaveText(`Saved 2 flows to ${file}`);
  expect(JSON.parse(read(file)).log.entries.map((e: any) => new URL(e.request.url).pathname)).toEqual(["/one", "/two"]);

  await (await open()).locator("div", { hasText: "Delete these flows" }).click();
  await expect(paths(page)).toHaveText(["/keep"]);
  expect((await sniffo.call("list_flows")).length).toBe(1);
});

test("apps and devices", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/from-node");
  // A phone on the LAN: its flows come from another IP (imported session).
  const har = { log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [1, 2].map((i) => ({
    startedDateTime: new Date().toISOString(), time: 5, _client: "192.168.1.40:5000",
    request: { method: "GET", url: `https://api.phone.test/item/${i}`, httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
    response: { status: 200, statusText: "OK", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: 0, mimeType: "text/plain" }, redirectURL: "", headersSize: -1, bodySize: 0 },
    cache: {}, timings: { send: 0, wait: 5, receive: 0 } })) } };
  const file = join(sniffo.dataDir, "phone.har");
  writeFileSync(file, JSON.stringify(har));
  await sniffo.call("import_har", { path: file, replace: false });
  // Local traffic whose app couldn't be resolved.
  har.log.entries = [{ ...har.log.entries[0], _client: "127.0.0.1:5001", request: { ...har.log.entries[0].request, url: "http://local.test/unresolved" } }];
  writeFileSync(file, JSON.stringify(har));
  await sniffo.call("import_har", { path: file, replace: false });
  await expect(page.locator(".side-section", { hasText: "This Mac" }).locator(".side-item", { hasText: "This Mac (other)" })).toBeVisible();
  await expect(row(page, "/unresolved").locator(".c-client")).toContainText("This Mac");
  await expect(row(page, "/unresolved").locator(".app-icon")).toHaveText("💻");

  const mac = page.locator(".side-section", { hasText: "This Mac" });
  await expect(mac.locator(".side-item", { hasText: "node" })).toBeVisible();
  await mac.locator(".side-item", { hasText: "node" }).click();
  await expect(paths(page)).toHaveText(["/from-node"]);
  await expect(mac.locator(".side-item", { hasText: "node" })).toHaveClass(/active/);
  await mac.locator(".side-item", { hasText: "node" }).click();

  const devices = page.locator(".side-section", { hasText: "Devices" });
  const phone = devices.locator(".side-item", { hasText: "192.168.1.40" });
  await expect(phone.locator(".muted")).toHaveText("2");
  await expect(phone.locator(".app-icon")).toHaveText("📱");
  await phone.click();
  await expect(paths(page)).toHaveText(["/item/1", "/item/2"]);
  await phone.click();

  // Rename (double-click), remembered across reloads, and shown in the Client column.
  await phone.dblclick();
  await expect(devices.locator("input.rename")).toBeFocused();
  // Traffic arriving meanwhile must not take the editor away.
  await sniffo.get("/during-rename");
  await expect(row(page, "/during-rename")).toBeVisible();
  await expect(devices.locator("input.rename")).toBeFocused();
  await devices.locator("input.rename").fill("Test iPhone");
  await devices.locator("input.rename").press("Enter");
  await expect(devices.locator(".side-item", { hasText: "Test iPhone" })).toBeVisible();
  await expect(row(page, "/item/1").locator(".c-client")).toContainText("Test iPhone");
  await page.reload();
  const renamed = page.locator(".side-section", { hasText: "Devices" }).locator(".side-item", { hasText: "Test iPhone" });
  await expect(renamed).toBeVisible();

  // Device menu: rename via menu (empty name resets), show only, export, delete.
  await renamed.click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Rename…" }).click();
  await page.locator("input.rename").fill("");
  await page.locator("input.rename").press("Enter");
  const byIp = page.locator(".side-section", { hasText: "Devices" }).locator(".side-item", { hasText: "192.168.1.40" });
  await expect(byIp).toBeVisible();
  await byIp.click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Show only this device" }).click();
  await expect(paths(page)).toHaveText(["/item/1", "/item/2"]);
  await page.locator(".sidebar .side-item", { hasText: "All" }).first().click();
  const out = join(sniffo.dataDir, "device.har");
  await sniffo.dialog(out);
  await byIp.click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Export as HAR…" }).click();
  await expect(page.locator(".toast")).toHaveText(`Saved 2 flows to ${out}`);
  expect(existsSync(out)).toBe(true);
  await byIp.click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Delete its flows" }).click();
  await expect(paths(page)).toHaveText(["/from-node", "/unresolved", "/during-rename"]);
  await expect(page.locator(".side-section", { hasText: "Devices" })).toContainText("Phones using this proxy appear here");
});
