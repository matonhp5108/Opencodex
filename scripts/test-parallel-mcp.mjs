import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = await mkdtemp(path.join(tmpdir(), "opencodex-parallel-test-"));
const requests = [];
const server = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const message = body ? JSON.parse(body) : {};
  requests.push({ method: message.method, headers: request.headers, params: message.params });
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const results = {
    initialize: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
    "tools/list": { tools: [{ name: "search", description: "Fixture search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] },
    "tools/call": { content: [{ type: "text", text: `result:${message.params?.arguments?.query}` }] },
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: results[message.method] }));
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}/mcp`;
  const vscodeStub = path.join(outputDir, "vscode-stub.mjs");
  await writeFile(vscodeStub, "export const workspace={}; export const env={}; export const Uri={};\n");
  await esbuild.build({
    entryPoints: [path.join(root, "src/mcp.ts")],
    outfile: path.join(outputDir, "mcp.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    plugins: [{ name: "vscode-stub", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeStub })); } }],
  });
  const { connectMcpServers, withParallelSearchServer } = await import(pathToFileURL(path.join(outputDir, "mcp.mjs")));

  const disabledDefinitions = withParallelSearchServer(
    { private: { url: "https://private.invalid", headers: { Authorization: "secret" } } },
    false,
    fixtureUrl,
  );
  assert.deepEqual(Object.keys(disabledDefinitions), ["private"]);
  const disabledConnection = await connectMcpServers(
    "{}",
    process.cwd(),
    async () => {},
    false,
    fixtureUrl,
  );
  assert.deepEqual(disabledConnection.tools, {});
  assert.equal(requests.length, 0, "disabled integration must make no requests");
  await disabledConnection.close();

  const collisionConnection = await connectMcpServers(
    JSON.stringify({
      ParallelSearch: {
        url: fixtureUrl,
        transport: "http",
        headers: { Authorization: "secret" },
      },
    }),
    process.cwd(),
    async () => {},
    true,
    "https://automatic.invalid",
  );
  assert.ok(collisionConnection.tools.mcp_parallelsearch_search);
  assert.ok(
    requests.some(({ headers }) => headers.authorization === "secret"),
    "a colliding named user server and its headers must be preserved",
  );
  await collisionConnection.close();
  requests.length = 0;

  const approvals = [];
  const connection = await connectMcpServers("{}", process.cwd(), async (...args) => approvals.push(args), true, fixtureUrl);
  assert.deepEqual(connection.errors, []);
  const tool = connection.tools.mcp_parallelsearch_search;
  assert.ok(tool, "fixture tool should be registered through the production MCP runtime");
  const result = await tool.execute({ query: "privacy test" }, {});
  assert.match(JSON.stringify(result), /result:privacy test/);
  assert.equal(approvals.length, 1, "tool calls retain the existing approval gate");
  assert.ok(requests.some(({ method }) => method === "initialize"));
  assert.ok(requests.some(({ method }) => method === "tools/list"));
  assert.ok(requests.some(({ method }) => method === "tools/call"));
  assert.ok(requests.every(({ headers }) => headers.authorization === undefined), "user credentials must not leak to Parallel");
  await connection.close();
  console.log("Parallel MCP runtime integration tests passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(outputDir, { recursive: true, force: true });
}
