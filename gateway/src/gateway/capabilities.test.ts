import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../protocol/tools";
import { validateNodeRuntimeInfo } from "./capabilities";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
  };
}

describe("validateNodeRuntimeInfo", () => {
  it("accepts a valid host profile", () => {
    const tools = [tool("Read"), tool("Write"), tool("Bash")];

    const runtime = validateNodeRuntimeInfo({
      nodeId: "exec-1",
      tools,
      runtime: {
        hostCapabilities: [
          "filesystem.list",
          "filesystem.read",
          "filesystem.write",
          "shell.exec",
          "filesystem.edit",
          "text.search",
        ],
        toolCapabilities: {
          Read: ["filesystem.read"],
          Write: ["filesystem.write"],
          Bash: ["shell.exec"],
        },
      },
    });

    expect(runtime.toolCapabilities.Read).toEqual(["filesystem.read"]);
  });

  it("accepts minimal runtime payload", () => {
    const runtime = validateNodeRuntimeInfo({
      nodeId: "exec-1",
      tools: [tool("Bash")],
      runtime: {
        hostCapabilities: ["shell.exec"],
        toolCapabilities: {
          Bash: ["shell.exec"],
        },
      },
    });

    expect(runtime.hostCapabilities).toEqual(["shell.exec"]);
    expect(runtime.toolCapabilities.Bash).toEqual(["shell.exec"]);
  });

  it("rejects missing runtime payload", () => {
    expect(() =>
      validateNodeRuntimeInfo({
        nodeId: "exec-1",
        tools: [tool("Read")],
        runtime: undefined,
      }),
    ).toThrow("nodeRuntime for exec-1 is required");
  });

  it("rejects unknown capability values", () => {
    expect(() =>
      validateNodeRuntimeInfo({
        nodeId: "exec-1",
        tools: [tool("Read")],
        runtime: {
          hostCapabilities: [
            "filesystem.list",
            "filesystem.read",
            "filesystem.write",
            "shell.exec",
            "filesystem.magic",
          ],
          toolCapabilities: {
            Read: ["filesystem.read"],
          },
        },
      }),
    ).toThrow("unknown capability");
  });

  it("rejects missing tool capability mappings", () => {
    expect(() =>
      validateNodeRuntimeInfo({
        nodeId: "exec-1",
        tools: [tool("Read"), tool("Write")],
        runtime: {
          hostCapabilities: [
            "filesystem.list",
            "filesystem.read",
            "filesystem.write",
            "shell.exec",
          ],
          toolCapabilities: {
            Read: ["filesystem.read"],
          },
        },
      }),
    ).toThrow("missing entry for tool: Write");
  });

  it("rejects tool capabilities missing from host capabilities", () => {
    expect(() =>
      validateNodeRuntimeInfo({
        nodeId: "exec-1",
        tools: [tool("Read")],
        runtime: {
          hostCapabilities: ["shell.exec"],
          toolCapabilities: {
            Read: ["filesystem.read"],
          },
        },
      }),
    ).toThrow("missing from hostCapabilities");
  });
});
