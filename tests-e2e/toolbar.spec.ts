// Launch, Start/Stop, system proxy, certificate, VPN helper, status bar.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const macos = process.platform === "darwin";

// A logout, `kill` or a `tauri dev` rebuild ends the app with a signal, not a normal quit: the
// system proxy must still be put back, or the machine is left pointing at a dead proxy.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`${sig} restores the system proxy before exiting`, async ({ sniffo }) => {
    test.skip(process.platform === "win32", "POSIX signals");
    const { page } = sniffo;
    await expect(page.locator(".statusbar")).toContainText("System proxy On");
    const snapshot = join(sniffo.dataDir, "system-proxy-snapshot.json");
    expect(existsSync(snapshot)).toBe(true);
    const before = readFileSync(join(sniffo.fakesDir, "calls.log"), "utf8").length;
    await page.goto("about:blank"); // the UI would only report the backend going away
    expect(await sniffo.signal(sig)).toBe(0);
    expect(existsSync(snapshot)).toBe(false);
    const after = readFileSync(join(sniffo.fakesDir, "calls.log"), "utf8").slice(before);
    expect(after).toContain(macos ? "networksetup -setwebproxy Wi-Fi corp.proxy 3128" : "gsettings set org.gnome.system.proxy mode none");
  });
}

test("launch starts the proxy and takes over the system proxy", async ({ sniffo }) => {
  const { page, port } = sniffo;
  const bar = page.locator(".statusbar");
  await expect(bar).toContainText("System proxy On");
  await expect(bar).toContainText("Certificate Not trusted");
  await expect(bar).toContainText("SSL proxying 0 hosts");
  await expect(bar).toContainText("Rules 0 active");
  await expect(bar).toContainText("0 / 0 flows");
  await expect(page.locator(".toolbar .dot.on")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.locator(".detail.empty")).toContainText(`Set your HTTP/HTTPS proxy to 127.0.0.1:${port}`);
  const status = await sniffo.call("proxy_status");
  if (status.lan[0]) {
    await expect(page.locator(".toolbar .lan")).toHaveText(`📱 ${status.lan[0].ip}:${port}`);
    await expect(bar).toContainText(`LAN ${status.lan[0].ip}:${port}`);
  }
  expect(await sniffo.osCalls()).toContain(macos ? `networksetup -setwebproxy Wi-Fi 127.0.0.1 ${port}` : "gsettings set org.gnome.system.proxy mode manual");
});

test("stop restores the system proxy, start brings the proxy back", async ({ sniffo }) => {
  const { page, port } = sniffo;
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".statusbar")).toContainText("Proxy stopped");
  await expect(page.locator(".statusbar")).toContainText("System proxy Off");
  await expect(page.locator(".detail.empty")).toHaveText("Start the proxy to capture traffic");
  await expect(page.getByLabel("System proxy")).toBeDisabled();
  await expect(page.locator(".toolbar .lan")).toHaveCount(0);
  expect(await sniffo.osCalls()).toContain(macos ? "networksetup -setwebproxy Wi-Fi corp.proxy 3128" : "gsettings set org.gnome.system.proxy mode none");
  await expect(sniffo.get("/json")).rejects.toThrow();

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".statusbar")).toContainText(`Proxy 127.0.0.1:${port}`);
  expect((await sniffo.get("/json")).status).toBe(200);
});

test("system proxy checkbox", async ({ sniffo }) => {
  const { page } = sniffo;
  const box = page.getByLabel("System proxy");
  await expect(box).toBeChecked();
  // Controlled by the backend state: it flips once the OS change is done.
  await box.click();
  await expect(box).not.toBeChecked();
  await expect(page.locator(".statusbar")).toContainText("System proxy Off");
  expect((await sniffo.call("proxy_status")).system_proxy).toBe(false);
  await box.click();
  await expect(box).toBeChecked();
  await expect(page.locator(".statusbar")).toContainText("System proxy On");
  expect((await sniffo.call("proxy_status")).system_proxy).toBe(true);
});

