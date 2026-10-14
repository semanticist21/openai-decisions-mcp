import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DecisionInputPart } from 'openai/resources/decisions';
import { InputError, limits, type Source } from './schema.js';

export class FileAccess {
  private projectRoots: string[] = [];
  private extras: string[] = [];
  constructor(private readonly fallback?: string, private readonly additional: string[] = []) {}
  async initialize() {
    this.extras = await Promise.all(this.additional.map(p => realpath(p)));
    if (this.fallback) this.projectRoots = [await realpath(this.fallback)];
  }
  async setRoots(uris: string[]) {
    // Revoke stale roots before resolving a changed workspace, including failed updates.
    this.projectRoots = [];
    this.projectRoots = await Promise.all(uris.map(uri => realpath(fileURLToPath(uri))));
  }
  async read(source: Exclude<Source, { type: 'text' }>) {
    const roots = [...this.projectRoots, ...this.extras];
    if (!roots.length) throw new InputError('No project root available. Configure --root or use a client providing MCP Roots.');
    let candidate = source.path;
    if (!path.isAbsolute(candidate)) {
      let base: string;
      if (source.root) {
        base = await realpath(source.root);
        if (!roots.includes(base)) throw new InputError('Requested root is not an authorized root.');
      } else {
        if (this.projectRoots.length !== 1) throw new InputError('Relative path is ambiguous. Specify an authorized root or an absolute path.');
        base = this.projectRoots[0]!;
      }
      candidate = path.resolve(base, candidate);
    }
    const resolved = await realpath(candidate);
    const allowed = roots.some(root => { const rel = path.relative(root, resolved); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); });
    if (!allowed) throw new InputError('File is outside the current project and additional allowed roots.');
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new InputError('Only regular files can be evaluated.');
      if (info.size > limits.fileBytes) throw new InputError('File exceeds 20 MiB. Split the file before evaluation.');
      const current = await stat(await realpath(candidate));
      if (current.dev !== info.dev || current.ino !== info.ino || await realpath(candidate) !== resolved) throw new InputError('File changed during access validation; retry with a stable file.');
      const buffer = Buffer.alloc(Math.min(info.size + 1, limits.fileBytes + 1));
      let size = 0;
      while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > info.size) throw new InputError('File grew during reading; retry with a stable file.');
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }
}

export interface Coverage { source: number; type: Source['type']; complete: boolean; scope: string; modes?: string[] }
export async function prepareInput(sources: Source[], access: FileAccess, signal: AbortSignal) {
  const parts: DecisionInputPart[] = [];
  const coverage: Coverage[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  let imageCount = 0;
  let pdfPages = 0;
  for (const [index, source] of sources.entries()) {
    signal.throwIfAborted();
    const sourceParts: DecisionInputPart[] = [];
    let item: Coverage = { source: index, type: source.type, complete: true, scope: 'entire input' };
    if (source.type === 'text') sourceParts.push({ type: 'input_text', text: source.text });
    else {
      const data = await access.read(source);
      signal.throwIfAborted();
      if (source.type === 'file') {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new InputError('Text files must be UTF-8. Use image or pdf for binary documents.'); }
        if (text.includes('\0')) throw new InputError('Binary data is not accepted as a text file.');
        const lines = text.split(/\r?\n/);
        const start = source.start_line ?? 1;
        const end = source.end_line ?? lines.length;
        if (start > end || end > lines.length) throw new InputError('Line range is outside the file.');
        sourceParts.push({ type: 'input_text', text: lines.slice(start - 1, end).join('\n') });
        item = { ...item, complete: start === 1 && end === lines.length, scope: `lines ${start}-${end} of ${lines.length}` };
      } else if (source.type === 'image') {
        let mime: string;
        if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
        else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mime = 'image/jpeg';
        else if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
        else throw new InputError('Supported image formats: PNG, JPEG, WebP.');
        sourceParts.push({ type: 'input_image', image_url: `data:${mime};base64,${data.toString('base64')}` });
      } else {
        const result = await renderPdf(data, source.pages, source.mode, signal);
        pdfPages += result.pages.length;
        if (pdfPages > limits.pages) throw new InputError('At most 20 PDF pages per evaluation. Specify a smaller page range.');
        sourceParts.push(...result.parts);
        item = { ...item, complete: result.pages.length === result.totalPages, scope: `pages ${result.pages.join(',')} of ${result.totalPages}`, modes: result.modes };
      }
    }
    parts.push({ type: 'input_text', text: `Source ${index + 1} (${source.type}; ${item.scope}):` });
    for (const part of sourceParts) {
      if (part.type === 'input_text') textBytes += Buffer.byteLength(part.text);
      else { imageCount++; imageBytes += Buffer.byteLength(part.image_url); }
      if (textBytes > limits.textBytes || imageBytes > limits.requestBytes || imageCount > 128) throw new InputError('Input exceeds text (1 MiB), image count (128), or request size limits. Select a smaller scope.');
      parts.push(part);
    }
    coverage.push(item);
  }
  return { input: [{ role: 'user' as const, content: parts }], coverage };
}
interface PdfResult { parts: DecisionInputPart[]; pages: number[]; totalPages: number; modes: string[] }
export function renderPdf(data: Buffer, pages: number[] | undefined, mode: string, signal: AbortSignal): Promise<PdfResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { workerData: { data, pages, mode }, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
    // PDF.js diagnostics may contain document content; never forward worker output.
    worker.stdout.resume(); worker.stderr.resume();
    const stop = () => { void worker.terminate(); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { void worker.terminate(); reject(new InputError('PDF processing exceeded 20 seconds. Select fewer pages.')); }, 20_000);
    worker.once('message', (message: { result?: PdfResult; error?: string }) => {
      if (message.result) resolve(message.result); else reject(new InputError(message.error ?? 'PDF processing failed.'));
      void worker.terminate();
    });
    worker.once('error', () => reject(new InputError('PDF processing failed or exceeded its memory limit.')));
    worker.once('exit', code => { clearTimeout(timer); signal.removeEventListener('abort', stop); if (code !== 0) reject(new InputError('PDF worker stopped before completion.')); });
  });
}
