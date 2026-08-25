function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Stopped"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function connectionFailureReason(error, secrets = []) {
  let message = error instanceof Error ? error.message : "Connection failed";
  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, "[redacted]");
    }
  }
  return message.replace(/[\r\n]+/g, " ").slice(0, 160) || "Connection failed";
}

export class ReconnectSupervisor {
  constructor({
    isConnected,
    connect,
    onRetry = () => {},
    wait = delay,
    initialRetryMs = 500,
    maximumRetryMs = 10_000,
  }) {
    this.isConnected = isConnected;
    this.connect = connect;
    this.onRetry = onRetry;
    this.wait = wait;
    this.initialRetryMs = initialRetryMs;
    this.maximumRetryMs = maximumRetryMs;
    this.started = false;
    this.stopped = false;
    this.connecting = null;
    this.reconnectTimer = null;
    this.stopAbort = new AbortController();
  }

  start() {
    this.started = true;
    return this.ensureConnected();
  }

  disconnected() {
    if (!this.started || this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, 0);
  }

  ensureConnected() {
    if (!this.started || this.stopped || this.isConnected()) {
      return Promise.resolve();
    }
    if (this.connecting) {
      return this.connecting;
    }

    let active;
    active = Promise.resolve()
      .then(() => this.connectLoop())
      .finally(() => {
        if (this.connecting === active) {
          this.connecting = null;
        }
      });
    this.connecting = active;
    return active;
  }

  async connectLoop() {
    let retryMs = this.initialRetryMs;
    while (this.started && !this.stopped && !this.isConnected()) {
      try {
        await this.connect();
        return;
      } catch (error) {
        if (!this.started || this.stopped) {
          return;
        }
        this.onRetry(error, retryMs);
        try {
          await this.wait(retryMs, this.stopAbort.signal);
        } catch {
          return;
        }
        retryMs = Math.min(retryMs * 2, this.maximumRetryMs);
      }
    }
  }

  async stop() {
    this.started = false;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopAbort.abort(new Error("Connection stopped"));
    await this.connecting?.catch(() => {});
  }
}
