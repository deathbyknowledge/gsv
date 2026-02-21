import { snapshot, type Proxied } from "../shared/persisted-object";
import type {
  NodeExecEventParams,
  NodeExecEventType,
} from "../protocol/tools";
import type { Gateway } from "./do";

const ASYNC_EXEC_SESSION_TTL_MS = 24 * 60 * 60_000;
const ASYNC_EXEC_DELIVERY_TTL_MS = 24 * 60 * 60_000;
const ASYNC_EXEC_DELIVERY_RETRY_BASE_MS = 1000;
const ASYNC_EXEC_DELIVERY_RETRY_MAX_MS = 60_000;
const ASYNC_EXEC_EVENT_DEDUPE_TTL_MS = 24 * 60 * 60_000;

type AsyncExecTerminalEventType = Extract<
  NodeExecEventType,
  "finished" | "failed" | "timed_out"
>;

type PendingAsyncExecSession = {
  nodeId: string;
  sessionId: string;
  sessionKey: string;
  callId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type PendingAsyncExecDelivery = {
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

export type AsyncExecDeliveryDeps = {
  getSessionByName: (sessionKey: string) => ReturnType<Env["SESSION"]["getByName"]>;
};

export type AsyncExecEventDeps = AsyncExecDeliveryDeps & {
  scheduleAlarm: () => Promise<void>;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asyncExecSessionKey(nodeId: string, sessionId: string): string {
  return `${nodeId}:${sessionId}`;
}

function clonePendingAsyncExecSession(
  value: PendingAsyncExecSession,
  overrides?: Partial<PendingAsyncExecSession>,
): PendingAsyncExecSession {
  const plain = snapshot(
    value as unknown as Proxied<PendingAsyncExecSession>,
  );
  return {
    nodeId: overrides?.nodeId ?? plain.nodeId,
    sessionId: overrides?.sessionId ?? plain.sessionId,
    sessionKey: overrides?.sessionKey ?? plain.sessionKey,
    callId: overrides?.callId ?? plain.callId,
    createdAt: overrides?.createdAt ?? plain.createdAt,
    updatedAt: overrides?.updatedAt ?? plain.updatedAt,
    expiresAt: overrides?.expiresAt ?? plain.expiresAt,
  };
}

function asPendingAsyncExecSession(
  value: unknown,
): PendingAsyncExecSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nodeId = asString(record.nodeId);
  const sessionId = asString(record.sessionId);
  const sessionKey = asString(record.sessionKey);
  const callId = asString(record.callId);
  const createdAt = asNumber(record.createdAt);
  const updatedAt = asNumber(record.updatedAt);
  const expiresAt = asNumber(record.expiresAt);
  if (
    !nodeId ||
    !sessionId ||
    !sessionKey ||
    !callId ||
    createdAt === undefined ||
    updatedAt === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return {
    nodeId,
    sessionId,
    sessionKey,
    callId,
    createdAt,
    updatedAt,
    expiresAt,
  };
}

function getPendingAsyncExecSession(
  gw: Gateway,
  nodeId: string,
  sessionId: string,
): PendingAsyncExecSession | undefined {
  const key = asyncExecSessionKey(nodeId, sessionId);
  const rawValue = gw.pendingAsyncExecSessions[key];
  const value = asPendingAsyncExecSession(rawValue);
  if (!value) {
    if (rawValue !== undefined) {
      delete gw.pendingAsyncExecSessions[key];
    }
    return undefined;
  }
  return clonePendingAsyncExecSession(value);
}

function deletePendingAsyncExecSession(
  gw: Gateway,
  nodeId: string,
  sessionId: string,
): void {
  const key = asyncExecSessionKey(nodeId, sessionId);
  delete gw.pendingAsyncExecSessions[key];
}

function touchPendingAsyncExecSession(
  gw: Gateway,
  nodeId: string,
  sessionId: string,
): void {
  const key = asyncExecSessionKey(nodeId, sessionId);
  const rawValue = gw.pendingAsyncExecSessions[key];
  const value = asPendingAsyncExecSession(rawValue);
  if (!value) {
    if (rawValue !== undefined) {
      delete gw.pendingAsyncExecSessions[key];
    }
    return;
  }
  const now = Date.now();
  gw.pendingAsyncExecSessions[key] = clonePendingAsyncExecSession(value, {
    updatedAt: now,
    expiresAt: now + ASYNC_EXEC_SESSION_TTL_MS,
  });
}

function asAsyncExecTerminalEvent(
  value: string,
): AsyncExecTerminalEventType | undefined {
  if (value === "finished" || value === "failed" || value === "timed_out") {
    return value;
  }
  return undefined;
}

function resolveAsyncExecEventId(
  nodeId: string,
  sessionId: string,
  params: NodeExecEventParams,
): string {
  const explicit =
    typeof params.eventId === "string" ? params.eventId.trim() : "";
  if (explicit) {
    return explicit;
  }

  const parts = [
    nodeId,
    sessionId,
    typeof params.event === "string" ? params.event.trim() : "unknown",
    typeof params.callId === "string" ? params.callId.trim() : "",
    typeof params.startedAt === "number" ? String(params.startedAt) : "",
    typeof params.endedAt === "number" ? String(params.endedAt) : "",
    typeof params.exitCode === "number" ? String(params.exitCode) : "",
    typeof params.signal === "string" ? params.signal.trim() : "",
  ];

  return parts.filter((part) => part.length > 0).join(":");
}

function clonePendingAsyncExecDelivery(
  value: PendingAsyncExecDelivery,
  overrides?: Partial<PendingAsyncExecDelivery>,
): PendingAsyncExecDelivery {
  const plain = snapshot(
    value as unknown as Proxied<PendingAsyncExecDelivery>,
  );
  return {
    eventId: overrides?.eventId ?? plain.eventId,
    nodeId: overrides?.nodeId ?? plain.nodeId,
    sessionId: overrides?.sessionId ?? plain.sessionId,
    sessionKey: overrides?.sessionKey ?? plain.sessionKey,
    callId: overrides?.callId ?? plain.callId,
    event: overrides?.event ?? plain.event,
    exitCode: overrides?.exitCode ?? plain.exitCode,
    signal: overrides?.signal ?? plain.signal,
    outputTail: overrides?.outputTail ?? plain.outputTail,
    startedAt: overrides?.startedAt ?? plain.startedAt,
    endedAt: overrides?.endedAt ?? plain.endedAt,
    createdAt: overrides?.createdAt ?? plain.createdAt,
    updatedAt: overrides?.updatedAt ?? plain.updatedAt,
    attempts: overrides?.attempts ?? plain.attempts,
    nextAttemptAt: overrides?.nextAttemptAt ?? plain.nextAttemptAt,
    expiresAt: overrides?.expiresAt ?? plain.expiresAt,
    lastError: overrides?.lastError ?? plain.lastError,
  };
}

function asPendingAsyncExecDelivery(
  value: unknown,
): PendingAsyncExecDelivery | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const eventId = asString(record.eventId);
  const nodeId = asString(record.nodeId);
  const sessionId = asString(record.sessionId);
  const sessionKey = asString(record.sessionKey);
  const callId = asString(record.callId);
  const event =
    typeof record.event === "string"
      ? asAsyncExecTerminalEvent(record.event.trim())
      : undefined;
  const createdAt = asNumber(record.createdAt);
  const updatedAt = asNumber(record.updatedAt);
  const attempts = asNumber(record.attempts);
  const nextAttemptAt = asNumber(record.nextAttemptAt);
  const expiresAt = asNumber(record.expiresAt);

  if (
    !eventId ||
    !nodeId ||
    !sessionId ||
    !sessionKey ||
    !callId ||
    !event ||
    createdAt === undefined ||
    updatedAt === undefined ||
    attempts === undefined ||
    nextAttemptAt === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }

  return {
    eventId,
    nodeId,
    sessionId,
    sessionKey,
    callId,
    event,
    exitCode:
      typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
        ? record.exitCode
        : record.exitCode === null
          ? null
          : undefined,
    signal: asString(record.signal),
    outputTail: asString(record.outputTail),
    startedAt: asNumber(record.startedAt),
    endedAt: asNumber(record.endedAt),
    createdAt,
    updatedAt,
    attempts: Math.max(0, Math.floor(attempts)),
    nextAttemptAt: Math.floor(nextAttemptAt),
    expiresAt: Math.floor(expiresAt),
    lastError: asString(record.lastError),
  };
}

function isAsyncExecEventDelivered(
  gw: Gateway,
  eventId: string,
  now = Date.now(),
): boolean {
  const expiresAt = gw.deliveredAsyncExecEvents[eventId];
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > now) {
    return true;
  }

  if (expiresAt !== undefined) {
    delete gw.deliveredAsyncExecEvents[eventId];
  }

  return false;
}

function markAsyncExecEventDelivered(
  gw: Gateway,
  eventId: string,
  now = Date.now(),
): void {
  gw.deliveredAsyncExecEvents[eventId] = now + ASYNC_EXEC_EVENT_DEDUPE_TTL_MS;
}

function getPendingAsyncExecDelivery(
  gw: Gateway,
  eventId: string,
): PendingAsyncExecDelivery | undefined {
  const rawValue = gw.pendingAsyncExecDeliveries[eventId];
  const value = asPendingAsyncExecDelivery(rawValue);
  if (!value) {
    if (rawValue !== undefined) {
      delete gw.pendingAsyncExecDeliveries[eventId];
    }
    return undefined;
  }
  return clonePendingAsyncExecDelivery(value);
}

function asyncExecDeliveryBackoffMs(attempts: number): number {
  const normalizedAttempts = Math.max(1, Math.floor(attempts));
  const exponent = Math.min(normalizedAttempts - 1, 8);
  return Math.min(
    ASYNC_EXEC_DELIVERY_RETRY_MAX_MS,
    ASYNC_EXEC_DELIVERY_RETRY_BASE_MS * 2 ** exponent,
  );
}

function queueAsyncExecDelivery(
  gw: Gateway,
  params: {
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
  },
): PendingAsyncExecDelivery {
  const existing = getPendingAsyncExecDelivery(gw, params.eventId);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const delivery: PendingAsyncExecDelivery = {
    eventId: params.eventId,
    nodeId: params.nodeId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    callId: params.callId,
    event: params.event,
    exitCode: params.exitCode,
    signal: params.signal,
    outputTail: params.outputTail,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    nextAttemptAt: now,
    expiresAt: now + ASYNC_EXEC_DELIVERY_TTL_MS,
  };
  gw.pendingAsyncExecDeliveries[params.eventId] = delivery;
  return delivery;
}

export function gcPendingAsyncExecSessions(
  gw: Gateway,
  now = Date.now(),
  reason?: string,
): number {
  let removed = 0;
  for (const [key, rawValue] of Object.entries(gw.pendingAsyncExecSessions)) {
    const value = asPendingAsyncExecSession(rawValue);
    if (!value) {
      delete gw.pendingAsyncExecSessions[key];
      removed += 1;
      continue;
    }
    if (value.expiresAt > now) {
      continue;
    }
    delete gw.pendingAsyncExecSessions[key];
    removed += 1;
  }
  if (removed > 0) {
    console.warn(
      `[Gateway] GC removed ${removed} stale async exec sessions${reason ? ` (${reason})` : ""}`,
    );
  }
  return removed;
}

export function nextPendingAsyncExecSessionExpiryAtMs(
  gw: Gateway,
): number | undefined {
  let next: number | undefined;
  for (const [key, rawValue] of Object.entries(gw.pendingAsyncExecSessions)) {
    const value = asPendingAsyncExecSession(rawValue);
    if (!value) {
      delete gw.pendingAsyncExecSessions[key];
      continue;
    }
    if (next === undefined || value.expiresAt < next) {
      next = value.expiresAt;
    }
  }
  return next;
}

export function registerPendingAsyncExecSession(
  gw: Gateway,
  params: {
    nodeId: string;
    sessionId: string;
    sessionKey: string;
    callId: string;
  },
): void {
  const now = Date.now();
  const normalizedSessionId = params.sessionId.trim();
  if (!normalizedSessionId) {
    return;
  }
  gcPendingAsyncExecSessions(gw, now, "register");
  const key = asyncExecSessionKey(params.nodeId, normalizedSessionId);
  gw.pendingAsyncExecSessions[key] = {
    nodeId: params.nodeId,
    sessionId: normalizedSessionId,
    sessionKey: params.sessionKey,
    callId: params.callId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ASYNC_EXEC_SESSION_TTL_MS,
  };
}

export function gcPendingAsyncExecDeliveries(
  gw: Gateway,
  now = Date.now(),
  reason?: string,
): number {
  let removed = 0;
  for (const [eventId, rawValue] of Object.entries(gw.pendingAsyncExecDeliveries)) {
    const value = asPendingAsyncExecDelivery(rawValue);
    if (!value || value.expiresAt <= now) {
      delete gw.pendingAsyncExecDeliveries[eventId];
      removed += 1;
    }
  }

  if (removed > 0) {
    console.warn(
      `[Gateway] GC removed ${removed} stale async exec deliveries${reason ? ` (${reason})` : ""}`,
    );
  }

  return removed;
}

export function nextPendingAsyncExecDeliveryAtMs(
  gw: Gateway,
  now = Date.now(),
): number | undefined {
  let next: number | undefined;
  for (const [eventId, rawValue] of Object.entries(gw.pendingAsyncExecDeliveries)) {
    const value = asPendingAsyncExecDelivery(rawValue);
    if (!value) {
      delete gw.pendingAsyncExecDeliveries[eventId];
      continue;
    }

    const candidate = value.expiresAt <= now ? now : Math.max(now, value.nextAttemptAt);
    if (next === undefined || candidate < next) {
      next = candidate;
    }
  }
  return next;
}

export function gcDeliveredAsyncExecEvents(
  gw: Gateway,
  now = Date.now(),
  reason?: string,
): number {
  let removed = 0;
  for (const [eventId, expiresAt] of Object.entries(gw.deliveredAsyncExecEvents)) {
    if (
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now
    ) {
      delete gw.deliveredAsyncExecEvents[eventId];
      removed += 1;
    }
  }

  if (removed > 0) {
    console.warn(
      `[Gateway] GC removed ${removed} delivered async exec event ids${reason ? ` (${reason})` : ""}`,
    );
  }

  return removed;
}

export function nextDeliveredAsyncExecEventGcAtMs(
  gw: Gateway,
  now = Date.now(),
): number | undefined {
  let next: number | undefined;
  for (const [eventId, expiresAt] of Object.entries(gw.deliveredAsyncExecEvents)) {
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
      delete gw.deliveredAsyncExecEvents[eventId];
      if (next === undefined || now < next) {
        next = now;
      }
      continue;
    }
    const candidate = expiresAt <= now ? now : expiresAt;
    if (next === undefined || candidate < next) {
      next = candidate;
    }
  }
  return next;
}

