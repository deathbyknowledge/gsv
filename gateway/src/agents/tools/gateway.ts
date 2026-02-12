import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";

export const getGatewayToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.CONFIG_GET,
    description:
      "Inspect Gateway configuration. Returns masked full config by default, or a specific value when path is provided.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional dotted path (e.g., 'session.dmScope' or 'channels.whatsapp.allowFrom').",
        },
      },
      required: [],
    },
  },
  {
    name: NATIVE_TOOLS.LOGS_GET,
    description:
      "Fetch recent log lines from a connected node. If nodeId is omitted, it auto-selects when exactly one node is connected.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Optional node id. Required when multiple nodes are connected.",
        },
        lines: {
          type: "number",
          description: "Optional number of lines (default 100, max 5000).",
        },
      },
      required: [],
    },
  },
];

export const gatewayNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.CONFIG_GET]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "ConfigGet tool unavailable: gateway context missing",
      };
    }

    const path = typeof args.path === "string" ? args.path.trim() : undefined;
    if (path) {
      const value = await context.gateway.getConfigPath(path);
      return {
        ok: true,
        result: { path, value },
      };
    }

    return {
      ok: true,
      result: { config: await context.gateway.getSafeConfig() },
    };
  },
  [NATIVE_TOOLS.LOGS_GET]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "LogsGet tool unavailable: gateway context missing",
      };
    }

    const nodeId =
      typeof args.nodeId === "string" ? args.nodeId.trim() || undefined : undefined;
    const lines =
      typeof args.lines === "number" && Number.isFinite(args.lines)
        ? args.lines
        : undefined;

    const payload = await context.gateway.getNodeLogs({ nodeId, lines });
    return {
      ok: true,
      result: payload,
    };
  },
};
