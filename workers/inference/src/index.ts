import { WorkerEntrypoint } from "cloudflare:workers";
import { InferenceExecutor, getInferenceExecutor, resolveInferenceModel, type InferenceServiceEnvironment } from "@humansandmachines/gsv-inference/executor";
import type { InferenceExecutionService, InferenceExecutor as ExecutorContract, InferenceModelMetadata } from "@humansandmachines/gsv/services/inference-execution";
import { emitTelemetry, inferenceModelLookupSchema, type InferenceModelLookup, type TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";

export { InferenceExecutor };

/** Provider execution is available only through the trusted gateway binding. */
export class InferenceService extends WorkerEntrypoint<InferenceServiceEnvironment & TelemetryEnvironment> implements InferenceExecutionService {
  async fetch(): Promise<Response> { return new Response("Not Found", { status: 404 }); }
  async getExecutor(installationId: string): Promise<ExecutorContract> { return getInferenceExecutor(this.env, installationId); }
  async resolveModel(provider: string, model: string, lookup?: InferenceModelLookup): Promise<InferenceModelMetadata> {
    const startedAt = Date.now();
    const trace = inferenceModelLookupSchema.safeParse(lookup);
    let outcome: "ok" | "error" = "error";
    try {
      const metadata = await resolveInferenceModel(this.env, provider, model);
      outcome = "ok";
      return metadata;
    } finally {
      if (trace.success) emitTelemetry(this.env, {
        installationId: trace.data.installationId, component: "inference",
        event: {
          stream: "operational", name: "inference.metadata.finished",
          properties: { lookupId: trace.data.lookupId, outcome, durationMs: Math.max(0, Date.now() - startedAt) },
        },
      });
    }
  }
}

export default InferenceService;

export { InferenceLifecycleEntrypoint } from "./lifecycle";
