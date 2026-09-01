import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  parseRunControlCommand,
  type RunControlCommandParseResult,
} from "./run-control-command";

export type RunControlShellCall = {
  toolCall: ToolCall;
  parsed: RunControlCommandParseResult;
};

const terminalShellToolArgsSchema = z.object({
  input: z.string(),
  target: z.enum(["gsv", "gateway"]).optional(),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
}).strict();

export const FINAL_MESSAGE_BLOCK_EXAMPLE =
  "message send <<'GSV_MESSAGE' && yield\nyour user-visible response\nGSV_MESSAGE";

const RUN_CONTROL_INSTRUCTION =
  `Use a direct \`message send\` Shell call whenever the user should receive a message; sending does not finish the run. After all work is complete, run \`yield\`, or compose the final message as:\n${FINAL_MESSAGE_BLOCK_EXAMPLE}\nOrdinary assistant text is Process activity and is not sent to the user.`;

const RUN_CONTROL_SHELL_TOOL: Tool = {
  name: "Shell",
  description: `Run a GSV shell command. ${RUN_CONTROL_INSTRUCTION}`,
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The message or run-control command to run on GSV.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  },
};

export function withRunControlInstructions(workTools: Tool[]): Tool[] {
  let foundShell = false;
  const tools = workTools.map((tool) => {
    if (tool.name !== "Shell") return tool;
    foundShell = true;
    return {
      ...tool,
      description: `${tool.description} ${RUN_CONTROL_INSTRUCTION}`,
    };
  });
  return foundShell ? tools : [...tools, RUN_CONTROL_SHELL_TOOL];
}

export function runControlShellCall(
  toolCall: ToolCall,
): RunControlShellCall | null {
  if (toolCall.name !== "Shell") return null;
  const args = terminalShellToolArgsSchema.safeParse(toolCall.arguments);
  if (!args.success) return null;
  const parsed = parseRunControlCommand(args.data.input);
  return parsed ? { toolCall, parsed } : null;
}

export function missingRunControlCorrectionMessage(): string {
  return [
    "This run is not complete. Ordinary assistant text is Process activity and is not sent to the user.",
    "Run `yield` now if the work is complete.",
    `If the user still needs a final message, send and finish with:\n${FINAL_MESSAGE_BLOCK_EXAMPLE}`,
  ].join("\n");
}
