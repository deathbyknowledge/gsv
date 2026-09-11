import type { InferenceMediaRequest, InferenceMediaResult, InferenceExecutor } from "@humansandmachines/gsv/services/inference-execution";
import type { GatewayEnv } from "../runtime-env";
import type { InferenceAttribution } from "./provider";
import { raceWithAbort } from "../shared/abort";
import { createGenerationAbort, TimeoutError } from "./timeout";
import { ownInferenceBody } from "./owned-body";

export type MediaOperation = InferenceMediaRequest extends infer Request
  ? Request extends InferenceMediaRequest ? Pick<Request, "kind" | "input"> : never
  : never;

export type MediaExecutor = (
  operation: MediaOperation,
  body: ReadableStream<Uint8Array> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<InferenceMediaResult>;

export function createMediaExecutor(env: GatewayEnv, attribution: () => Promise<InferenceAttribution>): MediaExecutor {
  return async (operation, body, timeoutMs, signal) => {
    const abort = createGenerationAbort(signal, timeoutMs);
    let target: InferenceExecutor | undefined;
    let requestId: string | undefined;
    let started = false;
    let finished = false;
    let abortSent = false;
    const cancel = () => {
      if (started && !finished && !abortSent && target && requestId) {
        abortSent = true;
        void target.abort(requestId, abort.signal.reason instanceof TimeoutError ? "timeout" : "cancelled").catch(() => {});
      }
    };
    const cleanup = () => {
      finished = true;
      abort.signal.removeEventListener("abort", cancel);
      abort.clear();
      dispose(target);
    };
    abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      abort.signal.throwIfAborted();
      if (!env.INFERENCE_EXECUTION) throw new Error("Inference execution service is not configured");
      const identity = await raceWithAbort(attribution(), abort.signal);
      requestId = identity.logicalRequestId;
      target = await raceWithAbort(env.INFERENCE_EXECUTION.getExecutor(identity.installationId), abort.signal, {
        onLateResolve: dispose,
      });
      abort.signal.throwIfAborted();
      started = true;
      const result = await raceWithAbort(target.media({
        version: 1, ...identity, ...operation, timeoutMs, deadlineAt: abort.deadlineAt,
      }, body), abort.signal, {
        onAbort: cancel,
        onLateResolve: (late) => { if ("body" in late) void late.body?.cancel().catch(() => {}); },
      });
      if (!("body" in result) || !result.body) {
        cleanup();
        return result;
      }
      const responseBody = ownInferenceBody(result.body, abort.signal, cancel, cleanup);
      return { ...result, body: responseBody };
    } catch (error) {
      cancel();
      if (!started) await body?.cancel(error).catch(() => {});
      cleanup();
      throw error;
    }
  };
}

function dispose(target: InferenceExecutor | undefined): void {
  // SAFETY: Cloudflare RPC stubs provide optional disposal; this client owns its acquired stub.
  const resource = target as (InferenceExecutor & { [Symbol.dispose]?: () => void }) | undefined;
  resource?.[Symbol.dispose]?.();
}
