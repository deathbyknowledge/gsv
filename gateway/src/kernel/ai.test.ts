import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import { handleAiConfig, handleAiTools } from "./ai";
import { SYSTEM_CONFIG_DEFAULTS } from "./config";

function makeContext(connectionState: string): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    devices: {
      listForUser: vi.fn(() => []),
    },
    mcpServers: {
      list: vi.fn(() => [{
        serverId: "server-1",
        uid: 1000,
        name: "Search",
        url: "https://mcp.example.com/mcp",
        transport: "auto",
        createdAt: 1,
        updatedAt: 2,
      }]),
    },
    mcp: {
      mcpConnections: {
        "server-1": { connectionState },
      },
      listTools: vi.fn(() => [{
        serverId: "server-1",
        name: "lookup",
        description: "Look up records",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
          required: ["title"],
        },
      }]),
    },
  } as unknown as KernelContext;
}

describe("handleAiTools", () => {
  it("does not add MCP server tools to the direct LLM tool surface", async () => {
    const ctx = makeContext("ready");

    const result = await handleAiTools(ctx);

    expect(result.tools.some((tool) => tool.name.startsWith("MCP_"))).toBe(false);
    expect(result.mcpServers).toEqual(["Search"]);
    const codeModeTool = result.tools.find((tool) => tool.name === "CodeMode");
    expect(codeModeTool?.description).toContain("declare function lookup");
    expect(codeModeTool?.description).toContain("type LookupOutput");
    expect(ctx.mcp.listTools).toHaveBeenCalledWith({ serverId: "server-1" });
  });

  it("keeps the same boundary for non-ready MCP connections", async () => {
    const ctx = makeContext("authenticating");

    const result = await handleAiTools(ctx);

    expect(result.tools.some((tool) => tool.name.startsWith("MCP_"))).toBe(false);
    expect(result.mcpServers).toEqual([]);
    expect(ctx.mcp.listTools).not.toHaveBeenCalled();
  });
});

describe("handleAiConfig", () => {
  it("resolves the mind system profile context and automatic approval policy", async () => {
    const ctx = {
      ...makeContext("ready"),
      env: {},
      config: makeDefaultConfig(),
      packages: {
        list: vi.fn(() => []),
      },
    } as unknown as KernelContext;

    const result = await handleAiConfig({ profile: "mind" }, ctx);

    expect(result.profile).toBe("mind");
    expect(result.profileContextFiles?.map((file) => file.name)).toContain("00-role.md");
    expect(result.profileContextFiles?.map((file) => file.name)).toContain("10-social.md");
    expect(result.profileContextFiles?.find((file) => file.name === "00-role.md")?.text)
      .toContain("Mind");
    expect(result.profileContextFiles?.find((file) => file.name === "10-social.md")?.text)
      .toContain("social message send");
    expect(result.profileApprovalPolicy).toBe("{\"default\":\"auto\",\"rules\":[]}");
  });
});

function makeDefaultConfig() {
  return {
    get(key: string) {
      return SYSTEM_CONFIG_DEFAULTS[key] ?? null;
    },
    list(prefix: string) {
      const normalized = prefix.replace(/\/+$/, "");
      return Object.entries(SYSTEM_CONFIG_DEFAULTS)
        .filter(([key]) => key === normalized || key.startsWith(`${normalized}/`))
        .map(([key, value]) => ({ key, value }))
        .sort((left, right) => left.key.localeCompare(right.key));
    },
  };
}
