import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAccess } from "../dist/input.js";
import { Evaluator } from "../dist/evaluate.js";
import { findCode } from "../dist/find.js";
import { findSchema } from "../dist/schema.js";
import { fixture, decision } from "./helpers.mjs";

async function setup(t, provider) {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true }));
  const access = new FileAccess(root);
  await access.initialize();
  return { root, access, evaluator: new Evaluator(access, provider) };
}
const signal = () => new AbortController().signal;

test("code search preserves selected line numbers, UTF-8, overlaps and original judgments without echoing code", async t => {
  const calls = [];
  const { root, access, evaluator } = await setup(t, async body => {
    calls.push(body);
    const result = decision(body);
    result.answers[0].probability = 0.01;
    return result;
  });
  const lines = Array.from({ length: 450 }, (_, i) => `비공개 코드 ${i + 1}`);
  await writeFile(path.join(root, "code.ts"), lines.join("\r\n"));
  const input = findSchema.parse({ files: [{ path: "code.ts", start_line: 11, end_line: 420 }], query: "Does this chunk validate a session?" });
  const result = await findCode(input, access, evaluator, signal());
  assert.deepEqual(result.chunks.map(c => [c.start_line, c.end_line]), [[11, 210], [191, 390], [371, 420]]);
  assert.equal(calls.length, 3);
  const texts = calls.map(c => c.input[0].content.map(p => p.text).join("\n"));
  assert.match(texts[0], /11: 비공개 코드 11\n/);
  assert.match(texts[1], /191: 비공개 코드 191\n/);
  assert.doesNotMatch(texts.join("\n"), /\n10:|\n421:/);
  assert.equal(calls[0].questions[0].instructions, input.query);
  assert.equal(result.chunks[0].result.answers[0].probability, 0.01);
  assert.equal(result.chunks[0].source_sha256, createHash("sha256").update(lines.slice(10,420).join("\n")).digest("hex"));
  assert.doesNotMatch(JSON.stringify(result), /비공개 코드/);
});

test("search preflights scope, access, binary data and cancellation before any paid call", async t => {
  let calls = 0;
  const { root, access, evaluator } = await setup(t, async body => { calls++; return decision(body); });
  await writeFile(path.join(root, "large.ts"), "x\n".repeat(3800));
  await writeFile(path.join(root, "binary.ts"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "medium.ts"), "x".repeat(600_000));
  await writeFile(path.join(root, "boundary.ts"), "x".repeat(1024 * 1024));
  const run = (files, sig = signal()) => findCode(findSchema.parse({ files, query: "Is this relevant?" }), access, evaluator, sig);
  await assert.rejects(run([{ path: "large.ts" }]), /20 chunks/);
  await assert.rejects(run([{ path: "medium.ts" }, { path: "medium.ts" }]), /scope exceeds 1 MiB/);
  await assert.rejects(run([{ path: "boundary.ts" }]), /Numbered search chunk/);
  await assert.rejects(run([{ path: "example.txt" }, { path: "missing.ts" }]));
  await assert.rejects(run([{ path: "binary.ts" }]), /Binary/);
  await assert.rejects(run([{ path: "example.txt", start_line: 4 }]), /Line range/);
  await assert.rejects(run([{ path: "example.txt" }], AbortSignal.abort()));
  const outside = await fixture(); t.after(() => rm(outside, { recursive: true }));
  await assert.rejects(run([{ path: path.join(outside, "example.txt") }]), /outside/);
  assert.equal(calls, 0);
});

test("search retains refusal and redacted per-chunk failures instead of dropping candidates", async t => {
  let calls = 0;
  const { access, evaluator } = await setup(t, async body => {
    if (++calls === 2) throw new Error("sensitive provider body");
    const result = decision(body);
    result.answers = [{ name: "relevant", type: "refusal" }];
    return result;
  });
  const result = await findCode(findSchema.parse({ files: [{ path: "example.txt", start_line: 1, end_line: 1 }, { path: "example.txt", start_line: 2, end_line: 2 }], query: "Is this relevant?" }), access, evaluator, signal());
  assert.equal(result.chunks[0].ok, true);
  assert.equal(result.chunks[0].result.answers[0].type, "refusal");
  assert.equal(result.chunks[1].ok, false);
  assert.doesNotMatch(result.chunks[1].error, /sensitive/);
  assert.equal(calls, 2);
});
