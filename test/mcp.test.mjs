import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../dist/server.js";
import { fixture, decision, questions } from "./helpers.mjs";

test("real MCP exchanges discover tools, evaluate, reject schemas, and track Roots changes", async (t) => {
  const a = await fixture(),
    b = await fixture();
  t.after(() =>
    Promise.all([rm(a, { recursive: true }), rm(b, { recursive: true })]),
  );
  let roots = [{ uri: pathToFileURL(a).href }];
  const server = await createServer({
    root: a,
    provider: async (body) => decision(body),
  });
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(st);
  await client.connect(ct);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["decide", "evaluate_batch", "find_code"],
  );
  const args = { sources: [{ type: "file", path: "example.txt" }], questions };
  const result = await client.callTool({ name: "decide", arguments: args });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).answers.length, 3);
  const invalid = await client.callTool({
    name: "decide",
    arguments: { ...args, questions: [] },
  });
  assert.equal(invalid.isError, true);
  roots = [{ uri: pathToFileURL(b).href }];
  await client.sendRootsListChanged();
  const denied = await client.callTool({
    name: "decide",
    arguments: {
      ...args,
      sources: [{ type: "file", path: path.join(a, "example.txt") }],
    },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /outside/);
  const batch = await client.callTool({
    name: "evaluate_batch",
    arguments: {
      items: [{ id: "a", sources: [{ type: "text", text: "x" }] }],
      questions,
    },
  });
  assert.equal(JSON.parse(batch.content[0].text).items[0].ok, true);
  const found = await client.callTool({ name: "find_code", arguments: { files: [{ path: "example.txt" }], query: "Does the code handle login?" } });
  assert.notEqual(found.isError, true);
  assert.equal(JSON.parse(found.content[0].text).chunks[0].start_line, 1);
});

test("packaged stdio process discovers tools without API key and reports missing key", async (t) => {
  const root = await fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js")],
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (x) => {
    stderr += x;
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true });
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 3);
  const result = await client.callTool({
    name: "decide",
    arguments: {
      sources: [{ type: "file", path: "example.txt" }],
      questions: [questions[0]],
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /OPENAI_API_KEY is missing/);
  const encoded = await client.callTool({
    name: "evaluate_batch",
    arguments: {
      items: JSON.stringify([{ id: "encoded", sources: [{ type: "text", text: "unchanged" }] }]),
      questions: JSON.stringify([questions[0]]),
    },
  });
  assert.notEqual(encoded.isError, true);
  assert.match(JSON.parse(encoded.content[0].text).items[0].error, /OPENAI_API_KEY is missing/);
  assert.equal(stderr, "");
});

test("PDF workers do not inherit parent --input-type flags", async () => {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const source = `import {renderPdf} from ${JSON.stringify(pathToFileURL(path.resolve("dist/input.js")).href)}; import {pdfFixture} from ${JSON.stringify(pathToFileURL(path.resolve("test/helpers.mjs")).href)}; const r=await renderPdf(pdfFixture(),undefined,'auto',AbortSignal.timeout(10000)); if(r.modes.join(',')!=='text,image')throw Error('bad PDF modes'); console.log('PASS');`;
  const result = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    source,
  ]);
  assert.equal(result.stdout.trim(), "PASS");
});
