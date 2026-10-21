import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// macOS app window: the title bar is hidden and the traffic lights sit inside the toolbar (tauri.conf.json).
// Checked before the dev mocks below, which fake __TAURI_INTERNALS__ in a plain browser.
if ("__TAURI_INTERNALS__" in window && navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac-titlebar");

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  if (new URLSearchParams(location.search).has("bridge")) await import("./dev-bridge");
  else await import("./dev-mock");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
