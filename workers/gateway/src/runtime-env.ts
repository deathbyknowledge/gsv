import type { ManagedOutboundMailCommand } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { InferenceService } from "@humansandmachines/gsv/services/inference";
import type { InferenceExecutionService } from "@humansandmachines/gsv/services/inference-execution";
import type { InstallationOwnershipService } from "@humansandmachines/gsv/services/ownership";
import type { InstallationOnboardingService } from "@humansandmachines/gsv/services/onboarding";
import type { TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";

/**
 * Wrangler generates `Env` from the standalone Gateway configuration. Managed
 * deployments add these optional bindings through the deployment runtime.
 */
type GatewayDeploymentBindings = TelemetryEnvironment & {
  INSTALLATION_DIRECTORY?: InstallationDirectoryService & InstallationOnboardingService;
  INSTALLATION_OWNERSHIP?: InstallationOwnershipService;
  INFERENCE_EXECUTION?: InferenceExecutionService;
  MANAGED_INFERENCE?: InferenceService;
  MANAGED_INFERENCE_INSTALLATIONS?: DurableObjectNamespace;
  MANAGED_MAIL_OUTBOUND?: Queue<ManagedOutboundMailCommand>;
  GSV_CANONICAL_ORIGIN?: string;
};

export type GatewayEnv = Omit<Env, "AI"> & GatewayDeploymentBindings;
