import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ManagedInferencePolicy,
  ManagedInferenceUsageEvent,
} from "@humansandmachines/gsv/protocol";

export default class ManagedInferencePolicyFixture extends WorkerEntrypoint {
  async getManagedInferencePolicy(
    installationId: string,
  ): Promise<ManagedInferencePolicy> {
    return {
      version: 1,
      installationId,
      enabled: true,
      monthlyLimitNanoUsd: Number.MAX_SAFE_INTEGER,
      routing: {
        version: 2,
        models: [{
          modelId: "deepseek/deepseek-v4-flash-0731",
          displayName: "DeepSeek: DeepSeek V4 Flash 0731",
          contextWindow: 1_048_576,
          maxOutputTokens: 384_000,
          reasoning: true,
          inputNanoUsdPerToken: 80,
          outputNanoUsdPerToken: 180,
          cacheReadNanoUsdPerToken: 16,
          cacheWriteNanoUsdPerToken: 0,
        }],
        updatedAt: 0,
      },
    };
  }

  async recordManagedInferenceUsage(
    _events: ManagedInferenceUsageEvent[],
  ): Promise<void> {}
}
