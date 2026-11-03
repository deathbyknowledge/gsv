import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  InferenceExecutionService,
  InferenceExecutor,
  InferenceMediaResult,
  InferenceModelMetadata,
} from "@humansandmachines/gsv/services/inference-execution";
import type { ManagedInferenceResult } from "@humansandmachines/gsv/services/inference";

export const UNIT_TEST_INFERENCE_REFUSAL = "Unit tests run no inference";

/** Refuses every request; tests that generate bind their own executor. */
class RefusingExecutor extends RpcTarget implements InferenceExecutor {
  async generate(): Promise<ManagedInferenceResult> {
    throw new Error(UNIT_TEST_INFERENCE_REFUSAL);
  }

  async generateStream(): Promise<ReadableStream<Uint8Array>> {
    throw new Error(UNIT_TEST_INFERENCE_REFUSAL);
  }

  async abort(): Promise<void> {}

  async media(): Promise<InferenceMediaResult> {
    throw new Error(UNIT_TEST_INFERENCE_REFUSAL);
  }
}

/**
 * The unit-test Worker's INFERENCE_EXECUTION binding: no model has a known
 * context window, and its executor refuses. The refusal comes from the
 * executor, because Vitest's worker pool reports every exception an
 * entrypoint method throws, even one its caller handles. Never deployed.
 */
export class TestInferenceExecution extends WorkerEntrypoint implements InferenceExecutionService {
  async getExecutor(): Promise<InferenceExecutor> {
    return new RefusingExecutor();
  }

  async resolveModel(provider: string, model: string): Promise<InferenceModelMetadata> {
    return { provider, model, contextWindowTokens: null };
  }
}
