import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// macOS app window: the title bar is hidden and the traffic lights sit inside the toolbar (tauri.conf.json).
// Checked before the dev mocks below, which fake __TAURI_INTERNALS__ in a plain browser.
if ("__TAURI_INTERNALS__" in window && navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac-titlebar");

// No native WebView menu (Reload / Inspect Element): our own menus call preventDefault themselves,
// text fields keep copy/paste, and dev builds keep Inspect.
if (!import.meta.env.DEV) {
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as Element).closest?.("input, textarea, [contenteditable]")) e.preventDefault();
  });
}

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  if (new URLSearchParams(location.search).has("bridge")) await import("./dev-bridge");
  else await import("./dev-mock");
}

const params = new URLSearchParams(location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
const Root = import.meta.env.DEV && params.has("gallery") ? (await import("./Gallery")).Gallery : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
