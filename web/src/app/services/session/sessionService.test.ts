import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsvClientStatus } from "@humansandmachines/gsv/client";
import type { SysSetupResult } from "@humansandmachines/gsv/protocol";
import { createSessionService, type SessionClient } from "./sessionService";

type StatusListener = (status: GsvClientStatus) => void;

function requireStatusListener(listener: StatusListener | null): StatusListener {
  if (!listener) throw new Error("status listener was not registered");
  return listener;
}

function installWindow(): void {
  const values = new Map<string, string>();
  const sessionValues = new Map<string, string>();
  vi.stubGlobal("window", {
    clearTimeout: vi.fn(),
    location: { host: "example.test", protocol: "https:", pathname: "/", search: "", hash: "" },
    history: { state: null, replaceState: vi.fn() },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
    sessionStorage: {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      removeItem: (key: string) => sessionValues.delete(key),
      setItem: (key: string, value: string) => sessionValues.set(key, value),
    },
    setTimeout: vi.fn(() => 1),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account setup", () => {
  const onboardingStorageKey = "gsv.ui.installation-onboarding.v1";
  const onboardingToken = `onboard_${"a".repeat(43)}`;
  const setupResult = {
    server: { version: "test", release: "test" },
    user: { uid: 1, gid: 1, gids: [1], username: "alice", home: "/home/alice", cwd: "/home/alice" },
    rootLocked: false,
  } satisfies SysSetupResult;

  function createSetupClient() {
    return {
      connect: vi.fn<SessionClient["connect"]>().mockResolvedValue({
        server: { ...setupResult.server, connectionId: "connection:alice" },
        protocol: 4,
        peer: {
          id: "web",
          sessionId: "connection:alice",
          principal: { kind: "human", account: setupResult.user },
          grant: { calls: [], signals: [], implements: [] },
        },
      }),
      disconnect: vi.fn(),
      isConnected: () => false,
      requestOnce: vi.fn<SessionClient["requestOnce"]>().mockResolvedValue(setupResult),
      onStatus: () => () => undefined,
      sys: { token: { create: vi.fn(), revoke: vi.fn(), list: vi.fn() } },
    } satisfies SessionClient;
  }

  it("signs in immediately with the credentials created by setup", async () => {
    installWindow();
    window.sessionStorage.setItem(onboardingStorageKey, onboardingToken);
    const client = createSetupClient();
    const service = createSessionService(client);

    await expect(service.setup({ username: "alice", password: " setup password " })).resolves.toEqual(setupResult);

    expect(client.requestOnce).toHaveBeenCalledWith("wss://example.test/ws", "sys.setup", {
      username: "alice",
      password: " setup password ",
      onboardingToken,
    });
    expect(client.connect).toHaveBeenCalledWith({
      url: "wss://example.test/ws",
      username: "alice",
      password: "setup password",
    });
    expect(service.snapshot()).toMatchObject({ phase: "ready", username: "alice", connectionId: "connection:alice" });
    expect(window.sessionStorage.getItem(onboardingStorageKey)).toBeNull();
    expect(window.localStorage.getItem("gsv.ui.gateway.username")).toBe("alice");
  });

  it("retains setup authorization when account creation fails so the user can retry", async () => {
    installWindow();
    window.sessionStorage.setItem(onboardingStorageKey, onboardingToken);
    const client = createSetupClient();
    client.requestOnce.mockRejectedValueOnce(new Error("Account creation interrupted"));
    const service = createSessionService(client);
    const input = { username: "alice", password: "setup password" };

    await expect(service.setup(input)).rejects.toThrow("Account creation interrupted");

    expect(service.snapshot()).toMatchObject({ phase: "setup", username: "alice", message: "Account creation interrupted" });
    expect(client.connect).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(onboardingStorageKey)).toBe(onboardingToken);

    await service.setup(input);

    expect(client.requestOnce).toHaveBeenNthCalledWith(2, "wss://example.test/ws", "sys.setup", { ...input, onboardingToken });
    expect(service.snapshot().phase).toBe("ready");
    expect(window.sessionStorage.getItem(onboardingStorageKey)).toBeNull();
  });

  it("offers ordinary sign-in if connecting fails after account creation", async () => {
    installWindow();
    window.sessionStorage.setItem(onboardingStorageKey, onboardingToken);
    const client = createSetupClient();
    client.connect.mockRejectedValueOnce(new Error("Connection interrupted"));
    const service = createSessionService(client);
    const input = { username: "alice", password: "setup password" };

    await expect(service.setup(input)).rejects.toThrow("Connection interrupted");

    expect(service.snapshot()).toMatchObject({ phase: "locked", username: "alice", message: "Connection interrupted" });
    expect(window.sessionStorage.getItem(onboardingStorageKey)).toBeNull();

    await service.login(input);

    expect(service.snapshot().phase).toBe("ready");
    expect(client.requestOnce).toHaveBeenCalledOnce();
  });

  it("does not sign in after the session was locked while setup was pending", async () => {
    installWindow();
    window.sessionStorage.setItem(onboardingStorageKey, onboardingToken);
    const client = createSetupClient();
    let finishSetup!: (result: SysSetupResult) => void;
    client.requestOnce.mockReturnValueOnce(new Promise<SysSetupResult>((resolve) => {
      finishSetup = resolve;
    }));
    const service = createSessionService(client);

    const pending = service.setup({ username: "alice", password: "setup password" });
    service.lock();
    finishSetup(setupResult);
    await pending;

    expect(service.snapshot()).toMatchObject({ phase: "locked", username: "alice" });
    expect(client.connect).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(onboardingStorageKey)).toBeNull();
  });
});

describe("session lock", () => {
  it("preserves exact password bytes for invitation and recovery credentials", async () => {
    installWindow();
    const connect = vi.fn().mockRejectedValue(new Error("test transport ended"));
    const client = { connect, disconnect: vi.fn(), isConnected: () => false, requestOnce: vi.fn(), onStatus: () => () => undefined,
      sys: { token: { create: vi.fn(), revoke: vi.fn(), list: vi.fn() } },
    } satisfies SessionClient;
    const service = createSessionService(client);
    await expect(service.login({ username: " person ", password: " password with spaces " })).rejects.toThrow("test transport ended");
    expect(connect).toHaveBeenCalledWith({ url: "wss://example.test/ws", username: "person", password: " password with spaces " });
  });

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
      protocol: 3,
      peer: {
        id: "web",
        sessionId: "connection:bob",
        principal: {
          kind: "human",
          account: { uid: 1, gid: 1, gids: [1], username: "bob", home: "/", cwd: "/" },
        },
        grant: { calls: [], signals: [], implements: [] },
      },
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
