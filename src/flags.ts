import { parseArgs } from "node:util";
import { z } from "zod";

import type { CommandDefinition } from "./types.js";
import {
  type OptionKind,
  getOptionKind,
  getSchemaAliases,
  getSchemaMeta,
  getSchemaShape,
  normalizeAlias,
  toKebabCase,
} from "./schema.js";

type OptionSpec = {
  key: string;
  flag: string;
  kind: OptionKind;
};

export type ParsedFlags = {
  data: Record<string, unknown>;
  positionals: string[];
};

type ParseOptions = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

function registerFlag(
  spec: OptionSpec,
  specs: Map<string, OptionSpec>,
  flagToKey: Map<string, string>,
  aliasToFlag: Map<string, string>,
) {
  const existingFlag = flagToKey.get(spec.flag);
  if (existingFlag && existingFlag !== spec.key) {
    throw new Error(`Duplicate flag name: --${spec.flag}`);
  }

  const existingAlias = aliasToFlag.get(spec.flag);
  if (existingAlias && existingAlias !== spec.flag) {
    throw new Error(`Alias -${spec.flag} already maps to --${existingAlias}`);
  }

  specs.set(spec.key, spec);
  flagToKey.set(spec.flag, spec.key);
  aliasToFlag.set(spec.flag, spec.flag);
}

function registerAlias(alias: string, flag: string, aliasToFlag: Map<string, string>) {
  const normalized = normalizeAlias(alias);
  const existing = aliasToFlag.get(normalized);
  if (existing && existing !== flag) {
    throw new Error(`Alias -${normalized} already maps to --${existing}`);
  }
  aliasToFlag.set(normalized, flag);
}

function buildParseOptions(specs: Map<string, OptionSpec>): ParseOptions {
  const parseOptions: ParseOptions = {};
  for (const spec of specs.values()) {
    parseOptions[spec.flag] =
      spec.kind === "array"
        ? {
            type: "string",
            multiple: true,
          }
        : {
            type: spec.kind === "boolean" ? "boolean" : "string",
          };
  }
  return parseOptions;
}

function pushArrayValues(target: string[], flag: string, values: string[]) {
  for (const value of values) {
    if (value.startsWith("-")) {
      target.push(`--${flag}=${value}`);
    } else {
      target.push(`--${flag}`, value);
    }
  }
}

function isKnownFlagToken(
  token: string,
  aliasToFlag: Map<string, string>,
): boolean {
  if (token === "--") {
    return true;
  }

  if (token.startsWith("--no-")) {
    return aliasToFlag.has(token.slice(5));
  }

  if (token.startsWith("--")) {
    const raw = token.slice(2);
    const [name = ""] = raw.split("=", 2);
    return aliasToFlag.has(name);
  }

  if (token.startsWith("-") && token.length > 1) {
    const raw = token.slice(1);
    const [alias = ""] = raw.split("=", 2);
    return aliasToFlag.has(alias);
  }

  return false;
}

function takeArrayValues(
  args: string[],
  startIndex: number,
  aliasToFlag: Map<string, string>,
): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let index = startIndex;

  while (index + 1 < args.length) {
    const next = args[index + 1];
    if (!next) break;
    if (next === "--") {
      const rest = args.slice(index + 2);
      values.push(...rest);
      return { values, nextIndex: args.length };
    }
    if (isKnownFlagToken(next, aliasToFlag)) break;
    values.push(next);
    index += 1;
  }

  return { values, nextIndex: index };
}

export function defineFlag<T extends z.ZodTypeAny>(
  schema: T,
  config: { aliases: string | string[] },
): T {
  const list = Array.isArray(config.aliases) ? config.aliases : [config.aliases];
  const normalized = list.map(normalizeAlias);
  const meta = getSchemaMeta(schema) ?? {};
  return schema.meta({ ...meta, aliases: normalized });
}

