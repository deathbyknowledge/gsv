import type {
  SysSetupAssistArgs,
  SysSetupAssistResult,
  SysBootstrapArgs,
  SysBootstrapResult,
  SysSetupArgs,
  SysSetupResult,
} from "@gsv/protocol/syscalls/system";
import type { ProcMediaInput } from "@gsv/protocol/syscalls/proc";
import {
  GatewayRpcClient,
  type GatewayClientStatus,
  type GatewayConnectOptions,
  type GatewayConnectResult,
  type GatewayRpcClientOptions,
} from "./gatewayRpcClient";

export type {
  GatewayClientStatus,
  GatewayConnectOptions,
  GatewayConnectResult,
  GatewayRpcClientOptions,
} from "./gatewayRpcClient";

export type UserSessionToken = {
  tokenId: string;
  token: string;
  expiresAt: number | null;
};

export type ProcSendResult =
  | { ok: true; status: "started"; runId: string; queued?: boolean }
  | { ok: false; error: string };

export type ProcSpawnArgs = {
  /** Account to run as: username, uid, or `package#agent`. Defaults to the caller's personal agent. */
  runAs?: string;
  label?: string;
  prompt?: string;
  parentPid?: string;
  cwd?: string;
};

export type ProcSpawnResult =
  | {
      ok: true;
      pid: string;
      label?: string;
      cwd: string;
    }
  | { ok: false; error: string };

export type ProcHistoryResult =
  | {
      ok: true;
      pid: string;
      messages: Array<{
        role: "user" | "assistant" | "system" | "toolResult";
        content: unknown;
        timestamp?: number;
      }>;
      messageCount: number;
      truncated?: boolean;
    }
  | { ok: false; error: string };

export type GatewayClientLike = {
  getStatus: () => GatewayClientStatus;
  isConnected: () => boolean;
  onSignal: (listener: (signal: string, payload: unknown) => void) => () => void;
  onStatus: (listener: (status: GatewayClientStatus) => void) => () => void;
  call: <T = unknown>(call: string, args?: unknown) => Promise<T>;
  spawnProcess: (args: ProcSpawnArgs) => Promise<ProcSpawnResult>;
  sendMessage: (message: string, pid?: string, media?: ProcMediaInput[]) => Promise<ProcSendResult>;
  getHistory: (limit?: number, pid?: string, offset?: number) => Promise<ProcHistoryResult>;
  probeSetupMode: (url: string) => Promise<boolean>;
  setupSystem: (url: string, args: SysSetupArgs) => Promise<SysSetupResult>;
  bootstrapSystem: (args?: SysBootstrapArgs) => Promise<SysBootstrapResult>;
};

export class GatewayClient extends GatewayRpcClient implements GatewayClientLike {
  async sendMessage(message: string, pid?: string, media?: ProcMediaInput[]): Promise<ProcSendResult> {
    const result = (await this.call("proc.send", {
      message,
      ...(pid ? { pid } : {}),
      ...(media && media.length > 0 ? { media } : {}),
    })) as ProcSendResult;
    return result;
  }

  async spawnProcess(args: ProcSpawnArgs): Promise<ProcSpawnResult> {
    const result = (await this.call("proc.spawn", args)) as ProcSpawnResult;
    return result;
  }

  async getHistory(limit = 50, pid?: string, offset?: number): Promise<ProcHistoryResult> {
    const result = (await this.call("proc.history", {
      limit,
      ...(typeof offset === "number" ? { offset } : {}),
      ...(pid ? { pid } : {}),
    })) as ProcHistoryResult;
    return result;
  }

  async createUserSessionToken(expiresAt: number): Promise<UserSessionToken> {
    const raw = (await this.call("sys.token.create", {
      kind: "user",
      label: "gsv-ui-session",
      allowedRole: "user",
      expiresAt,
    })) as {
      token?: {
        tokenId?: unknown;
        token?: unknown;
        expiresAt?: unknown;
      };
    };

    const tokenId = raw.token?.tokenId;
    const token = raw.token?.token;
    const rawExpiresAt = raw.token?.expiresAt;

    if (typeof tokenId !== "string" || typeof token !== "string") {
      throw new Error("sys.token.create returned invalid token payload");
    }

    return {
      tokenId,
      token,
      expiresAt: typeof rawExpiresAt === "number" ? rawExpiresAt : null,
    };
  }

  async revokeToken(tokenId: string, reason = "ui session lock"): Promise<boolean> {
    const raw = (await this.call("sys.token.revoke", {
      tokenId,
      reason,
    })) as { revoked?: unknown };

    return raw.revoked === true;
  }

  async probeSetupMode(url: string): Promise<boolean> {
    try {
      await this.callWithoutConnect(url, "sys.connect", {
        protocol: 1,
        client: {
          id: "gsv-ui-setup-probe",
          version: "0.2.6",
          platform: "browser",
          role: "user",
        },
      });
      return false;
    } catch (error) {
      const rpcError = error as Error & { code?: number; details?: unknown };
      if (rpcError.code === 425) {
        return true;
      }
      if (
        rpcError.details &&
        typeof rpcError.details === "object" &&
        (rpcError.details as { setupMode?: unknown }).setupMode === true
      ) {
        return true;
      }
      return false;
    }
  }

  async setupSystem(url: string, args: SysSetupArgs): Promise<SysSetupResult> {
    return await this.callWithoutConnect<SysSetupResult>(url, "sys.setup", args);
  }

  async setupAssist(url: string, args: SysSetupAssistArgs): Promise<SysSetupAssistResult> {
    return await this.callWithoutConnect<SysSetupAssistResult>(url, "sys.setup.assist", args);
  }

  async bootstrapSystem(args: SysBootstrapArgs = {}): Promise<SysBootstrapResult> {
    return await this.call<SysBootstrapResult>("sys.bootstrap", args);
  }
}

export function createGatewayClient(options?: GatewayRpcClientOptions): GatewayClient {
  return new GatewayClient(options);
}
