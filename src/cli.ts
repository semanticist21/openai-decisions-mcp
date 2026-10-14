#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadEnvFile } from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

try {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      "allow-root": { type: "string", multiple: true },
      "env-file": { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "openai-decisions-mcp [--root PATH] [--allow-root PATH ...] [--env-file PATH]\nLocal stdio MCP. Reads current project via client Roots, CLAUDE_PROJECT_DIR, or cwd.\nRequires OPENAI_API_KEY for evaluation. No OAuth. See README for limits.",
    );
  } else if (values.version) console.log("0.2.0");
  else {
    if (values["env-file"]) loadEnvFile(values["env-file"]);
    const server = await createServer({
      root: values.root,
      additionalRoots: values["allow-root"],
    });
    await server.connect(new StdioServerTransport());
    process.once("SIGTERM", () => {
      void server.close().finally(() => process.exit(0));
    });
    process.once("SIGINT", () => {
      void server.close().finally(() => process.exit(0));
    });
  }
} catch {
  console.error(
    "Could not start openai-decisions-mcp. Check arguments, project directories, and the optional environment file.",
  );
  process.exitCode = 1;
}
