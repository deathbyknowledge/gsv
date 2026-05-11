import type {
  GatewayClientLike,
  GatewayClientStatus,
  ProcHistoryResult,
  ProcSendResult,
  ProcSpawnArgs,
  ProcSpawnResult,
} from "./gateway-client";

type HostRpcMethod =
  | "call"
  | "spawnProcess"
  | "sendMessage"
  | "getHistory"
  | "setTitle"
  | "setBadge"
  | "setDirty"
  | "requestNewWindow";

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
  requestId?: string;
};

type HostPortMessage = HostRpcMessage | HostRpcResultMessage | HostStatusMessage | HostSignalMessage;

export type HostBridgeController = {
  destroy: () => void;
};

type HostChromeController = {
  setTitle: (title: string | null) => void;
  setBadge: (badge: string | null) => void;
  setDirty: (dirty: boolean) => void;
  requestNewWindow: (route?: string) => string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postMessage(port: MessagePort, message: HostPortMessage): void {
  port.postMessage(message);
}

async function handleRpc(
  gatewayClient: GatewayClientLike,
  chrome: HostChromeController | null,
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
      const media = Array.isArray(payload?.media) ? payload.media : undefined;
      return gatewayClient.sendMessage(text, pid, media as Parameters<GatewayClientLike["sendMessage"]>[2]);
    }
    case "getHistory": {
      const payload = asRecord(message.payload);
      const limit = typeof payload?.limit === "number" ? payload.limit : 50;
      const pid = asString(payload?.pid) ?? undefined;
      const offset = typeof payload?.offset === "number" ? payload.offset : undefined;
      return gatewayClient.getHistory(limit, pid, offset);
    }
    case "setTitle": {
      const payload = asRecord(message.payload);
      chrome?.setTitle(asString(payload?.title));
      return { ok: true };
    }
    case "setBadge": {
      const payload = asRecord(message.payload);
      chrome?.setBadge(asString(payload?.badge));
      return { ok: true };
    }
    case "setDirty": {
      const payload = asRecord(message.payload);
      chrome?.setDirty(asBoolean(payload?.dirty));
      return { ok: true };
    }
    case "requestNewWindow": {
      const payload = asRecord(message.payload);
      const route = asString(payload?.route) ?? undefined;
      return { windowId: chrome?.requestNewWindow(route) ?? null };
    }
  }
}

export function attachHostBridge(
  iframe: HTMLIFrameElement,
  gatewayClient: GatewayClientLike,
  chrome: HostChromeController | null = null,
): HostBridgeController {
  let port: MessagePort | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  let unsubscribeSignal: (() => void) | null = null;
  let iframeLoaded = false;
  let pendingConnectRequestId: string | undefined;
  let destroyed = false;

  const cleanup = (): void => {
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    unsubscribeSignal?.();
    unsubscribeSignal = null;
    port?.close();
    port = null;
  };

  const connect = (requestId?: string): void => {
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

      void handleRpc(gatewayClient, chrome, message as HostRpcMessage)
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
        requestId,
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

  const onLoad = (): void => {
    iframeLoaded = true;
    connect(pendingConnectRequestId);
    pendingConnectRequestId = undefined;
  };

  const onConnectRequest = (event: MessageEvent<unknown>): void => {
    if (destroyed || event.origin !== window.location.origin || event.source !== iframe.contentWindow) {
      return;
    }
    const record = asRecord(event.data);
    if (!record || record.type !== "gsv-host-connect-request") {
      return;
    }
    const requestId = asString(record.requestId) ?? undefined;
    if (!iframeLoaded) {
      pendingConnectRequestId = requestId;
      return;
    }
    connect(requestId);
  };

  iframe.addEventListener("load", onLoad, { once: true });
  window.addEventListener("message", onConnectRequest);

  return {
    destroy: () => {
      destroyed = true;
      iframe.removeEventListener("load", onLoad);
      window.removeEventListener("message", onConnectRequest);
      cleanup();
    },
  };
}
