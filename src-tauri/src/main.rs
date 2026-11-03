// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if sniffo_lib::run_proxy_guard() {
        return;
    }
    sniffo_lib::run()
}