export function parseFlags<Input extends z.ZodObject<z.ZodRawShape>>(
  args: string[],
  schema: Input,
  options?: {
    positionals?: string[];
  },
): ParsedFlags {
  const shape = getSchemaShape(schema);
  const specs = new Map<string, OptionSpec>();
  const flagToKey = new Map<string, string>();
  const aliasToFlag = new Map<string, string>();

  for (const [key, value] of Object.entries(shape)) {
    if (key === "args") continue;
    const flag = toKebabCase(key);
    const kind = getOptionKind(value);
    const spec: OptionSpec = { key, flag, kind };
    registerFlag(spec, specs, flagToKey, aliasToFlag);

    for (const alias of getSchemaAliases(value)) {
      registerAlias(alias, spec.flag, aliasToFlag);
    }
  }

  const normalizedArgs: string[] = [];
  const negatedFlags = new Set<string>();
  const positionals: string[] = options?.positionals ? [...options.positionals] : [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (token.startsWith("--no-")) {
      const name = token.slice(5);
      const flag = aliasToFlag.get(name);
      if (!flag) {
        throw new Error(`Unknown flag: --no-${name}`);
      }
      const key = flagToKey.get(flag);
      if (!key) {
        throw new Error(`Unknown flag: --no-${name}`);
      }
      const spec = specs.get(key);
      if (!spec || spec.kind !== "boolean") {
        throw new Error(`Flag --no-${name} is only valid for boolean options.`);
      }
      negatedFlags.add(flag);
      continue;
    }

    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const [name = "", inlineValue] = raw.split("=", 2);
      const flag = aliasToFlag.get(name);
      if (!flag) {
        throw new Error(`Unknown flag: --${name}`);
      }
      const key = flagToKey.get(flag);
      if (!key) {
        throw new Error(`Unknown flag: --${name}`);
      }
      const spec = specs.get(key);
      if (!spec) {
        throw new Error(`Unknown flag: --${name}`);
      }

      if (spec.kind === "boolean") {
        if (inlineValue !== undefined) {
          throw new Error(`Flag --${name} does not take a value.`);
        }
        normalizedArgs.push(`--${flag}`);
        continue;
      }

      if (spec.kind === "array") {
        if (inlineValue !== undefined) {
          normalizedArgs.push(`--${flag}=${inlineValue}`);
          continue;
        }
        const { values, nextIndex } = takeArrayValues(args, index, aliasToFlag);
        if (values.length === 0) {
          throw new Error(`Flag --${name} expects one or more values.`);
        }
        pushArrayValues(normalizedArgs, flag, values);
        index = nextIndex;
        continue;
      }

      if (inlineValue !== undefined) {
        normalizedArgs.push(`--${flag}=${inlineValue}`);
        continue;
      }

      const next = args[index + 1];
      if (!next || next === "--" || next.startsWith("-")) {
        throw new Error(`Flag --${name} expects a value.`);
      }
      normalizedArgs.push(`--${flag}`, next);
      index += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const raw = token.slice(1);
      const [alias = "", inlineValue] = raw.split("=", 2);
      const flag = aliasToFlag.get(alias);
      if (!flag) {
        throw new Error(`Unknown flag: -${alias}`);
      }
      const key = flagToKey.get(flag);
      if (!key) {
        throw new Error(`Unknown flag: -${alias}`);
      }
      const spec = specs.get(key);
      if (!spec) {
        throw new Error(`Unknown flag: -${alias}`);
      }
      if (alias.length > 1 && inlineValue === undefined) {
        throw new Error(`Short flag groups are not supported: -${alias}`);
      }

      if (spec.kind === "boolean") {
        if (inlineValue !== undefined) {
          throw new Error(`Flag -${alias} does not take a value.`);
        }
        normalizedArgs.push(`--${flag}`);
        continue;
      }

      if (spec.kind === "array") {
        if (inlineValue !== undefined) {
          normalizedArgs.push(`--${flag}=${inlineValue}`);
          continue;
        }
        const { values, nextIndex } = takeArrayValues(args, index, aliasToFlag);
        if (values.length === 0) {
          throw new Error(`Flag -${alias} expects one or more values.`);
        }
        pushArrayValues(normalizedArgs, flag, values);
        index = nextIndex;
        continue;
      }

      if (inlineValue !== undefined) {
        normalizedArgs.push(`--${flag}=${inlineValue}`);
        continue;
      }

      const next = args[index + 1];
      if (!next || next === "--" || next.startsWith("-")) {
        throw new Error(`Flag -${alias} expects a value.`);
      }
      normalizedArgs.push(`--${flag}`, next);
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  const { values, positionals: parsedPositionals } = parseArgs({
    args: normalizedArgs,
    options: buildParseOptions(specs),
    allowPositionals: true,
  });

  const data: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(values)) {
    const key = flagToKey.get(flag);
    if (!key) continue;
    data[key] = value;
  }

  for (const flag of negatedFlags) {
    const key = flagToKey.get(flag);
    if (!key) continue;
    if (data[key] !== undefined) {
      throw new Error(`Flag --${flag} cannot be combined with --no-${flag}.`);
    }
    data[key] = false;
  }

  const combinedPositionals = [...positionals, ...parsedPositionals];
  if ("args" in shape) {
    data.args = combinedPositionals;
  } else if (combinedPositionals.length > 0) {
    throw new Error(`Unexpected positional arguments: ${combinedPositionals.join(" ")}`);
  }

  return { data, positionals: combinedPositionals };
}

export function getCommandAliases<Input extends z.ZodObject<z.ZodRawShape>>(
  command: CommandDefinition<Input>,
): Set<string> {
  const shape = getSchemaShape(command.input);
  const aliases = new Set<string>();
  for (const [key, value] of Object.entries(shape)) {
    if (key === "args") continue;
    for (const alias of getSchemaAliases(value)) {
      aliases.add(normalizeAlias(alias));
    }
  }
  return aliases;
}
