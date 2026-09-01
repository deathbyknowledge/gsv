import type { Tool } from "@earendil-works/pi-ai";

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
