import type { Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  FINAL_MESSAGE_BLOCK_EXAMPLE,
  withRunControlInstructions,
} from "./run-control-tool";

const READ_TOOL: Tool = {
  name: "Read",
  description: "Read a file.",
  parameters: {
    type: "object",
    properties: {},
  },
};

const SHELL_TOOL: Tool = {
  name: "Shell",
  description: "Run a shell command.",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string" },
    },
    required: ["input"],
  },
};

describe("withRunControlInstructions", () => {
  it("augments an offered Shell tool without changing its schema", () => {
    const [tool] = withRunControlInstructions([SHELL_TOOL]);

    expect(tool.parameters).toBe(SHELL_TOOL.parameters);
    expect(tool.description).toContain(SHELL_TOOL.description);
    expect(tool.description).toContain("message send");
    expect(tool.description).toContain(FINAL_MESSAGE_BLOCK_EXAMPLE);
  });

  it("adds the Process-owned Shell surface when Shell is not otherwise offered", () => {
    const tools = withRunControlInstructions([READ_TOOL]);

    expect(tools.map(({ name }) => name)).toEqual(["Read", "Shell"]);
    expect(tools[1]?.parameters).toEqual({
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "The message or run-control command to run on GSV.",
        },
      },
      required: ["input"],
      additionalProperties: false,
    });
  });
});
