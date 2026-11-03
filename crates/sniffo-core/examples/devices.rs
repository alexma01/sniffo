//! Manual check: `cargo run --example devices` lists devices; `-- <id> <command>` runs one.
use sniffo_core::devices::{self, Command, Context};
use std::path::Path;

fn main() {
    let list = devices::list();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(id) = args.first() else {
        for d in &list { println!("{:?} | {} | {} | {} | {}", d.platform, d.id, d.name, d.state, d.os); }
        return;
    };
    let device = list.iter().find(|d| &d.id == id).expect("unknown device");
    let cmd: Command = serde_json::from_str(&format!(r#"{{"type":"{}"}}"#, args[1])).expect("command");
    let ca = format!("{}/Library/Application Support/dev.sniffo.app/sniffo-ca.pem", std::env::var("HOME").unwrap());
    println!("{:?}", devices::execute(device, &cmd, &Context { ca_pem: Path::new(&ca), proxy_port: 9191 }));
}
