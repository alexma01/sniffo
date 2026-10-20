import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  if (new URLSearchParams(location.search).has("bridge")) await import("./dev-bridge");
  else await import("./dev-mock");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
