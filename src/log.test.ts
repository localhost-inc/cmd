import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";

import { log } from "./log.js";

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
