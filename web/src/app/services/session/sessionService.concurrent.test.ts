import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GsvClientError, type GsvClientStatus } from "@humansandmachines/gsv/client";
import type { ConnectResult } from "@humansandmachines/gsv/protocol";
import { createSessionService, type SessionClient, type SessionStorage } from "./sessionService";

const KEY = "gsv.ui.session.token.v1";
const DAY = 24 * 60 * 60 * 1000;
const token = (id: string, days = 30, username = "alice") => ({ username, tokenId: id, token: `secret-${id}`, expiresAt: Date.now() + days * DAY });
// SAFETY: The fixture writes token() records; the service writes its validated persisted token shape.
const persisted = () => JSON.parse(window.localStorage.getItem(KEY) ?? "null") as ReturnType<typeof token> | null;
function memoryStorage(): SessionStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

let storageListeners: Array<(event: Partial<StorageEvent>) => void>;
function notifyStorage() {
  for (const listener of storageListeners) listener({ key: KEY, storageArea: window.localStorage });
}
function changeToken(next: ReturnType<typeof token> | null) {
  if (next) window.localStorage.setItem(KEY, JSON.stringify(next));
  else window.localStorage.removeItem(KEY);
  notifyStorage();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error | { code: number }) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clientFixture(name: string) {
  let connected = false;
  let listener: (status: GsvClientStatus) => void = () => {};
  const result: ConnectResult = {
    protocol: 4, server: { version: "test", release: "test", connectionId: name },
    peer: { id: "gsv-ui", sessionId: name, principal: { kind: "human", account: { uid: 1, gid: 1, gids: [1], username: "alice", home: "/home/alice", cwd: "/home/alice" } },
      grant: { calls: [], signals: [], implements: [] } },
  };
  const client = {
    connect: vi.fn<SessionClient["connect"]>(async () => {
      connected = true;
      listener({ state: "connected", connectionId: name, url: "wss://example.test/ws", username: "alice", message: null });
      return result;
    }),
    disconnect: vi.fn(() => { connected = false; listener({ state: "disconnected", connectionId: null, url: null, username: null, message: null }); }),
    isConnected: () => connected,
    requestOnce: vi.fn<SessionClient["requestOnce"]>(),
    onStatus: (next: typeof listener) => { listener = next; return () => { listener = () => {}; }; },
    sys: { token: {
      create: vi.fn<SessionClient["sys"]["token"]["create"]>(async ({ expiresAt }) => ({ token: {
        tokenId: `renewed-${name}`, token: `secret-renewed-${name}`, expiresAt: expiresAt ?? null, uid: 1, tokenPrefix: "secret", createdAt: Date.now(), label: "gsv-ui-session", kind: "human", peerId: null,
      } })),
      revoke: vi.fn<SessionClient["sys"]["token"]["revoke"]>(async () => ({ revoked: true })),
      list: vi.fn<SessionClient["sys"]["token"]["list"]>(),
    } },
  } satisfies SessionClient;
  return { client, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  storageListeners = [];
  let previous = Promise.resolve();
  vi.stubGlobal("window", {
    location: { protocol: "https:", host: "example.test", hash: "" },
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    setTimeout, clearTimeout,
    addEventListener: (_: string, callback: (event: Partial<StorageEvent>) => void) => { storageListeners.push(callback); },
    removeEventListener: (_: string, callback: (event: Partial<StorageEvent>) => void) => { storageListeners = storageListeners.filter(listener => listener !== callback); },
    navigator: { locks: { request: vi.fn((_name: string, action: () => Promise<void>) => { previous = previous.then(action); return previous; }) } },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("remembered sessions across windows", () => {
  it("remembers a fresh sign-in for 30 days", async () => {
    const { client } = clientFixture("browser");
    const session = createSessionService(client);
    await session.login({ username: "alice", password: "password" });
    expect(persisted()?.expiresAt).toBe(Date.now() + 30 * DAY);
    expect(client.sys.token.create).toHaveBeenCalledOnce();
    session.dispose?.();
  });

  it("renews once when two tabs become due together and reconnects using the new token", async () => {
    changeToken(token("old", 29));
    const a = clientFixture("a"), b = clientFixture("b");
    const first = createSessionService(a.client), second = createSessionService(b.client);
    await Promise.all([first.start(), second.start()]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.client.sys.token.create.mock.calls.length + b.client.sys.token.create.mock.calls.length).toBe(1);
    const current = persisted()!;
    notifyStorage();
    b.client.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.client.connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: current.token }));
    expect(first.snapshot().phase).toBe("ready");
    expect(second.snapshot().phase).toBe("ready");
    expect(a.client.sys.token.revoke).not.toHaveBeenCalledWith(expect.objectContaining({ tokenId: current.tokenId }));
    first.dispose?.(); second.dispose?.();
  });

  it("adopts the latest credential even before a suspended tab receives its storage event", async () => {
    changeToken(token("old"));
    const { client } = clientFixture("browser");
    const session = createSessionService(client);
    await session.start();
    window.localStorage.setItem(KEY, JSON.stringify(token("new")));
    client.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: "secret-new" }));
    session.dispose?.();
  });

  it("ignores an old token rejection after another tab has renewed", async () => {
    changeToken(token("old"));
    const { client } = clientFixture("browser");
    const pending = deferred<ConnectResult>();
    client.connect.mockReturnValueOnce(pending.promise);
    const session = createSessionService(client);
    const start = session.start();
    window.localStorage.setItem(KEY, JSON.stringify(token("new")));
    pending.reject({ code: 401 });
    await start;
    await vi.advanceTimersByTimeAsync(1000);
    expect(persisted()?.tokenId).toBe("new");
    expect(session.snapshot().phase).toBe("ready");
    session.dispose?.();
  });

  it("retries a network outage past the old retry limit without deleting the credential", async () => {
    changeToken(token("saved"));
    const { client, result } = clientFixture("browser");
    client.connect.mockRejectedValue(new Error("Network unavailable"));
    const session = createSessionService(client);
    await session.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.connect.mock.calls.length).toBeGreaterThan(5);
    expect(persisted()?.tokenId).toBe("saved");
    expect(session.snapshot().phase).toBe("booting");
    client.connect.mockResolvedValue(result);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.snapshot().phase).toBe("ready");
    session.dispose?.();
  });

  it("clears an actually rejected credential and stops reconnecting", async () => {
    changeToken(token("revoked"));
    const { client } = clientFixture("browser");
    client.connect.mockRejectedValue({ code: 401 });
    const session = createSessionService(client);
    await session.start();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(persisted()).toBeNull();
    expect(session.snapshot()).toMatchObject({ phase: "locked", message: "Session expired. Sign in again." });
    session.dispose?.();
  });

  it.each([
    { code: 102, message: "Update the client to use protocol 4" },
    { code: 103, message: "Peer id is required" },
    { code: 403, message: "Access denied" },
    { code: 409, message: "Connection configuration conflict" },
    { code: 503, message: "Service permanently disabled", retryable: false },
  ])("surfaces a terminal handshake error: $message", async (error) => {
    changeToken(token("saved"));
    const { client } = clientFixture("browser");
    client.connect.mockRejectedValue(new GsvClientError(error));
    const session = createSessionService(client);
    await session.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(session.snapshot()).toMatchObject({ phase: "locked", message: error.message });
    expect(persisted()?.tokenId).toBe("saved");
    session.dispose?.();
  });

  it.each([
    { code: 408, message: "Request timed out" },
    { code: 429, message: "Try again later" },
    { code: 503, message: "Space provisioning is incomplete" },
    { code: 409, message: "Temporary conflict", retryable: true },
  ])("retries a temporary handshake error: $message", async (error) => {
    changeToken(token("saved"));
    const { client } = clientFixture("browser");
    client.connect.mockRejectedValueOnce(new GsvClientError(error));
    const session = createSessionService(client);
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(session.snapshot().phase).toBe("ready");
    expect(persisted()?.tokenId).toBe("saved");
    session.dispose?.();
  });

  it("serializes sign-out after another tab's in-flight renewal and revokes the new credential", async () => {
    changeToken(token("old", 29));
    const renewing = clientFixture("renewing"), signingOut = clientFixture("signing-out");
    const pending = deferred<Awaited<ReturnType<SessionClient["sys"]["token"]["create"]>>>();
    renewing.client.sys.token.create.mockReturnValueOnce(pending.promise);
    const first = createSessionService(renewing.client), second = createSessionService(signingOut.client);
    await first.start();
    await vi.advanceTimersByTimeAsync(1000);
    await second.start();
    expect(renewing.client.sys.token.create).toHaveBeenCalledOnce();

    const locked = second.lock();
    expect(second.snapshot().phase).toBe("locked");
    pending.resolve({ token: { tokenId: "renewed", token: "new-secret", expiresAt: Date.now() + 30 * DAY,
      uid: 1, tokenPrefix: "new", createdAt: Date.now(), label: "session", kind: "human", peerId: null } });
    await locked;
    notifyStorage();

    expect(signingOut.client.sys.token.revoke).toHaveBeenCalledWith({ tokenId: "renewed", reason: "ui session lock" });
    expect(persisted()).toBeNull();
    expect(first.snapshot().phase).toBe("locked");
    expect(second.snapshot().phase).toBe("locked");
    first.dispose?.(); second.dispose?.();
  });

  it("signs other browser tabs out without touching a separate desktop session", async () => {
    changeToken(token("browser"));
    const browser = clientFixture("browser"), desktop = clientFixture("desktop");
    const nativeStorage = memoryStorage();
    nativeStorage.setItem(KEY, JSON.stringify(token("desktop")));
    const first = createSessionService(browser.client), second = createSessionService(desktop.client, { storage: nativeStorage });
    await Promise.all([first.start(), second.start()]);
    changeToken(null);
    expect(first.snapshot().phase).toBe("locked");
    expect(second.snapshot().phase).toBe("ready");
    expect(desktop.client.disconnect).not.toHaveBeenCalled();
    first.dispose?.(); second.dispose?.();
    expect(storageListeners).toHaveLength(0);
  });

  it("closes the old account boundary on an account switch without clearing the new login", async () => {
    changeToken(token("alice"));
    const { client } = clientFixture("browser");
    const session = createSessionService(client);
    await session.start();
    changeToken(token("bob", 30, "bob"));
    expect(session.snapshot()).toMatchObject({ phase: "locked", username: "alice" });
    expect(persisted()?.username).toBe("bob");
    session.dispose?.();
  });

  it("does not resurrect a sign-out while token creation is in flight", async () => {
    changeToken(token("old", 29));
    const { client } = clientFixture("browser");
    const pending = deferred<Awaited<ReturnType<SessionClient["sys"]["token"]["create"]>>>();
    client.sys.token.create.mockReturnValue(pending.promise);
    const session = createSessionService(client);
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    changeToken(null);
    pending.resolve({ token: { tokenId: "late", token: "late-secret", expiresAt: Date.now() + DAY, uid: 1, tokenPrefix: "secret", createdAt: Date.now(), label: "session", kind: "human", peerId: null } });
    await vi.advanceTimersByTimeAsync(0);
    expect(persisted()).toBeNull();
    expect(session.snapshot().phase).toBe("locked");
    session.dispose?.();
  });

  it("retries a failed renewal without discarding a valid credential", async () => {
    changeToken(token("old", 29));
    const { client } = clientFixture("browser");
    client.sys.token.create.mockRejectedValueOnce(new Error("Temporary failure"));
    const session = createSessionService(client);
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(persisted()?.tokenId).toBe("old");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persisted()?.tokenId).toBe("renewed-browser");
    session.dispose?.();
  });
});
