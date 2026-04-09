/**
 * Integration test: McpService against a live MCP server (context7).
 * Skipped by default. Run with:
 *   cd gateway && MCP_INTEGRATION=1 npx vitest run src/gateway/mcp-service.integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { McpService } from "./mcp-service";
import type { McpConfig } from "../config";

const CONTEXT7_URL = "https://mcp.context7.com/mcp";
const RUN_INTEGRATION = process.env.MCP_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)("McpService integration (live context7)", () => {
  const service = new McpService();
  const config: McpConfig = {
    servers: {
      context7: { url: CONTEXT7_URL, timeoutMs: 30_000 },
    },
  };

  it("discovers tools from context7 via refreshCache", async () => {
    await service.refreshCache(config);

    const tools = service.listToolsCached(config);
    console.log(`Discovered ${tools.length} tools from context7:`);
    for (const tool of tools) {
      console.log(`  ${tool.name}: ${tool.description?.slice(0, 80)}`);
    }

    expect(tools.length).toBeGreaterThan(0);
    // context7 tools should be namespaced as context7__{toolName}
    expect(tools[0].name).toMatch(/^context7__/);
    expect(tools[0].inputSchema).toBeDefined();
  }, 30_000);

  it("resolves a discovered tool", async () => {
    // Cache should still be warm from previous test
    const tools = service.listToolsCached(config);
    if (tools.length === 0) {
      await service.refreshCache(config);
    }

    const firstTool = service.listToolsCached(config)[0];
    const resolved = service.resolve(firstTool.name, config);

    expect(resolved).not.toBeNull();
    expect(resolved!.serverId).toBe("context7");
    expect(resolved!.serverConfig.url).toBe(CONTEXT7_URL);
  }, 10_000);

  it("calls a tool on context7", async () => {
    // Ensure cache is warm
    if (service.listToolsCached(config).length === 0) {
      await service.refreshCache(config);
    }

    const tools = service.listToolsCached(config);
    // Find resolve-library-id tool (common context7 tool)
    const resolveTool = tools.find((t) => t.name.includes("resolve"));
    if (!resolveTool) {
      console.log("No resolve tool found, skipping callTool test");
      return;
    }

    console.log("Tool schema:", JSON.stringify(resolveTool.inputSchema, null, 2));

    const resolved = service.resolve(resolveTool.name, config);
    expect(resolved).not.toBeNull();

    // resolve-library-id requires { query: string, libraryName: string }
    const result = await service.callTool(
      resolved!.serverConfig,
      resolved!.toolName,
      { query: "UI framework", libraryName: "react" },
    );

    console.log("callTool result:", JSON.stringify(result).slice(0, 200));

    // Should get a result (not an error)
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  }, 30_000);
});
