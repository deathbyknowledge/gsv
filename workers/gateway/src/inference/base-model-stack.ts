import type { AiModelEntry } from "@humansandmachines/gsv/protocol";
import {
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PROVIDER,
} from "@humansandmachines/gsv/services/inference";
import type { GatewayEnv } from "../runtime-env";
import {
  DEFAULT_TEXT_GENERATION_MAX_TOKENS,
  DEFAULT_WORKERS_AI_FALLBACK_MODEL,
  DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
  DEFAULT_WORKERS_AI_FALLBACK_PROFILE_NAME,
  DEFAULT_WORKERS_AI_MODEL,
} from "./default-models";
import { gsvInferenceFeaturesFromEnv } from "./gsv-provider";

export const GSV_INCLUDED_MODEL_ID = "gsv-included";
export const WORKERS_AI_PRIMARY_MODEL_ID = "workers-ai-glm-5-3-flash";

/**
 * The model stack every deployment supplies without anyone configuring it.
 * Managed installations get GSV Included; self-hosted ones get the Workers AI
 * pair. Owner and system lists extend this stack; nothing replaces it.
 */
export function baseAiModelStack(env: GatewayEnv): AiModelEntry[] {
  if (gsvInferenceFeaturesFromEnv(env).includes(GSV_INFERENCE_FEATURE)) {
    return [{
      id: GSV_INCLUDED_MODEL_ID,
      name: "GSV Included",
      provider: GSV_INFERENCE_PROVIDER,
      model: GSV_INFERENCE_MODEL,
      maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    }];
  }
  return [
    {
      id: WORKERS_AI_PRIMARY_MODEL_ID,
      name: "GLM 5.3 Flash",
      provider: "workers-ai",
      model: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    },
    {
      id: DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
      name: DEFAULT_WORKERS_AI_FALLBACK_PROFILE_NAME,
      provider: "workers-ai",
      model: DEFAULT_WORKERS_AI_FALLBACK_MODEL,
      maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    },
  ];
}
