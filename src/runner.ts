import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError, z } from "zod";
import type { z as zType } from "zod";

import type { CommandDefinition, CommandIo } from "./types.js";
import { getCommandAliases, parseFlags } from "./flags.js";
import { formatCommandHelp, formatNamespaceHelp } from "./help.js";
import { getSchemaShape } from "./schema.js";

export type RunCliOptions = {
  name: string;
  baseDir: string;
  argv?: string[];
  commandExtensions?: string[];
  /** Relative path to a command file used when no subcommand is given. */
  defaultCommandPath?: string;
  io?: CliIo;
  /** Enable `<name> mcp` subcommand that starts an MCP stdio server. */
  mcp?: { version: string };
};

export type CliIo = CommandIo;

type AnyCommand = CommandDefinition<zType.ZodObject<zType.ZodRawShape>>;

type CommandMatch = {
  command: AnyCommand;
  depth: number;
  path: string;
};

type ChildEntry = {
  description?: string;
  name: string;
};

let commandIndex: Map<string, Set<string>> = new Map();

const defaultIo: CliIo = {
  stderr: (message) => console.error(message),
  stdout: (message) => console.log(message),
};

async function getCommandIndex(
  baseDir: string,
  commandExtensions: readonly string[],
): Promise<Set<string>> {
  const key = `${baseDir}:${commandExtensions.join(",")}`;
  const cached = commandIndex.get(key);
  if (cached) return cached;
  const index = new Set<string>();
  for (const extension of commandExtensions) {
    const glob = new Bun.Glob(`commands/**/*.${extension}`);
    for await (const file of glob.scan({ cwd: baseDir })) {
      index.add(file.replace(/\\/g, "/"));
    }
  }
  commandIndex.set(key, index);
  return index;
}

function splitArgs(args: string[]) {
  const segments: string[] = [];
  const flagArgs: string[] = [];
  let sawFlag = false;

  for (const arg of args) {
    if (!sawFlag && (arg === "--" || arg.startsWith("-"))) {
      sawFlag = true;
    }

    if (sawFlag) {
      flagArgs.push(arg);
    } else {
      segments.push(arg);
    }
  }

  return { segments, flagArgs };
}

async function importCommand(baseDir: string, relativePath: string): Promise<AnyCommand> {
  const fullPath = path.join(baseDir, relativePath);
  const url = pathToFileURL(fullPath).toString();
  const module = await import(url);
  if (!module.default) {
    throw new Error(`Command module "${relativePath}" has no default export.`);
  }
  return module.default as AnyCommand;
}

function isPrivateModuleName(name: string): boolean {
  return name.startsWith("_");
}

function findCommandRelativePath(
  segments: string[],
  index: Set<string>,
  commandExtensions: readonly string[],
): { depth: number; relativePath: string } | null {
  for (let depth = segments.length; depth > 0; depth -= 1) {
    for (const extension of commandExtensions) {
      const relativePath = `commands/${segments.slice(0, depth).join("/")}.${extension}`;
      const fileName = path.basename(relativePath);
      const moduleName = fileName.replace(/\.(ts|js)$/, "");
      if (isPrivateModuleName(moduleName)) {
        continue;
      }
      if (index.has(relativePath)) {
        return { depth, relativePath };
      }
    }
  }

  return null;
}

function printZodError(error: ZodError, io: CliIo) {
  io.stderr("Invalid arguments:");
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "args";
    io.stderr(`- ${path}: ${issue.message}`);
  }
}

function hasHelpAlias(command: AnyCommand): boolean {
  return getCommandAliases(command).has("h");
}

function isHelpRequested(flagArgs: string[], command: AnyCommand): boolean {
  const hasLongHelp = flagArgs.some((arg) => arg === "--help" || arg.startsWith("--help="));
  if (hasLongHelp) return true;
  const hasShortHelp = flagArgs.some((arg) => arg === "-h" || arg.startsWith("-h="));
  if (!hasShortHelp) return false;
  return !hasHelpAlias(command);
}

function commandAcceptsPositionals(command: AnyCommand): boolean {
  return "args" in getSchemaShape(command.input);
}

