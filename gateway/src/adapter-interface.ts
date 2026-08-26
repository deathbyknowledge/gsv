import type { Frame } from "./protocol/frames";
import type {
  AdapterGatewayInterface,
  AdapterPairingWorkerInterface,
  AdapterWorkerInterface,
} from "@humansandmachines/gsv/protocol";
import type {
  AdapterService,
  AdapterServiceDescriptor,
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
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterSurface,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";

export type GatewayAdapterInterface = AdapterGatewayInterface<Frame>;
export type { AdapterService, AdapterServiceDescriptor, AdapterWorkerInterface };
export type { AdapterPairingWorkerInterface };
