// WebSocket frames: list, inspect, inject in both directions, breakpoints on frames.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { wsConnect } from "./upstream";

const wsRow = (page: Page) => page.locator(".flow-row:not(.head)", { has: page.locator(".c-path", { hasText: "/ws" }) });
const frames = (page: Page) => page.locator(".pane").nth(1).locator(".ws-row");
const until = async <T,>(f: () => T | undefined, what: string) => expect.poll(() => f(), { message: what }).toBeTruthy();

test("frames are listed, inspected and injected both ways", async ({ sniffo }) => {
  const { page } = sniffo;
  const ws = await wsConnect(sniffo.port, sniffo.up.wsPort);
  ws.send('{"op":"subscribe"}');
  await until(() => ws.received.find((f) => f.data.toString() === 'echo:{"op":"subscribe"}'), "echo");
  ws.send(Buffer.from([1, 2, 3]));
  await until(() => ws.received.length >= 2 || undefined, "binary echo");

  const r = wsRow(page);
  await expect(r.locator(".badge", { hasText: /^WS \d+$/ })).toHaveText("WS 4");
  await expect(r.locator(".c-type")).toHaveText("websocket");
  await r.click();
  const pane = page.locator(".pane").nth(1);
  await expect(pane.locator("button.tab.active")).toHaveText("messages");
  await expect(frames(page)).toHaveCount(4);
  await expect(frames(page).nth(0)).toHaveClass(/out/);
  await expect(frames(page).nth(0).locator(".ws-dir")).toHaveText("↑");
  await expect(frames(page).nth(0).locator(".ws-data")).toHaveText('{"op":"subscribe"}');
  await expect(frames(page).nth(1)).toHaveClass(/in/);
  await expect(frames(page).nth(2).locator(".ws-kind")).toHaveText("binary");
  await expect(frames(page).nth(2).locator(".ws-data")).toHaveText("AQID");

  // Expanding a frame shows its body; "Edit & resend" loads it into the composer.
  await frames(page).nth(0).click();
  await expect(pane.locator(".json-tree")).toContainText('op: "subscribe"');
  await pane.getByRole("button", { name: "Edit & resend" }).click();
  const box = pane.locator(".ws-compose textarea");
  await expect(box).toHaveValue('{"op":"subscribe"}');
  await frames(page).nth(0).click();

  // ↑ Server: the server receives it (and echoes).
  await box.fill('{"op":"ping","n":1}');
  await pane.getByRole("button", { name: "{ }" }).click();
  await expect(box).toHaveValue('{\n  "op": "ping",\n  "n": 1\n}');
  await pane.getByRole("button", { name: "Send" }).click();
  await until(() => sniffo.up.wsReceived.find((f) => f.data.toString().includes('"ping"')), "server got injected frame");
  await expect(frames(page).filter({ has: page.locator(".badge", { hasText: "injected" }) })).toHaveCount(1);

  // ↓ Client: the client receives it as if the server sent it (⌘↩ sends).
  await pane.getByRole("button", { name: "↓ Client" }).click();
  await box.fill("hello client");
  await box.press("ControlOrMeta+Enter");
  await until(() => ws.received.find((f) => f.data.toString() === "hello client"), "client got injected frame");

  // Base64 = binary frame; invalid base64 is reported.
  await pane.getByRole("button", { name: "Base64" }).click();
  await expect(pane.getByRole("button", { name: "{ }" })).toHaveCount(0);
  await box.fill("%%%");
  await pane.getByRole("button", { name: "Send" }).click();
  await expect(pane.locator(".ws-compose .err")).toContainText("invalid base64");
  await box.fill("AAEC");
  await pane.getByRole("button", { name: "Send" }).click();
  await until(() => ws.received.find((f) => f.opcode === 2 && f.data.equals(Buffer.from([0, 1, 2]))), "binary to client");
  await expect(pane.locator(".ws-compose .err")).toHaveCount(0);
  // Invalid JSON can't be formatted.
  await pane.getByRole("button", { name: "Text" }).click();
  await box.fill("{oops");
  await pane.getByRole("button", { name: "{ }" }).click();
  await expect(pane.locator(".ws-compose .err")).toContainText("SyntaxError");

  // Frames pushed by the server show up live.
  sniffo.up.wsPush("server says hi");
  await expect(frames(page).filter({ hasText: "server says hi" })).toHaveCount(1);

  // Closed: no composer, and sending is refused.
  ws.close();
  await expect(frames(page).filter({ has: page.locator(".ws-kind", { hasText: "close" }) }).first()).toBeVisible();
  await expect(pane.locator(".ws-compose")).toHaveCount(0);
});

test("breakpoints on frames: edit and forward, or drop", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.call("set_rules", { rules: { rules: [{ id: "b", name: "b", enabled: true, matcher: { url: "*/ws*", regex: false, methods: [] }, action: { type: "breakpoint", request: true, response: true } }], allow_list: { enabled: false, patterns: [] }, no_caching: false } });
  // The upgrade goes through; frames are what pause.
  const ws = await wsConnect(sniffo.port, sniffo.up.wsPort);
  const modal = page.locator(".modal");

  ws.send("original");
  await expect(modal.locator("h3")).toHaveText(/Breakpoint — WebSocket ↑ client → server/);
  await expect(modal.locator("textarea")).toHaveValue("original");
  await modal.locator("textarea").fill("edited");
  await modal.getByRole("button", { name: "Forward" }).click();
  await until(() => sniffo.up.wsReceived.find((f) => f.data.toString() === "edited"), "edited frame at server");
  // Its echo (server → client) is paused too.
  await expect(modal.locator("h3")).toHaveText(/WebSocket ↓ server → client/);
  await modal.getByRole("button", { name: "Drop frame" }).click();
  await expect(modal).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(ws.received.find((f) => f.data.toString() === "echo:edited")).toBeUndefined();

  ws.send(Buffer.from([9, 9]));
  await expect(modal.locator("h3")).toHaveText(/WebSocket ↑/);
  await expect(modal).toContainText("Binary frame (base64)");
  await expect(modal.locator("textarea")).toHaveValue("CQk=");
  await modal.getByRole("button", { name: "Drop frame" }).click();
  await page.waitForTimeout(300);
  expect(sniffo.up.wsReceived.filter((f) => f.opcode === 2)).toHaveLength(0);
});

test("WebSocket to a host with a DNS override set in Settings: connects, recorded, injectable", async ({ sniffo }) => {
  const { page } = sniffo;
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".modal section", { has: page.locator("h4", { hasText: "Upstream proxy" }) }).locator("textarea").fill("127.0.0.1 chat.test");
  await page.locator(".modal").getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);

  const ws = await wsConnect(sniffo.port, sniffo.up.wsPort, "/ws", "chat.test");
  ws.send("via the override");
  await until(() => ws.received.find((f) => f.data.toString() === "echo:via the override"), "echo");
  const r = page.locator(".flow-row:not(.head)", { has: page.locator(".c-host", { hasText: "chat.test" }) });
  await expect(r.locator(".badge", { hasText: /^WS \d+$/ })).toHaveText("WS 2");
  await r.click();
  await expect(frames(page)).toHaveCount(2);
  const pane = page.locator(".pane").nth(1);
  await pane.locator(".ws-compose textarea").fill("injected via relay");
  await pane.getByRole("button", { name: "Send" }).click();
  await until(() => sniffo.up.wsReceived.find((f) => f.data.toString() === "injected via relay"), "server got it");
  ws.close();
});
