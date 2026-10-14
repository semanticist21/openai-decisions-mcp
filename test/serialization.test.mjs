import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { batchSchema, decideSchema, findSchema } from "../dist/schema.js";
import { decision, questions } from "./helpers.mjs";

test("MCP accepts native and JSON-encoded arrays without losing questions or evidence", async t => {
  const seen = [];
  const server = await createServer({ provider: async body => { seen.push(body); return decision(body); } });
  const client = new Client({ name: "serialization-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const schema = (await client.listTools()).tools.find(t => t.name === "evaluate_batch").inputSchema;
  for (const field of ["items", "questions"])
    assert.deepEqual(schema.properties[field].anyOf.map(s => s.type), ["array", "string"]);
  for (let i = 0; i < 35; i++) {
    const text = `제안 ${i}: 상수 호이스팅 + fillRect\n\"quoted\" \\ ${"long ".repeat(i * 10)}`;
    const items = [{ id: String(i), sources: [{ type: "text", text }] }];
    const result = await client.callTool({ name: "evaluate_batch", arguments: {
      items: i % 2 ? JSON.stringify(items) : items,
      questions: i % 3 ? JSON.stringify(questions) : questions,
    } });
    assert.notEqual(result.isError, true);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.items[0].ok, true);
    assert.equal(output.items[0].result.answers.length, questions.length);
    assert.deepEqual(seen.at(-1).questions, questions);
    assert.equal(seen.at(-1).input[0].content[1].text, text);
  }
  const valid = [{ id: "a", sources: [{ type: "text", text: "keep" }] }];
  for (const args of [
    { items: "[invalid sensitive-body", questions },
    { items: JSON.stringify(valid), questions: "[]" },
    { items: valid },
    { items: JSON.stringify([{ id: "a", sources: [{ type: "text" }] }]), questions },
    { items: JSON.stringify(JSON.stringify(valid)), questions },
  ]) {
    const result = await client.callTool({ name: "evaluate_batch", arguments: args });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-body/);
  }
  assert.equal(seen.length, 35, "invalid input must never reach the provider");
});

test("encoded arrays retain strict validation and bounds across top-level tools", () => {
  const sources = [{ type: "text", text: "evidence" }];
  assert.deepEqual(decideSchema.parse({ sources: JSON.stringify(sources), questions: JSON.stringify(questions) }), { sources, questions, full: false });
  const files = [{ path: "src/schema.ts", start_line: 2, end_line: 8 }];
  assert.deepEqual(findSchema.parse({ files: JSON.stringify(files), query: "query" }).files, files);
  const items = [{ id: "a", sources }];
  for (const value of [null, {}, 42, "[]", [], [...items, ...items], [{ ...items[0], unexpected: true }], Array.from({ length: 21 }, (_, i) => ({ id: String(i), sources }))]) {
    assert.equal(batchSchema.safeParse({ items: JSON.stringify(value), questions }).success, false);
  }
  assert.equal(batchSchema.safeParse({ items: JSON.stringify(items), questions: JSON.stringify([...questions, questions[0]]) }).success, false);
  const oversized = batchSchema.safeParse({ items: "가".repeat(8 * 1024 * 1024 + 1), questions });
  assert.equal(oversized.success, false);
  assert.match(JSON.stringify(oversized.error.issues), /JSON array exceeds 24 MiB/);
});
