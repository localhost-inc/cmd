# @localhost-inc/cmd

A minimal CLI framework powered by [Zod](https://zod.dev) schemas. Define commands with type-safe flags, automatic `--help` generation, filesystem-based routing, and optional MCP server support.

## Install

```bash
bun add @localhost-inc/cmd
```

## Quick Start

Create a command file at `commands/greet.ts`:

```ts
import { z } from "zod";
import { defineCommand, defineFlag } from "@localhost-inc/cmd";

export default defineCommand({
  description: "Say hello.",
  input: z.object({
    name: defineFlag(z.string().describe("Who to greet."), { aliases: ["n"] }),
    loud: z.boolean().optional().describe("Shout it."),
  }),
  run: async ({ name, loud }, { stdout }) => {
    const msg = `Hello, ${name}!`;
    stdout(loud ? msg.toUpperCase() : msg);
  },
});
```

Wire up the CLI entry point:

```ts
#!/usr/bin/env bun
import { runCli } from "@localhost-inc/cmd";

const code = await runCli({
  name: "my-cli",
  baseDir: import.meta.dir,
});
if (code !== 0) process.exit(code);
```

```bash
my-cli greet --name world --loud
# HELLO, WORLD!

my-cli greet --help
# Usage: my-cli greet [args] [flags]
#
# Say hello.
#
# Flags:
#   -n, --name <value>  Who to greet.
#       --loud          Shout it.
```

## Features

### Filesystem Routing

Commands are discovered from `commands/` relative to `baseDir`. Nested directories become subcommand namespaces:

```
commands/
  deploy.ts        -> my-cli deploy
  db/
    migrate.ts     -> my-cli db migrate
    seed.ts        -> my-cli db seed
```

Running `my-cli db` with no subcommand prints the namespace help listing.

### Flag Parsing

Flags are derived from the Zod schema shape. Property names are converted to `--kebab-case` flags automatically.

- **Strings**: `--flag value` or `--flag=value`
- **Booleans**: `--flag` to enable, `--no-flag` to disable
- **Arrays**: `--flag a b c` or collect values after `--`
- **Aliases**: `defineFlag(schema, { aliases: ["f"] })` adds `-f`

### Positional Arguments

Define an `args` key in your schema to accept positional arguments:

```ts
input: z.object({
  args: z.array(z.string()).describe("Files to process."),
  verbose: z.boolean().optional(),
}),
```

### MCP Server

Enable the built-in MCP subcommand to expose all your CLI commands as [Model Context Protocol](https://modelcontextprotocol.io) tools:

```ts
const code = await runCli({
  name: "my-cli",
  baseDir: import.meta.dir,
  mcp: { version: "1.0.0" },
});
```

```bash
my-cli mcp  # starts MCP stdio server
```

### Custom Help

Override the auto-generated help with a static string or a function:

```ts
export default defineCommand({
  help: (ctx) => `Usage: ${ctx.cliName} ${ctx.commandPath} <file>`,
  // ...
});
```

## API

### `defineCommand(options)`

Creates a command definition.

| Option | Type | Description |
|---|---|---|
| `input` | `z.ZodObject` | Zod schema defining flags and args |
| `run` | `(input, context) => Promise<number \| void>` | Command handler |
| `description` | `string?` | One-line description for help text |
| `help` | `string \| ((ctx) => string)?` | Custom help override |

### `defineFlag(schema, options)`

Attaches alias metadata to a Zod schema.

```ts
defineFlag(z.string(), { aliases: ["n"] })
```

### `runCli(options)`

Runs the CLI. Returns an exit code.

| Option | Type | Description |
|---|---|---|
| `name` | `string` | CLI name shown in help text |
| `baseDir` | `string` | Directory containing `commands/` |
| `argv` | `string[]?` | Override `Bun.argv` |
| `commandExtensions` | `string[]?` | File extensions to scan (default: `["ts", "js"]`) |
| `defaultCommandPath` | `string?` | Command to run when no subcommand is given |
| `mcp` | `{ version: string }?` | Enable MCP subcommand |

### `parseFlags(args, schema, options?)`

Low-level flag parser. Useful when building custom CLI entry points outside of `runCli`.

### `formatCommandHelp(cliName, commandPath, command)`

Generates help text for a command.

### `formatNamespaceHelp(cliName, commandPath, children)`

Generates help text for a namespace listing.

## License

MIT
