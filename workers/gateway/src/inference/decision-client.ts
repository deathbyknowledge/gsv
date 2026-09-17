import type { AiDecideResult } from "@humansandmachines/gsv/protocol";
import type { InferenceDecisionRequest, InferenceExecutor } from "@humansandmachines/gsv/services/inference-execution";
import type { GatewayEnv } from "../runtime-env";
import { raceWithAbort } from "../shared/abort";
import { createGenerationAbort, TimeoutError } from "./timeout";

export async function executeDecision(
  env: GatewayEnv,
  input: Omit<InferenceDecisionRequest, "version" | "deadlineAt">,
  signal?: AbortSignal,
): Promise<AiDecideResult> {
  const abort = createGenerationAbort(signal, input.timeoutMs);
  let target: InferenceExecutor | undefined;
  let started = false;
  let finished = false;
  let abortSent = false;
  const cancel = () => {
    if (!target || !started || finished || abortSent) return;
    abortSent = true;
    void target.abort(input.logicalRequestId, abort.signal.reason instanceof TimeoutError ? "timeout" : "cancelled").catch(() => {});
  };
  abort.signal.addEventListener("abort", cancel, { once: true });
  try {
    abort.signal.throwIfAborted();
    if (!env.INFERENCE_EXECUTION) throw new Error("Inference execution service is not configured");
    target = await raceWithAbort(env.INFERENCE_EXECUTION.getExecutor(input.installationId), abort.signal, { onLateResolve: dispose });
    abort.signal.throwIfAborted();
    started = true;
    const result = await raceWithAbort(target.decide({ version: 1, ...input, deadlineAt: abort.deadlineAt }), abort.signal, { onAbort: cancel });
    abort.signal.throwIfAborted();
    finished = true;
    return result;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    abort.signal.removeEventListener("abort", cancel);
    abort.clear();
    dispose(target);
  }
}

function dispose(target: InferenceExecutor | undefined): void {
  // SAFETY: The acquired RPC target is owned by this request and may expose disposal.
  const resource = target as (InferenceExecutor & { [Symbol.dispose]?: () => void }) | undefined;
  resource?.[Symbol.dispose]?.();
}
