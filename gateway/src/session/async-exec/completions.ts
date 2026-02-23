import type {
  AsyncExecCompletionInput,
  AsyncExecTerminalEventType,
} from "../../protocol/async-exec";

export type { AsyncExecCompletionInput };

export type PendingAsyncExecCompletion = AsyncExecCompletionInput & {
  receivedAt: number;
};

export const ASYNC_EXEC_EVENT_SEEN_TTL_MS = 24 * 60 * 60_000;
export const ASYNC_EXEC_EVENT_PENDING_MAX_AGE_MS = 24 * 60 * 60_000;

function normalizeEvent(value: unknown): AsyncExecTerminalEventType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const event = value.trim();
  if (event === "finished" || event === "failed" || event === "timed_out") {
    return event;
  }
  return undefined;
}

export function asPendingAsyncExecCompletion(
  value: unknown,
): PendingAsyncExecCompletion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const eventId = typeof record.eventId === "string" ? record.eventId.trim() : "";
  const nodeId = typeof record.nodeId === "string" ? record.nodeId.trim() : "";
  const sessionId =
    typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const event = normalizeEvent(record.event);
  const receivedAt =
    typeof record.receivedAt === "number" && Number.isFinite(record.receivedAt)
      ? record.receivedAt
      : undefined;

  if (!eventId || !nodeId || !sessionId || !event || receivedAt === undefined) {
    return undefined;
  }

  return value as PendingAsyncExecCompletion;
}

export function hasPendingAsyncExecCompletions(
  pending: Record<string, PendingAsyncExecCompletion>,
): boolean {
  let hasPending = false;
  for (const [eventId, rawCompletion] of Object.entries(pending)) {
    const completion = asPendingAsyncExecCompletion(rawCompletion);
    if (!completion) {
      delete pending[eventId];
      continue;
    }
    hasPending = true;
  }
  return hasPending;
}

export function gcAsyncExecCompletionState(
  seenEventIds: Record<string, number>,
  pendingCompletions: Record<string, PendingAsyncExecCompletion>,
  now = Date.now(),
): void {
  for (const [eventId, expiresAt] of Object.entries(seenEventIds)) {
    if (
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now
    ) {
      delete seenEventIds[eventId];
    }
  }

  for (const [eventId, rawCompletion] of Object.entries(pendingCompletions)) {
    const completion = asPendingAsyncExecCompletion(rawCompletion);
    const receivedAt = completion?.receivedAt;
    if (!receivedAt || receivedAt + ASYNC_EXEC_EVENT_PENDING_MAX_AGE_MS <= now) {
      delete pendingCompletions[eventId];
    }
  }
}

export function buildAsyncExecSystemEventMessage(
  completion: PendingAsyncExecCompletion,
): string {
  const payload = {
    eventId: completion.eventId,
    nodeId: completion.nodeId,
    sessionId: completion.sessionId,
    callId: completion.callId,
    event: completion.event,
    exitCode: completion.exitCode,
    signal: completion.signal,
    outputTail: completion.outputTail,
    startedAt: completion.startedAt,
    endedAt: completion.endedAt,
  };

  return [
    "System event: async_exec_completion",
    JSON.stringify(payload),
  ].join("\n");
}

export function normalizeAsyncExecCompletionInput(
  input: AsyncExecCompletionInput,
  now = Date.now(),
): PendingAsyncExecCompletion | null {
  const eventId = typeof input.eventId === "string" ? input.eventId.trim() : "";
  const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  const event = normalizeEvent(input.event);

  if (!eventId || !nodeId || !sessionId || !event) {
    return null;
  }

  return {
    eventId,
    nodeId,
    sessionId,
    callId:
      typeof input.callId === "string"
        ? input.callId.trim() || undefined
        : undefined,
    event,
    exitCode:
      typeof input.exitCode === "number" && Number.isFinite(input.exitCode)
        ? input.exitCode
        : input.exitCode === null
          ? null
          : undefined,
    signal:
      typeof input.signal === "string" ? input.signal.trim() || undefined : undefined,
    outputTail:
      typeof input.outputTail === "string"
        ? input.outputTail.trim() || undefined
        : undefined,
    startedAt:
      typeof input.startedAt === "number" && Number.isFinite(input.startedAt)
        ? input.startedAt
        : undefined,
    endedAt:
      typeof input.endedAt === "number" && Number.isFinite(input.endedAt)
        ? input.endedAt
        : undefined,
    tools: JSON.parse(JSON.stringify(input.tools ?? [])),
    runtimeNodes: input.runtimeNodes
      ? JSON.parse(JSON.stringify(input.runtimeNodes))
      : undefined,
    receivedAt: now,
  };
}
