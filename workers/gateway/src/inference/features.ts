import { GSV_INFERENCE_FEATURE } from "@humansandmachines/gsv/services/inference";
import type { GatewayEnv } from "../runtime-env";

export function gsvInferenceFeaturesFromEnv(env: GatewayEnv): string[] {
  return env.INFERENCE_EXECUTION
    ? [GSV_INFERENCE_FEATURE]
    : [];
}

export function isWorkersAiProvider(provider: string): boolean {
  return ["workers-ai", "workersai", "cloudflare-workers-ai"].includes(provider.trim().toLowerCase());
}
