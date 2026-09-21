import type { ManagedOutboundMailCommand } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { InferenceExecutionService } from "@humansandmachines/gsv/services/inference-execution";
import type { InstallationOwnershipService } from "@humansandmachines/gsv/services/ownership";
import type { InstallationOnboardingService } from "@humansandmachines/gsv/services/onboarding";
import type { TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";

/**
 * Deployment service contracts augment the generated platform bindings.
 */
type GatewayDeploymentBindings = TelemetryEnvironment & {
  GSV_FEDERATION_LOCAL_DEVELOPMENT?: "1";
  INSTALLATION_DIRECTORY: InstallationDirectoryService & InstallationOnboardingService;
  INSTALLATION_OWNERSHIP?: InstallationOwnershipService;
  INFERENCE_EXECUTION: InferenceExecutionService;
  MANAGED_INFERENCE_INSTALLATIONS?: DurableObjectNamespace;
  MANAGED_MAIL_OUTBOUND?: Queue<ManagedOutboundMailCommand>;
};

export type GatewayEnv = Omit<Env, "INFERENCE_EXECUTION"> & GatewayDeploymentBindings;
