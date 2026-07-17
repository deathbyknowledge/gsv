import type { Frame } from "./protocol/frames";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterConnectChallenge,
  AdapterOutboundMessage,
  AdapterSurface,
  BinaryBody,
} from "@humansandmachines/gsv/protocol";

export type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterActor,
  AdapterConnectChallenge,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSurface,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";

export type AdapterConnectResult =
  | {
      ok: true;
      message?: string;
      connected?: boolean;
      authenticated?: boolean;
      challenge?: AdapterConnectChallenge;
    }
  | {
      ok: false;
      error: string;
      challenge?: AdapterConnectChallenge;
    };

export type AdapterDisconnectResult =
  | {
      ok: true;
      message?: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface GatewayAdapterInterface {
  serviceFrame(frame: Frame): Promise<Frame | null>;
}

export interface AdapterWorkerInterface {
  readonly adapterId: string;

  // DONT RENAME TO connect() because Cloudflare service bindings already expose
  // a built-in socket connect() method. If gateway calls service.connect(...),
  // workerd resolves the socket API instead of our RPC entrypoint and throws
  // "Specified address is missing port" before the request reaches the channel worker.
  adapterConnect(accountId: string, config?: Record<string, unknown>): Promise<AdapterConnectResult>;
  adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult>;
  adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<
    | { ok: true; messageId?: string; deduplicated?: boolean }
    | { ok: false; error: string; retryable?: boolean; ambiguous?: boolean }
  >;
  adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]>;
}
