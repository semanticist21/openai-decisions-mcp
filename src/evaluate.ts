import OpenAI from "openai";
import { z } from "zod";
import type { DecisionCreateParams } from "openai/resources/decisions";
import { FileAccess, prepareInput } from "./input.js";
import {
  InputError,
  limits,
  safeError,
  type DecideInput,
  type BatchInput,
  type Question,
} from "./schema.js";

const probability = z.number().min(0).max(1);
const count = z.number().int().nonnegative();
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predicate"), name: z.string(), probability }),
  z.object({
    type: z.literal("choice"),
    name: z.string(),
    choice: z.union([z.string(), z.boolean()]),
    confidence: probability,
    probabilities: z
      .array(
        z.object({ value: z.union([z.string(), z.boolean()]), probability }),
      )
      .min(2)
      .max(100),
  }),
  z.object({
    type: z.literal("score"),
    name: z.string(),
    score: z.number(),
    confidence: probability,
    probabilities: z
      .array(
        z.object({
          value: z.number().int().nonnegative(),
          label: z.string(),
          probability,
        }),
      )
      .min(2)
      .max(100),
  }),
  z.object({ type: z.literal("refusal"), name: z.string() }),
]);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.array(answerSchema).max(100),
  usage: z.object({
    input_tokens: count,
    output_tokens: count,
    total_tokens: count,
    input_tokens_details: z.object({
      cached_tokens: count,
      cache_write_tokens: count,
    }),
    output_tokens_details: z.object({ reasoning_tokens: count }),
  }),
});
export function validateDecision(raw: unknown, questions: Question[]) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new InputError(
      "OpenAI returned a malformed decision. No result was accepted.",
    );
  const result = parsed.data;
  if (
    result.model !== "gpt-6-luna" ||
    result.answers.length !== questions.length
  )
    throw new InputError("OpenAI returned a mismatched model or answer count.");
  for (const [i, question] of questions.entries()) {
    const answer = result.answers[i]!;
    if (
      answer.name !== question.name ||
      (answer.type !== "refusal" && answer.type !== question.type)
    )
      throw new InputError(
        "OpenAI returned a mismatched question name or type.",
      );
    if (answer.type === "choice" && question.type === "choice") {
      const expected = new Set(
        question.choices.map((x) => JSON.stringify(x.value)),
      );
      const actual = answer.probabilities.map((x) => JSON.stringify(x.value));
      if (
        !expected.has(JSON.stringify(answer.choice)) ||
        actual.length !== expected.size ||
        new Set(actual).size !== expected.size ||
        actual.some((x) => !expected.has(x))
      )
        throw new InputError("OpenAI returned invalid choice values.");
    }
    if (answer.type === "score" && question.type === "score") {
      if (
        answer.score < 0 ||
        answer.score > question.levels.length - 1 ||
        answer.probabilities.length !== question.levels.length ||
        new Set(answer.probabilities.map((p) => p.value)).size !==
          question.levels.length ||
        answer.probabilities.some(
          (p) => question.levels[p.value]?.label !== p.label,
        )
      )
        throw new InputError("OpenAI returned invalid score levels.");
    }
    if (
      "probabilities" in answer &&
      Math.abs(
        answer.probabilities.reduce((n, p) => n + p.probability, 0) - 1,
      ) > 0.01
    )
      throw new InputError(
        "OpenAI returned an invalid probability distribution.",
      );
  }
  return result;
}
export type DecisionProvider = (
  body: DecisionCreateParams,
  signal: AbortSignal,
) => Promise<unknown>;
export async function callOpenAI(
  body: DecisionCreateParams,
  signal: AbortSignal,
): Promise<unknown> {
  if (!process.env.OPENAI_API_KEY)
    throw new InputError(
      "OPENAI_API_KEY is missing. Set it in the server environment or use --env-file.",
    );
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
      timeout: limits.timeoutMs,
      fetchOptions: { redirect: "error" },
      logLevel: "off",
    });
    return await client.decisions.create(body, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof OpenAI.APIError)
      throw new InputError(
        `OpenAI request failed (HTTP ${error.status ?? "unknown"}). Check API key, account access, or rate limits. No automatic retry.`,
      );
    throw new InputError(
      "OpenAI connection failed or timed out. The request may have been processed; no automatic retry.",
    );
  }
}

export class Evaluator {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(
    private readonly access: FileAccess,
    private readonly provider: DecisionProvider = callOpenAI,
  ) {}
  async decide(input: DecideInput, parentSignal: AbortSignal) {
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(limits.timeoutMs),
    ]);
    if (this.active >= limits.concurrency) {
      if (this.queue.length >= 60)
        throw new InputError(
          "Server is busy. Retry after current evaluations finish.",
        );
      await new Promise<void>((resolve, reject) => {
        const proceed = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.queue = this.queue.filter((x) => x !== proceed);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        this.queue.push(proceed);
        if (signal.aborted) abort();
      });
    } else this.active++;
    try {
      signal.throwIfAborted();
      const prepared = await prepareInput(input.sources, this.access, signal);
      const body = {
        model: "gpt-6-luna",
        input: prepared.input,
        questions: input.questions,
      };
      if (Buffer.byteLength(JSON.stringify(body)) > limits.requestBytes)
        throw new InputError(
          "Serialized request exceeds 24 MiB. Select fewer sources or pages.",
        );
      signal.throwIfAborted();
      const started = performance.now();
      const raw = await this.provider(body, signal);
      signal.throwIfAborted();
      const response = validateDecision(raw, input.questions);
      const answers = input.full
        ? response.answers
        : response.answers.map((answer) => {
            if ("probabilities" in answer) {
              const { probabilities: _omitted, ...compact } = answer;
              return compact;
            }
            return answer;
          });
      const usage = input.full
        ? response.usage
        : {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            total_tokens: response.usage.total_tokens,
          };
      return {
        model: response.model,
        answers,
        usage,
        coverage: prepared.coverage,
        upstream_ms: Math.round(performance.now() - started),
      };
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
  async batch(input: BatchInput, parentSignal: AbortSignal) {
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(120_000),
    ]);
    const results: unknown[] = new Array(input.items.length);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(limits.concurrency, input.items.length) },
        async () => {
          while (next < input.items.length) {
            const index = next++;
            const item = input.items[index]!;
            try {
              signal.throwIfAborted();
              const result = await this.decide(
                {
                  sources: item.sources,
                  questions: input.questions,
                  full: input.full,
                },
                signal,
              );
              results[index] = { id: item.id, ok: true, result };
            } catch (error) {
              results[index] = {
                id: item.id,
                ok: false,
                error: safeError(error),
              };
            }
          }
        },
      ),
    );
    return { items: results };
  }
}
