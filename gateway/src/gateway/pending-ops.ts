import { PersistedObject } from "../shared/persisted-object";

export const PENDING_TOOL_RESULT_KIND = "tool.result";
export const PENDING_LOGS_RESULT_KIND = "logs.result";
const MAX_PENDING_OPERATION_TTL_MS = 120_000;

export type PendingToolRoute =
  | { kind: "session"; sessionKey: string }
  | { kind: "client"; clientId: string; frameId: string; createdAt: number };

export type PendingLogRoute = {
  clientId: string;
  frameId: string;
  nodeId: string;
  createdAt: number;
};

export type PendingToolOperation = {
  kind: typeof PENDING_TOOL_RESULT_KIND;
  createdAt: number;
  expiresAt?: number;
  payload: { route: PendingToolRoute };
};

export type PendingLogOperation = {
  kind: typeof PENDING_LOGS_RESULT_KIND;
  createdAt: number;
  expiresAt?: number;
  payload: { route: PendingLogRoute };
};

export type GatewayPendingOperation = PendingToolOperation | PendingLogOperation;

export type GatewayPendingOperations = Record<string, GatewayPendingOperation>;

export type PendingToolOperationExpired = {
  callId: string;
  route: PendingToolRoute;
};

export type PendingLogOperationExpired = {
  callId: string;
  route: PendingLogRoute;
};

export type ExpiredPendingOperations = {
  toolCalls: PendingToolOperationExpired[];
  logCalls: PendingLogOperationExpired[];
};

export type PendingOperationRegistration = {
  ttlMs?: number;
};

