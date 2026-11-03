// Servers the proxied traffic goes to, plus clients that send it through the proxy.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// 1x1 red PNG.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
/** protobuf: id=150, name="Ada" */
export const PROTO = Buffer.from([0x08, 0x96, 0x01, 0x12, 0x03, 0x41, 0x64, 0x61]);
export const PROTO_SCHEMA = 'syntax = "proto3"; package demo; message User { int32 id = 1; string name = 2; }';

type Handler = (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void;

const routes: Record<string, Handler> = {
  "/json": (_q, _b, res) => send(res, 200, "application/json", JSON.stringify({ users: [{ id: 1, name: "Ada", tags: ["admin"] }], total: 1 })),
  "/xml": (_q, _b, res) => send(res, 200, "application/xml", "<rss><channel><title>Feed</title><item><title>One</title></item></channel></rss>"),
  "/html": (_q, _b, res) => send(res, 200, "text/html; charset=utf-8", "<html><body><h1>Hello page</h1></body></html>"),
  "/app.js": (_q, _b, res) => send(res, 200, "application/javascript", "console.log('js')"),
  "/style.css": (_q, _b, res) => send(res, 200, "text/css", "body{color:red}"),
  "/font.woff2": (_q, _b, res) => send(res, 200, "font/woff2", Buffer.from([0x77, 0x4f, 0x46, 0x32])),
  "/image.png": (_q, _b, res) => send(res, 200, "image/png", PNG),
  "/video.mp4": (_q, _b, res) => send(res, 200, "video/mp4", Buffer.from([0, 0, 0, 24])),
  "/form-reply": (_q, _b, res) => send(res, 200, "application/x-www-form-urlencoded", "ok=1"),
  "/binary": (_q, _b, res) => send(res, 200, "application/octet-stream", Buffer.from(Array.from({ length: 40 }, (_, i) => i))),
  "/proto": (_q, _b, res) => send(res, 200, "application/x-protobuf", PROTO),
  "/grpc": (_q, _b, res) => send(res, 200, "application/grpc", Buffer.concat([Buffer.from([0, 0, 0, 0, PROTO.length]), PROTO, Buffer.from([0, 0, 0, 0, PROTO.length]), PROTO])),
  "/gzip": (_q, _b, res) => { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(gzipSync('{"zipped":true}')); },
  "/cookies": (_q, _b, res) => { res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["session=xyz; Path=/; HttpOnly", "theme=dark"] }); res.end("cookies set"); },
  "/cached": (q, _b, res) => { res.writeHead(200, { "content-type": "text/plain", etag: '"v1"', "cache-control": "max-age=3600" }); res.end(`if-none-match=${q.headers["if-none-match"] ?? "none"}`); },
};

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

const handle: Handler = (req, body, res) => {
  const url = new URL(req.url!, "http://x");
  const route = routes[url.pathname];
  if (route) return route(req, body, res);
  const status = /^\/status\/(\d+)$/.exec(url.pathname);
  if (status) return send(res, Number(status[1]), "text/plain", `status ${status[1]}`);
  const delay = url.pathname === "/slow" ? Number(url.searchParams.get("ms") ?? 300) : 0;
  setTimeout(() => send(res, 200, "application/json", JSON.stringify({ method: req.method, path: req.url, headers: req.headers, body: body.toString() })), delay);
};

export interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }

// ---------------------------------------------------------------- WebSocket frames

export interface Frame { opcode: number; data: Buffer }

export function encodeFrame(opcode: number, data: Buffer, mask: boolean): Buffer {
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len])
    : Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | 126, len >> 8, len & 255]);
  if (!mask) return Buffer.concat([head, data]);
  const key = randomBytes(4);
  return Buffer.concat([head, key, Buffer.from(data.map((b, i) => b ^ key[i % 4]))]);
}

/** Feeds bytes in, calls `onFrame` for every complete frame. */
function frameReader(onFrame: (f: Frame) => void) {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      const masked = (buf[1] & 0x80) !== 0;
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      let data = buf.subarray(off + (masked ? 4 : 0), total);
      if (masked) { const key = buf.subarray(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ key[i % 4])); }
      onFrame({ opcode: buf[0] & 15, data: Buffer.from(data) });
      buf = buf.subarray(total);
    }
  };
}

// ---------------------------------------------------------------- servers

export interface Upstream {
  http: string;
  https: string;
  wsPort: number;
  seen: Seen[];
  /** Frames the WebSocket server received. */
  wsReceived: Frame[];
  /** Server-initiated message to every open WebSocket. */
  wsPush: (text: string) => void;
  close: () => Promise<void>;
}

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "sniffo-e2e-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

