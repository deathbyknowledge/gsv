import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
} from "@humansandmachines/gsv/services/inference-context";
import type {
  InferenceExecutionRequest,
  InferenceExecutor,
} from "@humansandmachines/gsv/services/inference-execution";
import { decodeInferenceExecutionStream, type AiConfigResult, type AiTextGenerateOptions } from "@humansandmachines/gsv/protocol";
import type { GatewayEnv } from "../runtime-env";
import type { InferenceAttribution } from "./provider";
import { raceWithAbort } from "../shared/abort";
import { createGenerationAbort, TimeoutError } from "./timeout";
import { RoutedInferenceTransport } from "./transport";
import { applyManagedInferenceEvent } from "./stream-projection";
import { describeGeneratedTextFailure, extractGeneratedText } from "./generated-text";
import { errorMessageFromUnknown } from "./errors";

type GenerateRequest = {
  config: AiConfigResult;
  context: Context;
  options?: AiTextGenerateOptions;
  fetch?: typeof fetch;
  sessionAffinityKey?: string;
  signal?: AbortSignal;
  attribution?: InferenceAttribution;
};

export function createGenerationService(env: GatewayEnv) {
  const start = (request: GenerateRequest, streaming: boolean): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void pump(env, request, streaming, stream);
    return stream;
  };
  const generate = (request: GenerateRequest) => start(request, false).result();
  return {
    generate,
    stream: (request: GenerateRequest) => start(request, true),
    async generateText(request: GenerateRequest): Promise<string> {
      const response = await generate(request);
      const text = extractGeneratedText(response);
      if (text) return text;
      throw new Error(describeGeneratedTextFailure(request, response));
    },
  };
}

async function pump(
  env: GatewayEnv,
  request: GenerateRequest,
  streaming: boolean,
  output: AssistantMessageEventStream,
): Promise<void> {
  const timeoutMs = request.options?.timeoutMs ?? request.config.generationTimeoutMs;
  const abort = createGenerationAbort(request.signal, timeoutMs);
  let target: InferenceExecutor | undefined;
  let transport: RoutedInferenceTransport | undefined;
  let started = false;
  let abortSent = false;
  const abortGeneration = () => {
    if (!target || !started || abortSent) return;
    abortSent = true;
    void target.abort(
      request.attribution!.logicalRequestId,
      abort.signal.reason instanceof TimeoutError ? "timeout" : "cancelled",
    ).catch(() => {});
  };
  abort.signal.addEventListener("abort", abortGeneration, { once: true });
  try {
    abort.signal.throwIfAborted();
    if (!env.INFERENCE_EXECUTION) throw new Error("Inference execution service is not configured");
    if (!request.attribution) throw new Error("Inference request attribution is unavailable");
    const acquisition = env.INFERENCE_EXECUTION.getExecutor(request.attribution.installationId);
    let acquisitionDisposed = false;
    target = await raceWithAbort(acquisition, abort.signal, {
      onAbort: () => { acquisitionDisposed = disposeRpc(acquisition); },
      onLateResolve: (late) => { if (!acquisitionDisposed) disposeRpc(late); },
    });
    abort.signal.throwIfAborted();
    const input = executionRequest(request, timeoutMs, abort.deadlineAt);
    transport = request.fetch ? new RoutedInferenceTransport(request.fetch) : undefined;
    started = true;
    if (!streaming) {
      const generation = target.generate(input, transport);
      const result = await raceWithAbort(generation, abort.signal, {
        onAbort: () => { abortGeneration(); disposeRpc(generation); },
      });
      output.push(result.stopReason === "error" || result.stopReason === "aborted"
        ? { type: "error", reason: result.stopReason, error: result }
        : { type: "done", reason: result.stopReason, message: result });
      return;
    }
    const generation = target.generateStream(input, transport);
    const body = await raceWithAbort(generation, abort.signal, {
      onAbort: () => { abortGeneration(); disposeRpc(generation); },
      onLateResolve: (late) => { void late.cancel(abort.signal.reason).catch(() => {}); },
    });
    let partial: AssistantMessage | undefined;
    let terminal = false;
    for await (const event of decodeInferenceExecutionStream(body, abort.signal)) {
      abort.signal.throwIfAborted();
      const projected = applyManagedInferenceEvent(event, partial);
      partial = projected.partial;
      output.push(projected.event);
      terminal = projected.terminal;
      if (terminal) break;
    }
    if (!terminal) throw new Error("Inference stream ended before its terminal result");
  } catch (error) {
    abortGeneration();
    const cancelled = abort.signal.aborted && !(abort.signal.reason instanceof TimeoutError);
    output.push({
      type: "error",
      reason: cancelled ? "aborted" : "error",
      error: {
        role: "assistant", content: [], api: "gsv-inference",
        provider: request.config.provider, model: request.config.model,
        stopReason: cancelled ? "aborted" : "error",
        errorMessage: errorMessageFromUnknown(abort.signal.aborted ? abort.signal.reason : error),
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    });
  } finally {
    abort.signal.removeEventListener("abort", abortGeneration);
    abort.clear();
    transport?.close();
    disposeRpc(target);
  }
}

function executionRequest(request: GenerateRequest, timeoutMs: number, deadlineAt: number): InferenceExecutionRequest {
  const { config, context, attribution } = request;
  if (!attribution) throw new Error("Inference request attribution is unavailable");
  return {
    version: 1,
    ...attribution,
    connection: {
      provider: config.provider, model: config.model, apiKey: config.apiKey,
      baseUrl: config.baseUrl, providerStyle: config.providerStyle,
      openAiCodex: config.openAiCodex, reasoning: config.reasoning,
      maxTokens: config.maxTokens, contextWindowTokens: config.contextWindowTokens,
    },
    systemPrompt: context.systemPrompt,
    // SAFETY: Historical context is validated when projected; pending messages never enter it.
    messages: context.messages as InferenceExecutionRequest["messages"],
    tools: context.tools,
    options: request.options,
    sessionAffinityKey: request.sessionAffinityKey,
    timeoutMs,
    deadlineAt,
  };
}

function disposeRpc<T>(value: InferenceExecutor | Promise<T> | undefined): boolean {
  // SAFETY: Acquired RPC targets and promises may expose the platform's disposal method.
  const resource = value as (typeof value & { [Symbol.dispose]?: () => void });
  const disposer = resource?.[Symbol.dispose];
  if (!disposer) return false;
  disposer.call(resource);
  return true;
}
