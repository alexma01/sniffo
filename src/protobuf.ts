// Schema-less protobuf decoding (like `protoc --decode_raw`) plus gRPC message framing.

export type ProtoValue = number | bigint | string | ProtoField[] | { bytes: string };
export interface ProtoField { field: number; wire: "varint" | "i64" | "len" | "i32"; value: ProtoValue }

class Reader {
  pos = 0;
  buf: Uint8Array;
  constructor(buf: Uint8Array) { this.buf = buf; }
  done() { return this.pos >= this.buf.length; }
  varint(): bigint {
    let result = 0n, shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("varint too long");
    }
  }
  take(n: number) {
    if (this.pos + n > this.buf.length) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

const small = (v: bigint): number | bigint => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

function printable(s: string) {
  return !/[\u0000-\u0008\u000e-\u001f�]/.test(s);
}

/** Length-delimited payloads are ambiguous: try a nested message, then UTF-8 text, else bytes. */
function guessLen(bytes: Uint8Array, depth: number): ProtoValue {
  if (bytes.length && depth < 32) {
    try {
      const nested = decode(bytes, depth + 1);
      if (nested.length) return nested;
    } catch { /* not a message */ }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (printable(text)) return text;
  return { bytes: hex(bytes) };
}

/** Throws on malformed input (callers fall back to the hex view). */
export function decode(buf: Uint8Array, depth = 0): ProtoField[] {
  const r = new Reader(buf);
  const out: ProtoField[] = [];
  while (!r.done()) {
    const tag = r.varint();
    const field = Number(tag >> 3n), wt = Number(tag & 7n);
    if (field === 0) throw new Error("field 0");
    if (wt === 0) out.push({ field, wire: "varint", value: small(r.varint()) });
    else if (wt === 1) out.push({ field, wire: "i64", value: small(new DataView(r.take(8).slice().buffer).getBigUint64(0, true)) });
    else if (wt === 2) out.push({ field, wire: "len", value: guessLen(r.take(Number(r.varint())), depth) });
    else if (wt === 5) out.push({ field, wire: "i32", value: new DataView(r.take(4).slice().buffer).getUint32(0, true) });
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}

/** Splits a gRPC body (1-byte compressed flag + 4-byte big-endian length per message). */
export function grpcFrames(buf: Uint8Array): { compressed: boolean; data: Uint8Array }[] {
  const frames = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const compressed = buf[pos] === 1;
    const len = new DataView(buf.buffer, buf.byteOffset + pos + 1, 4).getUint32(0);
    if (pos + 5 + len > buf.length) throw new Error("truncated gRPC frame");
    frames.push({ compressed, data: buf.subarray(pos + 5, pos + 5 + len) });
    pos += 5 + len;
  }
  if (pos !== buf.length) throw new Error("trailing bytes after gRPC frames");
  return frames;
}

/** JSON-ish view for the tree component: repeated fields become arrays. */
export function toPlain(fields: ProtoField[]): Record<string, unknown> {
  const groups = new Map<string, unknown[]>();
  for (const f of fields) {
    const v = Array.isArray(f.value) ? toPlain(f.value) : typeof f.value === "bigint" ? f.value.toString() : f.value;
    groups.set(String(f.field), [...(groups.get(String(f.field)) ?? []), v]);
  }
  return Object.fromEntries([...groups].map(([k, vs]) => [k, vs.length === 1 ? vs[0] : vs]));
}