test("a start failure is shown in the banner", async ({ sniffo }) => {
  const { page, port } = sniffo;
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  const squatter = createServer().listen(port, "0.0.0.0");
  await new Promise((ok) => squatter.once("listening", ok));
  try {
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.locator(".banner")).toContainText(`cannot listen on port ${port}`);
  } finally {
    squatter.close();
  }
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".banner")).toHaveCount(0);
  await expect(page.locator(".statusbar")).toContainText(`Proxy 127.0.0.1:${port}`);
});

test("trusting the certificate from the toolbar warning", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.fake("trusted/0");
  await page.getByRole("button", { name: "Certificate not trusted" }).click();
  const modal = page.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Settings");
  await expect(modal).toContainText(sniffo.caPath);
  await expect(modal).toContainText("Status: not trusted");

  // The OS prompt cancelled: the error is shown, nothing changes.
  await sniffo.fake("deny/1");
  await modal.getByRole("button", { name: "Install & trust…" }).click();
  await expect(modal.locator("p.muted").last()).toContainText(macos ? "User canceled" : "pkexec");
  await sniffo.fake("deny/0");

  await modal.getByRole("button", { name: "Install & trust…" }).click();
  await expect(modal).toContainText("Certificate installed");
  await expect(modal).toContainText("Status: trusted by this system");
  await expect(page.locator(".statusbar")).toContainText("Certificate Trusted");
  await expect(page.getByRole("button", { name: "Certificate not trusted" })).toHaveCount(0);
  expect(await sniffo.osCalls()).toContain(macos ? `security add-trusted-cert -r trustRoot -p ssl -k` : "pkexec sh -c");

  await modal.getByRole("button", { name: "Show in folder" }).click();
  expect(await sniffo.uiCalls("reveal_ca")).toHaveLength(1);
});

/** Turns the system proxy off and on again (re-evaluating the VPN state). */
async function reapply(page: import("@playwright/test").Page, before?: () => Promise<void>) {
  const box = page.getByLabel("System proxy");
  await box.click();
  await expect(box).not.toBeChecked();
  await before?.();
  await box.click();
  await expect(box).toBeChecked();
}

test.describe("VPN overriding the system proxy (macOS)", () => {
  test.skip(!macos, "VPN proxy entries are a macOS concept");

  test("routed through the helper, and a helper failure", async ({ sniffo }) => {
    const { page } = sniffo;
    await reapply(page, () => sniffo.fake("proxy/10.0.0.1:8080"));
    const routed = page.locator(".statusbar .item.ok", { hasText: "VPN routed" });
    const missing = page.getByRole("button", { name: "VPN bypasses Sniffo — Install helper…" });
    await expect(routed.or(missing)).toBeVisible();
    if (await missing.isVisible()) return; // machine without the helper: covered by the next test

    await reapply(page, async () => { await sniffo.fake("proxy/10.0.0.1:8080"); await sniffo.fake("deny/1"); });
    const failed = page.locator(".statusbar .item.err", { hasText: "VPN routing failed" });
    await expect(failed).toBeVisible();
    await expect(failed).toHaveAttribute("title", /password is required/);
    await sniffo.fake("deny/0");
  });

  test("helper missing: install it from the status bar", async ({ sniffo }) => {
    const { page } = sniffo;
    // Whether the helper is installed is a property of this machine: pretend it isn't.
    let missing = true;
    await page.route("**/invoke/proxy_status", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (missing) body.ok.vpn = { state: "helper_missing" };
      await route.fulfill({ response, json: body });
    });
    await reapply(page);
    const install = page.getByRole("button", { name: "VPN bypasses Sniffo — Install helper…" });
    await expect(install).toBeVisible();

    await sniffo.fake("deny/1");
    await install.click();
    await expect(page.locator(".banner")).toContainText("User canceled");
    await sniffo.fake("deny/0");

    missing = false;
    await install.click();
    await expect(page.locator(".toast")).toHaveText("VPN helper installed");
    expect(await sniffo.osCalls()).toContain("with administrator privileges");
    await expect(install).toHaveCount(0);
  });
});
