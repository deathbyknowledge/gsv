import type { ManagedOutboundMailCommand } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { InferenceExecutionService } from "@humansandmachines/gsv/services/inference-execution";
import type { InstallationOwnershipService } from "@humansandmachines/gsv/services/ownership";
import type { InstallationOnboardingService } from "@humansandmachines/gsv/services/onboarding";
import type { TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";
import type { WebSearchService } from "@humansandmachines/gsv/services/web-search";
import type { FeedbackService } from "@humansandmachines/gsv/services/feedback";
import type { InstancesService } from "@humansandmachines/gsv/services/instances";
import type { PdsService } from "@humansandmachines/gsv/services/pds";

/**
 * Deployment service contracts augment the generated platform bindings.
 */
type GatewayDeploymentBindings = TelemetryEnvironment & {
  GSV_FEDERATION_LOCAL_DEVELOPMENT?: "1";
  GSV_OWNER_SIGNUP_URL?: string;
  GSV_PUBLIC_CONFIG?: string;
  GSV_OPERATOR_UPDATES?: string;
  INSTALLATION_DIRECTORY: InstallationDirectoryService & InstallationOnboardingService;
  INSTALLATION_OWNERSHIP?: InstallationOwnershipService;
  INFERENCE_EXECUTION: InferenceExecutionService;
  MANAGED_INFERENCE_INSTALLATIONS?: DurableObjectNamespace;
  MANAGED_MAIL_OUTBOUND?: Queue<ManagedOutboundMailCommand>;
  WEB_SEARCH?: WebSearchService;
  FEEDBACK?: FeedbackService;
  INSTANCES?: InstancesService;
  PDS?: PdsService;
  /** The did:plc directory other Ships' identities are read from; plc.directory unless the operator names another. */
  PLC_URL?: string;
};

export type GatewayEnv = Omit<Env, "INFERENCE_EXECUTION"> & GatewayDeploymentBindings;
