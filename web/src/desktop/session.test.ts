import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService, type SessionClient } from "../app/services/session/sessionService";
import { deferred } from "../app/testing/testHarness";
import { disconnectSpace, nativeSessionStorage, type DesktopSession } from "./bridge";

const tokenKey = "gsv.ui.session.token.v1";
const pendingKey = "gsv.ui.session.pending-revokes.v1";

function sessionHarness(connected = true, restoredValues?: Record<string, string>) {
  const session: DesktopSession = {
    generation: "first-generation",
    origin: "https://first.example",
    values: restoredValues ?? {
      [tokenKey]: JSON.stringify({ username: "alice", tokenId: "first-token", token: "fixture-credential", expiresAt: Date.now() + 60_000 }),
    },
  };
  let stored = { ...session.values };
  let forgotten: Record<string, string> | null = null;
  let writeGate = Promise.resolve();
  let writeFailure = false;
  let configureFailure = false;
  const invoke = vi.fn(async (command: string, args: { generation?: string; values?: Record<string, string>; origin?: string | null }) => {
    if (command === "desktop_store") {
      await writeGate;
      if (writeFailure) throw new Error("storage unavailable");
      if (args.generation !== session.generation || !args.values) throw new Error("Invalid storage request");
      stored = { ...args.values };
    } else if (command === "desktop_configure") {
      if (configureFailure) throw new Error("configuration unavailable");
      expect(args).toEqual({ origin: null });
      forgotten = { ...stored };
    } else {
      throw new Error(`Unexpected native command ${command}`);
    }
  });
  vi.stubGlobal("window", { __TAURI__: { core: { invoke } },
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  const onError = vi.fn();
  const storage = nativeSessionStorage(session, onError);
  const revocation = deferred<{ revoked: boolean }>();
  const unsubscribe = vi.fn();
  const client = {
    connect: vi.fn<SessionClient["connect"]>(),
    disconnect: vi.fn(() => { connected = false; }),
    isConnected: () => connected,
    onStatus: () => unsubscribe,
    requestOnce: vi.fn<SessionClient["requestOnce"]>(),
    sys: { token: {
      create: vi.fn<SessionClient["sys"]["token"]["create"]>(),
      revoke: vi.fn<SessionClient["sys"]["token"]["revoke"]>().mockReturnValue(revocation.promise),
      list: vi.fn<SessionClient["sys"]["token"]["list"]>(),
    } },
  } satisfies SessionClient;
  const service = createSessionService(client, { url: "wss://first.example/ws", storage, onboarding: false });
  return { service, storage, client, invoke, onError, revocation, unsubscribe,
    stored: () => stored, forgotten: () => forgotten,
    blockWrites: (promise: Promise<void>) => { writeGate = promise; },
    failWrites: (fail: boolean) => { writeFailure = fail; },
    failConfigure: (fail: boolean) => { configureFailure = fail; },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("desktop session persistence", () => {
  it("announces sign-in only after token issuance and the native credential write complete", async () => {
    const h = sessionHarness(true, {});
    const writes = deferred<void>();
    const issuing = deferred<Awaited<ReturnType<SessionClient["sys"]["token"]["create"]>>>();
    h.blockWrites(writes.promise);
    h.client.connect.mockResolvedValue({
      protocol: 4,
      server: { version: "test", release: "test", connectionId: "connection:alice" },
      peer: { id: "web", sessionId: "connection:alice",
        principal: { kind: "human", account: { uid: 1, gid: 1, gids: [1], username: "alice", home: "/home/alice", cwd: "/home/alice" } },
        grant: { calls: [], signals: [], implements: [] },
      },
    });
    h.client.sys.token.create.mockReturnValue(issuing.promise);
    const signedIn = vi.fn();
    const unsubscribe = h.storage.subscribeSignedIn(signedIn);
    expect(signedIn).toHaveBeenCalledExactlyOnceWith(null);
    const login = h.service.login({ username: "alice", password: "fixture-password" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.snapshot().phase).toBe("ready");
    expect(h.client.sys.token.create).toHaveBeenCalledOnce();
    expect(signedIn).toHaveBeenCalledOnce();
    expect(h.stored()[tokenKey]).toBeUndefined();
    issuing.resolve({ token: {
      tokenId: "next-token", token: "next-fixture-credential", tokenPrefix: "fixture", uid: 1, kind: "human",
      label: "gsv-ui-session", peerId: null, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    } });
    await login;
    expect(signedIn).toHaveBeenCalledOnce();
    expect(h.stored()[tokenKey]).toBeUndefined();
    writes.resolve();
    await h.storage.flush();
    expect(signedIn.mock.calls).toEqual([[null], ["alice"]]);
    expect(JSON.parse(h.stored()[tokenKey]).username).toBe("alice");
    h.storage.setItem(tokenKey, JSON.stringify({ username: "alice", token: "rotated-fixture" }));
    await h.storage.flush();
    expect(signedIn).toHaveBeenCalledTimes(2);
    h.storage.removeItem(tokenKey);
    await h.storage.flush();
    expect(signedIn.mock.calls).toEqual([[null], ["alice"], [null]]);
    unsubscribe();
    h.storage.setItem(tokenKey, JSON.stringify({ username: "bob", token: "other-fixture" }));
    await h.storage.flush();
    expect(signedIn).toHaveBeenCalledTimes(3);
    h.service.dispose?.();
  });

  it("does not announce a credential the native host failed to save", async () => {
    const h = sessionHarness(true, {});
    const signedIn = vi.fn();
    h.storage.subscribeSignedIn(signedIn);
    h.failWrites(true);
    h.storage.setItem(tokenKey, JSON.stringify({ username: "alice", token: "fixture-credential" }));
    await expect(h.storage.flush()).rejects.toThrow("storage unavailable");
    expect(signedIn).toHaveBeenCalledExactlyOnceWith(null);
    h.failWrites(false);
    h.storage.setItem(tokenKey, JSON.stringify({ username: "alice", token: "fixture-credential" }));
    await h.storage.flush();
    expect(signedIn.mock.calls).toEqual([[null], ["alice"]]);
    h.service.dispose?.();
  });

  it("locks immediately but waits for revocation and the final durable write before forgetting the space", async () => {
    const h = sessionHarness();
    const writes = deferred<void>();
    h.blockWrites(writes.promise);
    const disconnect = disconnectSpace(h.service, h.storage);
    expect(h.service.snapshot().phase).toBe("locked");
    expect(h.storage.getItem(tokenKey)).toBeNull();
    expect(h.client.sys.token.revoke).toHaveBeenCalledWith({ tokenId: "first-token", reason: "ui session lock" });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.client.disconnect).not.toHaveBeenCalled();
    expect(h.forgotten()).toBeNull();
    h.revocation.resolve({ revoked: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.forgotten()).toBeNull();
    expect(h.unsubscribe).not.toHaveBeenCalled();
    writes.resolve();
    await disconnect;
    expect(h.forgotten()).toEqual({});
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.invoke.mock.calls.at(-1)?.[0]).toBe("desktop_configure");
  });

  it.each(["offline", "failed", "unconfirmed", "timeout"] as const)("persists an %s revocation before disconnecting so the host can retry it in the original space", async (outcome) => {
    const h = sessionHarness(outcome !== "offline");
    if (outcome === "failed") h.client.sys.token.revoke.mockRejectedValueOnce(new Error("connection lost"));
    if (outcome === "unconfirmed") h.client.sys.token.revoke.mockResolvedValueOnce({ revoked: false });
    const disconnect = disconnectSpace(h.service, h.storage);
    if (outcome === "timeout") {
      await vi.advanceTimersByTimeAsync(1_499);
      expect(h.forgotten()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
    }
    await disconnect;
    expect(h.forgotten()).toEqual({ [pendingKey]: JSON.stringify(["first-token"]) });
    expect(h.storage.getItem(tokenKey)).toBeNull();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    if (outcome === "offline") expect(h.client.sys.token.revoke).not.toHaveBeenCalled();
  });

  it("retains the configured session and its retry IDs if persistence fails, then allows retry", async () => {
    const h = sessionHarness(false);
    h.failWrites(true);
    await expect(disconnectSpace(h.service, h.storage)).rejects.toThrow("storage unavailable");
    expect(h.forgotten()).toBeNull();
    expect(h.unsubscribe).not.toHaveBeenCalled();
    expect(h.storage.getItem(pendingKey)).toBe(JSON.stringify(["first-token"]));
    expect(h.onError).toHaveBeenCalled();
    h.failWrites(false);
    await disconnectSpace(h.service, h.storage);
    expect(h.forgotten()).toEqual({ [pendingKey]: JSON.stringify(["first-token"]) });
  });

  it("keeps the locked service available when native reconfiguration fails", async () => {
    const h = sessionHarness(false);
    h.failConfigure(true);
    await expect(disconnectSpace(h.service, h.storage)).rejects.toThrow("configuration unavailable");
    expect(h.unsubscribe).not.toHaveBeenCalled();
    expect(h.stored()).toEqual({ [pendingKey]: JSON.stringify(["first-token"]) });
    h.failConfigure(false);
    await disconnectSpace(h.service, h.storage);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it("retries restored revocations after authenticating to the original space and persists their removal", async () => {
    const h = sessionHarness(true, { [pendingKey]: JSON.stringify(["first-token"]) });
    h.client.connect.mockResolvedValue({
      protocol: 4,
      server: { version: "test", release: "test", connectionId: "connection:alice" },
      peer: { id: "web", sessionId: "connection:alice",
        principal: { kind: "human", account: { uid: 1, gid: 1, gids: [1], username: "alice", home: "/home/alice", cwd: "/home/alice" } },
        grant: { calls: [], signals: [], implements: [] },
      },
    });
    h.client.sys.token.revoke.mockResolvedValue({ revoked: true });
    h.client.sys.token.create.mockResolvedValue({ token: {
      tokenId: "next-token", token: "next-fixture-credential", tokenPrefix: "fixture", uid: 1, kind: "human",
      label: "gsv-ui-session", peerId: null, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    } });
    await h.service.login({ username: "alice", password: "fixture-password" });
    await h.storage.flush();
    expect(h.client.connect).toHaveBeenCalledWith({ url: "wss://first.example/ws", username: "alice", password: "fixture-password" });
    expect(h.client.sys.token.revoke).toHaveBeenCalledExactlyOnceWith({ tokenId: "first-token", reason: "ui session cleanup" });
    expect(h.stored()[pendingKey]).toBeUndefined();
    expect(JSON.parse(h.stored()[tokenKey]).tokenId).toBe("next-token");
    h.service.dispose?.();
  });
});
