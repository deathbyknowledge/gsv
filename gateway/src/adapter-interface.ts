import type { Frame } from "./protocol/frames";
import type {
  AdapterGatewayInterface,
  AdapterWorkerInterface,
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

export type GatewayAdapterInterface = AdapterGatewayInterface<Frame>;
export type { AdapterWorkerInterface };
