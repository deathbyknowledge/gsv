import type { GatewayClient, GatewayClientStatus, ProcHistoryResult, ProcSendResult } from "../gateway-client";
import type { AppManifest } from "./manifest";

export type AppKernelClient = {
  isConnected: () => boolean;
  getStatus: () => GatewayClientStatus;
  onStatus: (listener: (status: GatewayClientStatus) => void) => () => void;
  onSignal: (listener: (signal: string, payload: unknown) => void) => () => void;
  request: <T = unknown>(syscall: string, args?: unknown) => Promise<T>;
  sendMessage: (message: string, pid?: string) => Promise<ProcSendResult>;
  getHistory: (limit?: number, pid?: string, offset?: number) => Promise<ProcHistoryResult>;
  allowedSyscalls: readonly string[];
};

function hasPermission(permissions: readonly string[], syscall: string): boolean {
  if (permissions.includes("*")) {
    return true;
  }

  const domain = syscall.split(".")[0] ?? "";
  for (const permission of permissions) {
    if (permission === syscall) {
      return true;
    }
    if (permission === `${domain}.*`) {
      return true;
    }
  }

  return false;
}

function assertAllowed(manifest: AppManifest, syscall: string): void {
  if (!hasPermission(manifest.syscalls, syscall)) {
    throw new Error(`App "${manifest.id}" is not allowed to call ${syscall}`);
  }
}

export function createScopedKernelClient(
  gatewayClient: GatewayClient,
  manifest: AppManifest,
): AppKernelClient {
  return {
    isConnected: () => gatewayClient.isConnected(),
    getStatus: () => gatewayClient.getStatus(),
    onStatus: (listener) => gatewayClient.onStatus(listener),
    onSignal: (listener) => gatewayClient.onSignal(listener),
    request: async <T>(syscall: string, args: unknown = {}): Promise<T> => {
      assertAllowed(manifest, syscall);
      return gatewayClient.call<T>(syscall, args);
    },
    sendMessage: async (message: string, pid?: string): Promise<ProcSendResult> => {
      assertAllowed(manifest, "proc.send");
      return gatewayClient.sendMessage(message, pid);
    },
    getHistory: async (limit = 50, pid?: string, offset?: number): Promise<ProcHistoryResult> => {
      assertAllowed(manifest, "proc.history");
      return gatewayClient.getHistory(limit, pid, offset);
    },
    allowedSyscalls: manifest.syscalls,
  };
}
