import type {
  GsvClientStatus,
  GsvDriverConnectOptions,
} from "@humansandmachines/gsv/client";
import { configReady, type ExtensionConfig } from "../shared/config";

type ConnectionDriver = {
  client: {
    getStatus(): GsvClientStatus;
  };
  connect(options: GsvDriverConnectOptions): Promise<unknown>;
  disconnect(reason?: string): void;
};

export type ConnectionSupervisorState = {
  reconnectSuppressed: boolean;
  retryAt: number | null;
};

type ConnectionSupervisorOptions = {
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
  now?: () => number;
};

type ReconcileOptions = {
  manual?: boolean;
};

const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

export class ConnectionSupervisor {
  private readonly driver: ConnectionDriver;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private desired: { config: ExtensionConfig; fingerprint: string } | null = null;
  private generation = 0;
  private maintainConnection = false;
  private reconnectSuppressed = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private retryAt: number | null = null;
  private connectAttempt: { generation: number; promise: Promise<void> } | null = null;

  constructor(driver: ConnectionDriver, options: ConnectionSupervisorOptions = {}) {
    this.driver = driver;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  getState(): ConnectionSupervisorState {
    return {
      reconnectSuppressed: this.reconnectSuppressed,
      retryAt: this.retryAt,
    };
  }

  setReconnectSuppressed(suppressed: boolean, reason = "reconnect paused by user"): void {
    if (this.reconnectSuppressed === suppressed) {
      return;
    }
    this.reconnectSuppressed = suppressed;
    this.generation += 1;
    this.maintainConnection = false;
    this.retryAttempt = 0;
    this.clearRetry();
    if (suppressed && this.driver.client.getStatus().state !== "disconnected") {
      this.driver.disconnect(reason);
    }
  }

  async reconcile(config: ExtensionConfig, options: ReconcileOptions = {}): Promise<void> {
    const fingerprint = configFingerprint(config);
    const configChanged = this.desired?.fingerprint !== fingerprint;
    const shouldMaintain = configReady(config)
      && !this.reconnectSuppressed
      && (options.manual === true || config.autoConnect);
    const policyChanged = shouldMaintain !== this.maintainConnection;

    if (configChanged || policyChanged) {
      this.generation += 1;
      this.retryAttempt = 0;
      this.clearRetry();
    }
    this.maintainConnection = shouldMaintain;
    if (configChanged) {
      this.desired = { config: { ...config }, fingerprint };
      if (this.driver.client.getStatus().state !== "disconnected") {
        this.driver.disconnect("connection settings changed");
      }
    }

    if (!shouldMaintain) {
      if (this.driver.client.getStatus().state === "connecting") {
        this.driver.disconnect("automatic reconnect disabled");
      }
      return;
    }
    if (this.driver.client.getStatus().state !== "disconnected") {
      return;
    }
    this.clearRetry();
    await this.connect(this.generation);
  }

  handleStatus(status: GsvClientStatus): void {
    if (status.state === "connected") {
      this.retryAttempt = 0;
      this.clearRetry();
      return;
    }
    if (status.state === "disconnected") {
      this.scheduleRetry(this.generation);
    }
  }

  private async connect(generation: number): Promise<void> {
    if (
      generation !== this.generation
      || !this.maintainConnection
      || !this.desired
      || this.driver.client.getStatus().state !== "disconnected"
    ) {
      return;
    }
    if (this.connectAttempt?.generation === generation) {
      return await this.connectAttempt.promise;
    }

    const { config } = this.desired;
    const promise = this.driver.connect({
      url: config.gatewayUrl,
      username: config.username,
      token: config.token,
      deviceId: config.deviceId,
    }).then(() => undefined);
    this.connectAttempt = { generation, promise };
    try {
      await promise;
    } catch (error) {
      if (generation === this.generation) {
        this.scheduleRetry(generation);
      }
      throw error;
    } finally {
      if (this.connectAttempt?.promise === promise) {
        this.connectAttempt = null;
      }
    }
  }

  private scheduleRetry(generation: number): void {
    if (
      this.retryTimer
      || generation !== this.generation
      || !this.maintainConnection
      || !this.desired
    ) {
      return;
    }
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** this.retryAttempt));
    const delay = Math.min(this.retryMaxMs, Math.round(exponential * (0.75 + this.random() * 0.5)));
    this.retryAttempt += 1;
    this.retryAt = this.now() + delay;
    this.retryTimer = globalThis.setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      void this.connect(generation).catch(() => {});
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAt = null;
  }
}

function configFingerprint(config: ExtensionConfig): string {
  return JSON.stringify([
    config.gatewayUrl,
    config.username,
    config.token,
    config.deviceId,
  ]);
}
