// Flow list columns and every view of the detail panes.
import { PROTO_SCHEMA, request as request_ } from "./upstream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, row, test } from "./fixtures";

const request = (page: import("@playwright/test").Page) => page.locator(".pane").nth(0);
const response = (page: import("@playwright/test").Page) => page.locator(".pane").nth(1);
const tab = (pane: import("@playwright/test").Locator, name: string) => pane.locator("button.tab", { hasText: new RegExp(`^${name}$`) }).click();

test("list columns and status colours", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/json");
  await sniffo.get("/status/404");
  await sniffo.get("/status/503");
  await sniffo.get("/status/302");
  const ok = row(page, "/json");
  await expect(ok).toHaveClass(/s-ok/);
  await expect(ok.locator(".c-method")).toHaveText("GET");
  await expect(ok.locator(".c-status")).toHaveText("200");
  await expect(ok.locator(".c-host")).toHaveText("127.0.0.1");
  await expect(ok.locator(".c-type")).toHaveText("application/json");
  await expect(ok.locator(".c-version")).toHaveText("h1.1");
  await expect(ok.locator(".c-size")).toHaveText(/\d+ B/);
  await expect(ok.locator(".c-duration")).toHaveText(/\d+ ms/);
  await expect(ok.locator(".c-time")).toHaveText(/^\d\d:\d\d:\d\d\.\d{3}$/);
  // The client app is resolved from the connection (this test runs in node).
  await expect(ok.locator(".c-client")).toContainText("node");
  await expect(row(page, "/status/404")).toHaveClass(/s-warn/);
  await expect(row(page, "/status/503")).toHaveClass(/s-err/);
  await expect(row(page, "/status/302")).toHaveClass(/s-redirect/);
  await expect(page.locator(".statusbar")).toContainText("Errors 2");
  await expect(page.locator(".statusbar")).toContainText("4 / 4 flows");
});

test("headers, query, cookies, raw and timing", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/cookies?page=2&sort=name", { headers: { cookie: "a=1; b=two", "x-custom": "hello" } });
  await row(page, "/cookies").click();
  await expect(page.locator(".detail-url")).toContainText(sniffo.url("/cookies?page=2&sort=name"));

  const req = request(page);
  await tab(req, "headers");
  await expect(req.locator("tr", { hasText: "x-custom" }).locator(".v")).toHaveText("hello");
  await tab(req, "query");
  await expect(req.locator("tr")).toHaveText(["page2", "sortname"]);
  await tab(req, "cookies");
  await expect(req.locator("tr")).toHaveText(["a1", "btwo"]);
  await tab(req, "body");
  await expect(req).toContainText("No body");
  await tab(req, "raw");
  await expect(req.locator("pre")).toContainText("GET /cookies?page=2&sort=name HTTP/1.1");
  await expect(req.locator("pre")).toContainText("x-custom: hello");

  const res = response(page);
  await tab(res, "cookies");
  await expect(res.locator("tr")).toHaveText(["sessionxyz; Path=/; HttpOnly", "themedark"]);
  await tab(res, "body");
  await expect(res.locator("pre")).toHaveText("cookies set");
  await tab(res, "raw");
  await expect(res.locator("pre")).toContainText("HTTP/1.1 200");
  await expect(res.locator("pre")).toContainText("cookies set");
  await tab(res, "timing");
  for (const label of ["Started", "Waiting (TTFB)", "Download", "Total", "Client", "Protocol", "State"]) {
    await expect(res.locator("td.k", { hasText: label })).toBeVisible();
  }
  await expect(res.locator("tr", { hasText: "Protocol" }).locator(".v")).toHaveText("HTTP · HTTP/1.1");
  await expect(res.locator("tr", { hasText: "State" }).locator(".v")).toHaveText("complete");
  await expect(res.locator("tr", { hasText: "Total" }).locator(".v")).toHaveText(/^\d+ ms$/);
});

test("JSON tree and pretty views, gzip decoded", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/json");
  await sniffo.get("/gzip");
  await row(page, "/json").click();
  const res = response(page);
  const tree = res.locator(".json-tree");
  await expect(tree).toContainText("total: 1");
  // Two levels open by default; deeper ones collapsed with a count.
  await expect(tree).toContainText("3 keys");
  await tree.locator(".j-toggle").nth(2).click();
  await expect(tree).toContainText('name: "Ada"');
  await res.getByRole("button", { name: "Pretty" }).click();
  await expect(res.locator("pre")).toContainText('"name": "Ada"');
  await res.getByRole("button", { name: "Tree" }).click();
  await expect(res.locator(".json-tree")).toBeVisible();

  await row(page, "/gzip").click();
  await expect(response(page).locator(".json-tree")).toContainText("zipped: true");
});

test("XML, HTML, image, binary hex", async ({ sniffo }) => {
  const { page } = sniffo;
  for (const p of ["/xml", "/html", "/image.png", "/binary"]) await sniffo.get(p);
  await row(page, "/xml").click();
  await expect(response(page).locator("pre")).toContainText("<rss>\n  <channel>\n    <title>Feed</title>");
  await row(page, "/html").click();
  await expect(response(page).locator("pre")).toHaveText("<html><body><h1>Hello page</h1></body></html>");
  await row(page, "/image.png").click();
  const img = response(page).locator("img.preview");
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  await row(page, "/binary").click();
  const res = response(page);
  await expect(res.locator("pre")).toContainText("00000000  00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f");
  await res.getByRole("button", { name: "Decode as Protobuf" }).click();
  await expect(res).toContainText("Not a valid protobuf message");
  await tab(res, "raw");
  await expect(res.locator("pre")).toContainText("<40 B binary>");
});

