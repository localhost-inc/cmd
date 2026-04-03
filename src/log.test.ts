import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";

import { log, stripAnsi, visualRows } from "./log.js";

describe("log (plain mode)", () => {
  let output: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    output = [];
    spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test("info writes plain message", () => {
    log.info("hello");
    expect(output).toHaveLength(1);
    expect(output[0]).toBe("hello");
  });

  test("success writes green check", () => {
    log.success("done");
    expect(output[0]).toContain("✓");
    expect(output[0]).toContain("done");
  });

  test("warn writes yellow marker", () => {
    log.warn("careful");
    expect(output[0]).toContain("⚠");
    expect(output[0]).toContain("careful");
  });

  test("error writes red marker", () => {
    log.error("failed");
    expect(output[0]).toContain("✗");
    expect(output[0]).toContain("failed");
  });

  test("val returns cyan-wrapped string", () => {
    const result = log.val("api");
    expect(result).toContain("api");
    expect(result).toContain("\x1b[36m");
  });

  test("group indents nested calls", async () => {
    await log.group("Deploy", async () => {
      log.info("building");
    });
    expect(output[0]).toContain("Deploy");
    expect(output[1]).toBe("  building");
    expect(output[2]).toContain("✓");
    expect(output[2]).toContain("Deploy");
  });

  test("nested groups indent further", async () => {
    await log.group("Outer", async () => {
      await log.group("Inner", async () => {
        log.info("deep");
      });
    });
    const deepLine = output.find((l) => l.includes("deep"));
    expect(deepLine).toBe("    deep");
  });

  test("group shows error marker on throw", async () => {
    try {
      await log.group("Failing", async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    const last = output[output.length - 1]!;
    expect(last).toContain("✗");
    expect(last).toContain("Failing");
  });

  test("group returns action result", async () => {
    const result = await log.group("Math", async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test("group rethrows errors", async () => {
    const err = new Error("boom");
    try {
      await log.group("Bad", async () => {
        throw err;
      });
    } catch (caught) {
      expect(caught).toBe(err);
    }
  });
});

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\x1b[36mhello\x1b[0m")).toBe("hello");
  });

  test("removes multiple codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[32m✓\x1b[0m done")).toBe("✓ done");
  });

  test("returns plain text unchanged", () => {
    expect(stripAnsi("plain")).toBe("plain");
  });
});

describe("visualRows", () => {
  test("single row when text fits", () => {
    expect(visualRows("hello", 80)).toBe(1);
  });

  test("wraps at column boundary", () => {
    expect(visualRows("a".repeat(80), 80)).toBe(1);
    expect(visualRows("a".repeat(81), 80)).toBe(2);
    expect(visualRows("a".repeat(160), 80)).toBe(2);
    expect(visualRows("a".repeat(161), 80)).toBe(3);
  });

  test("ignores ANSI codes in width calculation", () => {
    // 5 printable chars wrapped in ANSI — should be 1 row even at width 10
    const colored = "\x1b[36mhello\x1b[0m";
    expect(visualRows(colored, 10)).toBe(1);
  });

  test("long ANSI-wrapped text wraps by printable length", () => {
    // 100 printable chars with ANSI wrapping, 40-col terminal = 3 rows
    const text = `\x1b[2m${"x".repeat(100)}\x1b[0m`;
    expect(visualRows(text, 40)).toBe(3);
  });

  test("empty text returns 1 row", () => {
    expect(visualRows("", 80)).toBe(1);
  });

  test("zero columns returns 1 row", () => {
    expect(visualRows("anything", 0)).toBe(1);
  });
});