function namespaceExists(index: Set<string>, commandPath: string | null): boolean {
  const prefix = commandPath ? `commands/${commandPath.replace(/ /g, "/")}/` : "commands/";
  for (const entry of index) {
    if (entry.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

async function listChildEntries(
  baseDir: string,
  index: Set<string>,
  commandPath: string | null,
): Promise<ChildEntry[]> {
  const prefix = commandPath ? `commands/${commandPath.replace(/ /g, "/")}/` : "commands/";
  const childEntriesByName = new Map<string, ChildEntry>();

  for (const entry of index) {
    if (!entry.startsWith(prefix)) {
      continue;
    }

    const remainder = entry.slice(prefix.length);
    if (remainder.length === 0) {
      continue;
    }

    const [head = ""] = remainder.split("/", 1);
    if (!head) {
      continue;
    }

    if (!head.includes(".")) {
      if (isPrivateModuleName(head)) {
        continue;
      }
      if (!childEntriesByName.has(head)) {
        childEntriesByName.set(head, { name: head });
      }
      continue;
    }

    const childName = head.replace(/\.(ts|js)$/, "");
    if (childName.length === 0 || isPrivateModuleName(childName)) {
      continue;
    }

    const relativePath = `${prefix}${head}`;
    const command = await importCommand(baseDir, relativePath);
    childEntriesByName.set(
      childName,
      command.description
        ? { description: command.description, name: childName }
        : { name: childName },
    );
  }

  return [...childEntriesByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function resolveCommand(
  segments: string[],
  baseDir: string,
  index: Set<string>,
  commandExtensions: readonly string[],
  defaultCommandPath?: string,
): Promise<CommandMatch | null> {
  if (segments.length === 0 && defaultCommandPath) {
    if (!index.has(defaultCommandPath)) {
      return null;
    }
    const command = await importCommand(baseDir, defaultCommandPath);
    return { command, depth: 0, path: "" };
  }

  const commandMatch = findCommandRelativePath(segments, index, commandExtensions);
  if (!commandMatch) {
    return null;
  }

  const command = await importCommand(baseDir, commandMatch.relativePath);
  return {
    command,
    depth: commandMatch.depth,
    path: segments.slice(0, commandMatch.depth).join(" "),
  };
}

function resolveNamespaceDepth(segments: string[], index: Set<string>): number {
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const commandPath = depth === 0 ? null : segments.slice(0, depth).join(" ");
    if (namespaceExists(index, commandPath)) {
      return depth;
    }
  }

  return -1;
}

export async function runCli(options: RunCliOptions) {
  const argv = options.argv ?? Bun.argv.slice(2);
  const io = options.io ?? defaultIo;

  const { segments, flagArgs } = splitArgs(argv);

  // When mcp is enabled, `<name> mcp` starts an MCP stdio server that
  // exposes all discovered commands as tools.
  if (options.mcp && segments.length === 1 && segments[0] === "mcp") {
    const { runMcp } = await import("./mcp.js");
    await runMcp({
      name: options.name,
      version: options.mcp.version,
      baseDir: options.baseDir,
      ...(options.commandExtensions ? { commandExtensions: options.commandExtensions } : {}),
    });
    await new Promise(() => {});
    return 0;
  }
  const commandExtensions = options.commandExtensions ?? ["ts", "js"];
  const index = await getCommandIndex(options.baseDir, commandExtensions);

  const namespaceDepth = resolveNamespaceDepth(segments, index);
  const commandMatch = await resolveCommand(segments, options.baseDir, index, commandExtensions, options.defaultCommandPath);

  const isDefaultCommand = commandMatch !== null && commandMatch.depth === 0 && options.defaultCommandPath;
  const shouldRenderNamespace =
    namespaceDepth >= 0 && (!commandMatch || namespaceDepth >= commandMatch.depth) && !isDefaultCommand;

  if (shouldRenderNamespace) {
    const namespacePath = namespaceDepth === 0 ? null : segments.slice(0, namespaceDepth).join(" ");
    const remainingSegments = segments.slice(namespaceDepth);

    if (remainingSegments.length > 0) {
      io.stderr(`Unknown command: ${options.name} ${segments.join(" ")}`);
      return 1;
    }

    if (
      flagArgs.length > 0 &&
      !flagArgs.every(
        (arg) =>
          arg === "--help" || arg === "-h" || arg.startsWith("--help=") || arg.startsWith("-h="),
      )
    ) {
      io.stderr(`Unknown command: ${options.name} ${segments.join(" ")}`);
      return 1;
    }

    const childEntries = await listChildEntries(options.baseDir, index, namespacePath);
    io.stdout(formatNamespaceHelp(options.name, namespacePath, childEntries));
    return 0;
  }

  if (!commandMatch) {
    io.stderr(`Unknown command: ${options.name} ${segments.join(" ")}`);
    return 1;
  }

  const positionals = segments.slice(commandMatch.depth);

  if (
    positionals.length > 0 &&
    !commandAcceptsPositionals(commandMatch.command) &&
    namespaceExists(index, commandMatch.path)
  ) {
    io.stderr(`Unknown command: ${options.name} ${segments.join(" ")}`);
    return 1;
  }

  if (isHelpRequested(flagArgs, commandMatch.command)) {
    io.stdout(formatCommandHelp(options.name, commandMatch.path || null, commandMatch.command));
    return 0;
  }

  let parsedInput: Record<string, unknown>;

  try {
    const parsed = parseFlags(flagArgs, commandMatch.command.input, {
      positionals,
    });
    parsedInput = parsed.data;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const result = commandMatch.command.input.safeParse(parsedInput);
  if (!result.success) {
    printZodError(result.error, io);
    return 1;
  }

  try {
    return (
      (await commandMatch.command.run(result.data, {
        argv,
        cliName: options.name,
        commandPath: commandMatch.path || null,
        positionals,
        stderr: io.stderr,
        stdout: io.stdout,
      })) ?? 0
    );
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
