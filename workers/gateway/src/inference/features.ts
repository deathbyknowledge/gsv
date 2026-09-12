import { GSV_INFERENCE_FEATURE } from "@humansandmachines/gsv/services/inference";
import type { GatewayEnv } from "../runtime-env";

export function gsvInferenceFeaturesFromEnv(env: GatewayEnv): string[] {
  // Standalone also delegates execution, while retaining its native model stack.
  return (env.INSTALLATION_DIRECTORY && env.INFERENCE_EXECUTION) || env.MANAGED_INFERENCE || env.MANAGED_INFERENCE_INSTALLATIONS
    ? [GSV_INFERENCE_FEATURE]
    : [];
}

export function isWorkersAiProvider(provider: string): boolean {
  return ["workers-ai", "workersai", "cloudflare-workers-ai"].includes(provider.trim().toLowerCase());
}
