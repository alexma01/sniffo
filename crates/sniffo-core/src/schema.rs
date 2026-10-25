//! Protobuf decoding with user schemas: `.proto` sources (compiled in-process with protox)
//! or compiled descriptor sets (`.desc` / `.pb` from `protoc --descriptor_set_out`).

use prost_reflect::{DescriptorPool, DynamicMessage};
use std::path::{Path, PathBuf};

pub fn load(files: &[PathBuf]) -> Result<DescriptorPool, String> {
    let (protos, descs): (Vec<&PathBuf>, Vec<&PathBuf>) = files.iter().partition(|p| p.extension().is_some_and(|e| e == "proto"));
    let mut pool = if protos.is_empty() {
        DescriptorPool::new()
    } else {
        // Imports resolve relative to each file's folder.
        let mut includes: Vec<&Path> = protos.iter().filter_map(|p| p.parent()).collect();
        includes.dedup();
        let mut compiler = protox::Compiler::new(includes).map_err(|e| e.to_string())?;
        compiler.include_imports(true);
        for p in &protos {
            compiler.open_file(p).map_err(|e| format!("{}: {e}", p.display()))?;
        }
        compiler.descriptor_pool()
    };
    for d in descs {
        let bytes = std::fs::read(d).map_err(|e| format!("{}: {e}", d.display()))?;
        pool.decode_file_descriptor_set(bytes.as_slice()).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    Ok(pool)
}

pub fn message_names(pool: &DescriptorPool) -> Vec<String> {
    let mut names: Vec<String> = pool.all_messages().map(|m| m.full_name().to_owned()).collect();
    names.sort();
    names
}

/// Splits gRPC length-prefixed frames; `None` if the body isn't framed that way.
pub fn grpc_frames(body: &[u8]) -> Option<Vec<&[u8]>> {
    let mut out = vec![];
    let mut rest = body;
    while !rest.is_empty() {
        if rest.len() < 5 || rest[0] > 1 {
            return None;
        }
        let len = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        let frame = rest.get(5..5 + len)?;
        out.push(frame);
        rest = &rest[5 + len..];
    }
    Some(out)
}

/// Decodes each message (one, or one per gRPC frame) as `message_type` into proto3 JSON.
pub fn decode(pool: &DescriptorPool, message_type: &str, body: &[u8], grpc: bool) -> Result<Vec<serde_json::Value>, crate::Error> {
    let desc = pool.get_message_by_name(message_type).ok_or_else(|| crate::Error::new("proto_unknown_type").arg("type", message_type))?;
    let frames = if grpc { grpc_frames(body).ok_or(crate::Error::new("proto_not_grpc"))? } else { vec![body] };
    frames
        .into_iter()
        .map(|f| {
            let msg = DynamicMessage::decode(desc.clone(), f).map_err(|e| crate::Error::new("proto_decode").arg("type", message_type).arg("detail", e))?;
            serde_json::to_value(&msg).map_err(crate::Error::other)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROTO: &str = r#"
        syntax = "proto3";
        package demo;
        import "common.proto";
        message User { int32 id = 1; string name = 2; repeated string tags = 3; common.Status status = 4; }
    "#;
    const COMMON: &str = r#"syntax = "proto3"; package common; enum Status { UNKNOWN = 0; ACTIVE = 1; }"#;

    #[test]
    fn compiles_proto_with_imports_and_decodes_grpc() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("user.proto"), PROTO).unwrap();
        std::fs::write(dir.path().join("common.proto"), COMMON).unwrap();
        let pool = load(&[dir.path().join("user.proto")]).unwrap();
        assert!(message_names(&pool).contains(&"demo.User".to_string()));

        // id=7, name="ada", tags=["a","b"], status=ACTIVE
        let msg = [0x08, 7, 0x12, 3, b'a', b'd', b'a', 0x1a, 1, b'a', 0x1a, 1, b'b', 0x20, 1];
        let json = decode(&pool, "demo.User", &msg, false).unwrap();
        assert_eq!(json[0], serde_json::json!({ "id": 7, "name": "ada", "tags": ["a", "b"], "status": "ACTIVE" }));

        let mut framed = vec![0, 0, 0, 0, msg.len() as u8];
        framed.extend_from_slice(&msg);
        framed.extend_from_slice(&framed.clone());
        assert_eq!(decode(&pool, "demo.User", &framed, true).unwrap().len(), 2);
        assert!(decode(&pool, "demo.Nope", &msg, false).is_err());
    }

    #[test]
    fn reports_syntax_errors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("bad.proto"), "syntax = \"proto3\"; message {").unwrap();
        assert!(load(&[dir.path().join("bad.proto")]).unwrap_err().contains("bad.proto"));
    }
}
