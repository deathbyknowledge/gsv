import type { GSVClient, GsvClientStatus, GsvConnectOptions } from "@humansandmachines/gsv/client";
import type {
  ConnectResult,
  SysBootstrapResult,
  SysSetupResult,
  SysTokenCreateResult,
} from "@humansandmachines/gsv/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "./sessionService";

const STORAGE_SESSION_TOKEN = "gsv.ui.session.token.v1";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly failedWrites = new Set<string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failedWrites.has(key)) {
      throw new Error(`storage write failed for ${key}`);
    }
    this.values.set(key, value);
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function connectResult(): ConnectResult {
  return {
    protocol: 2,
    server: {
      version: "0.4.0",
      release: "test",
      connectionId: "connection-1",
    },
    identity: {
      role: "user",
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "hank",
        home: "/home/hank",
        cwd: "/home/hank",
      },
      capabilities: [],
    },
    syscalls: [],
    signals: [],
  };
}

function sessionTokenResult(): SysTokenCreateResult {
  return {
    token: {
      tokenId: "session-token-id",
      token: "session-token-value",
      tokenPrefix: "session",
      uid: 1000,
      kind: "user",
      label: "gsv-ui-session",
      allowedRole: "user",
      allowedDeviceId: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  };
}

function setupResult(): SysSetupResult {
  return {
    server: {
      version: "0.4.0",
      release: "test",
    },
    user: {
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "hank",
      home: "/home/hank",
      cwd: "/home/hank",
    },
    rootLocked: false,
  };
}

function bootstrapResult(): SysBootstrapResult {
  return {
    repo: "system",
    remoteUrl: "https://example.com/system.git",
    ref: "main",
    head: "abc123",
    changed: true,
    manual: {
      repo: "system",
      remoteUrl: "https://example.com/system.git",
      ref: "main",
      head: "abc123",
      changed: true,
    },
  };
}

type ClientHarnessOptions = {
  createToken?: () => Promise<SysTokenCreateResult>;
  bootstrap?: () => Promise<SysBootstrapResult>;
};

function createClientHarness(options: ClientHarnessOptions = {}) {
  const listeners = new Set<(status: GsvClientStatus) => void>();
  let status: GsvClientStatus = {
    state: "disconnected",
    url: null,
    username: null,
    connectionId: null,
    message: null,
  };

  const emitStatus = (next: GsvClientStatus): void => {
    status = next;
    for (const listener of listeners) {
      listener(status);
    }
  };

  const connect = vi.fn(async (input: GsvConnectOptions): Promise<ConnectResult> => {
    const result = connectResult();
    emitStatus({
      state: "connected",
      url: input.url ?? "wss://gateway.example/ws",
      username: input.username ?? null,
      connectionId: result.server.connectionId,
      message: null,
    });
    return result;
  });
  const disconnect = vi.fn(() => {
    emitStatus({
      state: "disconnected",
      url: status.url,
      username: status.username,
      connectionId: null,
      message: null,
    });
  });
  const createToken = vi.fn(options.createToken ?? (async () => sessionTokenResult()));
  const revokeToken = vi.fn(async () => ({ revoked: true }));
  const bootstrap = vi.fn(options.bootstrap ?? (async () => bootstrapResult()));
  const requestOnce = vi.fn(async () => setupResult());

  const client = {
    connect,
    disconnect,
    getStatus: () => status,
    isConnected: () => status.state === "connected",
    onStatus: (listener: (next: GsvClientStatus) => void) => {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    requestOnce,
    sys: {
      bootstrap,
      token: {
        create: createToken,
        revoke: revokeToken,
      },
    },
  } as unknown as GSVClient;

  return {
    bootstrap,
    client,
    connect,
    createToken,
    disconnect,
    emitStatus,
    revokeToken,
  };
}

describe("session service readiness", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = new MemoryStorage();
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        host: "gateway.example",
      },
      localStorage: storage,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("publishes password login readiness only after persisting the session token", async () => {
    const token = deferred<SysTokenCreateResult>();
    const tokenRequested = deferred<void>();
    const harness = createClientHarness({
      createToken: () => {
        tokenRequested.resolve();
        return token.promise;
      },
    });
    const service = createSessionService(harness.client);
    const persistedTokensAtReady: Array<string | null> = [];
    service.subscribe((snapshot) => {
      if (snapshot.phase === "ready") {
        persistedTokensAtReady.push(storage.getItem(STORAGE_SESSION_TOKEN));
      }
    });

    const login = service.login({ username: "hank", password: "password123" });
    await tokenRequested.promise;

    expect(service.snapshot()).toMatchObject({
      phase: "authenticating",
      username: "hank",
    });
    expect(persistedTokensAtReady).toEqual([]);

    token.resolve(sessionTokenResult());
    await login;

    expect(service.snapshot().phase).toBe("ready");
    expect(persistedTokensAtReady).toHaveLength(1);
    expect(JSON.parse(persistedTokensAtReady[0] ?? "null")).toMatchObject({
      username: "hank",
      tokenId: "session-token-id",
      token: "session-token-value",
    });
  });

  it("also holds access-token login until its reloadable session token is persisted", async () => {
    const sessionToken = deferred<SysTokenCreateResult>();
    const tokenRequested = deferred<void>();
    const harness = createClientHarness({
      createToken: () => {
        tokenRequested.resolve();
        return sessionToken.promise;
      },
    });
    const service = createSessionService(harness.client);
    const phases: string[] = [];
    service.subscribe((snapshot) => phases.push(snapshot.phase));

    const login = service.login({ username: "hank", token: "one-time-access-token" });
    await tokenRequested.promise;

    expect(service.snapshot().phase).toBe("authenticating");
    expect(phases).not.toContain("ready");
    expect(harness.connect).toHaveBeenCalledWith({
      url: "wss://gateway.example/ws",
      username: "hank",
      token: "one-time-access-token",
    });

    sessionToken.resolve(sessionTokenResult());
    await login;

    expect(service.snapshot().phase).toBe("ready");
    expect(storage.getItem(STORAGE_SESSION_TOKEN)).toContain("session-token-value");
  });

  it("does not publish ready when password login cannot create a session token", async () => {
    const harness = createClientHarness({
      createToken: async () => {
        throw new Error("token creation failed");
      },
    });
    const service = createSessionService(harness.client);
    const phases: string[] = [];
    service.subscribe((snapshot) => phases.push(snapshot.phase));

    await expect(service.login({ username: "hank", password: "password123" }))
      .rejects.toThrow("Could not create a persistent session");

    expect(service.snapshot()).toMatchObject({
      phase: "locked",
      message: "Could not create a persistent session. Sign in again.",
    });
    expect(phases).not.toContain("ready");
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });

  it("does not publish ready when the created session token cannot be persisted", async () => {
    storage.failedWrites.add(STORAGE_SESSION_TOKEN);
    const harness = createClientHarness();
    const service = createSessionService(harness.client);
    const phases: string[] = [];
    service.subscribe((snapshot) => phases.push(snapshot.phase));

    await expect(service.login({ username: "hank", password: "password123" }))
      .rejects.toThrow("Could not create a persistent session");

    expect(service.snapshot().phase).toBe("locked");
    expect(phases).not.toContain("ready");
    expect(storage.getItem(STORAGE_SESSION_TOKEN)).toBeNull();
    expect(harness.revokeToken).toHaveBeenCalledWith({
      tokenId: "session-token-id",
      reason: "ui session token persistence failed",
    });
  });

  it("keeps setup continuation hidden until bootstrap completes", async () => {
    const bootstrap = deferred<SysBootstrapResult>();
    const bootstrapRequested = deferred<void>();
    const harness = createClientHarness({
      bootstrap: () => {
        bootstrapRequested.resolve();
        return bootstrap.promise;
      },
    });
    const service = createSessionService(harness.client);

    await service.setup({
      username: "hank",
      password: "password123",
      timezone: "UTC",
    });
    expect(service.snapshot().phase).toBe("setup-complete");

    const phases: string[] = [];
    service.subscribe((snapshot) => phases.push(snapshot.phase));
    const initialize = service.initializeFromUpstream();
    await bootstrapRequested.promise;

    expect(service.snapshot().phase).toBe("authenticating");
    expect(phases).not.toContain("ready");

    bootstrap.resolve(bootstrapResult());
    await initialize;

    expect(service.snapshot().phase).toBe("ready");
  });

  it("preserves connected-status handling for silent reconnects", async () => {
    storage.setItem(STORAGE_SESSION_TOKEN, JSON.stringify({
      username: "hank",
      tokenId: "persisted-token-id",
      token: "persisted-token-value",
      expiresAt: Date.now() + 60_000,
    }));
    const harness = createClientHarness();
    const service = createSessionService(harness.client);

    await service.start();
    expect(service.snapshot().phase).toBe("ready");

    harness.emitStatus({
      state: "disconnected",
      url: "wss://gateway.example/ws",
      username: "hank",
      connectionId: null,
      message: "connection interrupted",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.connect).toHaveBeenCalledTimes(2);
    expect(service.snapshot()).toMatchObject({
      phase: "ready",
      username: "hank",
      message: null,
    });
  });
});
