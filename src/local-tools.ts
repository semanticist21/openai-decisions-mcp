import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { navigate } from "@jkudish/jev-browser";
import { z } from "zod";
import { LocalProvider, localModel, loopback } from "./local-provider.js";
import { FileAccess } from "./input.js";
import { Evaluator } from "./evaluate.js";
import { findCode } from "./find.js";
import { batchSchema, decideSchema, findSchema, findShape, InputError } from "./schema.js";

export const grepShape = {
  query: findShape.query,
  root: z.string().min(1).max(4096).optional(),
  files: findShape.files.optional(),
};
const grepSchema = z.object(grepShape).strict().refine(
  args => args.root === undefined || args.files === undefined,
  "Supply a search root or file ranges.",
);

export const browseShape = {
  start_url: z.url(),
  task: z.string().min(1).max(4096),
  max_steps: z.number().int().min(1).max(24).default(8),
  max_seconds: z.number().int().min(1).max(180).default(90),
  allow_typing: z.boolean().default(false),
  format: z.enum(["text", "markdown", "aria", "html"]).default("text"),
  screenshot: z.enum(["none", "final"]).default("none"),
};
const browseSchema = z.object(browseShape).strict();

async function searchTree(root: string, query: string, provider: LocalProvider, signal: AbortSignal) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const target = await provider.select(signal);
  const config = await mkdtemp(join(tmpdir(), "local-decisions-jg-"));
  const env = { ...process.env, XDG_CONFIG_HOME: config };
  try {
    const jg = fileURLToPath(import.meta.resolve("@dzhng/jevgrep/dist/bin/index.js"));
    const run = (args: string[], key?: string) => new Promise<{ output: string; partial: boolean }>((resolve, reject) => {
      const child = execFile(process.execPath, [jg, ...args], {
        env, signal, cwd: root, maxBuffer: 512 * 1024,
      }, (error, stdout) => {
        if (!error || (error.code === 2 && key === undefined))
          resolve({ output: stdout, partial: Boolean(error) || /bounded partial|search is partial/i.test(stdout) });
        else reject(signal.aborted ? signal.reason : new InputError("Jevgrep could not complete the scoped search."));
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(key === undefined ? undefined : `${key}\n`);
    });
    await run(["auth", "--provider", "custom", "--base-url", `${target.url}/v1`, "--model", localModel, "--stdin"], target.key ?? "loopback");
    const result = await run(["--no-cache", "--concurrency", "1", "--max-requests", "6", "--", query, root]);
    return { ...result, route: target.name };
  } finally {
    await rm(config, { recursive: true, force: true });
  }
}

async function browse(args: z.infer<typeof browseSchema>, provider: LocalProvider, parentSignal: AbortSignal) {
  const start = new URL(args.start_url);
  if (!["http:", "https:"].includes(start.protocol) || start.username || start.password)
    throw new InputError("Browser QA requires an HTTP(S) page URL without credentials.");
  if (args.allow_typing) {
    const { JEV_BROWSER_TYPE_BASE_URL: url, JEV_BROWSER_TYPE_MODEL: model, JEV_BROWSER_TYPE_PROVIDER: override } = process.env;
    if (!url || !model || override)
      throw new InputError("Typing requires a loopback JEV_BROWSER_TYPE_BASE_URL and JEV_BROWSER_TYPE_MODEL. Clear JEV_BROWSER_TYPE_PROVIDER.");
    loopback(url);
  }
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(args.max_seconds * 1000)]);
  const target = await provider.select(signal);
  const browser = await chromium.launch({ timeout: args.max_seconds * 1000 });
  const abort = () => void browser.close().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", async route => {
      const request = route.request();
      if (new URL(request.url()).origin !== start.origin || !["GET", "HEAD"].includes(request.method()))
        return route.abort();
      try {
        const response = await route.fetch({ maxRedirects: 0 });
        try {
          if (response.status() >= 300 && response.status() < 400 && response.headers().location)
            await route.abort();
          else await route.fulfill({ response });
        } finally {
          await response.dispose();
        }
      } catch {
        await route.abort().catch(() => {});
      }
    });
    await context.routeWebSocket("**/*", socket => socket.close());
    const page = await context.newPage();
    await page.goto(start.href, { waitUntil: "domcontentloaded" });
    const result = await navigate({
      page, task: args.task, maxSteps: args.max_steps, maxSeconds: args.max_seconds,
      allowTyping: args.allow_typing, format: args.format, screenshot: args.screenshot,
      transport: {
        name: `d3-flash-${target.name}`,
        ask: ({ state, questions, signal }) => provider.ask(target, { state, questions }, signal),
      },
    }, signal);
    signal.throwIfAborted();
    if (result.usage) delete result.usage.est_cost_usd;
    return { ...result, route: target.name };
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
  }
}

export function localTools(access: FileAccess, provider = new LocalProvider()) {
  const evaluator = new Evaluator(access, provider.evaluate, localModel);
  const codeEvaluator = new Evaluator(access, (body, signal) => provider.evaluate(body, signal, false), localModel);
  return {
    decide: (args: unknown, signal: AbortSignal) => evaluator.decide(decideSchema.parse(args), signal),
    batch: (args: unknown, signal: AbortSignal) => evaluator.batch(batchSchema.parse(args), signal),
    grep: async (args: unknown, signal: AbortSignal) => {
      const input = grepSchema.parse(args);
      if (input.files) return findCode(findSchema.parse({ query: input.query, files: input.files }), access, codeEvaluator, signal);
      return searchTree(await access.directory(input.root), input.query, provider, signal);
    },
    browse: (args: unknown, signal: AbortSignal) => browse(browseSchema.parse(args), provider, signal),
  };
}
