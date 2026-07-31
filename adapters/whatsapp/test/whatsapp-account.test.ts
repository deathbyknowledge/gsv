import type {
  BaileysEventMap,
  WASocket,
} from "@whiskeysockets/baileys";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { SOCKET_LEASE_REFRESH_INTERVAL_MS } from "../src/lifecycle";
import { defaultWhatsAppAccountState } from "../src/types";
import { WhatsAppAccount } from "../src/whatsapp-account";

type LeaseHarness = {
  sock: WASocket | null;
  socketGeneration: number;
  authenticatedSockets: WeakSet<object>;
  groupMetadata: { clear(): void };
  state: ReturnType<typeof defaultWhatsAppAccountState>;
  qrCode: string | null;
  inboundDeliveries: { armIfPending(deadline: number): Promise<boolean> };
  socketOperations: { run<T>(operation: () => Promise<T>): Promise<T> };
  identities: { bindLidPn(lid: string, pn: string): Promise<void> };
  persistStateAndSchedule(supersededDeadline?: number): Promise<void>;
  startSocketLocked(source: string): Promise<void>;
  socketLeaseHealth(): {
    hasSocket: boolean;
    stateConnected: boolean;
    socketAuthenticated: boolean;
    webSocketOpen: boolean;
  };
  refreshSocketLeaseLocked(action: "refresh" | "recover"): Promise<void>;
  failConnectionAttemptLocked(reason: string): Promise<void>;
  retryPendingInbound(): Promise<void>;
  scheduleNextAlarm(): Promise<void>;
  scheduleReconnectAfterFailure(error: unknown): Promise<void>;
  isCurrentSocket(generation: number, socket: WASocket): boolean;
  resolvePairingWaiters(result: {
    connected?: boolean;
    qr?: string;
    expiresAt?: number;
  }): void;
  notifyGatewayStatus(): Promise<void>;
  own(event: string, promise: Promise<unknown>): void;
};

type AlarmMethod = (this: LeaseHarness) => Promise<void>;
type RefreshLeaseMethod = (
  this: LeaseHarness,
  action: "refresh" | "recover",
) => Promise<void>;
type ConnectionUpdateMethod = (
  this: LeaseHarness,
  generation: number,
  socket: WASocket,
  update: Partial<BaileysEventMap["connection.update"]>,
) => Promise<void>;
type IsCurrentSocketMethod = (
  this: LeaseHarness,
  generation: number,
  socket: WASocket,
) => boolean;
type SocketLeaseHealthMethod = (this: LeaseHarness) => {
  hasSocket: boolean;
  stateConnected: boolean;
  socketAuthenticated: boolean;
  webSocketOpen: boolean;
};

const accountMethod = <T>(name: string): T =>
  Reflect.get(WhatsAppAccount.prototype, name) as T;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WhatsApp account socket lease", () => {
  it("refreshes a due lease through the alarm and fences the old socket", async () => {
    const now = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const events: string[] = [];
    const oldSocket = {
      ws: { isOpen: true },
      end: vi.fn(async () => {
        events.push("old_closed");
      }),
    } as unknown as WASocket;
    const freshSocket = {
      ws: { isOpen: true },
      user: undefined,
    } as unknown as WASocket;
    const authenticatedSockets = new WeakSet<object>();
    authenticatedSockets.add(oldSocket);
    let scheduledDeadline: number | undefined;

    const refreshLease = accountMethod<RefreshLeaseMethod>(
      "refreshSocketLeaseLocked",
    );
    const handleConnectionUpdate = accountMethod<ConnectionUpdateMethod>(
      "handleConnectionUpdate",
    );
    const isCurrentSocket = accountMethod<IsCurrentSocketMethod>(
      "isCurrentSocket",
    );
    const socketLeaseHealth = accountMethod<SocketLeaseHealthMethod>(
      "socketLeaseHealth",
    );

    const harness: LeaseHarness = {
      sock: oldSocket,
      socketGeneration: 7,
      authenticatedSockets,
      groupMetadata: { clear: vi.fn() },
      state: {
        ...defaultWhatsAppAccountState(),
        accountId: "primary",
        desired: "connected",
        status: "connected",
        connected: true,
        authenticated: true,
        leaseRefreshAt: now,
      },
      qrCode: null,
      inboundDeliveries: {
        armIfPending: vi.fn(async () => false),
      },
      socketOperations: {
        run: async (operation) => operation(),
      },
      identities: {
        bindLidPn: vi.fn(async () => undefined),
      },
      persistStateAndSchedule: vi.fn(async () => undefined),
      startSocketLocked: async (source) => {
        expect(source).toBe("lease_refresh");
        expect(events).toEqual(["old_closed"]);
        events.push("fresh_started");
        harness.socketGeneration += 1;
        harness.sock = freshSocket;
        harness.authenticatedSockets.add(freshSocket);
      },
      socketLeaseHealth() {
        return socketLeaseHealth.call(harness);
      },
      async refreshSocketLeaseLocked(action) {
        await refreshLease.call(harness, action);
        await handleConnectionUpdate.call(
          harness,
          harness.socketGeneration,
          freshSocket,
          { connection: "open" },
        );
      },
      failConnectionAttemptLocked: vi.fn(async () => undefined),
      retryPendingInbound: vi.fn(async () => undefined),
      scheduleNextAlarm: vi.fn(async () => {
        scheduledDeadline = harness.state.leaseRefreshAt;
      }),
      scheduleReconnectAfterFailure: vi.fn(async () => undefined),
      isCurrentSocket(generation, socket) {
        return isCurrentSocket.call(harness, generation, socket);
      },
      resolvePairingWaiters: vi.fn(),
      notifyGatewayStatus: vi.fn(async () => undefined),
      own: vi.fn((_event, promise) => {
        void promise;
      }),
    };

    const alarm = WhatsAppAccount.prototype.alarm as unknown as AlarmMethod;
    await alarm.call(harness);

    expect(events).toEqual(["old_closed", "fresh_started"]);
    expect(oldSocket.end).toHaveBeenCalledTimes(1);
    expect(harness.sock).toBe(freshSocket);
    expect(harness.state.connected).toBe(true);
    expect(harness.state.leaseRefreshAt).toBe(
      now + SOCKET_LEASE_REFRESH_INTERVAL_MS,
    );
    expect(scheduledDeadline).toBe(now + SOCKET_LEASE_REFRESH_INTERVAL_MS);
    expect(harness.socketGeneration).toBe(9);

    const connectedState = { ...harness.state };
    await handleConnectionUpdate.call(
      harness,
      7,
      oldSocket,
      { connection: "close" },
    );
    expect(harness.state).toEqual(connectedState);
    expect(harness.sock).toBe(freshSocket);
  });
});
