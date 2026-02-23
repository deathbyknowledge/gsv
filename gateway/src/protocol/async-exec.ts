import type { NodeExecEventType, RuntimeNodeInventory, ToolDefinition } from "./tools";

export type AsyncExecTerminalEventType = Extract<
  NodeExecEventType,
  "finished" | "failed" | "timed_out"
>;

export type AsyncExecCompletionInput = {
  eventId: string;
  nodeId: string;
  sessionId: string;
  callId?: string;
  event: AsyncExecTerminalEventType;
  exitCode?: number | null;
  signal?: string;
  outputTail?: string;
  startedAt?: number;
  endedAt?: number;
  tools: ToolDefinition[];
  runtimeNodes?: RuntimeNodeInventory;
};
