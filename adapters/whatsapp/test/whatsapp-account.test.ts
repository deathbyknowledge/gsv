import type {
  BaileysEventMap,
  WASocket,
} from "@whiskeysockets/baileys";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SOCKET_RESIDENCY_ALARM_INTERVAL_MS,
  SocketOperationQueue,
} from "../src/lifecycle";
import { defaultWhatsAppAccountState } from "../src/types";
import { WhatsAppAccount } from "../src/whatsapp-account";

type HandleConnectionUpdate = (
  this: WhatsAppAccount,
  generation: number,
  socket: WASocket,
  update: Partial<BaileysEventMap["connection.update"]>,
) => Promise<void>;

type HandleCredentialsUpdate = (
  this: WhatsAppAccount,
  generation: number,
  socket: WASocket,
  saveCreds: () => Promise<void>,
) => void;

type RememberLidPnMappings = (
  this: WhatsAppAccount,
  expectedSessionEpoch: number,
  generation: number,
  socket: WASocket,
  mappings: BaileysEventMap["messaging-history.set"]["lidPnMappings"],
) => Promise<void>;

type EnsureAccount = (
  this: WhatsAppAccount,
  accountId: string,
) => Promise<void>;

function socketFixture<T>(value: T): WASocket {
  // SAFETY: Each fixture supplies the socket members exercised by its scenario.
  return value as WASocket & T;
}

const accountMethod = <T>(name: string): T => {
  // SAFETY: Tests select private methods by their stable owner-defined names.
  return WhatsAppAccount.prototype[name as keyof WhatsAppAccount] as T;
};

const accountField = <T>(account: WhatsAppAccount, name: string): T => {
  // SAFETY: Tests select private fields by their stable owner-defined names.
  return account[name as keyof WhatsAppAccount] as T;
};

