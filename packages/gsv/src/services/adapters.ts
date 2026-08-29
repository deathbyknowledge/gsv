import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterConnectConfig,
  AdapterInstallationContext,
  AdapterMediaType,
  AdapterOutboundMessage,
  AdapterPairingWorkerInterface,
  AdapterSurfaceKind,
  AdapterSurface,
  AdapterWorkerActivityResult,
  AdapterWorkerConnectResult,
  AdapterWorkerDisconnectResult,
  AdapterWorkerInterface,
  AdapterWorkerSendResult,
} from "../protocol/adapters";
import type { ArgsOf, ResultOf, SyscallName } from "../protocol/syscalls/map";
import { binaryBodySchema, type BinaryBody } from "../protocol/body";
import { jsonValueSchema, type JsonValue } from "../protocol/json";
import * as z from "zod/mini";

export const ADAPTER_SERVICE_VERSION = 1;

export const adapterServiceCapabilitiesSchema = z.strictObject({
  connect: z.boolean(),
  disconnect: z.boolean(),
  send: z.boolean(),
  status: z.boolean(),
  activity: z.boolean(),
  pairing: z.boolean(),
  targets: z.optional(z.boolean()),
  surfaces: z.array(z.enum(["dm", "group", "channel", "thread"])),
  media: z.strictObject({
    inbound: z.array(z.enum(["image", "audio", "video", "document"])),
    outbound: z.array(z.enum(["image", "audio", "video", "document"])),
  }),
});

export type AdapterServiceCapabilities = {
  connect: boolean;
  disconnect: boolean;
  send: boolean;
  status: boolean;
  activity: boolean;
  pairing: boolean;
  targets?: boolean;
  surfaces: AdapterSurfaceKind[];
  media: {
    inbound: AdapterMediaType[];
    outbound: AdapterMediaType[];
  };
};

export const adapterServiceDescriptorSchema = z.strictObject({
  version: z.literal(ADAPTER_SERVICE_VERSION),
  id: z.string().check(
    z.minLength(1),
    z.maxLength(64),
    z.regex(/^[a-z][a-z0-9-]*$/),
  ),
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  capabilities: adapterServiceCapabilitiesSchema,
});

export type AdapterServiceDescriptor = {
  version: typeof ADAPTER_SERVICE_VERSION;
  id: string;
  displayName: string;
  capabilities: AdapterServiceCapabilities;
};

export const adapterTargetIdentitySchema = z.strictObject({
  accountId: z.string().check(z.minLength(1), z.maxLength(512)),
  actorId: z.string().check(z.minLength(1), z.maxLength(512)),
  routeGeneration: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
});

export type AdapterTargetIdentity = {
  accountId: string;
  actorId: string;
  routeGeneration?: string;
};

export const adapterTargetDescriptorSchema = z.strictObject({
  id: z.string().check(
    z.minLength(1),
    z.maxLength(64),
    z.regex(/^[a-z][a-z0-9-]*$/),
  ),
  label: z.string().check(z.minLength(1), z.maxLength(160)),
  description: z.string().check(z.maxLength(1_024)),
  platform: z.string().check(z.minLength(1), z.maxLength(80)),
  version: z.string().check(z.maxLength(80)),
  implements: z.array(
    z.string().check(z.minLength(1), z.maxLength(128)),
  ).check(z.maxLength(64)),
});

export const adapterTargetDescriptorListSchema = z.array(
  adapterTargetDescriptorSchema,
).check(z.maxLength(64));

export type AdapterTargetDescriptor = {
  /** Stable identifier inside this adapter account and linked actor. */
  id: string;
  label: string;
  description: string;
  platform: string;
  version: string;
  implements: string[];
};

export type AdapterTargetRequestFrame<S extends SyscallName = SyscallName> = {
  [K in S]: {
    type: "req";
    id: string;
    call: K;
    args: ArgsOf<K>;
    deadlineAt: number;
    body?: BinaryBody;
  };
}[S];

export type AdapterTargetResponseFrame<S extends SyscallName = SyscallName> =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: ResultOf<S>;
      body?: BinaryBody;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: {
        code: number;
        message: string;
        details?: JsonValue;
        retryable?: boolean;
      };
    };

export const adapterTargetResponseFrameSchema = z.union([
  z.strictObject({
    type: z.literal("res"),
    id: z.string().check(z.minLength(1), z.maxLength(512)),
    ok: z.literal(true),
    data: z.optional(jsonValueSchema),
    body: z.optional(binaryBodySchema),
  }),
  z.strictObject({
    type: z.literal("res"),
    id: z.string().check(z.minLength(1), z.maxLength(512)),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.number().check(z.int()),
      message: z.string().check(z.minLength(1), z.maxLength(4_096)),
      details: z.optional(jsonValueSchema),
      retryable: z.optional(z.boolean()),
    }),
  }),
]);

export const adapterTargetCancelResultSchema = z.strictObject({
  cancelled: z.boolean(),
});

export type AdapterTargetCancelResult = {
  cancelled: boolean;
};

/**
 * Service-binding contract implemented by an adapter Worker.
 *
 * Operations are optional because an adapter may be transport-only, managed by
 * the platform, or intentionally omit interactive provisioning. The descriptor
 * is authoritative for discovery; the Gateway still authorizes the adapter by
 * its trusted binding identity.
 */
export interface AdapterService {
  readonly adapterId: string;
  adapterDescribe(): Promise<AdapterServiceDescriptor>;
  adapterConnect?: AdapterWorkerInterface["adapterConnect"] | ((
    installation: AdapterInstallationContext,
    accountId: string,
    config?: AdapterConnectConfig,
  ) => Promise<AdapterWorkerConnectResult>);
  adapterDisconnect?: AdapterWorkerInterface["adapterDisconnect"] | ((
    installation: AdapterInstallationContext,
    accountId: string,
  ) => Promise<AdapterWorkerDisconnectResult>);
  adapterSend?: AdapterWorkerInterface["adapterSend"] | ((
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ) => Promise<AdapterWorkerSendResult>);
  adapterSetActivity?: AdapterWorkerInterface["adapterSetActivity"] | ((
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ) => Promise<AdapterWorkerActivityResult>);
  adapterStatus?: AdapterWorkerInterface["adapterStatus"] | ((
    installation: AdapterInstallationContext,
    accountId?: string,
  ) => Promise<AdapterAccountStatus[]>);
  adapterPairingInfo?: AdapterPairingWorkerInterface["adapterPairingInfo"];
  adapterPairingInspect?: AdapterPairingWorkerInterface["adapterPairingInspect"];
  adapterPairingPrepare?: AdapterPairingWorkerInterface["adapterPairingPrepare"];
  adapterPairingActivate?: AdapterPairingWorkerInterface["adapterPairingActivate"];
  adapterPairingFinalize?: AdapterPairingWorkerInterface["adapterPairingFinalize"];
  adapterPairingDisconnect?: AdapterPairingWorkerInterface["adapterPairingDisconnect"];
  adapterTargetList?: (
    installation: AdapterInstallationContext,
    identity: AdapterTargetIdentity,
  ) => Promise<AdapterTargetDescriptor[]>;
  adapterTargetExecute?: (
    installation: AdapterInstallationContext,
    identity: AdapterTargetIdentity,
    targetId: string,
    frame: AdapterTargetRequestFrame,
  ) => Promise<AdapterTargetResponseFrame>;
  adapterTargetCancel?: (
    installation: AdapterInstallationContext,
    identity: AdapterTargetIdentity,
    targetId: string,
    requestId: string,
  ) => Promise<AdapterTargetCancelResult>;
}
