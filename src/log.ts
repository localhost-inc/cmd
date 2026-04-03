import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

// ANSI helpers

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Visual row counting — accounts for ANSI codes and terminal wrapping

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function visualRows(text: string, columns: number): number {
  const len = stripAnsi(text).length;
  if (len === 0 || columns <= 0) return 1;
  return Math.ceil(len / columns);
}

// Renderer — manages an in-place block of terminal lines (TTY only)

type LineEntry = { text: string };
type LineHandle = {
  update: (text: string) => void;
  remove: () => void;
};

class Renderer {
  private lines: LineEntry[] = [];
  private renderedCount = 0;

  addLine(text: string): LineHandle {
    const entry: LineEntry = { text };
    this.lines.push(entry);
    this.render();
    return {
      update: (newText: string) => {
        entry.text = newText;
        this.render();
      },
      remove: () => {
        const index = this.lines.indexOf(entry);
        if (index !== -1) {
          this.lines.splice(index, 1);
          this.render();
        }
      },
    };
  }

  append(text: string) {
    this.lines.push({ text });
    this.render();
  }

  finish() {
    this.render();
    this.renderedCount = 0;
  }

  private render() {
    if (this.renderedCount > 0) {
      process.stdout.write(`\x1b[${this.renderedCount}F\x1b[0J`);
    }
    const columns = process.stdout.columns || 80;
    let rows = 0;
    for (const line of this.lines) {
      process.stdout.write(`${line.text}\n`);
      rows += visualRows(line.text, columns);
    }
    this.renderedCount = rows;
  }
}

// Context

type LogContext = {
  depth: number;
  renderer: Renderer | null;
};

const storage = new AsyncLocalStorage<LogContext>();

function getDepth(): number {
  return storage.getStore()?.depth ?? 0;
}

function getRenderer(): Renderer | null {
  return storage.getStore()?.renderer ?? null;
}

function isInteractive(): boolean {
  if (process.env.CI) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout.isTTY);
}

function indentStr(depth: number): string {
  return "  ".repeat(depth);
}

function writeLine(message: string) {
  const renderer = getRenderer();
  if (renderer) {
    renderer.append(`${indentStr(getDepth())}${message}`);
  } else {
    console.log(`${indentStr(getDepth())}${message}`);
  }
}

// Exec internals

function formatArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/[^A-Za-z0-9_./:=@+-]/.test(arg)) return JSON.stringify(arg);
  return arg;
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(formatArg)].join(" ");
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function attachLineReader(stream: Readable, onLine: (line: string) => void) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split(/[\r\n]+/u);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.length > 0) onLine(part);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = "";
    }
  });
}

export type ExecOptions = {
  /** Arguments to pass to the command. */
  args?: readonly string[];
  /** Working directory. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
  /** How to handle output. "tail" shows last line (default), "stream" shows all, "silent" hides. */
  output?: "tail" | "stream" | "silent";
  /** Don't throw on non-zero exit. */
  nothrow?: boolean;
  /** Heartbeat interval in ms for CI (default: 15000). Set 0 to disable. */
  heartbeatMs?: number;
};

type ExecResult = {
  exitCode: number | null;
  output: string[];
};

function runExec(
  command: string,
  options: ExecOptions,
  onLine: ((line: string) => void) | undefined,
  onHeartbeat: ((elapsedMs: number) => void) | undefined,
): Promise<ExecResult> {
  const args = (options.args ?? []).map(String);
  const maxOutputLines = 200;

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const heartbeatInterval =
      onHeartbeat && (options.heartbeatMs ?? 15000) > 0
        ? setInterval(
            () => onHeartbeat(Date.now() - startTime),
            options.heartbeatMs ?? 15000,
          )
        : undefined;
    heartbeatInterval?.unref?.();

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env
        ? { ...process.env, ...options.env }
        : (process.env as Record<string, string>),
      stdio: ["inherit", "pipe", "pipe"],
    });

    const outputLines: string[] = [];
    const handleLine = (line: string) => {
      outputLines.push(line);
      if (outputLines.length > maxOutputLines) outputLines.shift();
      if (onLine) onLine(line);
    };

    if (child.stdout) attachLineReader(child.stdout, handleLine);
    if (child.stderr) attachLineReader(child.stderr, handleLine);

    child.on("error", (error) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      reject(error);
    });

    child.on("close", (code) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (code && code !== 0 && !options.nothrow) {
        const output = outputLines.join("\n").trim();
        const commandLine = formatCommand(command, args);
        const message = output.length
          ? `Command failed (${commandLine}) with exit code ${code}\n${output}`
          : `Command failed (${commandLine}) with exit code ${code}`;
        reject(new Error(message));
        return;
      }
      resolve({ exitCode: code, output: outputLines });
    });
  });
}