export async function deliverPendingAsyncExecDeliveries(
  gw: Gateway,
  deps: AsyncExecDeliveryDeps,
  now = Date.now(),
): Promise<number> {
  gcDeliveredAsyncExecEvents(gw, now, "delivery-scan");
  gcPendingAsyncExecDeliveries(gw, now, "delivery-scan");

  const deliveries = Object.entries(gw.pendingAsyncExecDeliveries)
    .map(([eventId, rawValue]) => {
      const value = asPendingAsyncExecDelivery(rawValue);
      if (!value) {
        delete gw.pendingAsyncExecDeliveries[eventId];
        return null;
      }
      return value;
    })
    .filter((entry): entry is PendingAsyncExecDelivery => entry !== null)
    .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);

  let delivered = 0;
  for (const delivery of deliveries) {
    if (delivery.expiresAt <= now) {
      delete gw.pendingAsyncExecDeliveries[delivery.eventId];
      continue;
    }

    if (delivery.nextAttemptAt > now) {
      continue;
    }

    if (isAsyncExecEventDelivered(gw, delivery.eventId, now)) {
      delete gw.pendingAsyncExecDeliveries[delivery.eventId];
      continue;
    }

    try {
      const session = deps.getSessionByName(delivery.sessionKey);
      await session.ingestAsyncExecCompletion({
        eventId: delivery.eventId,
        nodeId: delivery.nodeId,
        sessionId: delivery.sessionId,
        callId: delivery.callId,
        event: delivery.event,
        exitCode: delivery.exitCode,
        signal: delivery.signal,
        outputTail: delivery.outputTail,
        startedAt: delivery.startedAt,
        endedAt: delivery.endedAt,
        tools: JSON.parse(JSON.stringify(gw.getAllTools())),
        runtimeNodes: JSON.parse(JSON.stringify(gw.getRuntimeNodeInventory())),
      });
      markAsyncExecEventDelivered(gw, delivery.eventId, now);
      delete gw.pendingAsyncExecDeliveries[delivery.eventId];
      delivered += 1;
    } catch (error) {
      const attempts = delivery.attempts + 1;
      gw.pendingAsyncExecDeliveries[delivery.eventId] =
        clonePendingAsyncExecDelivery(delivery, {
          attempts,
          updatedAt: now,
          nextAttemptAt: now + asyncExecDeliveryBackoffMs(attempts),
          lastError: error instanceof Error ? error.message : String(error),
        });
    }
  }

  return delivered;
}

