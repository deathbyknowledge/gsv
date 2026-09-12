import { WorkerEntrypoint } from "cloudflare:workers";
import { InferenceExecutor, getInferenceExecutor, resolveInferenceModel, type InferenceServiceEnvironment } from "@humansandmachines/gsv-inference/executor";
import type { InferenceExecutionService, InferenceExecutor as ExecutorContract, InferenceModelMetadata } from "@humansandmachines/gsv/services/inference-execution";

export { InferenceExecutor };

/** Provider execution is available only through the trusted gateway binding. */
export default class InferenceService extends WorkerEntrypoint<InferenceServiceEnvironment> implements InferenceExecutionService {
  async fetch(): Promise<Response> { return new Response("Not Found", { status: 404 }); }
  async getExecutor(installationId: string): Promise<ExecutorContract> { return getInferenceExecutor(this.env, installationId); }
  async resolveModel(provider: string, model: string): Promise<InferenceModelMetadata> { return resolveInferenceModel(this.env, provider, model); }
}

export { InferenceLifecycleEntrypoint } from "./lifecycle";
export { StandaloneInferenceDirectoryEntrypoint } from "./standalone-directory";