export async function startUpstream(): Promise<Upstream> {
  const seen: Seen[] = [];
  const wsReceived: Frame[] = [];
  const sockets = new Set<net.Socket>();
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, path: req.url!, headers: req.headers, body: body.toString() });
      handle(req, body, res);
    });
  };
  const plain = http.createServer(onRequest);
  plain.on("upgrade", (req, socket: net.Socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("data", frameReader((f) => {
      wsReceived.push(f);
      if (f.opcode === 8) { socket.end(encodeFrame(8, f.data, false)); return; }
      if (f.opcode === 1 || f.opcode === 2) socket.write(encodeFrame(f.opcode, Buffer.concat([Buffer.from("echo:"), f.data]), false));
    }));
  });
  const secure = https.createServer(certificate(), onRequest);
  const listen = (s: http.Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as net.AddressInfo).port)));
  const [p1, p2] = [await listen(plain), await listen(secure)];
  return {
    http: `http://127.0.0.1:${p1}`,
    https: `https://localhost:${p2}`,
    wsPort: p1,
    seen,
    wsReceived,
    wsPush: (text) => sockets.forEach((s) => s.write(encodeFrame(1, Buffer.from(text), false))),
    close: async () => {
      sockets.forEach((s) => s.destroy());
      plain.closeAllConnections();
      secure.closeAllConnections();
      await Promise.all([new Promise((ok) => plain.close(ok)), new Promise((ok) => secure.close(ok))]);
    },
  };
}

// ---------------------------------------------------------------- clients (through the proxy)

export interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer; ms: number }

/** Plain HTTP through the proxy (absolute-form request). */
export function request(proxyPort: number, method: string, url: string, opts: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  const t = Date.now();
  return new Promise((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method, path: url, headers: { host: new URL(url).host, ...opts.headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - t }));
    });
    req.on("error", fail);
    req.end(opts.body);
  });
}

/** HTTPS through the proxy with curl, trusting `caPath` (Sniffo's CA) — like a real client;
 * `caPath` null skips verification (to make a tunnel to a self-signed server). */
export async function curlHttps(proxyPort: number, url: string, caPath: string | null, extra: string[] = []): Promise<{ status: number; body: string }> {
  const trust = caPath ? ["--cacert", caPath] : ["-k"];
  // Async: the upstream server runs in this process and must keep answering meanwhile.
  const { stdout } = await promisify(execFile)("curl", ["-s", "-m", "15", "--noproxy", "", "-x", `http://127.0.0.1:${proxyPort}`, ...trust, ...extra, "-w", "\n%{http_code}", url], { encoding: "utf8" });
  const i = stdout.lastIndexOf("\n");
  return { status: Number(stdout.slice(i + 1)), body: stdout.slice(0, i) };
}

/** A corporate-style forward proxy (CONNECT only, like what Sniffo chains through). */
export async function startForwardProxy(auth?: string): Promise<{ port: number; connects: string[]; close: () => Promise<void> }> {
  const connects: string[] = [];
  const server = http.createServer((_q, res) => { res.writeHead(405); res.end(); });
  server.on("connect", (req, client: net.Socket, head) => {
    if (auth && req.headers["proxy-authorization"] !== `Basic ${Buffer.from(auth).toString("base64")}`) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    connects.push(req.url!);
    const [host, port] = req.url!.split(":");
    const target = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      target.write(head);
      target.pipe(client).pipe(target);
    });
    target.on("error", () => client.destroy());
    client.on("error", () => target.destroy());
  });
  const port = await new Promise<number>((ok) => server.listen(0, "127.0.0.1", () => ok((server.address() as net.AddressInfo).port)));
  return { port, connects, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}

export interface WsClient {
  send: (data: string | Buffer) => void;
  received: Frame[];
  close: () => void;
}

/** WebSocket through the proxy: CONNECT tunnel, then the upgrade inside it (as browsers do). */
export function wsConnect(proxyPort: number, wsPort: number, path = "/ws", host = "127.0.0.1"): Promise<WsClient> {
  return new Promise((ok, fail) => {
    const s = net.connect(proxyPort, "127.0.0.1");
    const received: Frame[] = [];
    let stage: "connect" | "upgrade" | "open" = "connect";
    let head = "";
    const read = frameReader((f) => received.push(f));
    s.on("error", fail);
    s.on("connect", () => s.write(`CONNECT ${host}:${wsPort} HTTP/1.1\r\nHost: ${host}:${wsPort}\r\n\r\n`));
    s.on("data", (chunk) => {
      if (stage === "open") return read(chunk);
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const rest = Buffer.from(head.slice(end + 4), "latin1");
      if (stage === "connect") {
        if (!head.startsWith("HTTP/1.1 200")) return fail(new Error(head));
        stage = "upgrade";
        head = "";
        s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${wsPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      } else {
        if (!head.startsWith("HTTP/1.1 101")) return fail(new Error(head));
        stage = "open";
        if (rest.length) read(rest);
        ok({
          send: (d) => s.write(encodeFrame(typeof d === "string" ? 1 : 2, typeof d === "string" ? Buffer.from(d) : d, true)),
          received,
          close: () => s.write(encodeFrame(8, Buffer.from([3, 232]), true)),
        });
      }
    });
  });
}
