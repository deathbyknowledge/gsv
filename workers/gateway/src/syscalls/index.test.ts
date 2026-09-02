import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@humansandmachines/gsv/protocol";
import { intoSyscallTool } from ".";

describe("syscall tool target routing", () => {
  it("offers target as an optional override of the run environment", () => {
    const tool: ToolDefinition = {
      name: "Read",
      description: "Read a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    };

    const routed = intoSyscallTool(tool);

    expect(routed.inputSchema).toMatchObject({
      properties: {
        target: {
          type: "string",
          description: expect.stringContaining("selected capability environment"),
        },
      },
      required: ["path"],
    });
  });
});
