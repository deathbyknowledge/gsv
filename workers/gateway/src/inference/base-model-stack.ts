import type { AiModelEntry } from "@humansandmachines/gsv/protocol";
import {
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PROVIDER,
} from "@humansandmachines/gsv/services/inference";
import { DEFAULT_TEXT_GENERATION_MAX_TOKENS } from "./default-models";

export const GSV_INCLUDED_MODEL_ID = "gsv-included";

/**
 * The model stack every deployment supplies without anyone configuring it.
 * The operator's inference service resolves the default provider. Owner and
 * system lists extend this stack; nothing replaces it.
 */
export function baseAiModelStack(): AiModelEntry[] {
  return [{
    id: GSV_INCLUDED_MODEL_ID,
    name: "GSV Included",
    provider: GSV_INFERENCE_PROVIDER,
    model: GSV_INFERENCE_MODEL,
    maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
  }];
}