test("form, multipart and GraphQL requests", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "user=ada&remember=1" });
  const boundary = "XyZ";
  const multipart = [`--${boundary}`, 'Content-Disposition: form-data; name="title"', "", "Hello", `--${boundary}`, 'Content-Disposition: form-data; name="meta"', "Content-Type: application/json", "", '{"k":"v"}', `--${boundary}--`, ""].join("\r\n");
  await sniffo.get("/upload", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: multipart });
  await sniffo.get("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query GetUser($id: ID!) { user(id: $id) { name } }", operationName: "GetUser", variables: { id: 7 } }) });

  await row(page, "/form").click();
  await tab(request(page), "body");
  await expect(request(page).locator("tr")).toHaveText(["userada", "remember1"]);

  await row(page, "/upload").click();
  await tab(request(page), "body");
  const parts = request(page).locator(".part");
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toContainText('form-data; name="title"');
  await expect(parts.nth(0).locator("pre")).toHaveText("Hello");
  await expect(parts.nth(1).locator(".json-tree")).toContainText('k: "v"');

  // GraphQL over GET: query and variables in the URL.
  await sniffo.get(`/graphql?query=${encodeURIComponent("query Me { me { id } }")}&operationName=Me&variables=${encodeURIComponent('{"x":1}')}`);
  await page.locator(".flow-row:not(.head)", { has: page.locator(".badge.gql", { hasText: "query Me" }) }).click();
  await expect(request(page).locator("pre")).toHaveText("query Me { me { id } }");
  await expect(request(page).locator(".json-tree")).toContainText("x: 1");

  const gql = page.locator(".flow-row:not(.head)", { has: page.locator(".badge.gql", { hasText: "query GetUser" }) });
  await expect(gql.locator(".badge.gql")).toHaveText("query GetUser");
  await gql.click();
  const req = request(page);
  await expect(req.locator("button.tab.active")).toHaveText("graphql");
  await expect(req.locator("pre")).toHaveText("query GetUser($id: ID!) { user(id: $id) { name } }");
  await expect(req.locator(".json-tree")).toContainText("id: 7");
});

test("protobuf and gRPC bodies, raw and with a schema", async ({ sniffo }) => {
  const { page } = sniffo;
  await sniffo.get("/proto");
  await sniffo.get("/grpc", { method: "POST" });
  await row(page, "/proto").click();
  const res = response(page);
  await expect(res.locator("select")).toHaveValue("");
  await expect(res.locator(".json-tree")).toContainText("1: 150");
  await expect(res.locator(".json-tree")).toContainText('2: "Ada"');

  await row(page, "/grpc").click();
  await expect(response(page).locator(".part")).toHaveCount(2);
  await expect(response(page)).toContainText("gRPC message 1 · 8 B");
  await expect(response(page)).toContainText("gRPC message 2 · 8 B");

  // Adding a schema in Settings updates the open body's type list.
  await row(page, "/proto").click();
  const file = join(sniffo.dataDir, "user.proto");
  writeFileSync(file, PROTO_SCHEMA);
  await page.getByRole("button", { name: "Settings" }).click();
  await sniffo.dialog([file]);
  await page.getByRole("button", { name: "Add schema files…" }).click();
  await expect(page.locator(".modal")).toContainText("1 message types");
  await page.getByRole("button", { name: "Cancel" }).click();
  await response(page).locator("select").selectOption("demo.User");
  await expect(response(page).locator(".json-tree")).toContainText('name: "Ada"');
  await expect(response(page).locator(".json-tree")).toContainText("id: 150");
  // Remembered per endpoint.
  await row(page, "/grpc").click();
  await row(page, "/proto").click();
  await expect(response(page).locator("select")).toHaveValue("demo.User");
  await row(page, "/grpc").click();
  await response(page).locator("select").selectOption("demo.User");
  await expect(response(page).locator(".part .json-tree")).toHaveCount(2);
});

test("pending, failed and pinned flows", async ({ sniffo }) => {
  const { page } = sniffo;
  const slow = sniffo.get("/slow?ms=2500");
  const pending = row(page, "/slow");
  await expect(pending.locator(".c-status")).toHaveText("…");
  await pending.click();
  await expect(response(page)).toContainText("Waiting for response…");
  await slow;
  await expect(pending.locator(".c-status")).toHaveText("200");
  await expect(response(page).locator(".json-tree")).toBeVisible();

  await request_(sniffo.port, "GET", "http://127.0.0.1:1/unreachable");
  const failed = row(page, "/unreachable");
  await expect(failed.locator(".c-status")).toHaveText("ERR");
  await failed.click();
  await expect(response(page).locator(".muted.pad")).not.toBeEmpty();
  await tab(response(page), "timing");
  await expect(response(page).locator("tr", { hasText: "State" })).toContainText("failed —");

  await row(page, "/slow").click();
  await page.locator(".detail-url .pin").click();
  await expect(row(page, "/slow").locator(".c-id")).toHaveText("📌");
  await expect(page.locator(".detail-url .pin")).toHaveClass(/on/);
  await page.locator(".detail-url .pin").click();
  await expect(row(page, "/slow").locator(".c-id")).not.toHaveText("📌");
});
