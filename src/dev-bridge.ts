// Browser UI tests (tests-e2e): every invoke() goes to the real app behind
// src-tauri/examples/ui_bridge.rs, and its events are replayed here. Never bundled into the app.
// URL: http://localhost:1430/?bridge=http://127.0.0.1:<bridge port>&port=<proxy port>
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";

const params = new URLSearchParams(location.search);
const base = params.get("bridge")!;

/** Steered by the tests: answers for native file dialogs, and every call made. */
const test = {
  dialogs: [] as unknown[],
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
};
(window as unknown as { __sniffoTest: typeof test }).__sniffoTest = test;

mockIPC(async (cmd, payload) => {
  let args = (payload ?? {}) as Record<string, unknown>;
  test.calls.push({ cmd, args });
  if (cmd.startsWith("plugin:dialog|")) return test.dialogs.shift() ?? null;
  // Opens a Finder/Explorer window: covered by the desktop check instead.
  if (cmd === "reveal_ca") return null;
  // The app starts on its default port; tests use their own.
  if (cmd === "start_proxy" && args.port == null) args = { ...args, port: Number(params.get("port")) };
  const r = await fetch(`${base}/invoke/${cmd}`, { method: "POST", body: JSON.stringify(args) });
  if (r.headers.get("content-type") === "application/octet-stream") return r.arrayBuffer();
  const reply = await r.json();
  if ("err" in reply) throw reply.err;
  return reply.ok;
}, { shouldMockEvents: true });

(async () => {
  let since = 0;
  for (;;) {
    try {
      const r = await (await fetch(`${base}/events?since=${since}`)).json();
      since = r.next;
      for (const [name, data] of r.events) await emit(name, data);
    } catch {
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
})();
