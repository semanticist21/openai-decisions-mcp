import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { FileAccess, prepareInput } from "../dist/input.js";
import { Evaluator, validateDecision, callOpenAI } from "../dist/evaluate.js";
import { decideSchema, batchSchema } from "../dist/schema.js";
import { fixture, pdfFixture, questions, decision } from "./helpers.mjs";
const signal = () => AbortSignal.timeout(10_000);

test("file scopes, UTF-8, explicit ranges, binary rejection, and symlink containment", async (t) => {
  const root = await fixture();
  const outside = await fixture();
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true }),
      rm(outside, { recursive: true }),
    ]),
  );
  const access = new FileAccess(root);
  await access.initialize();
  const result = await prepareInput(
    [{ type: "file", path: "example.txt", start_line: 1, end_line: 1 }],
    access,
    signal(),
  );
  assert.match(JSON.stringify(result.input), /로그인 실패/);
  assert.equal(result.coverage[0].complete, false);
  await assert.rejects(
    prepareInput(
      [{ type: "file", path: "example.txt", end_line: 99 }],
      access,
      signal(),
    ),
    /Line range/,
  );
  await symlink(path.join(outside, "example.txt"), path.join(root, "escape"));
  await assert.rejects(
    access.read({ type: "file", path: "escape" }),
    /outside/,
  );
  await assert.rejects(access.read({ type: "file", path: outside }), /outside/);
  await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 255]));
  await assert.rejects(
    prepareInput([{ type: "file", path: "binary" }], access, signal()),
    /UTF-8/,
  );
  await mkdir(path.join(root, "dir"));
  await assert.rejects(
    access.read({ type: "file", path: "dir" }),
    /regular files/,
  );
});

test("roots changes revoke access, multiple roots require explicit selection, empty roots fail closed", async (t) => {
  const a = await fixture(),
    b = await fixture();
  t.after(() =>
    Promise.all([rm(a, { recursive: true }), rm(b, { recursive: true })]),
  );
  const access = new FileAccess(a);
  await access.initialize();
  await access.setRoots([pathToFileURL(a).href, pathToFileURL(b).href]);
  await assert.rejects(
    access.read({ type: "file", path: "example.txt" }),
    /ambiguous/,
  );
  assert.ok(await access.read({ type: "file", root: b, path: "example.txt" }));
  await access.setRoots([pathToFileURL(b).href]);
  await assert.rejects(
    access.read({ type: "file", path: path.join(a, "example.txt") }),
    /outside/,
  );
  await access.setRoots([]);
  await assert.rejects(
    access.read({ type: "file", path: path.join(b, "example.txt") }),
    /No project/,
  );
  assert.ok(
    await prepareInput([{ type: "text", text: "hello" }], access, signal()),
  );
});

test("PDF auto selects text and rendered page, visual renders both, invalid ranges and text-only scans fail", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true }));
  await writeFile(path.join(root, "sample.pdf"), pdfFixture());
  const access = new FileAccess(root);
  await access.initialize();
  const auto = await prepareInput(
    [{ type: "pdf", path: "sample.pdf", mode: "auto" }],
    access,
    signal(),
  );
  assert.deepEqual(auto.coverage[0].modes, ["text", "image"]);
  assert.match(JSON.stringify(auto.input), /Login error/);
  assert.equal(
    auto.input[0].content.filter((p) => p.type === "input_image").length,
    1,
  );
  const visual = await prepareInput(
    [{ type: "pdf", path: "sample.pdf", mode: "visual", pages: [1] }],
    access,
    signal(),
  );
  assert.deepEqual(visual.coverage[0].modes, ["image"]);
  assert.equal(visual.coverage[0].complete, false);
  await assert.rejects(
    prepareInput(
      [{ type: "pdf", path: "sample.pdf", mode: "text", pages: [2] }],
      access,
      signal(),
    ),
    /no extractable text/,
  );
  await assert.rejects(
    prepareInput(
      [{ type: "pdf", path: "sample.pdf", mode: "auto", pages: [3] }],
      access,
      signal(),
    ),
    /page selection/,
  );
  await writeFile(path.join(root, "large.pdf"), pdfFixture(21));
  await assert.rejects(
    prepareInput(
      [{ type: "pdf", path: "large.pdf", mode: "auto" }],
      access,
      signal(),
    ),
    /page selection/,
  );
  await writeFile(path.join(root, "bad.pdf"), "not a pdf");
  await assert.rejects(
    prepareInput(
      [{ type: "pdf", path: "bad.pdf", mode: "auto" }],
      access,
      signal(),
    ),
    /could not be processed/,
  );
});

