import type {
  GsvClientStatus,
  GsvDriverConnectOptions,
} from "@humansandmachines/gsv/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionConfig } from "../shared/config";
import { ConnectionSupervisor } from "./connection-supervisor";

const CONFIG: ExtensionConfig = {
  gatewayUrl: "wss://example.test/ws",
  username: "hank",
  token: "token-one",
  deviceId: "chrome",
  autoConnect: true,
};

describe("ConnectionSupervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries failed connections immediately with bounded exponential backoff", async () => {
    vi.useFakeTimers();
    const driver = new FakeDriver(async () => {
      throw new Error("offline");
    });
    const jitter = [0, 1, 0.5];
    const supervisor = new ConnectionSupervisor(driver, {
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      random: () => jitter.shift() ?? 0.5,
      now: Date.now,
    });

    await expect(supervisor.reconcile(CONFIG)).rejects.toThrow("offline");
    expect(driver.connectOptions).toHaveLength(1);
    expect(supervisor.getState().retryAt).toBe(Date.now() + 750);

    await vi.advanceTimersByTimeAsync(750);
    expect(driver.connectOptions).toHaveLength(2);
    expect(supervisor.getState().retryAt).toBe(Date.now() + 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(driver.connectOptions).toHaveLength(3);
    expect(supervisor.getState().retryAt).toBe(Date.now() + 2_000);
  });

  it("supersedes an opening connection when its configuration changes", async () => {
    const first = deferred<void>();
    let attempts = 0;
    const driver = new FakeDriver(async () => {
      attempts += 1;
      if (attempts === 1) {
        return await first.promise;
      }
    });
    const supervisor = new ConnectionSupervisor(driver);

    const stale = supervisor.reconcile(CONFIG);
    await Promise.resolve();
    const current = supervisor.reconcile({ ...CONFIG, token: "token-two" });
    await current;
    first.reject(new Error("superseded"));
    await expect(stale).rejects.toThrow("superseded");

    expect(driver.disconnectReasons).toEqual(["connection settings changed"]);
    expect(driver.connectOptions.map((options) => options.token)).toEqual(["token-one", "token-two"]);
    expect(supervisor.getState().retryAt).toBeNull();
  });

  it("keeps an explicit disconnect suppressed across reconciliation", async () => {
    vi.useFakeTimers();
    const driver = new FakeDriver(async () => {
      throw new Error("offline");
    });
    const supervisor = new ConnectionSupervisor(driver, {
      retryBaseMs: 100,
      random: () => 0.5,
    });

    await expect(supervisor.reconcile(CONFIG)).rejects.toThrow("offline");
    supervisor.setReconnectSuppressed(true);
    expect(supervisor.getState()).toEqual({ reconnectSuppressed: true, retryAt: null });

    await supervisor.reconcile(CONFIG);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(driver.connectOptions).toHaveLength(1);
  });

  it("reconnects after an established socket closes", async () => {
    vi.useFakeTimers();
    const driver = new FakeDriver(async () => {});
    const supervisor = new ConnectionSupervisor(driver, {
      retryBaseMs: 100,
      random: () => 0.5,
    });

    await supervisor.reconcile(CONFIG);
    driver.setStatus("disconnected", "Connection closed");
    supervisor.handleStatus(driver.client.getStatus());
    await vi.advanceTimersByTimeAsync(100);

    expect(driver.connectOptions).toHaveLength(2);
  });
});

class FakeDriver {
  readonly connectOptions: GsvDriverConnectOptions[] = [];
  readonly disconnectReasons: string[] = [];
  readonly client = {
    getStatus: (): GsvClientStatus => this.status,
  };

  private status: GsvClientStatus = status("disconnected");
  private readonly connectImplementation: () => Promise<void>;

  constructor(connectImplementation: () => Promise<void>) {
    this.connectImplementation = connectImplementation;
  }

  async connect(options: GsvDriverConnectOptions): Promise<void> {
    this.connectOptions.push(options);
    this.status = status("connecting");
    try {
      await this.connectImplementation();
      this.status = status("connected");
    } catch (error) {
      this.status = status("disconnected", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  disconnect(reason = "disconnected"): void {
    this.disconnectReasons.push(reason);
    this.status = status("disconnected", reason);
  }

  setStatus(state: GsvClientStatus["state"], message: string | null = null): void {
    this.status = status(state, message);
  }
}

function status(state: GsvClientStatus["state"], message: string | null = null): GsvClientStatus {
  return {
    state,
    url: null,
    username: null,
    connectionId: state === "connected" ? "connection" : null,
    message,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
