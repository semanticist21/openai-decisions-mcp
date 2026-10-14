# openai-decisions-mcp

Local MCP tools for OpenAI's Decisions API: classify, filter, and score text, project files, images, and PDF pages. Independent community project; not affiliated with OpenAI. MIT licensed.

## Install

Requires Node.js 22.13+ (Node 24 recommended). npm distribution: `npx -y openai-decisions-mcp`. Alternatively, clone this repository, run `npm ci && npm run build`, and use `node /absolute/path/openai-decisions-mcp/dist/cli.js` instead.

Supply `OPENAI_API_KEY` through the server environment, or put it in a private environment file outside the repository (Unix: `chmod 600`) and pass `--env-file /absolute/path/credentials.env`. ChatGPT OAuth/subscriptions are not used. The server never reads other apps' credentials.

```sh
codex mcp add openai-decisions -- npx -y openai-decisions-mcp --env-file /absolute/path/credentials.env
claude mcp add --scope user --transport stdio openai-decisions -- npx -y openai-decisions-mcp --env-file /absolute/path/credentials.env
```

Restart the client session after registration. Install the bundled `skills/openai-decisions` folder into `~/.codex/skills/` and/or `~/.claude/skills/`; when installing from npm, find it inside the installed package. The skill guides usage; it does not force every judgment through this tool.

## Tools

`decide({sources,questions,full?})` evaluates shared evidence against independent questions. `evaluate_batch({items:[{id,sources}],questions,full?})` applies the same questions independently to up to 20 items. Each valid item makes one paid request; up to 3 evaluations run concurrently per server process. No automatic retries or successful-item replay.

```json
{"sources":[{"type":"file","path":"src/auth.ts"}],"questions":[{"name":"relevant","type":"predicate","instructions":"Does this source implement login or session validation?"}]}
```

Source types: `{type:"text",text}`, `{type:"file",path,start_line?,end_line?}`, `{type:"image",path}`, `{type:"pdf",path,pages?,mode?}`. Text files are UTF-8; images are PNG/JPEG/WebP. Lines/pages are one-based. `root` optionally selects an already-authorized root for relative file paths. Combine sources to provide evidence and criteria together.

Questions have unique `name`, `instructions`, and `type`: `predicate` returns a probability; `choice` takes `choices:[{value,description?}]` (string/boolean values); `score` takes ordered `levels:[{label,description?}]` and returns a fractional zero-based index. Use 1–100 questions, 2–100 choices/levels. No fixed categories, thresholds, or action policy are imposed.

Compact results include answers, confidence where supplied, token usage, upstream latency, and coverage. `full:true` additionally retains every option's probability and usage details. Refusals stay refusals. Batch errors are returned by item ID in input order. No input text is echoed. Probabilities are model judgments, not proof or authorization.
`find_code({files:[{path,root?,start_line?,end_line?}],query})` locates relevant ranges in candidate files without returning their contents. List candidate paths with your normal file tools first. It evaluates all 200-line chunks with 20-line overlap, returning every probability, refusal, error, location and SHA-256 of the selected UTF-8 text with CRLF normalized to LF. Maximum 20 chunks and 1 MiB total selected text; oversized scopes fail before paid calls. Each chunk is one paid request. No directory crawling, hidden filtering, or automatic Read interception. Chunk results do not establish cross-file behavior or prove absence; read surrounding code/dependencies before acting. Each call sees only its supplied evidence, not earlier calls or the host conversation.

## Files and PDFs

The current project is automatic: MCP Roots take precedence; without Roots, the server uses `--root`, `CLAUDE_PROJECT_DIR`, then its startup working directory. Roots changes revoke previous project access. `--allow-root PATH` adds explicit external folders. With multiple project roots, use absolute paths or select an authorized `root`. Roots failure/empty Roots disables project-file access while preserving explicit extra roots and direct text input. File paths cannot grant access themselves; symlink escapes are rejected. This is application-level checking, not an OS sandbox against concurrent filesystem mutation.

PDF `auto` extracts each selected page's text and renders pages without text. `visual` renders every selected page for layout, tables, and diagrams; `text` rejects textless pages. Auto does not detect every mixed text/image layout—choose visual when appearance matters. PDF.js and the packaged canvas dependency perform local processing without a system PDF application. Encrypted PDFs must be decrypted separately. No Office document conversion or URL fetching.

Limits per evaluation: 20 sources, 20 MiB per file, 1 MiB extracted/direct text, 20 PDF pages, 128 image parts, 24 MiB serialized request. Raster pages are at most 2048 pixels on the longest side and 2× PDF scale. A PDF worker has a 256 MiB JS heap limit and a 20-second deadline; native allocations are not included in the heap limit. Evaluations have a 60-second deadline including queue time. Batches have a 120-second overall deadline; set client timeout to at least 180 seconds. Oversized inputs fail rather than truncate; choose explicit ranges. Coverage identifies selected scope, not whether evidence is sufficient to answer a question.

Selected content goes to `https://api.openai.com/v1/decisions` using `gpt-6-luna`. No server-side content/key logging or persistent conversion files. Clients may retain tool arguments/results. API errors are redacted, redirects rejected, and failed/timed-out requests are not replayed automatically. Read-only tools still transmit data and incur API charges.

## Verify and develop

`npm test` builds and runs offline file/PDF/schema/concurrency/cancellation and MCP protocol tests. `npm pack --dry-run` checks distribution contents. CI covers Node 22/24 on Linux/macOS/Windows. A green local run does not establish results on other platforms.

`OPENAI_API_KEY=... npm run smoke` runs a paid synthetic live MCP request. `OPENAI_API_KEY=... npm run benchmark` compares direct host classification with a real host function-call → MCP → Decisions → host path, including argument/result tokens. `BENCHMARK_MODEL` defaults to `gpt-6.1-sol`. It reports correctness, separate host/Decisions usage, and elapsed time—not an assumed savings percentage. Actual live results require a working key; no general token-savings claim is made.

References: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [MCP Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots). Design references: [ask-jev](https://github.com/timlevett/ask-jev) (generic typed questions), [mcp-server-jev](https://github.com/MattiooFR/mcp-server-jev) (batch/error boundaries), [jev-mcp](https://github.com/burnigtm/jev-mcp) (usage guidance). [Jev](https://github.com/BorisLeMeec/jev) inspired returning code locations instead of full contents. Implementation is independent; Jev-specific schemas, thresholds, and routing policies are not copied.
