import { execFileSync } from "node:child_process";

/** Builds the bridge (the real app on Tauri's mock runtime) once for every test. */
export default function globalSetup() {
  execFileSync("cargo", ["build", "-p", "sniffo", "--example", "ui_bridge"], { stdio: "inherit" });
}
