import type {
  SysSetupAssistArgs,
  SysSetupAssistResult,
  SysBootstrapArgs,
  SysBootstrapResult,
  SysSetupArgs,
  SysSetupResult,
} from "@humansandmachines/gsv/protocol";
import type {
  GsvAccountNamespace,
  GsvClientCall,
  GsvFsNamespace,
  GsvPkgNamespace,
  GsvProcNamespace,
} from "@humansandmachines/gsv/client";
import { createGsvClient } from "@humansandmachines/gsv/client";
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
export type {
  ProcHistoryResult,
  ProcMediaInput,
  ProcSendResult,
  ProcSpawnArgs,
  ProcSpawnResult,
} from "@humansandmachines/gsv/protocol";

export type UserSessionToken = {
  tokenId: string;
  token: string;
  expiresAt: number | null;
};

export type GatewayAccountNamespace = GsvAccountNamespace;
export type GatewayFsNamespace = GsvFsNamespace;
export type GatewayPkgNamespace = GsvPkgNamespace;
export type GatewayProcNamespace = GsvProcNamespace;

export type GatewayClientLike = {
  getStatus: () => GatewayClientStatus;
  isConnected: () => boolean;
  onSignal: (listener: (signal: string, payload: unknown) => void) => () => void;
  onStatus: (listener: (status: GatewayClientStatus) => void) => () => void;
  call: GsvClientCall;
  account: GatewayAccountNamespace;
  fs: GatewayFsNamespace;
  pkg: GatewayPkgNamespace;
  proc: GatewayProcNamespace;
  probeSetupMode: (url: string) => Promise<boolean>;
  setupSystem: (url: string, args: SysSetupArgs) => Promise<SysSetupResult>;
  bootstrapSystem: (args?: SysBootstrapArgs) => Promise<SysBootstrapResult>;
};

export class GatewayClient extends GatewayRpcClient implements GatewayClientLike {
  private readonly gsvClient = createGsvClient(this);
  readonly account: GatewayAccountNamespace = this.gsvClient.account;
  readonly fs: GatewayFsNamespace = this.gsvClient.fs;
  readonly pkg: GatewayPkgNamespace = this.gsvClient.pkg;
  readonly proc: GatewayProcNamespace = this.gsvClient.proc;

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
    return await this.callWithoutConnect(url, "sys.setup", args);
  }

  async setupAssist(url: string, args: SysSetupAssistArgs): Promise<SysSetupAssistResult> {
    return await this.callWithoutConnect(url, "sys.setup.assist", args);
  }

  async bootstrapSystem(args: SysBootstrapArgs = {}): Promise<SysBootstrapResult> {
    return await this.call("sys.bootstrap", args);
  }
}

export function createGatewayClient(options?: GatewayRpcClientOptions): GatewayClient {
  return new GatewayClient(options);
}
