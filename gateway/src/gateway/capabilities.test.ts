import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../protocol/tools";
import {
  EXECUTION_BASELINE_CAPABILITIES,
  listHostsByRole,
  pickExecutionHostId,
  validateNodeRuntimeInfo,
} from "./capabilities";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
  };
}

describe("validateNodeRuntimeInfo", () => {
  it("accepts a valid execution host profile", () => {
    const tools = [tool("Read"), tool("Write"), tool("Bash")];

    const runtime = validateNodeRuntimeInfo({
      nodeId: "exec-1",
      tools,
      runtime: {
        hostRole: "execution",
        hostCapabilities: [
          ...EXECUTION_BASELINE_CAPABILITIES,
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

    expect(runtime.hostRole).toBe("execution");
    expect(runtime.toolCapabilities.Read).toEqual(["filesystem.read"]);
  });

  it("accepts optional host skill facts", () => {
    const runtime = validateNodeRuntimeInfo({
      nodeId: "exec-1",
      tools: [tool("Bash")],
      runtime: {
        hostRole: "execution",
        hostCapabilities: EXECUTION_BASELINE_CAPABILITIES,
        toolCapabilities: {
          Bash: ["shell.exec"],
        },
        hostOs: "darwin",
        hostEnv: ["GITHUB_TOKEN"],
        hostBinStatus: { gh: true, jq: false },
        hostBinStatusUpdatedAt: 1700000000000,
      },
    });

    expect(runtime.hostOs).toBe("darwin");
    expect(runtime.hostEnv).toEqual(["GITHUB_TOKEN"]);
    expect(runtime.hostBinStatus).toEqual({ gh: true, jq: false });
    expect(runtime.hostBinStatusUpdatedAt).toBe(1700000000000);
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
          hostRole: "execution",
          hostCapabilities: [
            ...EXECUTION_BASELINE_CAPABILITIES,
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
          hostRole: "execution",
          hostCapabilities: EXECUTION_BASELINE_CAPABILITIES,
          toolCapabilities: {
            Read: ["filesystem.read"],
          },
        },
      }),
    ).toThrow("missing entry for tool: Write");
  });

  it("rejects execution host without baseline capabilities", () => {
    expect(() =>
      validateNodeRuntimeInfo({
        nodeId: "exec-1",
        tools: [tool("Read")],
        runtime: {
          hostRole: "execution",
          hostCapabilities: ["filesystem.read"],
          toolCapabilities: {
            Read: ["filesystem.read"],
          },
        },
      }),
    ).toThrow("missing execution baseline");
  });
});

describe("host selection helpers", () => {
  it("prefers lexicographically first execution host among candidates", () => {
    const runtimes = {
      "spec-1": {
        hostRole: "specialized",
        hostCapabilities: ["text.search"],
        toolCapabilities: { Grep: ["text.search"] },
      },
      "exec-b": {
        hostRole: "execution",
        hostCapabilities: EXECUTION_BASELINE_CAPABILITIES,
        toolCapabilities: { Bash: ["shell.exec"] },
      },
      "exec-a": {
        hostRole: "execution",
        hostCapabilities: EXECUTION_BASELINE_CAPABILITIES,
        toolCapabilities: { Bash: ["shell.exec"] },
      },
    } as const;

    const selected = pickExecutionHostId({
      nodeIds: ["spec-1", "exec-b", "exec-a"],
      runtimes: runtimes as any,
    });

    expect(selected).toBe("exec-a");
  });

  it("lists specialized hosts in stable sorted order", () => {
    const runtimes = {
      "spec-z": {
        hostRole: "specialized",
        hostCapabilities: ["text.search"],
        toolCapabilities: { Grep: ["text.search"] },
      },
      "exec-a": {
        hostRole: "execution",
        hostCapabilities: EXECUTION_BASELINE_CAPABILITIES,
        toolCapabilities: { Bash: ["shell.exec"] },
      },
      "spec-a": {
        hostRole: "specialized",
        hostCapabilities: ["text.search"],
        toolCapabilities: { Grep: ["text.search"] },
      },
    } as const;

    const hosts = listHostsByRole({
      nodeIds: ["spec-z", "exec-a", "spec-a"],
      runtimes: runtimes as any,
      role: "specialized",
    });

    expect(hosts).toEqual(["spec-a", "spec-z"]);
  });
});
