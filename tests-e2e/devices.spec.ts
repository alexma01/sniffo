// Devices dialog: iOS / Android tabs, each split into simulators (emulators) and physical devices,
// driven through (fake) xcrun and adb; Wi-Fi setup under physical devices.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const macos = process.platform === "darwin";
const open = async (page: Page) => {
  await page.locator(".toolbar .lan").click();
  const m = page.locator(".modal");
  await expect(m.locator("h3")).toHaveText("Devices");
  return m;
};
const tab = (m: ReturnType<Page["locator"]>, name: string) => m.getByRole("button", { name, exact: true }).click();
const item = (page: Page, name: string) => page.locator(".dev-item", { hasText: name });
const log = (page: Page) => page.locator(".dev-log > div");

test("android emulator, unauthorized phone and AVD", async ({ sniffo }) => {
  const { page, port } = sniffo;
  const m = await open(page);
  await tab(m, "Android");
  await expect(item(page, "sdk gphone64 arm64")).toContainText("Android · Android 15 · device");
  await expect(item(page, "R58N123")).toHaveCount(0); // physical: other sub-tab
  await expect(item(page, "Medium Phone")).toContainText("Android emulator (off)");
  await expect(item(page, "sdk gphone64 arm64").locator(".dot")).toHaveClass(/on/);
  await expect(item(page, "Medium Phone").locator(".dot")).toHaveClass(/off/);

  await item(page, "sdk gphone64 arm64").click();
  const actions = m.locator(".dev-actions button");
  await expect(actions).toHaveText(["Set proxy (adb reverse)", "Remove proxy", "Install CA (user)", "Install CA (system)", "Reboot", "Stop emulator"]);
  await expect(m.getByRole("button", { name: "Install CA (system)" })).toHaveAttribute("title", /Google APIs image/);
  await expect(m).toContainText(`tunnels the device's 127.0.0.1:${port} to this computer`);
  const expectations: [string, string, string][] = [
    ["Set proxy (adb reverse)", `Proxy set to 127.0.0.1:${port} via adb reverse`, `adb -s emulator-5554 reverse tcp:${port} tcp:${port}`],
    ["Remove proxy", "Proxy removed", "adb -s emulator-5554 shell settings put global http_proxy :0"],
    ["Install CA (user)", "Certificate copied to Downloads", "adb -s emulator-5554 push"],
    ["Install CA (system)", "CA trusted system-wide", "adb -s emulator-5554 root"],
    ["Reboot", "Rebooting device", "adb -s emulator-5554 reboot"],
    ["Stop emulator", "Emulator stopped", "adb -s emulator-5554 emu kill"],
  ];
  for (const [label, result, call] of expectations) {
    await m.getByRole("button", { name: label, exact: true }).click();
    await expect(log(page).first()).toHaveText(new RegExp(`^✓ sdk gphone64 arm64: ${result.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(await sniffo.osCalls()).toContain(call);
  }
  await m.locator(".row input.input").fill("https://example.com/deep");
  await m.getByRole("button", { name: "Open URL" }).click();
  await expect(log(page).first()).toHaveText("✓ sdk gphone64 arm64: Opened https://example.com/deep");
  expect(await sniffo.osCalls()).toContain("adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d https://example.com/deep");

  await item(page, "Medium Phone").click();
  await expect(actions).toHaveText(["Start emulator"]);
  await expect(m.locator(".row input.input")).toHaveCount(0); // not running: no Open URL
  await actions.click();
  await expect(log(page).first()).toHaveText("✓ Medium Phone: Starting Medium Phone…");
  await expect.poll(() => sniffo.osCalls()).toContain("emulator -avd Medium_Phone");

  await tab(m, "Physical devices");
  await expect(item(page, "sdk gphone64 arm64")).toHaveCount(0);
  // No OS version until authorized: no empty "· ·" in between.
  await expect(item(page, "R58N123").locator(".muted")).toHaveText("Android · unauthorized");
  await item(page, "R58N123").click();
  await expect(m).toContainText("Accept the “Allow USB debugging” prompt on the device.");
  await expect(actions).toHaveCount(0);
  await expect(m).toContainText("2. Android");
  await expect(m).not.toContainText("2. iPhone / iPad");

  await m.getByRole("button", { name: "Close" }).click();
  await expect(m).toHaveCount(0);
});

test("a failing device command is logged as an error", async ({ sniffo }) => {
  const { page } = sniffo;
  // The device disappears between listing and acting on it.
  await page.route("**/invoke/device_command", (route) => route.fulfill({ json: { err: "device not found (disconnected?)" }, headers: { "access-control-allow-origin": "*" } }));
  const m = await open(page);
  await tab(m, "Android");
  await item(page, "sdk gphone64 arm64").click();
  await m.getByRole("button", { name: "Reboot" }).click();
  await expect(log(page).first()).toHaveText("✗ sdk gphone64 arm64 — Reboot: device not found (disconnected?)");
  await expect(log(page).first()).toHaveClass(/err/);
  await expect(m.getByRole("button", { name: "Reboot" })).toBeEnabled();
});

test.describe("iOS (macOS)", () => {
  test.skip(!macos, "simulators and devicectl are macOS-only");

  test("simulator and physical iPhone", async ({ sniffo }) => {
    const { page } = sniffo;
    const m = await open(page);
    // iOS is the default tab on macOS; the booted simulator is selected first.
    await expect(item(page, "sdk gphone64 arm64")).toHaveCount(0);
    await expect(m.locator(".dev-item.active")).toContainText("iPhone 18 Pro");
    await expect(item(page, "iPhone 18 Pro")).toContainText("iOS Simulator · iOS 27.0");
    await expect(m.locator(".dev-actions button")).toHaveText(["Install & trust CA", "Restart", "Shut down"]);
    await m.getByRole("button", { name: "Install & trust CA" }).click();
    await expect(log(page).first()).toHaveText("✓ iPhone 18 Pro: CA installed and trusted in the simulator");
    expect(await sniffo.osCalls()).toContain(`xcrun simctl keychain SIM-BOOTED add-root-cert ${sniffo.caPath}`);
    await m.getByRole("button", { name: "Restart" }).click();
    await expect(log(page).first()).toHaveText("✓ iPhone 18 Pro: Simulator restarted");
    await m.locator(".row input.input").fill("https://example.com/sim");
    await m.getByRole("button", { name: "Open URL" }).click();
    await expect(log(page).first()).toHaveText("✓ iPhone 18 Pro: Opened https://example.com/sim");
    await m.getByRole("button", { name: "Shut down" }).click();
    await expect(log(page).first()).toHaveText("✓ iPhone 18 Pro: Simulator shut down");

    await item(page, "iPad Air").click();
    await expect(m.locator(".dev-actions button")).toHaveText(["Boot"]);
    await m.getByRole("button", { name: "Boot" }).click();
    await expect(log(page).first()).toHaveText("✓ iPad Air: Simulator booted");
    expect(await sniffo.osCalls()).toContain("open -a Simulator");

    await tab(m, "Physical devices");
    await expect(item(page, "iPhone 18 Pro")).toHaveCount(0);
    await item(page, "Test iPhone").click();
    await expect(m).toContainText("iPhone / iPad · iOS 26.1 · connected (USB)");
    await expect(m).toContainText("Connected. iOS doesn't let a computer change an iPhone's proxy");
    await expect(m.locator("h4", { hasText: "Over Wi-Fi" })).toBeVisible();
  });
});

test("Wi-Fi setup: LAN toggle, address, QR code", async ({ sniffo }) => {
  const { page, port } = sniffo;
  const m = await open(page);
  await tab(m, "Android");
  await tab(m, "Physical devices");
  const status = await sniffo.call("proxy_status");
  const lan = m.getByLabel(/Allow devices on the local network/);
  await expect(lan).toBeChecked();
  if (status.lan.length) {
    const ip = status.lan[0].ip;
    await expect(m.locator("tr", { hasText: "Port" }).locator(".v")).toHaveText(String(port));
    await expect(m.locator(".qr code")).toHaveText(`http://${ip}:${port}/`);
    const qr = m.locator(".qr img");
    await expect(qr).toHaveAttribute("src", /^data:image\/png;base64,/);
    expect(await qr.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
    // The certificate page the QR opens is really served on that address.
    const page2 = await (await fetch(`http://${ip}:${port}/`)).text();
    expect(page2).toContain("Sniffo");
    if (status.lan.length > 1) {
      const other = status.lan[1].ip;
      await m.locator(".kv select").selectOption(other);
      await expect(m.locator(".qr code")).toHaveText(`http://${other}:${port}/`);
    }
  } else {
    await expect(m).toContainText("No network address found");
  }
  // LAN off: loopback only, setup steps hidden; on again.
  await lan.click();
  await expect(lan).not.toBeChecked();
  await expect(m).toContainText("Enable LAN access to proxy traffic from other devices.");
  expect((await sniffo.call("proxy_status")).allow_lan).toBe(false);
  await expect(page.locator(".toolbar .lan")).toHaveText(/^\s*Devices$/);
  expect((await sniffo.get("/still-local")).status).toBe(200);
  await lan.click();
  await expect(lan).toBeChecked();
  expect((await sniffo.call("proxy_status")).allow_lan).toBe(true);
});
