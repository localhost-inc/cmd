import { z } from "zod";

export type OptionKind = "boolean" | "string" | "array";

type ZodCtor = new (...args: never[]) => z.ZodTypeAny;
type SchemaMeta = Record<string, unknown>;
type SchemaWithMeta = { _def?: { meta?: unknown } };
type SchemaWithMetaGetter = { meta?: (...args: unknown[]) => unknown };

function isZodInstance(schema: z.ZodTypeAny, ctor?: ZodCtor): boolean {
  return typeof ctor === "function" && schema instanceof ctor;
}

export function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

export function normalizeAlias(alias: string): string {
  const trimmed = alias.trim();
  const normalized = trimmed.replace(/^-+/, "");
  if (!normalized) {
    throw new Error(`Invalid flag alias: "${alias}"`);
  }
  if (normalized.includes(" ") || normalized.includes("=")) {
    throw new Error(`Invalid flag alias: "${alias}"`);
  }
  return normalized;
}

function unwrapInner(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const def = (schema as { _def?: { innerType?: z.ZodTypeAny } })._def;
  return def?.innerType ?? null;
}

function unwrapOnce(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const ZodOptional = (z as { ZodOptional?: ZodCtor }).ZodOptional;
  if (isZodInstance(schema, ZodOptional)) return unwrapInner(schema);

  const ZodExactOptional = (z as { ZodExactOptional?: ZodCtor }).ZodExactOptional;
  if (isZodInstance(schema, ZodExactOptional)) return unwrapInner(schema);

  const ZodDefault = (z as { ZodDefault?: ZodCtor }).ZodDefault;
  if (isZodInstance(schema, ZodDefault)) return unwrapInner(schema);

  const ZodNullable = (z as { ZodNullable?: ZodCtor }).ZodNullable;
  if (isZodInstance(schema, ZodNullable)) return unwrapInner(schema);

  const ZodCatch = (z as { ZodCatch?: ZodCtor }).ZodCatch;
  if (isZodInstance(schema, ZodCatch)) return unwrapInner(schema);

  const ZodReadonly = (z as { ZodReadonly?: ZodCtor }).ZodReadonly;
  if (isZodInstance(schema, ZodReadonly)) return unwrapInner(schema);

  const ZodPrefault = (z as { ZodPrefault?: ZodCtor }).ZodPrefault;
  if (isZodInstance(schema, ZodPrefault)) return unwrapInner(schema);

  const ZodNonOptional = (z as { ZodNonOptional?: ZodCtor }).ZodNonOptional;
  if (isZodInstance(schema, ZodNonOptional)) return unwrapInner(schema);

  const ZodSuccess = (z as { ZodSuccess?: ZodCtor }).ZodSuccess;
  if (isZodInstance(schema, ZodSuccess)) return unwrapInner(schema);

  const ZodLazy = (z as { ZodLazy?: ZodCtor }).ZodLazy;
  if (isZodInstance(schema, ZodLazy)) {
    const def = (schema as { _def?: { getter?: () => z.ZodTypeAny } })._def;
    if (def?.getter) return def.getter();
  }

  const ZodPipe = (z as { ZodPipe?: ZodCtor }).ZodPipe;
  if (isZodInstance(schema, ZodPipe)) {
    const def = (schema as { _def?: { in?: z.ZodTypeAny } })._def;
    if (def?.in) return def.in;
  }

  const ZodEffects = (z as { ZodEffects?: ZodCtor }).ZodEffects;
  if (isZodInstance(schema, ZodEffects)) {
    const def = (schema as { _def?: { schema?: z.ZodTypeAny } })._def;
    if (def?.schema) return def.schema;
  }

  return null;
}

export function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    const next = unwrapOnce(current);
    if (!next || next === current) return current;
    current = next;
  }
}

export function getOptionKind(schema: z.ZodTypeAny): OptionKind {
  const base = unwrapSchema(schema);
  if (base instanceof z.ZodBoolean) return "boolean";
  if (base instanceof z.ZodArray) return "array";
  return "string";
}

export type SchemaShape = Record<string, z.ZodTypeAny>;

export function getSchemaShape(schema: z.ZodObject<z.ZodRawShape>): SchemaShape {
  return schema.shape as SchemaShape;
}

export function getSchemaMeta(schema: z.ZodTypeAny): SchemaMeta | undefined {
  const metaGetter = (schema as SchemaWithMetaGetter).meta;
  if (typeof metaGetter === "function") {
    const meta = metaGetter.call(schema);
    if (meta && typeof meta === "object") return meta as SchemaMeta;
  }
  const meta = (schema as SchemaWithMeta)._def?.meta;
  if (!meta || typeof meta !== "object") return undefined;
  return meta as SchemaMeta;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function getSchemaAliasesValue(schema: z.ZodTypeAny): string[] {
  const meta = getSchemaMeta(schema);
  if (!meta || !("aliases" in meta)) return [];
  const aliases = meta.aliases;
  if (typeof aliases === "string") return [aliases];
  if (Array.isArray(aliases)) return aliases.filter(isString);
  return [];
}

export function getSchemaAliases(schema: z.ZodTypeAny): string[] {
  const direct = getSchemaAliasesValue(schema);
  if (direct.length > 0) return direct;
  const unwrapped = unwrapSchema(schema);
  if (unwrapped === schema) return [];
  return getSchemaAliasesValue(unwrapped);
}

function getSchemaDescriptionValue(schema: z.ZodTypeAny): string | undefined {
  const typedSchema = schema as { description?: unknown; _def?: { description?: unknown } };
  if (typeof typedSchema.description === "string") return typedSchema.description;
  if (typeof typedSchema._def?.description === "string") return typedSchema._def.description;
  return undefined;
}

export function getSchemaDescription(schema: z.ZodTypeAny): string | undefined {
  const direct = getSchemaDescriptionValue(schema);
  if (direct) return direct;
  const unwrapped = unwrapSchema(schema);
  if (unwrapped === schema) return undefined;
  return getSchemaDescriptionValue(unwrapped);
}
