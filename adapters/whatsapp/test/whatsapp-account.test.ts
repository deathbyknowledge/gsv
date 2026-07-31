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

type SocketReplacement = {
  socket: WASocket | null;
  generation: number;
  saveCreds: (() => Promise<void>) | null;
};

type HandleConnectionUpdate = (
  this: WhatsAppAccount,
  generation: number,
  socket: WASocket,
  update: Partial<BaileysEventMap["connection.update"]>,
) => Promise<void>;

const accountMethod = <T>(name: string): T =>
  Reflect.get(WhatsAppAccount.prototype, name) as T;

const accountField = <T>(account: WhatsAppAccount, name: string): T =>
  Reflect.get(account, name) as T;

function fakeAccount(fields: Record<string, unknown>): WhatsAppAccount {
  return Object.assign(Object.create(WhatsAppAccount.prototype), fields);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WhatsApp account socket lease", () => {
  it("starts one replacement without closing or blocking the active socket", async () => {
    const oldSocket = {
      ws: { isOpen: true },
      end: vi.fn(async () => undefined),
    } as unknown as WASocket;
    const state = {
      ...defaultWhatsAppAccountState(),
      desired: "connected" as const,
      status: "connected" as const,
      connected: true,
      authenticated: true,
      leaseRefreshAt: 1_000,
    };
    let releasePersist: (() => void) | undefined;
    const persist = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const started = vi.fn(async () => undefined);
    const owned: Promise<unknown>[] = [];
    const authenticatedSockets = new WeakSet<object>();
    authenticatedSockets.add(oldSocket);
    const socketOperations = { run: vi.fn() };
    const account = fakeAccount({
      sock: oldSocket,
      socketReplacement: null,
      socketGeneration: 7,
      authenticatedSockets,
      inboundDeliveries: { armIfPending: vi.fn(async () => false) },
      socketOperations,
      state,
      persistStateAndSchedule: vi.fn(() => persist),
      startSocket: started,
      retryPendingInbound: vi.fn(async () => undefined),
      scheduleNextAlarm: vi.fn(async () => undefined),
      scheduleReconnectAfterFailure: vi.fn(async () => undefined),
      own: vi.fn((_event: string, promise: Promise<unknown>) => {
        owned.push(promise);
      }),
    });

    await account.alarm();
    await account.alarm();

    expect(accountField(account, "sock")).toBe(oldSocket);
    expect(accountField(account, "socketReplacement")).toMatchObject({
      socket: null,
      generation: 8,
    });
    expect(state.connected).toBe(true);
    expect(state.status).toBe("connected");
    expect(oldSocket.end).not.toHaveBeenCalled();
    expect(owned).toHaveLength(1);
    expect(started).not.toHaveBeenCalled();
    expect(socketOperations.run).not.toHaveBeenCalled();

    releasePersist?.();
    await Promise.all(owned);
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(
      "lease_refresh",
      accountField(account, "socketReplacement"),
    );
  });

  it("keeps the active socket when its replacement fails", async () => {
    const now = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const oldSocket = { ws: { isOpen: true } } as unknown as WASocket;
    const candidate = { ws: { isOpen: false } } as unknown as WASocket;
    const authenticatedSockets = new WeakSet<object>();
    authenticatedSockets.add(oldSocket);
    const state = {
      ...defaultWhatsAppAccountState(),
      desired: "connected" as const,
      status: "connected" as const,
      connected: true,
      authenticated: true,
    };
    const replacement: SocketReplacement = {
      socket: candidate,
      generation: 8,
      saveCreds: null,
    };
    const account = fakeAccount({
      sock: oldSocket,
      socketReplacement: replacement,
      socketGeneration: 7,
      authenticatedSockets,
      groupMetadata: { clear: vi.fn() },
      state,
      persistStateAndSchedule: vi.fn(async () => undefined),
      notifyGatewayStatus: vi.fn(async () => undefined),
      own: vi.fn((_event: string, promise: Promise<unknown>) => {
        void promise;
      }),
    });

    await accountMethod<HandleConnectionUpdate>("handleConnectionUpdate").call(
      account,
      8,
      candidate,
      { connection: "close" },
    );

    expect(accountField(account, "sock")).toBe(oldSocket);
    expect(accountField(account, "socketReplacement")).toBeNull();
    expect(state.connected).toBe(true);
    expect(state.status).toBe("connected");
    expect(state.reconnectAt).toBeUndefined();
    expect(state.leaseRefreshAt).toBeGreaterThanOrEqual(now + 2_000);
    expect(state.leaseRefreshAt).toBeLessThan(now + 3_000);

    authenticatedSockets.delete(oldSocket);
    await accountMethod<HandleConnectionUpdate>("handleConnectionUpdate").call(
      account,
      7,
      oldSocket,
      {
        connection: "close",
        lastDisconnect: {
          error: { output: { statusCode: 440 } } as unknown as Error,
          date: new Date(now),
        },
      },
    );
    expect(state.desired).toBe("connected");
    expect(state.status).toBe("reconnecting");
    expect(state.reconnectAt).toBeGreaterThan(now);
  });

  it("promotes the replacement and ignores the displaced socket", async () => {
    const now = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const oldSocket = {
      ws: { isOpen: false },
      end: vi.fn(async () => undefined),
    } as unknown as WASocket;
    const candidate = {
      ws: { isOpen: true },
      user: {},
    } as unknown as WASocket;
    const authenticatedSockets = new WeakSet<object>();
    authenticatedSockets.add(candidate);
    const state = {
      ...defaultWhatsAppAccountState(),
      desired: "connected" as const,
      status: "connected" as const,
      connected: true,
      authenticated: true,
      leaseRefreshAt: now,
    };
    const replacement: SocketReplacement = {
      socket: candidate,
      generation: 8,
      saveCreds: null,
    };
    const owned: Promise<unknown>[] = [];
    const account = fakeAccount({
      sock: oldSocket,
      socketReplacement: replacement,
      socketGeneration: 7,
      authenticatedSockets,
      groupMetadata: { clear: vi.fn() },
      identities: { bindLidPn: vi.fn(async () => undefined) },
      socketOperations: { run: <T>(operation: () => Promise<T>) => operation() },
      state,
      persistStateAndSchedule: vi.fn(async () => undefined),
      resolvePairingWaiters: vi.fn(),
      notifyGatewayStatus: vi.fn(async () => undefined),
      own: vi.fn((_event: string, promise: Promise<unknown>) => {
        owned.push(promise);
      }),
    });
    const handleUpdate = accountMethod<HandleConnectionUpdate>("handleConnectionUpdate");

    await handleUpdate.call(account, 8, candidate, { connection: "open" });
    expect(accountField(account, "sock")).toBe(candidate);
    expect(accountField(account, "socketGeneration")).toBe(8);
    expect(accountField(account, "socketReplacement")).toBeNull();
    expect(state.connected).toBe(true);
    expect(state.status).toBe("connected");
    expect(state.leaseRefreshAt).toBe(
      now + SOCKET_LEASE_REFRESH_INTERVAL_MS,
    );
    expect(oldSocket.end).toHaveBeenCalledTimes(1);

    const connectedState = { ...state };
    await handleUpdate.call(account, 7, oldSocket, {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: 440 } } as unknown as Error,
        date: new Date(now),
      },
    });
    expect(state).toEqual(connectedState);
    expect(accountField(account, "sock")).toBe(candidate);
    await Promise.all(owned);
  });
});
