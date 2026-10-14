import { createHash } from "node:crypto";
import { FileAccess, prepareInput } from "./input.js";
import { Evaluator } from "./evaluate.js";
import { InputError, limits, type FindInput } from "./schema.js";

// Overlap preserves nearby context; cross-file relationships still need joint evidence.
const chunkLines = 200;
const overlap = 20;

export async function findCode(
  input: FindInput,
  access: FileAccess,
  evaluator: Evaluator,
  parentSignal: AbortSignal,
) {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(120_000)]);
  const chunks: { path: string; root?: string; start_line: number; end_line: number; source_sha256: string; text: string }[] = [];
  let bytes = 0;
  // Validate the complete requested scope before making any paid calls.
  for (const file of input.files) {
    const prepared = await prepareInput([{ type: "file", ...file }], access, signal);
    const content = prepared.input[0]!.content[1]!;
    if (content.type !== "input_text") throw new InputError("Expected UTF-8 code.");
    bytes += Buffer.byteLength(content.text);
    if (bytes > limits.textBytes) throw new InputError("Search scope exceeds 1 MiB. Select fewer files or explicit line ranges.");
    const lines = content.text.split("\n");
    const base = file.start_line ?? 1;
    const source_sha256 = createHash("sha256").update(content.text).digest("hex");
    for (let start = 0; start < lines.length; start += chunkLines - overlap) {
      const end = Math.min(start + chunkLines, lines.length);
      if (chunks.length >= limits.batch) throw new InputError("Search scope exceeds 20 chunks of 200 lines. Select fewer files or explicit line ranges; nothing was evaluated.");
      const text = lines.slice(start, end).map((line, i) => `${base + start + i}: ${line}`).join("\n");
      if (Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(file.path)) + 7 > limits.textBytes) throw new InputError("Numbered search chunk exceeds 1 MiB. Select a smaller line range.");
      chunks.push({
        path: file.path, root: file.root,
        start_line: base + start, end_line: base + end - 1, source_sha256,
        text,
      });
      if (end === lines.length) break;
    }
  }
  const batch = await evaluator.batch({
    items: chunks.map((chunk, index) => ({
      id: String(index),
      sources: [{ type: "text", text: `File: ${JSON.stringify(chunk.path)}\n${chunk.text}` }],
    })),
    questions: [{ name: "relevant", type: "predicate", instructions: input.query }],
    full: false,
  }, signal);
  return {
    scope: "Only the supplied files/ranges; each chunk is evaluated independently. Low probability is not proof of absence. Read surrounding code and dependencies before acting.",
    chunk_lines: chunkLines, overlap_lines: overlap,
    chunks: chunks.map(({ text: _text, ...location }, index) => ({ ...location, ...batch.items[index]! })),
  };
}
