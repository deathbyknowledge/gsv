import type {
  GatewayClientLike,
  GatewayClientStatus,
  ProcHistoryResult,
  ProcSendResult,
  ProcSpawnArgs,
  ProcSpawnResult,
} from "./gateway-client";

type HostRpcMethod = "call" | "spawnProcess" | "sendMessage" | "getHistory";

type HostRpcMessage = {
  type: "rpc";
  id: string;
  method: HostRpcMethod;
  payload?: unknown;
};

type HostRpcResultMessage =
  | {
      type: "rpc-result";
      id: string;
      ok: true;
      data?: unknown;
    }
  | {
      type: "rpc-result";
      id: string;
      ok: false;
      error: string;
    };

type HostStatusMessage = {
  type: "status";
  status: GatewayClientStatus;
};

type HostSignalMessage = {
  type: "signal";
  signal: string;
  payload?: unknown;
};

type HostConnectMessage = {
  type: "gsv-host-connect";
};

type HostPortMessage = HostRpcMessage | HostRpcResultMessage | HostStatusMessage | HostSignalMessage;

type PendingHostRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

export type HostBridgeController = {
  destroy: () => void;
};

const BRIDGE_TIMEOUT_MS = 20_000;

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postMessage(port: MessagePort, message: HostPortMessage): void {
  port.postMessage(message);
}

async function handleRpc(
  gatewayClient: GatewayClientLike,
  message: HostRpcMessage,
): Promise<unknown> {
  switch (message.method) {
    case "call": {
      const payload = asRecord(message.payload);
      const call = asString(payload?.call);
      if (!call) {
        throw new Error("HOST.call requires a syscall name");
      }
      return gatewayClient.call(call, payload?.args ?? {});
    }
    case "spawnProcess":
      return gatewayClient.spawnProcess((message.payload ?? {}) as ProcSpawnArgs);
    case "sendMessage": {
      const payload = asRecord(message.payload);
      const text = asString(payload?.message) ?? "";
      const pid = asString(payload?.pid) ?? undefined;
      return gatewayClient.sendMessage(text, pid);
    }
    case "getHistory": {
      const payload = asRecord(message.payload);
      const limit = typeof payload?.limit === "number" ? payload.limit : 50;
      const pid = asString(payload?.pid) ?? undefined;
      const offset = typeof payload?.offset === "number" ? payload.offset : undefined;
      return gatewayClient.getHistory(limit, pid, offset);
    }
  }
}

export function attachHostBridge(
  iframe: HTMLIFrameElement,
  gatewayClient: GatewayClientLike,
): HostBridgeController {
  let port: MessagePort | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  let unsubscribeSignal: (() => void) | null = null;
  let destroyed = false;

  const cleanup = (): void => {
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    unsubscribeSignal?.();
    unsubscribeSignal = null;
    port?.close();
    port = null;
  };

  const onLoad = (): void => {
    if (destroyed || !iframe.contentWindow) {
      return;
    }

    cleanup();

    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      const record = asRecord(message);
      if (!record || record.type !== "rpc") {
        return;
      }

      void handleRpc(gatewayClient, message as HostRpcMessage)
        .then((data) => {
          postMessage(channel.port1, {
            type: "rpc-result",
            id: String(record.id ?? ""),
            ok: true,
            data,
          });
        })
        .catch((error) => {
          postMessage(channel.port1, {
            type: "rpc-result",
            id: String(record.id ?? ""),
            ok: false,
            error: toErrorMessage(error),
          });
        });
    };
    port.start();

    iframe.contentWindow.postMessage(
      {
        type: "gsv-host-connect",
      } satisfies HostConnectMessage,
      window.location.origin,
      [channel.port2],
    );

    unsubscribeStatus = gatewayClient.onStatus((status) => {
      postMessage(channel.port1, {
        type: "status",
        status,
      });
    });
    unsubscribeSignal = gatewayClient.onSignal((signal, payload) => {
      postMessage(channel.port1, {
        type: "signal",
        signal,
        payload,
      });
    });
  };

  iframe.addEventListener("load", onLoad, { once: true });

  return {
    destroy: () => {
      destroyed = true;
      iframe.removeEventListener("load", onLoad);
      cleanup();
    },
  };
}

