import type { Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  FINAL_MESSAGE_BLOCK_EXAMPLE,
  missingRunControlCorrectionMessage,
  runControlShellCall,
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

describe("runControlShellCall", () => {
  it("recognizes Process-owned commands on the native target", () => {
    const toolCall = {
      type: "toolCall",
      id: "finish",
      name: "Shell",
      arguments: {
        input: "message send --message done && yield",
        target: "gsv",
      },
    } as const;

    expect(runControlShellCall(toolCall)).toEqual({
      toolCall,
      parsed: {
        ok: true,
        command: { action: "message", text: "done", finish: true },
      },
    });
  });

  it("does not intercept work sent to an external target", () => {
    expect(runControlShellCall({
      type: "toolCall",
      id: "remote",
      name: "Shell",
      arguments: {
        input: "message send --message done && yield",
        target: "laptop",
      },
    })).toBeNull();
  });

  it("does not intercept ordinary native shell commands", () => {
    expect(runControlShellCall({
      type: "toolCall",
      id: "work",
      name: "Shell",
      arguments: { input: "targets list" },
    })).toBeNull();
  });
});

it("renders the missing-yield correction from the shared run-control contract", () => {
  expect(missingRunControlCorrectionMessage()).toContain(
    "Ordinary assistant text is Process activity",
  );
  expect(missingRunControlCorrectionMessage()).toContain(
    FINAL_MESSAGE_BLOCK_EXAMPLE,
  );
});