function fakeAccount<T>(fields: T): WhatsAppAccount {
  return Object.assign(Object.create(WhatsAppAccount.prototype), {
    peerDeliveries: { armIfPending: vi.fn(async () => false) },
    drainPeerDeliveries: vi.fn(async () => undefined),
  }, fields);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WhatsApp account residency", () => {
  it("renews residency without replacing a healthy provider session", async () => {
    const now = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const socket = socketFixture({
      ws: { isOpen: true },
      end: vi.fn(async () => undefined),
    });
    const authenticatedSockets = new WeakSet<object>();
    authenticatedSockets.add(socket);
    const state = {
      ...defaultWhatsAppAccountState(),
      desired: "connected" as const,
      status: "connected" as const,
      connected: true,
      authenticated: true,
      residencyAlarmAt: now,
    };
    const persistStateAndSchedule = vi.fn(async () => undefined);
    const account = fakeAccount({
      sock: socket,
      socketGeneration: 7,
      authenticatedSockets,
      inboundDeliveries: { armIfPending: vi.fn(async () => false) },
      socketOperations: { run: <T>(operation: () => Promise<T>) => operation() },
      state,
      persistStateAndSchedule,
      retryPendingInbound: vi.fn(async () => undefined),
      scheduleNextAlarm: vi.fn(async () => undefined),
      scheduleReconnectAfterFailure: vi.fn(async () => undefined),
    });

    await account.alarm();

    expect(accountField(account, "sock")).toBe(socket);
    expect(state.connected).toBe(true);
    expect(state.residencyAlarmAt).toBe(
      now + SOCKET_RESIDENCY_ALARM_INTERVAL_MS,
    );
    expect(persistStateAndSchedule).toHaveBeenCalledWith(now);
    expect(socket.end).not.toHaveBeenCalled();
  });

  it("retires an unhealthy transport through the normal reconnect path", async () => {
    const now = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const socket = socketFixture({
      ws: { isOpen: false },
      end: vi.fn(async () => undefined),
    });
    const authenticatedSockets = new WeakSet<object>();
    authenticatedSockets.add(socket);
    const state = {
      ...defaultWhatsAppAccountState(),
      desired: "connected" as const,
      status: "connected" as const,
      connected: true,
      authenticated: true,
      residencyAlarmAt: 60_000,
    };
    const account = fakeAccount({
      sock: socket,
      socketGeneration: 7,
      authenticatedSockets,
      inboundDeliveries: { armIfPending: vi.fn(async () => false) },
      socketOperations: { run: <T>(operation: () => Promise<T>) => operation() },
      state,
      persistStateAndSchedule: vi.fn(async () => undefined),
      retryPendingInbound: vi.fn(async () => undefined),
      scheduleNextAlarm: vi.fn(async () => undefined),
      scheduleReconnectAfterFailure: vi.fn(async () => undefined),
    });

    await account.alarm();

    expect(accountField(account, "sock")).toBeNull();
    expect(accountField(account, "socketGeneration")).toBe(8);
    expect(authenticatedSockets.has(socket)).toBe(false);
    expect(state.connected).toBe(false);
    expect(state.status).toBe("reconnecting");
    expect(state.residencyAlarmAt).toBeUndefined();
    expect(state.lastDisconnectedAt).toBe(now);
    expect(state.disconnectReason).toBe("transport_unhealthy");
    expect(state.reconnectAt).toBeGreaterThanOrEqual(now + 2_000);
    expect(state.reconnectAt).toBeLessThan(now + 3_000);
    expect(socket.end).toHaveBeenCalledOnce();
  });

  it("leaves a connecting socket to its connection deadline", async () => {
    const now = 10_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const socket = socketFixture({
      ws: { isOpen: true },
      end: vi.fn(async () => undefined),
    });
    const state = {
      ...defaultWhatsAppAccountState(),
      desired: "connected" as const,
      status: "reconnecting" as const,
      connected: false,
      authenticated: true,
      connectionDeadlineAt: now + 20_000,
    };
    const armIfPending = vi.fn(async () => true);
    const retryPendingInbound = vi.fn(async () => undefined);
    const account = fakeAccount({
      sock: socket,
      socketGeneration: 7,
      authenticatedSockets: new WeakSet<object>(),
      inboundDeliveries: { armIfPending },
      socketOperations: { run: <T>(operation: () => Promise<T>) => operation() },
      state,
      persistStateAndSchedule: vi.fn(async () => undefined),
      retryPendingInbound,
      scheduleNextAlarm: vi.fn(async () => undefined),
      scheduleReconnectAfterFailure: vi.fn(async () => undefined),
    });

    await account.alarm();

    expect(armIfPending).toHaveBeenCalledWith(now + 10_000);
    expect(retryPendingInbound).toHaveBeenCalledOnce();
    expect(accountField(account, "sock")).toBe(socket);
    expect(accountField(account, "socketGeneration")).toBe(7);
    expect(state.status).toBe("reconnecting");
    expect(state.connectionDeadlineAt).toBe(now + 20_000);
    expect(socket.end).not.toHaveBeenCalled();
  });

  it("starts residency alarms when the provider session authenticates", async () => {
    const now = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const socket = socketFixture({
      ws: { isOpen: true },
      user: {},
    });
    const authenticatedSockets = new WeakSet<object>();
    authenticatedSockets.add(socket);
    const state = {
      ...defaultWhatsAppAccountState(),
      desired: "connected" as const,
      connectionDeadlineAt: 30_000,
    };
    const account = fakeAccount({
      sock: socket,
      socketGeneration: 7,
      authenticatedSockets,
      identities: { bindLidPn: vi.fn(async () => undefined) },
      state,
      persistStateAndSchedule: vi.fn(async () => undefined),
      resolvePairingWaiters: vi.fn(),
      notifyGatewayStatus: vi.fn(async () => undefined),
      own: vi.fn((_event: string, promise: Promise<unknown>) => {
        void promise;
      }),
    });

    await accountMethod<HandleConnectionUpdate>("handleConnectionUpdate").call(
      account,
      7,
      socket,
      { connection: "open" },
    );

    expect(state.connected).toBe(true);
    expect(state.status).toBe("connected");
    expect(state.residencyAlarmAt).toBe(
      now + SOCKET_RESIDENCY_ALARM_INTERVAL_MS,
    );
  });

  it("persists credential updates admitted by the current session", async () => {
    const sessionMutations = new SocketOperationQueue();
    let releaseMutation: () => void = () => undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const precedingMutation = sessionMutations.run(() => mutationGate);
    const socket = socketFixture({});
    const nextSocket = socketFixture({});
    const saveCreds = vi.fn(async () => undefined);
    const owned: Promise<unknown>[] = [];
    const account = fakeAccount({
      sock: socket,
      socketGeneration: 7,
      sessionMutations,
      own: vi.fn((_event: string, promise: Promise<unknown>) => {
        owned.push(promise);
      }),
    });
    const handleCredentials = accountMethod<HandleCredentialsUpdate>(
      "handleCredentialsUpdate",
    );

    handleCredentials.call(account, 7, socket, saveCreds);
    expect(saveCreds).not.toHaveBeenCalled();
    Reflect.set(account, "sock", nextSocket);
    Reflect.set(account, "socketGeneration", 8);
    releaseMutation();
    await Promise.all([precedingMutation, ...owned]);

    expect(saveCreds).toHaveBeenCalledOnce();
    handleCredentials.call(account, 7, socket, saveCreds);
    expect(saveCreds).toHaveBeenCalledOnce();
  });
});

