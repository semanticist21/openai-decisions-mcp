import { z } from "zod";

export const limits = {
  fileBytes: 20 * 1024 * 1024,
  requestBytes: 24 * 1024 * 1024,
  textBytes: 1024 * 1024,
  pages: 20,
  batch: 20,
  concurrency: 3,
  timeoutMs: 60_000,
} as const;
const name = z.string().min(1).max(128);
const instructions = z.string().min(1).max(16_384);
const choiceValue = z.union([z.string().min(1).max(1024), z.boolean()]);
export const questionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predicate"), name, instructions }).strict(),
  z
    .object({
      type: z.literal("choice"),
      name,
      instructions,
      choices: z
        .array(
          z
            .object({
              value: choiceValue,
              description: z.string().max(4096).optional(),
            })
            .strict(),
        )
        .min(2)
        .max(100)
        .refine(
          (v) =>
            new Set(v.map((x) => JSON.stringify(x.value))).size === v.length,
          "Choice values must be unique",
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      name,
      instructions,
      levels: z
        .array(
          z
            .object({
              label: name,
              description: z.string().max(4096).optional(),
            })
            .strict(),
        )
        .min(2)
        .max(100)
        .refine(
          (v) => new Set(v.map((x) => x.label)).size === v.length,
          "Level labels must be unique",
        ),
    })
    .strict(),
]);
export const questionsSchema = z
  .array(questionSchema)
  .min(1)
  .max(100)
  .refine(
    (v) => new Set(v.map((x) => x.name)).size === v.length,
    "Question names must be unique",
  );
const fileFields = {
  path: z.string().min(1).max(4096),
  root: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Existing authorized root for relative paths when multiple roots are available; does not grant access.",
    ),
};
export const sourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().min(1).max(limits.textBytes),
    })
    .strict(),
  z
    .object({
      type: z.literal("file"),
      ...fileFields,
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ type: z.literal("image"), ...fileFields }).strict(),
  z
    .object({
      type: z.literal("pdf"),
      ...fileFields,
      pages: z
        .array(z.number().int().positive())
        .min(1)
        .max(limits.pages)
        .optional(),
      mode: z.enum(["auto", "text", "visual"]).default("auto"),
    })
    .strict(),
]);
export const sourcesSchema = z.array(sourceSchema).min(1).max(20);
// Some MCP clients encode top-level arrays as JSON strings. Decode once at the boundary.
function jsonArray<T extends z.ZodType>(schema: T) {
  return z.union([
    schema,
    z.string().max(limits.requestBytes).transform((value, ctx) => {
      if (Buffer.byteLength(value) > limits.requestBytes) {
        ctx.addIssue({ code: "custom", message: "JSON array exceeds 24 MiB." });
        return z.NEVER;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Expected an array or a valid JSON-encoded array." });
        return z.NEVER;
      }
      const result = schema.safeParse(decoded);
      if (!result.success) {
        for (const issue of result.error.issues)
          ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
        return z.NEVER;
      }
      return result.data;
    }),
  ]).describe("Prefer a native JSON array. A JSON-encoded array string is also accepted for client compatibility; identical validation applies.");
}
export const decideShape = {
  sources: jsonArray(sourcesSchema),
  questions: jsonArray(questionsSchema),
  full: z.boolean().default(false),
};
export const decideSchema = z.object(decideShape).strict();
export const batchShape = {
  items: jsonArray(z
    .array(z.object({ id: name, sources: sourcesSchema }).strict())
    .min(1)
    .max(limits.batch)
    .refine(
      (v) => new Set(v.map((x) => x.id)).size === v.length,
      "Item IDs must be unique",
    )),
  questions: jsonArray(questionsSchema),
  full: z.boolean().default(false),
};
export const batchSchema = z.object(batchShape).strict();
export const findShape = {
  files: jsonArray(z.array(z.object({
    ...fileFields,
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  }).strict()).min(1).max(20)),
  query: instructions.describe("Self-contained question about the code to locate."),
};
export const findSchema = z.object(findShape).strict();
export type FindInput = z.infer<typeof findSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Question = z.infer<typeof questionSchema>;
export type DecideInput = z.infer<typeof decideSchema>;
export type BatchInput = z.infer<typeof batchSchema>;
export class InputError extends Error {}
export function safeError(error: unknown): string {
  if (error instanceof InputError) return error.message;
  if (error instanceof z.ZodError)
    return (
      "Invalid input: " +
      error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")
    );
  if (
    error instanceof Error &&
    ["AbortError", "TimeoutError"].includes(error.name)
  )
    return "Request cancelled or timed out; no automatic replay.";
  return "Operation failed. Check file access, file format, and API configuration. Content and provider error bodies are not logged.";
}