describe("renderer wrapping", () => {
  let writes: string[];
  let writeSpy: ReturnType<typeof spyOn>;
  let origIsTTY: boolean | undefined;
  let origColumns: number | undefined;
  let origCI: string | undefined;
  let origNoColor: string | undefined;

  function enterInteractive(columns: number) {
    writes = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    );
    origIsTTY = process.stdout.isTTY;
    origColumns = process.stdout.columns;
    origCI = process.env.CI;
    origNoColor = process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: columns,
      configurable: true,
    });
    delete process.env.CI;
    delete process.env.NO_COLOR;
  }

  function leaveInteractive() {
    if (origCI !== undefined) process.env.CI = origCI;
    else delete process.env.CI;
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    Object.defineProperty(process.stdout, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: origColumns,
      configurable: true,
    });
    writeSpy.mockRestore();
  }

  /** Largest cursor-up N found in captured writes (\x1b[NF). */
  function maxCursorUp(): number {
    const ups: number[] = [];
    for (const w of writes) {
      const m = /\x1b\[(\d+)F/.exec(w);
      if (m) ups.push(Number(m[1]));
    }
    return ups.length > 0 ? Math.max(...ups) : 0;
  }

  // -- log.info inside group (append path) --

  test("short lines — cursor-up equals logical line count", async () => {
    enterInteractive(80);
    try {
      await log.group("Task", async () => {
        log.info("ok");
      });
    } finally {
      leaveInteractive();
    }
    // 2 logical lines (header + "ok"), both short — no wrapping
    expect(maxCursorUp()).toBe(2);
  });

  test("long info line — cursor-up accounts for wrapped rows", async () => {
    enterInteractive(40);
    try {
      await log.group("Task", async () => {
        // 100 printable chars at 40 cols → ceil(100/40) = 3 visual rows
        log.info("x".repeat(100));
      });
    } finally {
      leaveInteractive();
    }
    // header (1 row) + wrapped info (3 rows) = 4
    // old bug: cursor-up would be 2 (logical lines only)
    expect(maxCursorUp()).toBeGreaterThanOrEqual(4);
  });

  test("multiple wrapping lines compound correctly", async () => {
    enterInteractive(40);
    try {
      await log.group("Multi", async () => {
        log.info("a".repeat(100)); // 3 rows
        log.info("b".repeat(100)); // 3 rows
      });
    } finally {
      leaveInteractive();
    }
    // header (1) + 3 + 3 = 7
    expect(maxCursorUp()).toBeGreaterThanOrEqual(7);
  });

  // -- log.exec stream inside group (append via writeLine path) --

  test("stream exec with long output — cursor-up accounts for wrapping", async () => {
    enterInteractive(40);
    try {
      await log.group("Deploy", async () => {
        // printf avoids trailing newline ambiguity across shells
        await log.exec("printf", {
          args: ["%s\\n", "y".repeat(120)],
          output: "stream",
        });
      });
    } finally {
      leaveInteractive();
    }
    // streamed line goes through renderer.append → render
    // "  \x1b[2m" + 120 chars + "\x1b[0m" → 122 printable → ceil(122/40) = 4 rows
    // header (1) + wrapped stream line (4) = 5
    expect(maxCursorUp()).toBeGreaterThan(2);
  });

  // -- log.exec tail inside group (addLine + update + remove path) --

  test("tail exec with long output — cursor-up accounts for wrapping", async () => {
    enterInteractive(40);
    try {
      await log.group("Fetch", async () => {
        // tail mode: addLine on first output, update on subsequent, remove on exit
        await log.exec("printf", {
          args: ["%s\\n", "z".repeat(120)],
          output: "tail",
        });
      });
    } finally {
      leaveInteractive();
    }
    // tail line wraps → renderedCount must include visual rows
    // so cursor-up on the remove() re-render goes back far enough
    expect(maxCursorUp()).toBeGreaterThan(2);
  });

  // -- nested groups with long content --

  test("nested group with long output — cursor-up spans full block", async () => {
    enterInteractive(40);
    try {
      await log.group("Outer", async () => {
        await log.group("Inner", async () => {
          log.info("w".repeat(100));
        });
        log.info("short");
      });
    } finally {
      leaveInteractive();
    }
    // outer header (1) + inner header (1) + wrapped info (3) + "short" (1) = 6
    expect(maxCursorUp()).toBeGreaterThanOrEqual(6);
  });
});

describe("log.exec", () => {
  test("captures output and returns exit code 0", async () => {
    const result = await log.exec("echo", {
      args: ["hello"],
      output: "silent",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
  });

  test("throws on non-zero exit by default", async () => {
    await expect(
      log.exec("sh", { args: ["-c", "exit 2"], output: "silent" }),
    ).rejects.toThrow("exit code 2");
  });

  test("nothrow returns non-zero exit code", async () => {
    const result = await log.exec("sh", {
      args: ["-c", "exit 2"],
      output: "silent",
      nothrow: true,
    });
    expect(result.exitCode).toBe(2);
  });

  test("stream mode pipes output", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      },
    );
    await log.exec("sh", {
      args: ["-c", "echo line1 && echo line2"],
      output: "stream",
    });
    spy.mockRestore();
    const combined = lines.join("\n");
    expect(combined).toContain("line1");
    expect(combined).toContain("line2");
  });
});
