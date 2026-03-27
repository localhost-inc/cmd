import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";

import type { CommandDefinition } from "./types.js";
import { getSchemaShape } from "./schema.js";

export interface RunMcpOptions {
  /** MCP server name (e.g. "lifecycle"). */
  name: string;
  version: string;
  /** Base directory containing `commands/` — same as `runCli`. */
  baseDir: string;
  /** File extensions to scan (default: ["ts", "js"]). */
  commandExtensions?: string[];
  /** Commands matching these paths are excluded from MCP tool registration. */
  exclude?: string[];
}

type AnyCommand = CommandDefinition<z.ZodObject<z.ZodRawShape>>;

async function discoverCommands(
  baseDir: string,
  extensions: readonly string[],
): Promise<Map<string, { command: AnyCommand; filePath: string }>> {
  const commands = new Map<string, { command: AnyCommand; filePath: string }>();

  for (const ext of extensions) {
    const glob = new Bun.Glob(`commands/**/*.${ext}`);
    for await (const file of glob.scan({ cwd: baseDir })) {
      const normalized = file.replace(/\\/g, "/");
      const name = normalized.replace(/^commands\//, "").replace(/\.(ts|js)$/, "");

      // Skip private modules.
      if (name.split("/").some((segment) => segment.startsWith("_"))) {
        continue;
      }

      const fullPath = path.join(baseDir, normalized);
      const url = pathToFileURL(fullPath).toString();
      const module = await import(url);
      if (!module.default || module.default.kind !== "command") continue;

      commands.set(name, { command: module.default as AnyCommand, filePath: normalized });
    }
  }

  return commands;
}

function commandPathToToolName(prefix: string, commandPath: string): string {
  return `${prefix}.${commandPath.replace(/\//g, ".")}`;
}

function extractInputSchema(command: AnyCommand): Record<string, z.ZodTypeAny> | null {
  const shape = getSchemaShape(command.input);
  const keys = Object.keys(shape);

  // Skip commands with no meaningful input (only json flag, etc.).
  const meaningfulKeys = keys.filter((k) => k !== "json" && k !== "args");

  if (meaningfulKeys.length === 0 && keys.length <= 1) {
    return {};
  }

  // Build a plain shape object for the MCP tool — filter out CLI-only flags.
  const mcpShape: Record<string, z.ZodTypeAny> = {};
  for (const key of keys) {
    if (key === "json") continue; // CLI-only
    mcpShape[key] = shape[key]!;
  }

  return mcpShape;
}

export async function runMcp(options: RunMcpOptions): Promise<void> {
  const extensions = options.commandExtensions ?? ["ts", "js"];
  const exclude = new Set(options.exclude ?? ["mcp"]);
  const commands = await discoverCommands(options.baseDir, extensions);

  const server = new McpServer({
    name: options.name,
    version: options.version,
  });

  for (const [commandPath, { command }] of commands) {
    if (exclude.has(commandPath)) continue;

    const toolName = commandPathToToolName(options.name, commandPath);
    const description = command.description ?? toolName;
    const inputSchema = extractInputSchema(command);
    if (inputSchema === null) continue;

    server.tool(toolName, description, inputSchema, async (params) => {
      const output: string[] = [];
      const errors: string[] = [];

      // Force JSON mode when available so we get structured output.
      const input = { ...params, json: true };
      const parsed = command.input.safeParse(input);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
            },
          ],
        };
      }

      try {
        const code = await command.run(parsed.data, {
          argv: [],
          cliName: options.name,
          commandPath,
          positionals: [],
          stderr: (msg) => errors.push(msg),
          stdout: (msg) => output.push(msg),
        });

        const text = output.join("\n") || errors.join("\n") || "(no output)";
        if (code !== 0 && code !== undefined) {
          return { isError: true, content: [{ type: "text" as const, text }] };
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
