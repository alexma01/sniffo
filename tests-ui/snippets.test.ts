// Run with: node tests-ui/snippets.test.ts
import assert from "node:assert/strict";
import { parseCurl, toCurl } from "../src/snippets.ts";

const devtools = `curl 'https://api.example.com/v1/items?x=1' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer abc' \\
  --data-raw '{"name":"x"}'`;
const r = parseCurl(devtools);
assert.equal(r.method, "POST");
assert.equal(r.url, "https://api.example.com/v1/items?x=1");
assert.deepEqual(r.headers, [["accept", "application/json"], ["authorization", "Bearer abc"]]);

const q = parseCurl(`curl -X PUT "http://h/a b" -H "x-q: \\"q\\"" -d a=1 -d b=2 -o out.txt`);
assert.deepEqual([q.method, q.url, q.body, q.headers[0][1]], ["PUT", "http://h/a b", "a=1&b=2", '"q"']);

// Round trip through our own generator, including single quotes in the body.
const back = parseCurl(toCurl({ method: "PATCH", url: "https://x/y", headers: [["content-type", "text/plain"], ["host", "x"]], body: "it's" }));
assert.deepEqual([back.method, back.url, back.body, back.headers.length], ["PATCH", "https://x/y", "it's", 1]);

assert.throws(() => parseCurl("wget http://x"));
console.log("snippets ok");
