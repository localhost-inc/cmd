import { z } from "zod";

import type { CommandDefinition, CommandHelpContext } from "./types.js";
import {
  getOptionKind,
  getSchemaAliases,
  getSchemaDescription,
  getSchemaShape,
  normalizeAlias,
  toKebabCase,
} from "./schema.js";

function formatHelpOverride(
  cliName: string,
  commandPath: string | null,
  command: Pick<CommandDefinition<z.ZodObject<z.ZodRawShape>>, "help">,
): string | null {
  const helpContext: CommandHelpContext = { cliName, commandPath };
  if (typeof command.help === "function") {
    return command.help(helpContext);
  }

  if (typeof command.help === "string") {
    return command.help;
  }

  return null;
}

export function formatCommandHelp<Input extends z.ZodObject<z.ZodRawShape>>(
  cliName: string,
  commandPath: string | null,
  command: CommandDefinition<Input>,
): string {
  const override = formatHelpOverride(cliName, commandPath, command);
  if (override !== null) {
    return override;
  }

  const lines: string[] = [];
  const usage = commandPath ? `${cliName} ${commandPath}` : cliName;
  lines.push(`Usage: ${usage} [args] [flags]`);

  if (command.description) {
    lines.push("", command.description);
  }

  const shape = getSchemaShape(command.input);
  let argsDescription: string | undefined;
  const flags: Array<{ description?: string; name: string }> = [];

  for (const [key, value] of Object.entries(shape)) {
    if (key === "args") {
      argsDescription = getSchemaDescription(value);
      continue;
    }

    const flag = toKebabCase(key);
    const kind = getOptionKind(value);
    const aliasList = getSchemaAliases(value).map(normalizeAlias);
    const aliasLabel =
      aliasList.length > 0 ? `${aliasList.map((alias) => `-${alias}`).join(", ")}, ` : "";
    const placeholder = kind === "string" ? " <value>" : kind === "array" ? " <value...>" : "";
    const name = `${aliasLabel}--${flag}${placeholder}`;
    const description = getSchemaDescription(value);
    flags.push(description ? { description, name } : { name });
  }

  if (argsDescription) {
    lines.push("", `Args: ${argsDescription}`);
  } else if ("args" in shape) {
    lines.push("", "Args: Positional arguments.");
  }

  if (flags.length > 0) {
    lines.push("", "Flags:");
    const maxName = Math.max(...flags.map((flag) => flag.name.length));
    for (const flag of flags) {
      const name = flag.name.padEnd(maxName);
      const description = flag.description ? `  ${flag.description}` : "";
      lines.push(`  ${name}${description}`);
    }
  }

  return lines.join("\n");
}

export function formatNamespaceHelp(
  cliName: string,
  commandPath: string | null,
  childEntries: ReadonlyArray<{ description?: string; name: string }>,
): string {
  const lines: string[] = [];
  const usage = commandPath ? `${cliName} ${commandPath}` : cliName;
  lines.push(`Usage: ${usage} <command> [flags]`);

  if (childEntries.length > 0) {
    lines.push("", "Commands:");
    const maxName = Math.max(...childEntries.map((child) => child.name.length));
    for (const child of childEntries) {
      const name = child.name.padEnd(maxName);
      const description = child.description ? `  ${child.description}` : "";
      lines.push(`  ${name}${description}`);
    }
  }

  return lines.join("\n");
}
