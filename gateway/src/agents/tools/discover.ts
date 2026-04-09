/**
 * Tool discovery and execution meta-tools.
 *
 * These provide an executor-style interface where the agent discovers
 * tools on demand instead of seeing all remote tools in its context.
 * MCP tools are kept out of the default tool list — the agent finds
 * them via SearchTools and invokes them via CallTool.
 *
 * Native tools remain in the tool list for direct access, but CallTool
 * can also invoke them for a consistent interface.
 */

import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";

export const getDiscoverToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.SEARCH_TOOLS,
    description:
      "Search for capabilities you don't have built in. Remote tool servers are " +
      "connected to this gateway — they can look up documentation, search memory, " +
      "query APIs, and more. ALWAYS try this before saying you can't do something. " +
      "Returns discovered tool names, descriptions, and schemas for use with CallTool.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What you need — describe the capability, not the tool name. " +
            'Examples: "documentation for React", "search my memory", "look up API docs".',
        },
      },
      required: ["query"],
    },
  },
  {
    name: NATIVE_TOOLS.CALL_TOOL,
    description:
      "Execute a discovered tool by name. After finding tools with SearchTools, " +
      "call them here with the exact name and arguments from the search results. " +
      "Works with any tool — native, node, or remote.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            'The full tool name as returned by SearchTools (e.g., "aeon__recall", "gsv__ReadFile").',
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool, matching its input schema.",
        },
      },
      required: ["tool"],
    },
  },
];

export const discoverNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.SEARCH_TOOLS]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "SearchTools unavailable: gateway context missing",
      };
    }

    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, error: "query is required" };
    }

    const results = await context.gateway.searchTools(query);
    return { ok: true, result: results };
  },

  [NATIVE_TOOLS.CALL_TOOL]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "CallTool unavailable: gateway context missing",
      };
    }

    const tool = typeof args.tool === "string" ? args.tool.trim() : "";
    if (!tool) {
      return { ok: false, error: "tool name is required" };
    }

    const toolArgs =
      args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : {};

    const result = await context.gateway.callToolDirect(
      tool,
      toolArgs,
      context.agentId,
    );
    return result;
  },
};
