#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileAccess } from "./input.js";
import { LocalProvider } from "./local-provider.js";
import { localTools } from "./local-tools.js";
import { InputError, limits, safeError } from "./schema.js";
import { createServer } from "./server.js";

async function jsonInput(path = "-") {
  let buffer: Buffer;
  if (path === "-") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > limits.requestBytes) throw new InputError("JSON input exceeds 24 MiB.");
      chunks.push(chunk);
    }
    buffer = Buffer.concat(chunks);
  } else {
    const info = await stat(path);
    if (!info.isFile() || info.size > limits.requestBytes) throw new InputError("Supply a JSON file at most 24 MiB.");
    buffer = await readFile(path);
    if (buffer.length > limits.requestBytes) throw new InputError("JSON input exceeds 24 MiB.");
  }
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new InputError("Expected a JSON input object.");
  }
}

const help = `local-decisions [mcp | doctor | grep | decide | batch | browse] [options]
  mcp                         Start the stdio MCP server (default)
  doctor                      Check the selected D3 Flash endpoint
  grep "question" [subtree]   Find behavior in the scoped tree
  browse URL "task"           Verify a page with read-only navigation
  decide, batch               Read a JSON object from stdin
  --input FILE                Read an MCP-shaped JSON object for a tool (- for stdin)
  --root PATH                 Set the workspace root
  --allow-root PATH           Add an authorized root (repeatable)
  --env-file PATH             Load private endpoint configuration`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      "allow-root": { type: "string", multiple: true },
      "env-file": { type: "string" },
      input: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command = "mcp", ...args] = positionals;
  if (values.help) console.log(help);
  else {
    const envFile = values["env-file"];
    try {
      loadEnvFile(envFile ?? join(homedir(), ".config", "local-decisions", "env"));
    } catch (error) {
      if (envFile || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new InputError("Could not load the Local Decisions environment file.");
    }
    const root = values.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const additionalRoots = values["allow-root"];
    if (command === "mcp") {
      if (args.length || values.input) throw new InputError("Run local-decisions --help for usage.");
      const server = await createServer({ local: true, root, additionalRoots });
      await server.connect(new StdioServerTransport());
      for (const signal of ["SIGTERM", "SIGINT"] as const)
        process.once(signal, () => void server.close().finally(() => process.exit(0)));
    } else {
      const signal = AbortSignal.timeout(command === "doctor" ? 15_000 : 180_000);
      const provider = new LocalProvider();
      if (command === "doctor") {
        if (args.length || values.input) throw new InputError("Run local-decisions --help for usage.");
        console.log(JSON.stringify(await provider.doctor(signal)));
      } else {
        const access = new FileAccess(root, additionalRoots);
        await access.initialize();
        const tools = localTools(access, provider);
        if (command !== "grep" && command !== "decide" && command !== "batch" && command !== "browse")
          throw new InputError("Run local-decisions --help for usage.");
        let input: unknown;
        if (args.length === 0) input = await jsonInput(values.input);
        else if (!values.input && command === "grep" && args.length <= 2)
          input = { query: args[0], root: args[1] };
        else if (!values.input && command === "browse" && args.length === 2)
          input = { start_url: args[0], task: args[1] };
        else throw new InputError("Run local-decisions --help for usage.");
        console.log(JSON.stringify(await tools[command](input, signal)));
      }
    }
  }
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
