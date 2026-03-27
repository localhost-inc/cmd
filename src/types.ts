import type { z } from "zod";

export type CommandIo = {
  stderr: (message: string) => void;
  stdout: (message: string) => void;
};

export type CommandContext = CommandIo & {
  argv: string[];
  cliName: string;
  commandPath: string | null;
  positionals: string[];
};

export type CommandHelpContext = Pick<CommandContext, "cliName" | "commandPath">;

export type CommandDefinition<Input extends z.ZodObject<z.ZodRawShape>> = {
  description?: string;
  help?: string | ((context: CommandHelpContext) => string);
  kind: "command";
  input: Input;
  run: (input: z.output<Input>, context: CommandContext) => Promise<number | void> | number | void;
};
