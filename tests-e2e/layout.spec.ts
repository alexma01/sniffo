// List layout (columns, resizing, splitter, auto-scroll, virtualisation), toasts, app icons.
import { expect, row, test } from "./fixtures";

test("column picker, resize and reset, persisted", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/json");
  const head = page.locator(".flow-row.head");
  await expect(head.locator(".th")).toHaveText(["#", "Time", "Client", "Method", "Code", "🔒", "Host", "Path", "Protocol", "Type", "Req", "Size", "Duration"]);
  await head.click({ button: "right" });
  const picker = page.locator(".menu .menu-check");
  await expect(picker).toHaveCount(15);
  await picker.filter({ hasText: /^ Host$/ }).locator("input").uncheck();
  await picker.filter({ hasText: /^ TTFB$/ }).locator("input").check();
  await expect(head.locator(".th", { hasText: /^Host$/ })).toHaveCount(0);
  await expect(head.locator(".th", { hasText: /^TTFB$/ })).toHaveCount(1);
  await expect(row(page, "/json").locator(".c-host")).toHaveCount(0);
  await expect(row(page, "/json").locator(".c-ttfb")).toHaveText(/\d+ ms/);
  await page.mouse.click(5, 5);
  await expect(page.locator(".menu")).toHaveCount(0);

  // Drag a header's right edge; double-click it to reset.
  const method = head.locator(".th", { hasText: /^Method$/ });
  const before = (await method.boundingBox())!.width;
  const handle = (await method.locator(".resizer").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 80, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await method.boundingBox())!.width).toBeGreaterThan(before + 60);
  const resized = (await method.boundingBox())!.width;

  await page.reload();
  const head2 = page.locator(".flow-row.head");
  await expect(head2.locator(".th", { hasText: /^Host$/ })).toHaveCount(0);
  await expect(head2.locator(".th", { hasText: /^TTFB$/ })).toHaveCount(1);
  await expect.poll(async () => Math.round((await head2.locator(".th", { hasText: /^Method$/ }).boundingBox())!.width)).toBe(Math.round(resized));
  await head2.locator(".th", { hasText: /^Method$/ }).locator(".resizer").dblclick();
  await expect.poll(async () => Math.round((await head2.locator(".th", { hasText: /^Method$/ }).boundingBox())!.width)).toBe(Math.round(before));
});

test("list/detail splitter is draggable and remembered", async ({ sniffo }) => {
  const { page } = sniffo;
  const list = page.locator(".flow-list");
  const content = (await page.locator(".content").boundingBox())!;
  const split = (await page.locator(".split").boundingBox())!;
  await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2);
  await page.mouse.down();
  await page.mouse.move(split.x + split.width / 2, content.y + content.height * 0.7, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox())!.height / content.height).toBeGreaterThan(0.6);
  // Clamped at 85%.
  await page.mouse.move(split.x + 5, content.y + content.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(split.x + 5, content.y + content.height + 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox())!.height / content.height).toBeLessThan(0.87);
  const h = (await list.boundingBox())!.height;
  await page.reload();
  await expect.poll(async () => Math.round((await page.locator(".flow-list").boundingBox())!.height)).toBe(Math.round(h));
});

test("many flows: virtualised list, auto-scroll and its opt-out", async ({ sniffo }) => {
  const { page } = sniffo;
  await Promise.all(Array.from({ length: 300 }, (_, i) => sniffo.get(`/item/${i}`)));
  await expect(page.locator(".statusbar")).toContainText("300 / 300 flows");
  // Only the visible window is rendered.
  expect(await page.locator(".flow-row:not(.head)").count()).toBeLessThan(120);
  // Auto-scroll keeps the newest flow in view.
  await sniffo.get("/newest");
  await expect(row(page, "/newest")).toBeInViewport();
  // Selecting a flow turns auto-scroll off so the selection stays put.
  await row(page, "/newest").click();
  await expect(page.getByLabel("Auto-scroll")).not.toBeChecked();
  await page.locator(".flow-scroll").evaluate((e) => e.scrollTo(0, 0));
  await sniffo.get("/after-opt-out");
  await expect(page.locator(".statusbar")).toContainText("302 / 302 flows");
  await expect(row(page, "/after-opt-out")).not.toBeInViewport();
  await page.getByLabel("Auto-scroll").check();
  await sniffo.get("/back-on");
  await expect(row(page, "/back-on")).toBeInViewport();
});

test("toasts disappear and totals add up", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/echo", { method: "POST", body: "x".repeat(2048) });
  await row(page, "/echo").click({ button: "right" });
  await page.locator(".menu > div", { hasText: "Copy URL" }).click();
  await expect(page.locator(".toast")).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator(".statusbar")).toContainText("↑ 2.0 KB");
  await expect(row(page, "/echo").locator(".c-reqsize")).toHaveText("2.0 KB");
});

test("real browser traffic shows its app icon (macOS)", async ({ sniffo, browser }) => {
  test.skip(process.platform !== "darwin", "app icons come from macOS bundles");
  const { page } = sniffo;
  // A second browser context whose traffic goes through Sniffo, like a user's browser would.
  const client = await browser.newContext({ proxy: { server: `http://127.0.0.1:${sniffo.port}`, bypass: "<-loopback>" } });
  const tab = await client.newPage();
  await tab.goto(sniffo.url("/html"));
  await expect(tab.locator("h1")).toHaveText("Hello page");
  await client.close();
  const r = row(page, "/html");
  // The client is resolved from the connection: the browser app, not this test process.
  await expect(r.locator(".c-client")).not.toHaveText(/node|This Mac/);
  const name = (await r.locator(".c-client").innerText()).replace(/^[^\p{L}]+/u, "").trim();
  // The icon is extracted from the app bundle (sips) and shown in the list and sidebar.
  await expect(r.locator("img.app-icon")).toBeVisible({ timeout: 20_000 });
  expect(await r.locator("img.app-icon").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(16);
  await expect(page.locator(".side-section", { hasText: "This Mac" }).locator(".side-item", { hasText: name }).locator("img.app-icon")).toBeVisible();
});
