import type { Frame } from "./protocol/frames";
import type {
  AdapterGatewayInterface,
  AdapterPairingWorkerInterface,
  AdapterWorkerInterface,
} from "@humansandmachines/gsv/protocol";
import {
  adapterServiceDescriptorSchema,
  type AdapterService,
  type AdapterServiceDescriptor,
} from "@humansandmachines/gsv/services/adapters";
export type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterActor,
  AdapterConnectChallenge,
  AdapterInstallationContext,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterPeerDeliveryContext,
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterSurface,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";

export type GatewayAdapterInterface = AdapterGatewayInterface<Frame>;
export type { AdapterService, AdapterServiceDescriptor, AdapterWorkerInterface };
export type { AdapterPairingWorkerInterface };

/** Select the frame carrier from authoritative discovery, not RPC property probes. */
export async function adapterServiceSupportsDeliveryFrames(
  adapter: string,
  service: Pick<Partial<AdapterService>, "adapterDescribe">,
): Promise<boolean> {
  try {
    if (!service.adapterDescribe) return false;
    const descriptor = adapterServiceDescriptorSchema.safeParse(
      await service.adapterDescribe(),
    );
    return descriptor.success
      && descriptor.data.id === adapter.trim().toLowerCase()
      && descriptor.data.capabilities.deliveryFrames === true;
  } catch {
    return false;
  }
}
