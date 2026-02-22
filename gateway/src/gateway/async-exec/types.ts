import type { AsyncExecTerminalEventType } from "../../protocol/async-exec";

export type PendingAsyncExecSession = {
  nodeId: string;
  sessionId: string;
  sessionKey: string;
  callId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type PendingAsyncExecDelivery = {
  eventId: string;
  nodeId: string;
  sessionId: string;
  sessionKey: string;
  callId: string;
  event: AsyncExecTerminalEventType;
  exitCode?: number | null;
  signal?: string;
  outputTail?: string;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
  lastError?: string;
};
