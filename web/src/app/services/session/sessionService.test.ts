import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsvClientStatus } from "@humansandmachines/gsv/client";
import { createSessionService, type SessionClient } from "./sessionService";

type StatusListener = (status: GsvClientStatus) => void;

function requireStatusListener(listener: StatusListener | null): StatusListener {
  if (!listener) throw new Error("status listener was not registered");
  return listener;
}

function installWindow(): void {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    clearTimeout: vi.fn(),
    location: { host: "example.test", protocol: "https:" },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
    setTimeout: vi.fn(() => 1),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session lock", () => {
  it("publishes the locked identity boundary synchronously", () => {
    installWindow();
    let onStatus: StatusListener | null = null;
    const client = {
      disconnect: vi.fn(),
      isConnected: () => false,
      connect: vi.fn(),
      requestOnce: vi.fn(),
      onStatus: (listener: StatusListener) => {
        onStatus = listener;
        return () => undefined;
      },
      sys: { token: { create: vi.fn(), revoke: vi.fn(), list: vi.fn() } },
    } satisfies SessionClient;
    const service = createSessionService(client);
    const snapshots = [service.snapshot()];
    service.subscribe((snapshot) => snapshots.push(snapshot));

    const publishStatus = requireStatusListener(onStatus);
    publishStatus({
      connectionId: "connection:alice",
      state: "connected",
      url: "wss://example.test/ws",
      username: "alice",
      message: null,
    });
    expect(service.snapshot().phase).toBe("ready");

    service.lock();

    expect(service.snapshot()).toMatchObject({
      connectionId: null,
      phase: "locked",
      username: "alice",
    });
    expect(snapshots.at(-1)?.phase).toBe("locked");
  });

  it("does not let delayed lock cleanup disconnect a newer login", async () => {
    installWindow();
    let onStatus: StatusListener | null = null;
    const disconnect = vi.fn();
    const connect = vi.fn<SessionClient["connect"]>();
    connect.mockResolvedValue({
      server: { version: "test", release: "test", connectionId: "connection:bob" },
      protocol: 2,
      identity: {
        role: "user",
        process: { uid: 1, gid: 1, gids: [1], username: "bob", home: "/", cwd: "/" },
        capabilities: [],
      },
      syscalls: [],
      signals: [],
    });
    const client = {
      connect,
      disconnect,
      isConnected: () => false,
      requestOnce: vi.fn(),
      onStatus: (listener: StatusListener) => {
        onStatus = listener;
        return () => undefined;
      },
      sys: { token: { create: vi.fn(), revoke: vi.fn(), list: vi.fn() } },
    } satisfies SessionClient;
    const service = createSessionService(client);
    const publishStatus = requireStatusListener(onStatus);
    publishStatus({
      connectionId: "connection:alice",
      state: "connected",
      url: "wss://example.test/ws",
      username: "alice",
      message: null,
    });

    service.lock();
    await service.login({ username: "bob" });
    await Promise.resolve();

    expect(service.snapshot()).toMatchObject({
      connectionId: "connection:bob",
      phase: "ready",
      username: "bob",
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