test("images use inline data, oversized text is rejected instead of truncated", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true }));
  const access = new FileAccess(root);
  await access.initialize();
  await writeFile(
    path.join(root, "image.png"),
    createCanvas(20, 20).toBuffer("image/png"),
  );
  const result = await prepareInput(
    [{ type: "image", path: "image.png" }],
    access,
    signal(),
  );
  assert.match(
    result.input[0].content[1].image_url,
    /^data:image\/png;base64,/,
  );
  await assert.rejects(
    prepareInput(
      [{ type: "text", text: "가".repeat(400_000) }],
      access,
      signal(),
    ),
    /exceeds/,
  );
});

test("strict questions, duplicate IDs and mismatched distributions are rejected", () => {
  assert.throws(() =>
    decideSchema.parse({
      sources: [{ type: "text", text: "x" }],
      questions: [questions[0], questions[0]],
    }),
  );
  assert.throws(() =>
    batchSchema.parse({
      items: [
        { id: "x", sources: [{ type: "text", text: "x" }] },
        { id: "x", sources: [{ type: "text", text: "y" }] },
      ],
      questions,
    }),
  );
  const body = { model: "gpt-6-luna", questions };
  const good = decision(body);
  assert.equal(validateDecision(good, questions).answers.length, 3);
  const missing = structuredClone(good);
  missing.answers.pop();
  assert.throws(() => validateDecision(missing, questions), /count/);
  const wrong = structuredClone(good);
  wrong.answers[1].probabilities[1].value = "bad";
  assert.throws(() => validateDecision(wrong, questions), /choice values/);
  const nan = structuredClone(good);
  nan.answers[0].probability = NaN;
  assert.throws(() => validateDecision(nan, questions), /malformed/);
  const refused = structuredClone(good);
  refused.answers[0] = { type: "refusal", name: "relevant" };
  assert.equal(validateDecision(refused, questions).answers[0].type, "refusal");
});

test("compact/full responses, batch partial failure, concurrency cap and no replay", async () => {
  const access = new FileAccess();
  await access.initialize();
  let active = 0,
    max = 0,
    calls = 0;
  const provider = async (body) => {
    calls++;
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    if (JSON.stringify(body.input).includes("FAIL"))
      throw new Error("secret provider body");
    return decision(body);
  };
  const evaluator = new Evaluator(access, provider);
  const args = {
    sources: [{ type: "text", text: "login" }],
    questions,
    full: false,
  };
  const compact = await evaluator.decide(args, signal());
  assert.equal("probabilities" in compact.answers[1], false);
  const full = await evaluator.decide({ ...args, full: true }, signal());
  assert.equal(full.answers[1].probabilities.length, 2);
  const result = await evaluator.batch(
    {
      items: Array.from({ length: 9 }, (_, i) => ({
        id: String(i),
        sources: [{ type: "text", text: i === 2 ? "FAIL" : "login" }],
      })),
      questions,
      full: false,
    },
    signal(),
  );
  assert.equal(result.items[2].ok, false);
  assert.doesNotMatch(result.items[2].error, /secret/);
  assert.equal(result.items.filter((x) => x.ok).length, 8);
  assert.equal(calls, 11);
  assert.equal(max, 3);
});

test("cancellation stops queued work and missing key is actionable", async () => {
  const access = new FileAccess();
  await access.initialize();
  let calls = 0;
  const evaluator = new Evaluator(access, async (body, signal) => {
    calls++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    return decision(body);
  });
  const abort = new AbortController();
  const input = {
    sources: [{ type: "text", text: "x" }],
    questions,
    full: false,
  };
  const promises = Array.from({ length: 5 }, () =>
    evaluator.decide(input, abort.signal),
  );
  setTimeout(() => abort.abort(), 10);
  const results = await Promise.allSettled(promises);
  assert.ok(results.every((x) => x.status === "rejected"));
  assert.equal(calls, 3);
  const old = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      callOpenAI({ model: "gpt-6-luna", input: "x", questions }, signal()),
      /OPENAI_API_KEY is missing/,
    );
  } finally {
    if (old) process.env.OPENAI_API_KEY = old;
  }
});

test("provider errors are redacted and 429 is not automatically replayed", async (t) => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => {
    if (old) process.env.OPENAI_API_KEY = old;
    else delete process.env.OPENAI_API_KEY;
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(String(url), "https://api.openai.com/v1/decisions");
    assert.equal(options.redirect, "error");
    return new Response(
      JSON.stringify({
        error: {
          message: "PRIVATE INPUT DO NOT RETURN",
          type: "rate_limit_error",
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  });
  await assert.rejects(
    callOpenAI({ model: "gpt-6-luna", input: "x", questions }, signal()),
    (error) =>
      /HTTP 429/.test(error.message) && !error.message.includes("PRIVATE"),
  );
  assert.equal(requests, 1);
});
