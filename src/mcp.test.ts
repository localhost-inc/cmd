import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createMcpFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmd-mcp-test-"));
  fixtures.push(dir);

  const srcIndex = pathToFileURL(join(process.cwd(), "src/index.ts")).href;
  mkdirSync(join(dir, "commands/memory"), { recursive: true });

  writeFileSync(
    join(dir, "cli.ts"),
    `import { runCli } from ${JSON.stringify(srcIndex)};\n\n` +
      `const code = await runCli({\n` +
      `  name: "casper",\n` +
      `  baseDir: import.meta.dir,\n` +
      `  mcp: { version: "0.0.0" },\n` +
      `});\n` +
      `if (code !== 0) process.exit(code);\n`,
  );

  writeFileSync(
    join(dir, "commands/memory/add.ts"),
    `import { z } from "zod";\n` +
      `import { defineCommand } from ${JSON.stringify(srcIndex)};\n\n` +
      `export default defineCommand({\n` +
      `  description: "Add memory",\n` +
      `  input: z.object({ body: z.string().describe("Body") }),\n` +
      `  run: async ({ body }, { stdout }) => { stdout(body); return 0; },\n` +
      `});\n`,
  );

  return dir;
}

async function listTools(fixtureDir: string): Promise<Array<{ name: string }>> {
  const child = spawn("bun", ["run", join(fixtureDir, "cli.ts"), "mcp"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  const tools = new Promise<Array<{ name: string }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for tools/list; stderr=${stderr}`)), 5000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let newline: number;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          clearTimeout(timer);
          resolve(msg.result.tools);
        }
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`mcp fixture exited ${code}; stderr=${stderr}`));
      }
    });
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");

  try {
    return await tools;
  } finally {
    child.kill();
  }
}

describe("runMcp", () => {
  test("uses command paths as tool names without duplicating the server name", async () => {
    const fixtureDir = createMcpFixture();
    const names = (await listTools(fixtureDir)).map((tool) => tool.name);

    expect(names).toContain("memory.add");
    expect(names).not.toContain("casper.memory.add");
  });
});
