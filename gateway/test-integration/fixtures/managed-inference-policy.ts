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
    };
  }

  async recordManagedInferenceUsage(
    _events: ManagedInferenceUsageEvent[],
  ): Promise<void> {}
}