export function connectEmbeddedHostClient(timeoutMs = BRIDGE_TIMEOUT_MS): Promise<GatewayClientLike> {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for HOST bridge"));
    }, timeoutMs);

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const record = asRecord(event.data);
      if (!record || record.type !== "gsv-host-connect") {
        return;
      }

      const [port] = event.ports;
      if (!(port instanceof MessagePort)) {
        cleanup();
        reject(new Error("HOST bridge did not provide a message port"));
        return;
      }

      cleanup();
      resolve(createEmbeddedHostClient(port));
    };

    const cleanup = (): void => {
      window.clearTimeout(timerId);
      window.removeEventListener("message", onMessage);
    };

    window.addEventListener("message", onMessage);
  });
}

function createEmbeddedHostClient(port: MessagePort): GatewayClientLike {
  let status: GatewayClientStatus = {
    state: "connecting",
    url: window.location.origin,
    username: null,
    connectionId: null,
    message: "Waiting for host bridge...",
  };

  const statusListeners = new Set<(status: GatewayClientStatus) => void>();
  const signalListeners = new Set<(signal: string, payload: unknown) => void>();
  const pending = new Map<string, PendingHostRequest>();

  const emitStatus = (): void => {
    for (const listener of statusListeners) {
      listener(status);
    }
  };

  const rejectAllPending = (message: string): void => {
    for (const { reject, timeoutId } of pending.values()) {
      window.clearTimeout(timeoutId);
      reject(new Error(message));
    }
    pending.clear();
  };

  port.onmessage = (event: MessageEvent<unknown>) => {
    const record = asRecord(event.data);
    if (!record || typeof record.type !== "string") {
      return;
    }

    if (record.type === "status") {
      const next = record.status as GatewayClientStatus | undefined;
      if (next) {
        status = next;
        emitStatus();
      }
      return;
    }

    if (record.type === "signal") {
      const signal = asString(record.signal);
      if (!signal) {
        return;
      }
      for (const listener of signalListeners) {
        listener(signal, record.payload);
      }
      return;
    }

    if (record.type === "rpc-result") {
      const id = asString(record.id);
      if (!id) {
        return;
      }
      const pendingRequest = pending.get(id);
      if (!pendingRequest) {
        return;
      }
      pending.delete(id);
      window.clearTimeout(pendingRequest.timeoutId);

      if (record.ok === true) {
        pendingRequest.resolve(record.data);
      } else {
        pendingRequest.reject(new Error(asString(record.error) ?? "HOST request failed"));
      }
    }
  };
  port.start();

  const rpc = <T>(method: HostRpcMethod, payload?: unknown): Promise<T> => {
    const id = makeId();
    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`HOST request timed out: ${method}`));
      }, BRIDGE_TIMEOUT_MS);

      pending.set(id, {
        resolve,
        reject,
        timeoutId,
      });

      postMessage(port, {
        type: "rpc",
        id,
        method,
        payload,
      });
    });
  };

  return {
    getStatus: () => status,
    isConnected: () => status.state === "connected",
    onSignal: (listener) => {
      signalListeners.add(listener);
      return () => {
        signalListeners.delete(listener);
      };
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(status);
      return () => {
        statusListeners.delete(listener);
      };
    },
    call: async <T>(call: string, args: unknown = {}): Promise<T> => {
      return rpc<T>("call", { call, args });
    },
    spawnProcess: async (args: ProcSpawnArgs): Promise<ProcSpawnResult> => {
      return rpc<ProcSpawnResult>("spawnProcess", args);
    },
    sendMessage: async (message: string, pid?: string): Promise<ProcSendResult> => {
      return rpc<ProcSendResult>("sendMessage", { message, pid });
    },
    getHistory: async (limit = 50, pid?: string, offset?: number): Promise<ProcHistoryResult> => {
      return rpc<ProcHistoryResult>("getHistory", { limit, pid, offset });
    },
  };
}
