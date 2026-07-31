import { DisconnectReason } from "@whiskeysockets/baileys";

export const SOCKET_LEASE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const PAIRING_WINDOW_MS = 2 * 60 * 1000;
export const INBOUND_RETRY_DELAY_MS = 10_000;
export const INBOUND_RETRY_BATCH_SIZE = 25;
export const APPEND_CATCH_UP_LIMIT = 100;
export const APPEND_CATCH_UP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const RECONNECT_JITTER_MS = 1_000;

export type DisconnectPolicy = {
  action: "reconnect" | "restart" | "stop" | "logged_out";
  clearAuth: boolean;
};

export function disconnectPolicy(statusCode: number | undefined): DisconnectPolicy {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return { action: "logged_out", clearAuth: true };
    case DisconnectReason.connectionReplaced:
      return { action: "stop", clearAuth: false };
    case DisconnectReason.badSession:
    case DisconnectReason.multideviceMismatch:
    case DisconnectReason.forbidden:
      return { action: "stop", clearAuth: true };
    case DisconnectReason.restartRequired:
      return { action: "restart", clearAuth: false };
    default:
      return { action: "reconnect", clearAuth: false };
  }
}

export function reconnectDelayMs(
  attempt: number,
  jitterFraction = secureJitterFraction(),
): number {
  const normalizedAttempt = Math.max(0, Math.min(20, Math.floor(attempt)));
  const exponential = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * (2 ** normalizedAttempt),
  );
  const jitter = Math.floor(
    Math.max(0, Math.min(0.999999, jitterFraction)) * RECONNECT_JITTER_MS,
  );
  return exponential + jitter;
}

export function restartDelayMs(
  attempt: number,
  jitterFraction?: number,
): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return normalizedAttempt === 0
    ? 0
    : reconnectDelayMs(normalizedAttempt - 1, jitterFraction);
}

export function earliestDeadline(
  ...deadlines: Array<number | null | undefined>
): number | undefined {
  const valid = deadlines.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return valid.length > 0 ? Math.min(...valid) : undefined;
}

export function nextAccountAlarmDeadline(
  lifecycleDeadline: number | undefined,
  hasPendingInbound: boolean,
  now = Date.now(),
): number | undefined {
  return earliestDeadline(
    lifecycleDeadline,
    hasPendingInbound ? now + INBOUND_RETRY_DELAY_MS : undefined,
  );
}

export type SocketLeaseHealth = {
  hasSocket: boolean;
  stateConnected: boolean;
  socketAuthenticated: boolean;
  webSocketOpen: boolean;
};

export type SocketLeaseAction = "wait" | "refresh" | "recover";

/**
 * An established socket is checked on every account alarm, but a healthy
 * socket is replaced only when its absolute Cloudflare keepalive lease is due.
 */
export function socketLeaseAction(
  refreshAt: number | undefined,
  health: SocketLeaseHealth,
  now = Date.now(),
): SocketLeaseAction {
  if (refreshAt === undefined || !Number.isFinite(refreshAt)) return "wait";
  if (
    !health.hasSocket
    || !health.stateConnected
    || !health.socketAuthenticated
    || !health.webSocketOpen
  ) {
    return "recover";
  }
  return refreshAt <= now ? "refresh" : "wait";
}

export function pairingSessionExpired(
  authenticated: boolean,
  expiresAt: number | undefined,
  now = Date.now(),
): boolean {
  return !authenticated
    && typeof expiresAt === "number"
    && Number.isFinite(expiresAt)
    && expiresAt <= now;
}

export function pairingChallengeIsCurrent(
  qr: string | null,
  expiresAt: number | undefined,
  now = Date.now(),
): qr is string {
  return Boolean(qr)
    && typeof expiresAt === "number"
    && Number.isFinite(expiresAt)
    && expiresAt > now;
}

export function canReplaceSupersededLifecycleAlarm(
  currentAlarm: number | null,
  supersededDeadline: number | undefined,
  hasPendingInbound: boolean,
): boolean {
  return !hasPendingInbound
    && supersededDeadline !== undefined
    && currentAlarm === supersededDeadline;
}

export class SocketOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Durably accepts an entire provider event before any accepted item is forwarded. */
export async function enqueueThenDeliverInboundBatch<T>(
  enqueueBatch: () => Promise<T[]>,
  deliver: (item: T) => Promise<void>,
): Promise<void> {
  const accepted = await enqueueBatch();
  for (const item of accepted) {
    await deliver(item);
  }
}

function secureJitterFraction(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 0x1_0000_0000;
}
