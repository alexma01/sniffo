//! Manual check of OS integration: `cargo run --example os -- <enable PORT|disable|trust CERT|trusted CERT> SNAPSHOT`
use sniffo_core::system;
use std::path::Path;

fn main() -> std::io::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    match a[0].as_str() {
        "enable" => system::enable_system_proxy("127.0.0.1", a[1].parse().unwrap(), Path::new(&a[2])),
        "disable" => system::disable_system_proxy(Path::new(&a[1])),
        "trust" => system::trust_ca(Path::new(&a[1])),
        "trusted" => { println!("{}", system::ca_trusted(Path::new(&a[1]))); Ok(()) }
        _ => panic!("unknown command"),
    }
}