// Public API

export const log = {
  info: (message: string) => writeLine(message),
  success: (message: string) => writeLine(green(`✓ ${message}`)),
  warn: (message: string) => writeLine(yellow(`⚠ ${message}`)),
  error: (message: string) => writeLine(red(`✗ ${message}`)),
  dim: (message: string) => writeLine(dim(message)),
  step: (message: string) => writeLine(bold(message)),
  val: (s: string) => cyan(s),

  async group<T>(title: string, action: () => Promise<T>): Promise<T> {
    const depth = getDepth();
    const parentRenderer = getRenderer();
    const interactive = isInteractive();

    if (interactive) {
      const isRoot = parentRenderer === null;
      const renderer = parentRenderer ?? new Renderer();
      const prefix = indentStr(depth);

      let frame = 0;
      const header = renderer.addLine(
        `${prefix}${cyan(spinnerFrames[0]!)} ${title}`,
      );
      const interval = setInterval(() => {
        frame = (frame + 1) % spinnerFrames.length;
        header.update(`${prefix}${cyan(spinnerFrames[frame]!)} ${title}`);
      }, 80);

      const ctx: LogContext = { depth: depth + 1, renderer };

      try {
        const result = await storage.run(ctx, action);
        clearInterval(interval);
        header.update(`${prefix}${green("✓")} ${dim(title)}`);
        if (isRoot) renderer.finish();
        return result;
      } catch (error) {
        clearInterval(interval);
        header.update(`${prefix}${red("✗")} ${title}`);
        if (isRoot) renderer.finish();
        throw error;
      }
    }

    // Plain mode (CI, piped, non-TTY)
    const prefix = indentStr(depth);
    console.log(`${prefix}${bold(title)}`);
    try {
      const result = await storage.run(
        { depth: depth + 1, renderer: null },
        action,
      );
      console.log(`${prefix}${green("✓")} ${dim(title)}`);
      return result;
    } catch (error) {
      console.log(`${prefix}${red("✗")} ${title}`);
      throw error;
    }
  },

  async exec(
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const outputMode = options.output ?? "tail";
    const renderer = getRenderer();
    const depth = getDepth();
    const prefix = indentStr(depth);
    const interactive = isInteractive();

    // Interactive tail mode — show last line, update in place, remove when done
    if (interactive && renderer && outputMode === "tail") {
      let tailHandle: LineHandle | null = null;
      const onLine = (line: string) => {
        const text = `${prefix}${dim(line)}`;
        if (tailHandle) {
          tailHandle.update(text);
        } else {
          tailHandle = renderer.addLine(text);
        }
      };
      const result = await runExec(command, options, onLine, undefined);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated in callback
      (tailHandle as LineHandle | null)?.remove();
      return result;
    }

    // Stream mode — pipe every line through as log output
    if (outputMode === "stream") {
      const onLine = (line: string) => writeLine(dim(line));
      return runExec(command, options, onLine, undefined);
    }

    // Plain tail mode (non-TTY) — show last line, with heartbeat for CI
    if (outputMode === "tail") {
      let lastLine = "";
      const onLine = (line: string) => {
        lastLine = line;
      };
      const onHeartbeat = !interactive
        ? (elapsedMs: number) => {
            const label = formatCommand(
              command,
              (options.args ?? []).map(String),
            );
            writeLine(dim(`${label} still running (${formatElapsed(elapsedMs)})`));
            if (lastLine) writeLine(dim(lastLine));
          }
        : undefined;
      return runExec(command, options, onLine, onHeartbeat);
    }

    // Silent mode
    return runExec(command, options, undefined, undefined);
  },
};
