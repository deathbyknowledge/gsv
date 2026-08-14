import type { GSVClient } from "@humansandmachines/gsv/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "./sessionService";

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
    let onStatus: ((status: {
      connectionId: string;
      state: string;
      url: string;
      username: string;
    }) => void) | null = null;
    const client = {
      disconnect: vi.fn(),
      isConnected: () => false,
      onStatus: (listener: typeof onStatus) => {
        onStatus = listener;
        return () => undefined;
      },
    } as unknown as GSVClient;
    const service = createSessionService(client);
    const snapshots = [service.snapshot()];
    service.subscribe((snapshot) => snapshots.push(snapshot));

    const publishStatus = onStatus as unknown as (status: {
      connectionId: string;
      state: string;
      url: string;
      username: string;
    }) => void;
    publishStatus({
      connectionId: "connection:alice",
      state: "connected",
      url: "wss://example.test/ws",
      username: "alice",
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
    let onStatus: ((status: {
      connectionId: string;
      state: string;
      url: string;
      username: string;
    }) => void) | null = null;
    const disconnect = vi.fn();
    const connect = vi.fn(async () => ({
      server: { connectionId: "connection:bob" },
    }));
    const client = {
      connect,
      disconnect,
      isConnected: () => false,
      onStatus: (listener: typeof onStatus) => {
        onStatus = listener;
        return () => undefined;
      },
    } as unknown as GSVClient;
    const service = createSessionService(client);
    const publishStatus = onStatus as unknown as (status: {
      connectionId: string;
      state: string;
      url: string;
      username: string;
    }) => void;
    publishStatus({
      connectionId: "connection:alice",
      state: "connected",
      url: "wss://example.test/ws",
      username: "alice",
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
