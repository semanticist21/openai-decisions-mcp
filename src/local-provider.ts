import { z } from "zod";
import { InputError, questionsSchema, type Question } from "./schema.js";
import type { DecisionProvider } from "./evaluate.js";

export const localModel = "d3-flash";
const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability);
const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: distribution }),
  z.object({ type: z.literal("score"), score: z.number(), confidence: probability, probabilities: distribution }),
]);
const response = z.object({
  model: z.literal(localModel),
  answers: z.record(z.string(), answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.literal(0) }),
});

function wireQuestion(question: Question) {
  const { type, instructions } = question;
  if (type === "predicate") return { type: "noul", instructions };
  if (type === "score" && question.levels.length <= 10)
    return { type, instructions, criteria: question.levels.map(levelText) };
  const values = type === "choice"
    ? question.choices.map(({ value, description }) => description ? `${value}: ${description}` : String(value))
    : question.levels.map(levelText);
  return {
    type: "choice",
    instructions,
    criteria: Object.fromEntries(values.map((value, index) => [`option_${index}`, value])),
  };
}

function levelText({ label, description }: { label: string; description?: string }) {
  return description ? `${label}: ${description}` : label;
}

function normalize(question: Question, result: z.infer<typeof answer>) {
  const { name, type } = question;
  if (type === "predicate" && result.type === "noul")
    return { name, type, probability: result.noul };
  if (type === "choice" && result.type === "choice") {
    const probabilities = question.choices.map(({ value }, index) => ({
      value, probability: result.probabilities[`option_${index}`],
    }));
    const winner = probabilities.findIndex((_, index) => result.choice === `option_${index}`);
    if (winner >= 0 && Object.keys(result.probabilities).length === probabilities.length)
      return { name, type, choice: probabilities[winner]!.value, confidence: result.confidence, probabilities };
  }
  if (type === "score" && result.type !== "noul") {
    const native = question.levels.length <= 10;
    if ((result.type === "score") === native && Object.keys(result.probabilities).length === question.levels.length) {
      const probabilities = question.levels.map(({ label }, value) => ({
        value, label, probability: result.probabilities[native ? String(value) : `option_${value}`],
      }));
      const score = result.type === "score" ? result.score : probabilities.reduce(
        (sum, item) => sum + item.value * (item.probability ?? NaN), 0,
      );
      return { name, type, score, confidence: result.confidence, probabilities };
    }
  }
  throw new InputError("D3 Flash returned a mismatched answer.");
}

