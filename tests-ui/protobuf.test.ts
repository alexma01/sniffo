// Run with: node tests-ui/protobuf.test.ts
import assert from "node:assert/strict";
import { decode, grpcFrames, toPlain } from "../src/protobuf.ts";

// message { int32 id = 1; string name = 2; Inner inner = 3; repeated int32 tags = 4; } with Inner { bool ok = 1; }
// id=150, name="sniffo", inner{ok=true}, tags=1, tags=2
const msg = Uint8Array.from([0x08, 0x96, 0x01, 0x12, 0x06, ...new TextEncoder().encode("sniffo"), 0x1a, 0x02, 0x08, 0x01, 0x20, 0x01, 0x20, 0x02]);
assert.deepEqual(toPlain(decode(msg)), { 1: 150, 2: "sniffo", 3: { 1: 1 }, 4: [1, 2] });

// gRPC: two frames of the same message.
const framed = new Uint8Array([0, 0, 0, 0, msg.length, ...msg, 0, 0, 0, 0, msg.length, ...msg]);
const frames = grpcFrames(framed);
assert.equal(frames.length, 2);
assert.deepEqual(toPlain(decode(frames[1].data))[2], "sniffo");

// Garbage is rejected instead of producing a bogus tree.
assert.throws(() => decode(Uint8Array.from([0x0f, 0xff])));
assert.throws(() => grpcFrames(Uint8Array.from([0, 0, 0, 0, 9, 1])));
console.log("protobuf ok");