export async function handleNodeExecEvent(
  gw: Gateway,
  nodeId: string,
  params: NodeExecEventParams,
  deps: AsyncExecEventDeps,
): Promise<{ ok: true; dropped?: true }> {
  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (!sessionId) {
    return { ok: true, dropped: true };
  }

  const eventType =
    typeof params.event === "string" ? params.event.trim() : "";
  if (!["started", "finished", "failed", "timed_out"].includes(eventType)) {
    return { ok: true, dropped: true };
  }

  const eventId = resolveAsyncExecEventId(nodeId, sessionId, params);
  if (!eventId) {
    return { ok: true, dropped: true };
  }

  const now = Date.now();
  gcPendingAsyncExecSessions(gw, now, "node.exec.event");
  gcPendingAsyncExecDeliveries(gw, now, "node.exec.event");
  gcDeliveredAsyncExecEvents(gw, now, "node.exec.event");

  if (isAsyncExecEventDelivered(gw, eventId, now)) {
    return { ok: true };
  }

  if (getPendingAsyncExecDelivery(gw, eventId)) {
    return { ok: true };
  }

  if (eventType === "started") {
    const pending = getPendingAsyncExecSession(gw, nodeId, sessionId);
    if (!pending) {
      return { ok: true, dropped: true };
    }
    touchPendingAsyncExecSession(gw, nodeId, sessionId);
    await deps.scheduleAlarm();
    return { ok: true };
  }

  const terminalEvent = asAsyncExecTerminalEvent(eventType);
  if (!terminalEvent) {
    return { ok: true, dropped: true };
  }

  const pending = getPendingAsyncExecSession(gw, nodeId, sessionId);
  if (!pending) {
    return { ok: true, dropped: true };
  }

  const outputTail =
    typeof params.outputTail === "string" ? params.outputTail.trim() : "";
  queueAsyncExecDelivery(gw, {
    eventId,
    nodeId,
    sessionId,
    sessionKey: pending.sessionKey,
    callId: pending.callId,
    event: terminalEvent,
    exitCode:
      typeof params.exitCode === "number" && Number.isFinite(params.exitCode)
        ? params.exitCode
        : params.exitCode === null
          ? null
          : undefined,
    signal:
      typeof params.signal === "string" ? params.signal.trim() || undefined : undefined,
    outputTail:
      outputTail.length > 4000
        ? outputTail.slice(outputTail.length - 4000)
        : outputTail || undefined,
    startedAt:
      typeof params.startedAt === "number" && Number.isFinite(params.startedAt)
        ? params.startedAt
        : undefined,
    endedAt:
      typeof params.endedAt === "number" && Number.isFinite(params.endedAt)
        ? params.endedAt
        : undefined,
  });
  deletePendingAsyncExecSession(gw, nodeId, sessionId);
  await deliverPendingAsyncExecDeliveries(gw, deps, now);
  await deps.scheduleAlarm();

  return { ok: true };
}
