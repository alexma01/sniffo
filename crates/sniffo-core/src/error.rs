//! Errors shown to the user: a stable code the UI translates (`backend.<code>` in src/locales)
//! plus named arguments for its `{placeholders}`. OS, tool and library messages have no code of
//! their own: they travel as `other` with the text in `detail`.

use serde::ser::{Serialize, SerializeMap, Serializer};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub args: Vec<(&'static str, String)>,
}

impl Error {
    pub fn new(code: &'static str) -> Self {
        Self { code, args: Vec::new() }
    }

    pub fn arg(mut self, name: &'static str, value: impl fmt::Display) -> Self {
        self.args.push((name, value.to_string()));
        self
    }

    pub fn other(detail: impl fmt::Display) -> Self {
        Self::new("other").arg("detail", detail)
    }
}

/// `{"code": "...", "<arg>": "..."}`
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.args.len() + 1))?;
        map.serialize_entry("code", self.code)?;
        for (k, v) in &self.args {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// For logs: `code name=value …`, or just the text for `other`.
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code == "other" {
            return f.write_str(&self.args[0].1);
        }
        f.write_str(self.code)?;
        self.args.iter().try_for_each(|(k, v)| write!(f, " {k}={v}"))
    }
}

/// Success lines from the backend (device setup log) use the same code + args shape.
pub type Message = Error;

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Self::other(s)
    }
}

impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Self::other(s)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::other(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_args_flat() {
        let e = Error::new("dns_ip").arg("ip", "nope");
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({ "code": "dns_ip", "ip": "nope" }));
        assert_eq!(e.to_string(), "dns_ip ip=nope");
        assert_eq!(Error::from("boom").to_string(), "boom");
    }
}
