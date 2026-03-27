import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineFlag, parseFlags } from "./flags.js";

describe("parseFlags", () => {
  test("parses named flags and positionals", () => {
    const input = z.object({
      name: z.string(),
      verbose: defineFlag(z.boolean().optional(), { aliases: "v" }),
      args: z.array(z.string()),
    });

    const { data, positionals } = parseFlags(["--name", "kin", "-v", "alpha", "beta"], input);

    expect(data).toEqual({
      name: "kin",
      verbose: true,
      args: ["alpha", "beta"],
    });
    expect(positionals).toEqual(["alpha", "beta"]);
  });

  test("collects array values after -- sentinel", () => {
    const input = z.object({
      tags: z.array(z.string()),
    });

    const { data } = parseFlags(["--tags", "--", "--foo", "-bar"], input);

    expect(data).toEqual({
      tags: ["--foo", "-bar"],
    });
  });

  test("treats piped array schemas as arrays", () => {
    const input = z.object({
      tags: z.array(z.string()).pipe(z.array(z.string())),
    });

    const { data } = parseFlags(["--tags", "a", "b"], input);

    expect(data).toEqual({
      tags: ["a", "b"],
    });
  });

  test("treats unknown dashed tokens as array values until the next known flag", () => {
    const input = z.object({
      scriptArgs: z.array(z.string()),
      env: z.string().optional(),
    });

    const { data } = parseFlags(
      [
        "--script-args",
        "--year",
        "2026",
        "--month",
        "3",
        "--env",
        "stg",
      ],
      input,
    );

    expect(data).toEqual({
      scriptArgs: ["--year", "2026", "--month", "3"],
      env: "stg",
    });
  });
});

describe("defineFlag", () => {
  test("rejects invalid aliases", () => {
    expect(() => defineFlag(z.string(), { aliases: "-" })).toThrow('Invalid flag alias: "-"');
  });
});

describe("alias collisions", () => {
  test("throws when two flags share an alias", () => {
    const input = z.object({
      alpha: defineFlag(z.string(), { aliases: "a" }),
      beta: defineFlag(z.string(), { aliases: "a" }),
    });

    expect(() => parseFlags([], input)).toThrow("Alias -a already maps to --alpha");
  });
});
