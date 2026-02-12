import type { ToolDefinition } from "../../protocol/tools";
import { NATIVE_TOOL_PREFIX } from "./constants";
import { cronNativeToolHandlers, getCronToolDefinitions } from "./cron";
import {
  gatewayNativeToolHandlers,
  getGatewayToolDefinitions,
} from "./gateway";
import {
  getWorkspaceToolDefinitions,
  workspaceNativeToolHandlers,
} from "./workspace";
import type {
  NativeToolExecutionContext,
  NativeToolHandlerMap,
  NativeToolResult,
} from "./types";

export * from "./constants";
export * from "./types";
export * from "./workspace";
export * from "./cron";
export * from "./gateway";

const nativeToolHandlers: NativeToolHandlerMap = {
  ...workspaceNativeToolHandlers,
  ...gatewayNativeToolHandlers,
  ...cronNativeToolHandlers,
};

export function isNativeTool(toolName: string): boolean {
  return toolName.startsWith(NATIVE_TOOL_PREFIX);
}

export function getNativeToolDefinitions(): ToolDefinition[] {
  return [
    ...getWorkspaceToolDefinitions(),
    ...getGatewayToolDefinitions(),
    ...getCronToolDefinitions(),
  ];
}

/**
 * Execute a native tool
 * Returns { ok, result?, error? }
 */
export async function executeNativeTool(
  context: {
    bucket: R2Bucket;
    agentId: string;
    gateway?: NativeToolExecutionContext["gateway"];
  },
  toolName: string,
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const handler = nativeToolHandlers[toolName];
  if (!handler) {
    return { ok: false, error: `Unknown native tool: ${toolName}` };
  }

  const executionContext: NativeToolExecutionContext = {
    ...context,
    basePath: `agents/${context.agentId}`,
  };

  try {
    return await handler(executionContext, args);
  } catch (e) {
    console.error(`[NativeTools] Error executing ${toolName}:`, e);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