describe("WhatsApp account session identity", () => {
  it("drops LID mappings from a superseded provider session", async () => {
    const sessionMutations = new SocketOperationQueue();
    let releaseMutation: () => void = () => undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const precedingMutation = sessionMutations.run(() => mutationGate);
    const socket = socketFixture({});
    const bindLidPnMappings = vi.fn(async () => undefined);
    const state = {
      ...defaultWhatsAppAccountState(),
      sessionEpoch: 4,
    };
    const account = fakeAccount({
      sock: socket,
      socketGeneration: 7,
      sessionMutations,
      identities: { bindLidPnMappings },
      state,
    });
    const rememberMappings = accountMethod<RememberLidPnMappings>(
      "rememberLidPnMappings",
    );
    const staleMapping = {
      lid: "123456789@lid",
      pn: "31612345678@s.whatsapp.net",
    };

    const staleWrite = rememberMappings.call(
      account,
      4,
      7,
      socket,
      [staleMapping],
    );
    state.sessionEpoch = 5;
    releaseMutation();
    await Promise.all([precedingMutation, staleWrite]);

    expect(bindLidPnMappings).not.toHaveBeenCalled();

    const currentMapping = {
      lid: "987654321@lid",
      pn: "31687654321@s.whatsapp.net",
    };
    await rememberMappings.call(account, 5, 7, socket, [currentMapping]);
    expect(bindLidPnMappings).toHaveBeenCalledOnce();
    expect(bindLidPnMappings).toHaveBeenCalledWith([currentMapping]);
  });
});

describe("WhatsApp account Durable Object identity", () => {
  it("reuses a reserved standalone name only when existing state proves it", async () => {
    const accountId = "account:singleton:legacy";
    const ensureAccount = accountMethod<EnsureAccount>("ensureAccount");
    const persisted = vi.fn(async () => undefined);
    const existing = fakeAccount({
      ctx: { id: { name: accountId } },
      state: { ...defaultWhatsAppAccountState(), accountId },
      persistStateAndSchedule: persisted,
    });

    await expect(ensureAccount.call(existing, accountId)).resolves.toBeUndefined();
    expect(persisted).not.toHaveBeenCalled();

    const empty = fakeAccount({
      ctx: { id: { name: accountId } },
      state: defaultWhatsAppAccountState(),
      persistStateAndSchedule: persisted,
    });
    await expect(ensureAccount.call(empty, accountId))
      .rejects.toThrow("name is invalid");
    expect(accountField<{ accountId: string }>(empty, "state").accountId).toBe("");
    expect(persisted).not.toHaveBeenCalled();
  });
});
