// Settings dialog, SSL Proxying per host (with real HTTPS), upstream proxy, DNS, reverse proxy.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, row, test } from "./fixtures";
import { curlHttps, PROTO_SCHEMA, request, startForwardProxy } from "./upstream";

const open = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  return page.locator(".modal");
};
const section = (page: Page, title: string) => page.locator(".modal section", { has: page.locator("h4", { hasText: title }) });
const save = (page: Page) => page.locator(".modal").getByRole("button", { name: "Save" }).click();
const freePort = async () => {
  const { createServer } = await import("node:net");
  return new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
};

test("port change restarts the proxy; auto system proxy is saved", async ({ sniffo }) => {
  const { page } = sniffo;
  const m = await open(page);
  const port = await freePort();
  await section(page, "Proxy").getByLabel("Port").fill(String(port));
  await section(page, "Proxy").getByLabel(/Enable the system proxy automatically/).uncheck();
  await expect.poll(async () => (await sniffo.call("proxy_status")).auto_system_proxy).toBe(false);
  await save(page);
  await expect(m).toHaveCount(0);
  await expect(page.locator(".statusbar")).toContainText(`Proxy 127.0.0.1:${port}`);
  expect((await request(port, "GET", sniffo.url("/json"))).status).toBe(200);
  // The OS proxy follows the new port.
  if (process.platform === "darwin") expect(await sniffo.osCalls()).toContain(`networksetup -setwebproxy Wi-Fi 127.0.0.1 ${port}`);

  // Cancel and the backdrop discard edits.
  await open(page);
  await section(page, "Proxy").getByLabel("Port").fill("1");
  await page.locator(".modal").getByRole("button", { name: "Cancel" }).click();
  await open(page);
  await expect(section(page, "Proxy").getByLabel("Port")).toHaveValue(String(port));
  await page.locator(".modal-back").click({ position: { x: 3, y: 3 } });
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("SSL Proxying per host: tunnel, enable, decrypt, disable", async ({ sniffo }) => {
  const { page } = sniffo;
  const url = `${sniffo.up.https}/json`;
  // Not enabled: an untouched tunnel (the client sees the server's own certificate).
  await curlHttps(sniffo.port, url, null);
  const tunnel = page.locator(".flow-row:not(.head)", { has: page.locator(".c-method", { hasText: "CONNECT" }) });
  await expect(tunnel.locator(".badge.ssl-off")).toHaveText("🔒 Enable SSL Proxying");
  await tunnel.click();
  const banner = page.locator(".ssl-banner");
  await expect(banner).toContainText("SSL Proxying is not enabled for localhost");
  await expect(banner.getByRole("button")).toHaveCount(1); // no parent domain to wildcard
  await expect(page.locator(".pane")).toHaveCount(1); // request pane only

  // The inline badge enables the host.
  await tunnel.locator(".badge.ssl-off").click();
  await expect(page.locator(".toast")).toHaveText("SSL Proxying enabled for localhost — retry the request to see it decrypted");
  expect((await sniffo.call("get_ssl_proxying")).include).toEqual(["localhost"]);
  await expect(page.locator(".statusbar")).toContainText("SSL proxying 1 hosts");
  await expect(page.locator(".sidebar .side-item", { hasText: "localhost" }).locator(".lock")).toHaveText("🔓");

  // Decrypted now; the self-signed upstream is refused until its errors are ignored.
  const refused = await curlHttps(sniffo.port, url, sniffo.caPath);
  expect(refused.status).toBe(502);
  await open(page);
  await section(page, "Upstream proxy").getByLabel(/Ignore upstream certificate errors/).check();
  await save(page);
  await expect(page.locator(".modal")).toHaveCount(0);
  const ok = await curlHttps(sniffo.port, url, sniffo.caPath);
  expect([ok.status, JSON.parse(ok.body).total]).toEqual([200, 1]);
  const decrypted = page.locator(".flow-row:not(.head)", { has: page.locator(".c-status", { hasText: "200" }) }).filter({ hasText: "/json" });
  await expect(decrypted.locator(".c-tls")).toHaveText("🔒");
  await decrypted.click();
  await expect(page.locator(".pane").nth(1).locator(".json-tree")).toContainText("total: 1");

  // "Decrypted · disable" in the detail header turns it off again.
  await page.locator(".detail-url").getByRole("button", { name: "🔓 Decrypted · disable" }).click();
  await expect(page.locator(".toast")).toHaveText("SSL Proxying disabled for localhost");
  expect((await sniffo.call("get_ssl_proxying")).include).toEqual([]);
  await expect(page.locator(".sidebar .side-item", { hasText: "localhost" }).locator(".lock")).toHaveText("🔒");

  // Sidebar lock and context menus toggle it too.
  await page.locator(".sidebar .side-section", { hasText: "Domains" }).locator(".side-item", { hasText: "localhost" }).locator(".lock").click();
  await expect.poll(async () => (await sniffo.call("get_ssl_proxying")).include).toEqual(["localhost"]);
  await decrypted.click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Disable SSL Proxying for localhost" }).click();
  await expect.poll(async () => (await sniffo.call("get_ssl_proxying")).include).toEqual([]);
  await tunnel.click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Enable SSL Proxying for localhost" }).click();
  await expect.poll(async () => (await sniffo.call("get_ssl_proxying")).include).toEqual(["localhost"]);
  await page.locator(".sidebar .side-section", { hasText: "Domains" }).locator(".side-item", { hasText: "localhost" }).click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Disable SSL Proxying for localhost" }).click();
  await expect.poll(async () => (await sniffo.call("get_ssl_proxying")).include).toEqual([]);
});

test("wildcards, excludes, and SSL Proxying switched off", async ({ sniffo }) => {
  const { page } = sniffo;
  const port = new URL(sniffo.up.https).port;
  let m = await open(page);
  await section(page, "Upstream proxy").locator("textarea").fill("127.0.0.1 api.example.test");
  await save(page);
  await expect(m).toHaveCount(0);
  await curlHttps(sniffo.port, `https://api.example.test:${port}/json`, null);
  await page.locator(".flow-row:not(.head)", { hasText: "api.example.test" }).click();
  await page.locator(".ssl-banner").getByRole("button", { name: "Enable for *.example.test" }).click();
  await expect.poll(async () => (await sniffo.call("get_ssl_proxying")).include).toEqual(["*.example.test"]);
  // Disabling one host under a wildcard excludes it (exclude wins).
  await page.locator(".sidebar .side-section", { hasText: "Domains" }).locator(".side-item", { hasText: "api.example.test" }).locator(".lock").click();
  await expect.poll(async () => sniffo.call("get_ssl_proxying")).toEqual({ enabled: true, include: ["*.example.test"], exclude: ["api.example.test"] });
  await expect(page.locator(".statusbar")).toContainText("SSL proxying 1 hosts (−1)");

  // Edit the lists in Settings; "*" means every host.
  m = await open(page);
  const ssl = section(page, "SSL proxying");
  await expect(ssl.locator("textarea").nth(0)).toHaveValue("*.example.test");
  await expect(ssl.locator("textarea").nth(1)).toHaveValue("api.example.test");
  await ssl.locator("textarea").nth(0).fill("*\n  \n");
  await ssl.locator("textarea").nth(1).fill("*.apple.com\nbank.test");
  await save(page);
  await expect.poll(async () => sniffo.call("get_ssl_proxying")).toEqual({ enabled: true, include: ["*"], exclude: ["*.apple.com", "bank.test"] });
  await expect(page.locator(".statusbar")).toContainText("SSL proxying All hosts (−2)");

  await open(page);
  await section(page, "SSL proxying").getByLabel("Decrypt HTTPS traffic").uncheck();
  await save(page);
  await expect(page.locator(".statusbar")).toContainText("SSL proxying Off");
  await curlHttps(sniffo.port, `${sniffo.up.https}/off`, null);
  const tunnel = page.locator(".flow-row:not(.head)", { has: page.locator(".c-method", { hasText: "CONNECT" }) }).filter({ hasText: "localhost" });
  await tunnel.locator(".badge.ssl-off").click();
  await expect(page.locator(".toast")).toHaveText("SSL Proxying enabled for localhost (SSL Proxying is off in Settings)");
});

test("upstream proxy, with credentials, and invalid settings", async ({ sniffo }) => {
  const { page } = sniffo;
  const corp = await startForwardProxy("alice:s3cret");
  try {
    let m = await open(page);
    const up = section(page, "Upstream proxy");
    await up.getByLabel(/Send traffic through another proxy/).check();
    // Saving without a host is refused and changes nothing.
    await save(page);
    await expect(m.locator("p.muted").last()).toContainText("upstream proxy: enter its host");
    await expect(page.locator(".statusbar")).toContainText(`Proxy 127.0.0.1:${sniffo.port}`);
    expect((await sniffo.call("get_network")).upstream).toBeNull();
    expect((await sniffo.get("/still-direct")).status).toBe(200);

    await up.getByLabel("Type").selectOption("http");
    await up.getByLabel("Host").fill("127.0.0.1");
    await up.locator("label", { hasText: /^Port/ }).locator("input").fill(String(corp.port));
    await up.getByPlaceholder("user").fill("alice");
    await up.getByPlaceholder("pass").fill("s3cret");
    await save(page);
    await expect(m).toHaveCount(0);
    expect((await sniffo.call("get_network")).upstream).toEqual({ kind: "http", host: "127.0.0.1", port: corp.port, username: "alice", password: "s3cret" });
    expect((await sniffo.get("/via-corp")).status).toBe(200);
    expect(corp.connects).toEqual([new URL(sniffo.up.http).host]);

    // Off again: direct.
    m = await open(page);
    await section(page, "Upstream proxy").getByLabel(/Send traffic through another proxy/).uncheck();
    await save(page);
    await expect(m).toHaveCount(0);
    expect((await sniffo.get("/direct-again")).status).toBe(200);
    expect(corp.connects).toHaveLength(1);
  } finally {
    await corp.close();
  }
});

test("DNS overrides", async ({ sniffo }) => {
  const { page } = sniffo;
  const m = await open(page);
  await section(page, "Upstream proxy").locator("textarea").fill("127.0.0.1 myapp.test\nnot-a-line\n");
  await save(page);
  await expect(m).toHaveCount(0);
  expect((await sniffo.call("get_network")).dns).toEqual([["myapp.test", "127.0.0.1"]]);
  const r = await request(sniffo.port, "GET", `http://myapp.test:${new URL(sniffo.up.http).port}/json`);
  expect(r.status).toBe(200);
  await expect(page.locator(".flow-row:not(.head) .c-host")).toHaveText(["myapp.test"]);

  await open(page);
  await expect(section(page, "Upstream proxy").locator("textarea")).toHaveValue("127.0.0.1 myapp.test");
  await section(page, "Upstream proxy").locator("textarea").fill("999.1.1.1 bad.test");
  await save(page);
  await expect(page.locator(".modal p.muted").last()).toContainText("not an IP address");
  expect((await sniffo.call("get_network")).dns).toEqual([["myapp.test", "127.0.0.1"]]);
});

test("protobuf schema files", async ({ sniffo }) => {
  const { page } = sniffo;
  const good = join(sniffo.dataDir, "user.proto");
  const other = join(sniffo.dataDir, "order.proto");
  const broken = join(sniffo.dataDir, "broken.proto");
  writeFileSync(good, PROTO_SCHEMA);
  writeFileSync(other, 'syntax = "proto3"; package shop; message Order { int64 id = 1; }');
  writeFileSync(broken, "message {");
  await open(page);
  const proto = section(page, "Protobuf schemas");
  await sniffo.dialog([good, other]);
  await proto.getByRole("button", { name: "Add schema files…" }).click();
  await expect(proto).toContainText("2 message types");
  const files = proto.locator(".row code");
  await expect(files).toHaveText([good, other]);
  // Adding the same file again doesn't duplicate it.
  await sniffo.dialog(good);
  await proto.getByRole("button", { name: "Add schema files…" }).click();
  await expect(files).toHaveCount(2);
  await sniffo.dialog([broken]);
  await proto.getByRole("button", { name: "Add schema files…" }).click();
  await expect(page.locator(".modal p.muted").last()).toContainText("broken.proto");
  await expect(files).toHaveCount(2);
  await proto.locator(".row", { hasText: other }).getByRole("button", { name: "✕" }).click();
  await expect(files).toHaveText([good]);
  await expect(proto).toContainText("1 message types");
  expect(await sniffo.call("get_proto_schemas")).toEqual({ files: [good], messages: ["demo.User"] });
  await sniffo.dialog(null);
  await proto.getByRole("button", { name: "Add schema files…" }).click();
  await expect(files).toHaveCount(1);
});

test("reverse proxies", async ({ sniffo }) => {
  const { page } = sniffo;
  const rp = await freePort();
  await open(page);
  const rev = section(page, "Reverse proxy");
  await rev.getByRole("button", { name: "Add reverse proxy" }).click();
  const entry = rev.locator(".row").first();
  await expect(entry.locator("input.input").first()).toHaveValue("9300");
  await expect(entry.locator("input.input").nth(1)).toHaveValue("http://localhost:3000");
  await entry.locator("input.input").first().fill(String(rp));
  await entry.locator("input.input").nth(1).fill(sniffo.up.http);
  await save(page);
  await expect(page.locator(".modal")).toHaveCount(0);
  const r = await fetch(`http://127.0.0.1:${rp}/json?via=reverse`);
  expect(r.status).toBe(200);
  await expect(row(page, "/json?via=reverse")).toBeVisible();

  // Entries on a busy port or on the proxy's own port report errors; the dialog stays open.
  const { createServer } = await import("node:net");
  const squatter = createServer().listen(0, "127.0.0.1");
  await new Promise((ok) => squatter.once("listening", ok));
  const busy = (squatter.address() as { port: number }).port;
  try {
    await open(page);
    await rev.getByRole("button", { name: "Add reverse proxy" }).click();
    await rev.locator(".row").nth(1).locator("input.input").first().fill(String(busy));
    await rev.getByRole("button", { name: "Add reverse proxy" }).click();
    await rev.locator(".row").nth(2).locator("input.input").first().fill(String(sniffo.port));
    await save(page);
    await expect(page.locator(".modal")).toContainText("Some reverse proxies failed to start");
    await expect(rev.locator(".row").nth(1).locator(".err")).toContainText(`port ${busy}`);
    await expect(rev.locator(".row").nth(2).locator(".err")).toContainText("it's the proxy's own port");
    expect((await sniffo.get("/proxy-unaffected")).status).toBe(200);
  } finally {
    squatter.close();
  }
  await rev.locator(".row").nth(2).getByRole("button", { name: "✕" }).click();
  await rev.locator(".row").nth(1).getByRole("button", { name: "✕" }).click();
  // Disabled entries are kept but not started.
  await rev.locator(".row").first().locator("input[type=checkbox]").uncheck();
  await save(page);
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(await sniffo.call("get_reverse")).toEqual([{ enabled: false, port: rp, target: sniffo.up.http }]);
  // Saving after a refused entry never leaves the main proxy stopped.
  await expect(page.locator(".statusbar")).toContainText(`Proxy 127.0.0.1:${sniffo.port}`);
  expect((await sniffo.get("/proxy-alive")).status).toBe(200);
  await expect(fetch(`http://127.0.0.1:${rp}/`)).rejects.toThrow();
});
