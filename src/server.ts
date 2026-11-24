import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { FileAccess } from "./input.js";
import { findCode } from "./find.js";
import { Evaluator, type DecisionProvider } from "./evaluate.js";
import {
  decideShape,
  decideSchema,
  batchShape,
  batchSchema,
  findShape,
  findSchema,
  safeError,
} from "./schema.js";

export async function createServer(
  options: {
    root?: string;
    additionalRoots?: string[];
    provider?: DecisionProvider;
    local?: boolean;
  } = {},
) {
  const access = new FileAccess(
    options.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    options.additionalRoots,
  );
  await access.initialize();
  const evaluator = new Evaluator(access, options.provider);
  const server = new McpServer(
    { name: options.local ? "local-decisions" : "openai-decisions-mcp", version: "0.2.1" },
    {
      instructions: options.local
        ? "Use D3 Flash on this machine or a configured private SSH tunnel for scoped search, typed decisions, and read-only browser QA. Verify the returned evidence."
        : "Evaluate supplied evidence with OpenAI Decisions. Choose questions and actions yourself. Use file paths to avoid copying long inputs. No file writes or action execution. Probabilities are judgments, not factual proof or authorization.",
    },
  );
  let rootsReady: Promise<void> = Promise.resolve();
  const refreshRoots = () => {
    rootsReady = rootsReady
      .catch(() => {})
      .then(async () => {
        await access.setRoots([]);
        const { roots } = await server.server.listRoots({}, { timeout: 5000 });
        await access.setRoots(
          roots
            .filter((root) => root.uri.startsWith("file:"))
            .map((root) => root.uri),
        );
      })
      .catch(() => {
        console.error(
          "Workspace roots unavailable; file access restricted to explicit additional roots.",
        );
      });
  };
  server.server.oninitialized = () => {
    if (server.server.getClientCapabilities()?.roots) refreshRoots();
  };
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    () => {
      if (server.server.getClientCapabilities()?.roots) refreshRoots();
    },
  );
  if (options.local) {
    const { localTools, grepShape, browseShape } = await import("./local-tools.js");
    const local = localTools(access);
    const localHandler = (run: (args: unknown, signal: AbortSignal) => Promise<unknown>) =>
      async (args: unknown, extra: { signal: AbortSignal }) => {
        try {
          await rootsReady;
          const result = await run(args, extra.signal);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: safeError(error) }] };
        }
      };
    const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
    server.registerTool("grep", {
      description: "Find where a behavior is implemented within a project subtree or specified file ranges. Scope the search tightly. Verify returned locations in the source.",
      inputSchema: grepShape, annotations,
    }, localHandler(local.grep));
    server.registerTool("decide", {
      description: "Apply typed questions to text, files, images or PDF pages using D3 Flash.",
      inputSchema: decideShape, annotations,
    }, localHandler(local.decide));
    server.registerTool("batch", {
      description: "Apply common typed questions to independent inputs. Returns per-item results and errors in order.",
      inputSchema: batchShape, annotations,
    }, localHandler(local.batch));
    server.registerTool("browse", {
      description: "Run read-only QA on an approved site. Navigation and resources are limited to the starting origin.",
      inputSchema: browseShape, annotations,
    }, localHandler(local.browse));
    return server;
  }
  server.registerTool(
    "decide",
    {
      description:
        "Evaluate text, project files, images or PDF pages against caller-defined predicate, choice or score questions. Batch independent questions about shared evidence. Use paths instead of copying files. Returns compact answers and coverage; full=true includes all probabilities. Makes a paid OpenAI API request.",
      inputSchema: decideShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        await rootsReady;
        const result = await evaluator.decide(
          decideSchema.parse(args),
          extra.signal,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: safeError(error) }],
        };
      }
    },
  );
  server.registerTool(
    "evaluate_batch",
    {
      description:
        "Apply common typed questions independently to up to 20 named items, each containing text or file/image/PDF sources. At most 3 evaluations run concurrently. Returns per-item results/errors in input order; never replays successful items. Paid requests: one per valid item. Caller chooses the criteria and subsequent selection.",
      inputSchema: batchShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        await rootsReady;
        const result = await evaluator.batch(
          batchSchema.parse(args),
          extra.signal,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: safeError(error) }],
        };
      }
    },
  );
  server.registerTool("find_code", {
    description: "Locate relevant code within caller-supplied project files or line ranges. Evaluates every 200-line chunk with 20-line overlap, returns paths/ranges and relevance probabilities without code text. Discover candidate paths with your normal file listing first. Maximum 20 chunks and 1 MiB total text; oversized scopes fail before any paid call. One paid request per chunk, up to 3 concurrently. Returns every result, refusal and error; no automatic filtering or Read hook. Independent chunks cannot establish cross-file behavior.",
    inputSchema: findShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    try {
      await rootsReady;
      const result = await findCode(findSchema.parse(args), access, evaluator, extra.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: safeError(error) }] };
    }
  });
  return server;
}