export function loopback(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("Expected a loopback URL.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash)
    throw new InputError("Model URLs must use http://127.0.0.1, directly or through an SSH tunnel.");
  return url;
}

type Target = { name: "local" | "mac-mini" | "fedora"; url: string; key?: string };
export class LocalProvider {
  private readonly targets: Target[] = [];

  constructor(env = process.env) {
    const nodeProxy = env.NODE_USE_ENV_PROXY === "1" ||
      process.execArgv.includes("--use-env-proxy") ||
      /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? "");
    const proxy = env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY;
    const bypass = (env.no_proxy ?? env.NO_PROXY ?? "").split(/[\s,]+/);
    if (nodeProxy && proxy && !bypass.includes("127.0.0.1") && !bypass.includes("*"))
      throw new InputError("Set NO_PROXY to include 127.0.0.1 before enabling Local Decisions with Node's environment proxy.");
    const routes = [
      ["local", env.LOCAL_DECISIONS_URL ?? "http://127.0.0.1:8091", env.LOCAL_DECISIONS_KEY],
      ["mac-mini", env.LOCAL_DECISIONS_MAC_URL, env.LOCAL_DECISIONS_MAC_KEY],
      ["fedora", env.LOCAL_DECISIONS_FEDORA_URL, env.LOCAL_DECISIONS_FEDORA_KEY],
    ] as const;
    for (const [name, value, key] of routes) {
      if (!value) continue;
      const url = loopback(value);
      if (url.pathname !== "/") throw new InputError("Decision URLs must specify the origin only.");
      this.targets.push({ name, url: url.origin, key });
    }
  }

  async select(signal: AbortSignal, shortText = false) {
    for (const target of this.targets) {
      if (target.name === "fedora" && !shortText) continue;
      signal.throwIfAborted();
      try {
        const result = await fetch(`${target.url}/v1/models`, {
          headers: this.headers(target), redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(1200)]),
        });
        if (!result.ok) {
          await result.body?.cancel();
          continue;
        }
        const models = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(await result.json());
        if (models.success && models.data.data.some(item => item.id === localModel)) return target;
      } catch {
        signal.throwIfAborted();
      }
    }
    throw new InputError("No configured D3 Flash endpoint is available for this operation. Run local-decisions doctor.");
  }

  private headers(target: Target): Record<string, string> {
    return target.key ? { authorization: `Bearer ${target.key}` } : {};
  }

  async ask(target: Target, body: { state: unknown; questions: unknown; files?: string[] }, signal: AbortSignal) {
    let result: Response;
    try {
      result = await fetch(`${target.url}/v1/systemone`, {
        method: "POST",
        headers: { ...this.headers(target), "content-type": "application/json" },
        body: JSON.stringify({ ...body, model: localModel }),
        redirect: "error",
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new InputError("D3 Flash connection failed. The request was not retried.");
    }
    if (!result.ok) {
      await result.body?.cancel();
      throw new InputError(`D3 Flash rejected the request (HTTP ${result.status}). For context limits, select less evidence.`);
    }
    const parsed = response.safeParse(await result.json().catch(() => null));
    signal.throwIfAborted();
    if (!parsed.success) throw new InputError("D3 Flash returned a malformed decision.");
    return parsed.data;
  }

  evaluate = async (body: Parameters<DecisionProvider>[0], signal: AbortSignal, shortText = true) => {
    if (!Array.isArray(body.input)) throw new InputError("Expected prepared evidence.");
    const state: string[] = [];
    const files: string[] = [];
    for (const message of body.input) {
      if (!Array.isArray(message.content)) throw new InputError("Expected prepared evidence parts.");
      for (const part of message.content) {
        if (part.type === "input_text") state.push(part.text);
        if (part.type === "input_image") {
          state.push(`[Image ${files.length + 1}]`);
          files.push(part.image_url);
        }
      }
    }
    const definitions = questionsSchema.parse(body.questions);
    const questions = Object.fromEntries(definitions.map((question, index) => [`q${index}`, wireQuestion(question)]));
    const request = { state: state.join("\n"), questions, files };
    const target = await this.select(signal, shortText && !files.length && definitions.length === 1 &&
      Buffer.byteLength(JSON.stringify(request)) <= 2048);
    const result = await this.ask(target, request, signal);
    const answers = Object.values(result.answers);
    if (answers.length !== definitions.length) throw new InputError("D3 Flash returned a mismatched answer count.");
    const { input_tokens, output_tokens } = result.usage;
    return {
      model: localModel,
      answers: definitions.map((question, index) => {
        const entry = result.answers[`q${index}`];
        if (!entry) throw new InputError("D3 Flash omitted a question.");
        return normalize(question, entry);
      }),
      usage: {
        input_tokens, output_tokens, total_tokens: input_tokens + output_tokens,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      route: target.name,
    };
  };

  async doctor(signal: AbortSignal) {
    const target = await this.select(signal, true);
    const result = await this.ask(target, {
      state: "The status is online.",
      questions: { online: { type: "noul", instructions: "Is the status online?" } },
    }, signal);
    const answer = result.answers.online;
    if (answer?.type !== "noul" || answer.noul < 0.5)
      throw new InputError("D3 Flash did not pass the synthetic status question.");
    return { route: target.name, endpoint: target.url, model: result.model, probability: answer.noul };
  }
}
