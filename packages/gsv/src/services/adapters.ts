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
import type { BinaryBody } from "../protocol/body";
import * as z from "zod/mini";

export const ADAPTER_SERVICE_VERSION = 1;

export const adapterServiceCapabilitiesSchema = z.strictObject({
  connect: z.boolean(),
  disconnect: z.boolean(),
  send: z.boolean(),
  status: z.boolean(),
  activity: z.boolean(),
  pairing: z.boolean(),
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
}
