import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DecisionInputPart } from "openai/resources/decisions";
import { limits } from "./schema.js";

try {
  const require = createRequire(import.meta.url);
  const base = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const task = getDocument({
    data: new Uint8Array(workerData.data),
    verbosity: VerbosityLevel.ERRORS,
    cMapUrl: path.join(base, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: path.join(base, "standard_fonts") + "/",
    wasmUrl: path.join(base, "wasm") + "/",
  });
  const doc = await task.promise;
  try {
    const pages: number[] =
      workerData.pages ??
      Array.from(
        { length: Math.min(doc.numPages, limits.pages + 1) },
        (_, i) => i + 1,
      );
    if (
      pages.length > limits.pages ||
      new Set(pages).size !== pages.length ||
      pages.some((p) => p < 1 || p > doc.numPages)
    )
      throw new Error(
        "Invalid or excessive page selection. Select up to 20 existing, unique pages.",
      );
    const parts: DecisionInputPart[] = [];
    const modes: string[] = [];
    let textBytes = 0;
    let imageBytes = 0;
    for (const number of pages) {
      const page = await doc.getPage(number);
      let text = "";
      if (workerData.mode !== "visual") {
        const content = await page.getTextContent();
        text = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("")
          .trim();
      }
      if (workerData.mode === "text" && !text)
        throw new Error(
          "Selected page has no extractable text. Use auto or visual mode.",
        );
      parts.push({ type: "input_text", text: `PDF page ${number}:` });
      if (text && workerData.mode !== "visual") {
        textBytes += Buffer.byteLength(text);
        if (textBytes > limits.textBytes)
          throw new Error("PDF text exceeds 1 MiB. Select fewer pages.");
        parts.push({ type: "input_text", text });
        modes.push("text");
      } else {
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(
          2,
          2048 / Math.max(natural.width, natural.height),
        );
        if (!Number.isFinite(scale) || scale <= 0)
          throw new Error("Invalid PDF page dimensions.");
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(
          Math.max(1, Math.ceil(viewport.width)),
          Math.max(1, Math.ceil(viewport.height)),
        );
        try {
          await page.render({
            viewport,
            canvas: canvas as unknown as HTMLCanvasElement,
          }).promise;
          const image = canvas.toBuffer("image/png");
          const image_url = `data:image/png;base64,${image.toString("base64")}`;
          imageBytes += Buffer.byteLength(image_url);
          if (imageBytes > limits.requestBytes)
            throw new Error("Rendered PDF exceeds 24 MiB. Select fewer pages.");
          parts.push({ type: "input_image", image_url });
          modes.push("image");
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      }
      page.cleanup();
    }
    parentPort!.postMessage({
      result: { parts, pages, totalPages: doc.numPages, modes },
    });
  } finally {
    await task.destroy();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const controlled =
    /^(Invalid or excessive|Selected page|PDF text exceeds|Invalid PDF page|Rendered PDF exceeds)/.test(
      message,
    );
  parentPort!.postMessage({
    error: controlled
      ? message
      : "PDF could not be processed. Encrypted, corrupt, or unsupported PDFs must be converted first.",
  });
}