export type FailedLogOperation = {
  callId: string;
  clientId: string;
  frameId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

export function isPendingToolRoute(
  value: unknown,
): value is PendingToolRoute {
  if (!isRecord(value)) {
    return false;
  }

  const routeKind = asString(value.kind);
  if (routeKind === "session") {
    return Boolean(asString(value.sessionKey));
  }

  if (routeKind !== "client") {
    return false;
  }

  return Boolean(asString(value.clientId)) &&
    Boolean(asString(value.frameId)) &&
    asNumber(value.createdAt) !== undefined;
}

export function isPendingLogRoute(value: unknown): value is PendingLogRoute {
  if (!isRecord(value)) {
    return false;
  }

  return Boolean(asString(value.clientId)) &&
    Boolean(asString(value.frameId)) &&
    Boolean(asString(value.nodeId)) &&
    asNumber(value.createdAt) !== undefined;
}

export function isPendingToolOperation(
  value: unknown,
): value is PendingToolOperation {
  if (!isRecord(value) || value.kind !== PENDING_TOOL_RESULT_KIND) {
    return false;
  }

  const createdAt = asNumber(value.createdAt);
  const expiresAt = value.expiresAt;
  const payload = value.payload;
  return createdAt !== undefined &&
    (expiresAt === undefined || asNumber(expiresAt) !== undefined) &&
    isRecord(payload) &&
    isPendingToolRoute(payload.route);
}

export function isPendingLogOperation(
  value: unknown,
): value is PendingLogOperation {
  if (!isRecord(value) || value.kind !== PENDING_LOGS_RESULT_KIND) {
    return false;
  }

  const createdAt = asNumber(value.createdAt);
  const expiresAt = value.expiresAt;
  const payload = value.payload;
  return createdAt !== undefined &&
    (expiresAt === undefined || asNumber(expiresAt) !== undefined) &&
    isRecord(payload) &&
    isPendingLogRoute(payload.route);
}

export function sanitizePendingToolRoute(route: PendingToolRoute): PendingToolRoute {
  if (route.kind === "session") {
    return { kind: "session", sessionKey: route.sessionKey };
  }

  return {
    kind: "client",
    clientId: route.clientId,
    frameId: route.frameId,
    createdAt: route.createdAt,
  };
}

export function sanitizePendingLogRoute(route: PendingLogRoute): PendingLogRoute {
  return {
    clientId: route.clientId,
    frameId: route.frameId,
    nodeId: route.nodeId,
    createdAt: route.createdAt,
  };
}

export class GatewayPendingOperationsService {
  private readonly pendingOperations: GatewayPendingOperations;

  constructor(private readonly kv: SyncKvStorage) {
    this.pendingOperations = PersistedObject<GatewayPendingOperations>(this.kv, {
      prefix: "pendingOperations:",
    });
  }

  private sanitizeTtl(ttlMs?: number): number | undefined {
    if (ttlMs === undefined) {
      return;
    }

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return;
    }

    const normalized = Math.floor(ttlMs);
    return Math.min(Math.max(1_000, normalized), MAX_PENDING_OPERATION_TTL_MS);
  }

  registerToolCall(
    callId: string,
    route: PendingToolRoute,
    options?: PendingOperationRegistration,
  ): void {
    const now = Date.now();
    const ttlMs = this.sanitizeTtl(options?.ttlMs);

    const expiresAt = ttlMs === undefined ? undefined : now + ttlMs;
    this.pendingOperations[callId] = {
      kind: PENDING_TOOL_RESULT_KIND,
      createdAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      payload: { route: sanitizePendingToolRoute(route) },
    };
  }

  consumeToolCall(callId: string): PendingToolRoute | undefined {
    const raw = this.pendingOperations[callId];
    if (!isPendingToolOperation(raw)) {
      if (raw !== undefined) {
        delete this.pendingOperations[callId];
      }
      return;
    }

    const route = raw.payload.route;
    delete this.pendingOperations[callId];
    return sanitizePendingToolRoute(route);
  }

  registerLogCall(
    callId: string,
    route: PendingLogRoute,
    options?: PendingOperationRegistration,
  ): void {
    const now = Date.now();
    const ttlMs = this.sanitizeTtl(options?.ttlMs);
    const expiresAt = ttlMs === undefined ? undefined : now + ttlMs;

    this.pendingOperations[callId] = {
      kind: PENDING_LOGS_RESULT_KIND,
      createdAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      payload: { route: sanitizePendingLogRoute(route) },
    };
  }

  getNextExpirationAtMs(): number | undefined {
    const now = Date.now();
    let next: number | undefined;
    for (const raw of Object.values(this.pendingOperations)) {
      if (!isPendingToolOperation(raw) && !isPendingLogOperation(raw)) {
        continue;
      }

      const expiresAt = asNumber(raw.expiresAt);
      if (expiresAt === undefined) {
        continue;
      }

      if (expiresAt <= now) {
        return now;
      }

      if (next === undefined || expiresAt < next) {
        next = expiresAt;
      }
    }

    return next;
  }

  cleanupExpired(now = Date.now()): ExpiredPendingOperations {
    const expired: ExpiredPendingOperations = {
      toolCalls: [],
      logCalls: [],
    };

    for (const [callId, raw] of Object.entries(this.pendingOperations)) {
      if (!isPendingToolOperation(raw) && !isPendingLogOperation(raw)) {
        delete this.pendingOperations[callId];
        continue;
      }

      const expiresAt = raw.expiresAt;
      if (expiresAt === undefined) {
        continue;
      }

      if (asNumber(expiresAt) === undefined || expiresAt <= now) {
        delete this.pendingOperations[callId];
      } else {
        continue;
      }

      if (raw.kind === PENDING_TOOL_RESULT_KIND) {
        expired.toolCalls.push({
          callId,
          route: sanitizePendingToolRoute(raw.payload.route),
        });
        continue;
      }

      expired.logCalls.push({
        callId,
        route: sanitizePendingLogRoute(raw.payload.route),
      });
    }

    return expired;
  }

  consumeLogCall(callId: string): PendingLogRoute | undefined {
    const raw = this.pendingOperations[callId];
    if (!isPendingLogOperation(raw)) {
      if (raw !== undefined) {
        delete this.pendingOperations[callId];
      }
      return;
    }

    const route = raw.payload.route;
    delete this.pendingOperations[callId];
    return sanitizePendingLogRoute(route);
  }

  cleanupClientPendingOperations(clientId: string): void {
    for (const [callId, raw] of Object.entries(this.pendingOperations)) {
      if (isPendingToolOperation(raw) && raw.payload.route.kind === "client") {
        if (raw.payload.route.clientId === clientId) {
          delete this.pendingOperations[callId];
        }
        continue;
      }

      if (isPendingLogOperation(raw) && raw.payload.route.clientId === clientId) {
        delete this.pendingOperations[callId];
      }
    }
  }

  failPendingLogCallsForNode(
    nodeId: string,
  ): FailedLogOperation[] {
    const failed: FailedLogOperation[] = [];

    for (const [callId, raw] of Object.entries(this.pendingOperations)) {
      if (!isPendingLogOperation(raw)) {
        continue;
      }
      if (raw.payload.route.nodeId !== nodeId) {
        continue;
      }

      failed.push({
        callId,
        clientId: raw.payload.route.clientId,
        frameId: raw.payload.route.frameId,
      });

      delete this.pendingOperations[callId];
    }

    return failed;
  }
}
