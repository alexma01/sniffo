//! What `reveal_ca` does, on the main thread like the app's sync commands (AppKit needs it).
//! Driven by the opt-in desktop test in tests/commands.rs.
fn main() {
    tauri_plugin_opener::reveal_item_in_dir(std::env::args().nth(1).expect("path")).unwrap();
}
