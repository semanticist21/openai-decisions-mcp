import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LocalProvider } from "../dist/local-provider.js";
import { FileAccess } from "../dist/input.js";
import { localTools } from "../dist/local-tools.js";

const exec = promisify(execFile);
const sources = [{ type: "text", text: "Paid the same invoice twice." }];
const predicate = { type: "predicate", name: "paid", instructions: "Was the invoice paid?" };
const decision = { sources, questions: [predicate] };
const signal = AbortSignal.timeout(25_000);

async function fixture(t, callback) {
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "d3-flash" }] }));
    if (req.url !== "/v1/systemone") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (callback?.(input, res)) return;
    const answers = Object.fromEntries(Object.entries(input.questions).map(([k, v]) => {
      if (v.type === "noul") return [k, { type: "noul", noul: 0.9 }];
      if (v.type === "score") return [k, { type: "score", score: 0.75, confidence: 0.5, probabilities: { 0: 0.25, 1: 0.75 } }];
      const criteria = Object.keys(v.criteria);
      return [k, { type: "choice", choice: criteria[1], confidence: 1, probabilities: Object.fromEntries(criteria.map((option, i) => [option, Number(i === 1)])) }];
    }));
    res.end(JSON.stringify({ model: "d3-flash", answers, usage: { input_tokens: 45, output_tokens: 0 } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("CLI and MCP share typed results, including boolean choices and score bands", async t => {
  const url = await fixture(t);
  const env = { ...process.env, LOCAL_DECISIONS_URL: url, LOCAL_DECISIONS_MAC_URL: "", LOCAL_DECISIONS_FEDORA_URL: "" };
  const input = {
    sources,
    questions: [
      predicate,
      { type: "choice", name: "choice", instructions: "Choose yes or no.", choices: [{ value: "true" }, { value: true }] },
      { type: "score", name: "small", instructions: "Rate priority.", levels: [{ label: "low" }, { label: "high" }] },
      { type: "score", name: "large", instructions: "Rate urgency.", levels: Array.from({ length: 11 }, (_, i) => ({ label: String(i) })) },
    ],
    full: true,
  };
  const client = new Client({ name: "verification", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/local-cli.js", "mcp"], env });
  await client.connect(transport);
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["batch", "browse", "decide", "grep"]);
  const result = await client.callTool({ name: "decide", arguments: input });
  assert.equal(result.isError, undefined);
  const cliResult = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["dist/local-cli.js", "decide"], { env }, (error, stdout) => {
      if (error) reject(error);
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify(input));
  });
  const { upstream_ms: _cliTime, ...cli } = cliResult;
  const { upstream_ms: _mcpTime, ...mcp } = JSON.parse(result.content[0].text);
  assert.deepEqual(cli, mcp);
  assert.deepEqual(cli.answers.map(value => value.choice ?? value.score ?? value.probability), [0.9, true, 0.75, 1]);
  const doctor = await exec(process.execPath, ["dist/local-cli.js", "doctor"], { env });
  assert.equal(JSON.parse(doctor.stdout).route, "local");
});

test("Mac mini is preferred, Fedora is restricted, and a submitted decision is not replayed", async t => {
  let fedoraCalls = 0;
  const fedora = await fixture(t, () => { fedoraCalls++; });
  let macCalls = 0;
  const mac = await fixture(t, (_input, res) => {
    macCalls++;
    res.writeHead(503).end("private upstream error");
    return true;
  });
  const access = new FileAccess(process.cwd());
  await access.initialize();
  const tools = localTools(access, new LocalProvider({
    LOCAL_DECISIONS_URL: "http://127.0.0.1:1", LOCAL_DECISIONS_MAC_URL: mac, LOCAL_DECISIONS_FEDORA_URL: fedora,
  }));
  await assert.rejects(tools.decide(decision, signal), /503/);
  assert.equal(macCalls, 1);
  assert.equal(fedoraCalls, 0);
  const shortOnly = localTools(access, new LocalProvider({ LOCAL_DECISIONS_URL: "", LOCAL_DECISIONS_FEDORA_URL: fedora }));
  assert.equal((await shortOnly.decide(decision, signal)).route, "fedora");
  await assert.rejects(shortOnly.grep({ query: "find" }, signal), /No configured/);
  await assert.rejects(shortOnly.grep({ query: "find", root: ".." }, signal), /outside the current project/);
  await assert.rejects(shortOnly.decide({ ...decision, sources: [{ type: "text", text: "token ".repeat(500) }] }, signal), /No configured/);
  assert.equal(fedoraCalls, 1);
  assert.throws(() => new LocalProvider({ LOCAL_DECISIONS_URL: "https://example.com" }), /loopback|127\.0\.0\.1/);
  assert.throws(() => new LocalProvider({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:8888" }), /NO_PROXY/);
});
