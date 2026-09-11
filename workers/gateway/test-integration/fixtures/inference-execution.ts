import { WorkerEntrypoint } from "cloudflare:workers";
import { InferenceExecutor as SharedInferenceExecutor, getInferenceExecutor, resolveInferenceModel, type InferenceServiceEnvironment } from "@humansandmachines/gsv-inference/executor";
import { createGsvInferenceProviderFactory, GSV_INFERENCE_MODEL_METADATA } from "@humansandmachines/gsv-inference/text/gsv-provider";
import type { InferenceService as FundedInferenceService } from "@humansandmachines/gsv/services/inference";
import type { InferenceExecutionService, InferenceExecutor as ExecutorContract, InferenceModelMetadata } from "@humansandmachines/gsv/services/inference-execution";

type ExecutionEnvironment = InferenceServiceEnvironment & { FUNDED_INFERENCE: FundedInferenceService };

/** Exercise the real executor and provider transport against deterministic provider fixtures. */
export class InferenceExecutor extends SharedInferenceExecutor<ExecutionEnvironment> {
  protected providerFactories() { return [createGsvInferenceProviderFactory(this.env.FUNDED_INFERENCE)]; }
}

export default class ExecutionService extends WorkerEntrypoint<ExecutionEnvironment> implements InferenceExecutionService {
  getExecutor(installationId: string): Promise<ExecutorContract> { return getInferenceExecutor(this.env, installationId); }
  async resolveModel(provider: string, model: string): Promise<InferenceModelMetadata> {
    if (provider === "gsv" && model === "default") return { provider, model, contextWindowTokens: GSV_INFERENCE_MODEL_METADATA.contextWindow };
    return resolveInferenceModel(this.env, provider, model);
  }
}
