import type { CommandDefinition } from "./types.js";
import { z } from "zod";

export function defineCommand<Input extends z.ZodObject<z.ZodRawShape>>(
  command: Omit<CommandDefinition<Input>, "kind">,
): CommandDefinition<Input> {
  return {
    ...command,
    kind: "command",
  };
}
