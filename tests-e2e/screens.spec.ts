// Every screen in light and dark: no horizontal overflow, nothing outside the window, and a
// screenshot in target/screens for visual review.
import type { Page } from "@playwright/test";
import { expect, row, test } from "./fixtures";
import { wsConnect } from "./upstream";

async function fits(page: Page, name: string, scheme: string) {
  const overflow = await page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    for (const el of document.querySelectorAll<HTMLElement>(".modal, .menu, .toast, .toolbar, .statusbar, .filterbar")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1)) out.push(`${el.className} outside the window: ${JSON.stringify(r)}`);
    }
    return out;
  });
  expect(overflow, name).toEqual([]);
  await page.screenshot({ path: `target/screens/${scheme}/${name}.png` });
}

for (const scheme of ["light", "dark"] as const) {
  test(`screens (${scheme})`, async ({ sniffo }) => {
    const { page } = sniffo;
    await page.emulateMedia({ colorScheme: scheme });
    for (const p of ["/json?page=2", "/xml", "/image.png", "/status/404", "/status/500"]) await sniffo.get(p);
    await sniffo.get("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: '{"query":"query Q { a }"}' });
    const ws = await wsConnect(sniffo.port, sniffo.up.wsPort);
    ws.send('{"hello":"world"}');
    await fits(page, "01-list", scheme);
    await row(page, "/json").click();
    await fits(page, "02-detail-json", scheme);
    await row(page, "/ws").click();
    await fits(page, "03-detail-websocket", scheme);
    await row(page, "/xml").click({ button: "right" });
    await fits(page, "04-context-menu", scheme);
    await page.keyboard.press("Escape");
    await page.locator(".sidebar .side-section", { hasText: "Domains" }).locator(".side-item").first().click({ button: "right" });
    await fits(page, "05-sidebar-menu", scheme);
    await page.mouse.click(700, 500);
    await page.locator(".flow-row.head").click({ button: "right" });
    await fits(page, "06-column-picker", scheme);
    await page.mouse.click(700, 500);
    for (const [button, name] of [["Compose", "07-compose"], ["Rules", "08-rules"], ["Settings", "09-settings"]] as const) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await fits(page, name, scheme);
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Add rule" }).click();
    for (const action of ["Map Local", "Map Remote", "Throttle", "Script"]) {
      await page.locator(".modal").getByLabel("Action").selectOption({ label: action });
      await fits(page, `10-rule-${action.toLowerCase().replace(" ", "-")}`, scheme);
    }
    await page.keyboard.press("Escape");
    await page.locator(".toolbar .lan").click();
    await expect(page.locator(".dev-item").first()).toBeVisible();
    await fits(page, "11-devices", scheme);
    await page.getByRole("button", { name: "Wi-Fi device (manual)" }).click();
    await fits(page, "12-devices-wifi", scheme);
    await page.keyboard.press("Escape");
    await sniffo.call("set_rules", { rules: { rules: [{ id: "b", name: "b", enabled: true, matcher: { url: "*/held", regex: false, methods: [] }, action: { type: "breakpoint", request: true, response: false } }], allow_list: { enabled: false, patterns: [] }, no_caching: false } });
    const held = sniffo.get("/held");
    await expect(page.locator(".modal h3")).toContainText("Breakpoint");
    await fits(page, "13-breakpoint", scheme);
    await page.locator(".modal").getByRole("button", { name: "Execute" }).click();
    await held;
    await page.locator(".statusbar button", { hasText: /^Console/ }).click();
    await fits(page, "14-console", scheme);
    // Narrow window: still usable, nothing spills out.
    await page.setViewportSize({ width: 1024, height: 680 });
    await page.getByRole("button", { name: "Settings" }).click();
    await fits(page, "15-narrow-settings", scheme);
    ws.close();
  });
}
