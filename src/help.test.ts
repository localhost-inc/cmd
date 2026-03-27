import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineCommand } from "./define.js";
import { formatCommandHelp, formatNamespaceHelp } from "./help.js";

describe("formatCommandHelp", () => {
  test("returns custom static help when provided", () => {
    const command = defineCommand({
      help: "Custom help text",
      input: z.object({}),
      run: async () => 0,
    });

    expect(formatCommandHelp("lifecycle", "workspace", command)).toBe("Custom help text");
  });

  test("passes cli context into custom help generators", () => {
    const command = defineCommand({
      help: ({ cliName, commandPath }) => `${cliName}:${commandPath ?? "<root>"}`,
      input: z.object({}),
      run: async () => 0,
    });

    expect(formatCommandHelp("lifecycle", "workspace service", command)).toBe(
      "lifecycle:workspace service",
    );
  });
});

describe("formatNamespaceHelp", () => {
  test("renders dynamic child command listings", () => {
    expect(
      formatNamespaceHelp("lifecycle", "workspace", [
        { description: "Create a workspace.", name: "create" },
        { name: "service" },
        { description: "Open or focus a workspace surface.", name: "tab" },
      ]),
    ).toBe(
      [
        "Usage: lifecycle workspace <command> [flags]",
        "",
        "Commands:",
        "  create   Create a workspace.",
        "  service",
        "  tab      Open or focus a workspace surface.",
      ].join("\n"),
    );
  });
});
