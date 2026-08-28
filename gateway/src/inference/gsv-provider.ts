import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  decodeManagedInferenceStream,
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceRequest,
  type ManagedInferenceResult,
  type ManagedInferenceStreamEvent,
} from "@humansandmachines/gsv/protocol";
import type {
  InferenceService as ManagedInferenceService,
  InferenceTarget as ManagedInferenceTarget,
} from "@humansandmachines/gsv/services/inference";
import type {
  InferenceAttribution,
  InferenceProviderFactory,
} from "./provider";
import { raceWithAbort } from "../shared/abort";

const GSV_INFERENCE_API = "gsv-inference";

const GSV_INFERENCE_MODEL_METADATA: Model<typeof GSV_INFERENCE_API> = {
  id: GSV_INFERENCE_MODEL,
  name: "GSV included",
  api: GSV_INFERENCE_API,
  provider: GSV_INFERENCE_PROVIDER,
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_048_576,
  maxTokens: 8_192,
};

type GsvInferenceBindings = {
  MANAGED_INFERENCE?: ManagedInferenceService;
};

type DisposableManagedInferenceTarget = ManagedInferenceTarget & {
  [Symbol.dispose]?(): void;
};

type DisposableManagedInferenceAcquisition = Promise<ManagedInferenceTarget> & {
  [Symbol.dispose]?(): void;
};

type AppliedManagedInferenceEvent = {
  event: AssistantMessageEvent;
  partial: AssistantMessage | undefined;
  terminal: boolean;
};

export function gsvInferenceProviderFactoryFromEnv(
  env: Env,
): InferenceProviderFactory | undefined {
  const service = managedInferenceServiceFromEnv(env);
  return service ? createGsvInferenceProviderFactory(service) : undefined;
}

export function gsvInferenceFeaturesFromEnv(env: Env): string[] {
  return managedInferenceServiceFromEnv(env)
    ? [GSV_INFERENCE_FEATURE]
    : [];
}

export function createGsvInferenceProviderFactory(
  service: ManagedInferenceService,
): InferenceProviderFactory {
  return {
    id: GSV_INFERENCE_PROVIDER,
    create: (attribution) => createProvider({
      id: GSV_INFERENCE_PROVIDER,
      name: "GSV",
      auth: {
        apiKey: {
          name: "GSV included inference",
          resolve: async () => ({ auth: {}, source: "gateway service binding" }),
        },
      },
      models: [GSV_INFERENCE_MODEL_METADATA],
      api: gsvInferenceStreams(service, attribution),
    }),
  };
}

function gsvInferenceStreams(
  service: ManagedInferenceService,
  attribution: InferenceAttribution,
): ProviderStreams {
  return {
    stream: (_model, context, options) => streamGsvInference(
      service,
      attribution,
      context,
      options,
    ),
    streamSimple: (_model, context, options) => streamGsvInference(
      service,
      attribution,
      context,
      options,
    ),
  };
}

function streamGsvInference(
  service: ManagedInferenceService,
  attribution: InferenceAttribution,
  context: Context,
  options?: StreamOptions | SimpleStreamOptions,
): AssistantMessageEventStream {
  if (options?.fetch) {
    throw new Error("GSV inference cannot originate model requests from a connected machine.");
  }
  const stream = createAssistantMessageEventStream();
  void pumpGsvInference(
    service,
    buildManagedInferenceRequest(attribution, context, options),
    stream,
    options?.signal,
  );
  return stream;
}

function buildManagedInferenceRequest(
  attribution: InferenceAttribution,
  context: Context,
  options?: StreamOptions | SimpleStreamOptions,
): ManagedInferenceRequest {
  const reasoning = options && "reasoning" in options
    ? options.reasoning
    : undefined;
  // SAFETY: Context messages use the same JSON message contract as managed inference.
  const messages = context.messages as ManagedInferenceRequest["messages"];
  const request: ManagedInferenceRequest = {
    version: 1,
    installationId: attribution.installationId,
    logicalRequestId: attribution.logicalRequestId,
    actor: attribution.actor,
    model: GSV_INFERENCE_PRODUCT_MODEL,
    messages,
    maxOutputTokens: options?.maxTokens ?? GSV_INFERENCE_MODEL_METADATA.maxTokens,
    timeoutMs: options?.timeoutMs ?? 180_000,
  };
  if (context.systemPrompt) request.systemPrompt = context.systemPrompt;
  if (context.tools && context.tools.length > 0) {
    // SAFETY: pi-ai tools and the managed protocol share the same JSON Schema contract.
    request.tools = context.tools as ManagedInferenceRequest["tools"];
  }
  if (reasoning) request.reasoning = reasoning;
  return request;
}

async function pumpGsvInference(
  service: ManagedInferenceService,
  request: ManagedInferenceRequest,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
): Promise<void> {
  let target: ManagedInferenceTarget | undefined;
  let acquisitionDisposesLateTarget = false;
  let generationStarted = false;
  let generationAbort: Promise<void> | undefined;
  const abortGeneration = () => {
    if (target && generationStarted && !generationAbort) {
      generationAbort = (async () => {
        try {
          await target.abort(request.logicalRequestId);
        } catch {}
      })();
    }
  };
  signal?.addEventListener("abort", abortGeneration, { once: true });

  try {
    if (signal?.aborted) {
      stream.push(gsvInferenceErrorEvent(true));
      return;
    }
    const acquisition = service.getInstallation(request.installationId);
    target = await raceWithAbort(acquisition, signal, {
      onAbort: () => {
        acquisitionDisposesLateTarget = disposeManagedInferenceAcquisition(
          acquisition,
        );
      },
      onLateResolve: (lateTarget) => {
        if (!acquisitionDisposesLateTarget) {
          disposeManagedInferenceTarget(lateTarget);
        }
      },
    });
    if (signal?.aborted) {
      stream.push(gsvInferenceErrorEvent(true));
      return;
    }
    const bodyPromise = target.generateStream(request);
    generationStarted = true;
    if (signal?.aborted) abortGeneration();
    const body = await bodyPromise;
    let partial: AssistantMessage | undefined;
    let terminal = false;
    for await (const raw of decodeManagedInferenceStream(body, signal)) {
      if (signal?.aborted) break;
      const applied = applyManagedInferenceEvent(raw, partial);
      partial = applied.partial;
      terminal = applied.terminal;
      stream.push(applied.event);
      if (terminal) break;
    }
    if (signal?.aborted) {
      stream.push(gsvInferenceErrorEvent(true));
      return;
    }
    if (!terminal) throw new Error("Managed inference stream ended early");
  } catch {
    abortGeneration();
    stream.push(gsvInferenceErrorEvent(signal?.aborted === true));
  } finally {
    signal?.removeEventListener("abort", abortGeneration);
    await generationAbort;
    disposeManagedInferenceTarget(target);
  }
}

function disposeManagedInferenceAcquisition(
  acquisition: Promise<ManagedInferenceTarget>,
): boolean {
  // SAFETY: Workers RPC promises implement Symbol.dispose. Disposing a pending
  // promise also disposes an RpcTarget result if it arrives later.
  const disposable = acquisition as DisposableManagedInferenceAcquisition;
  const dispose = disposable[Symbol.dispose];
  if (!dispose) return false;
  dispose.call(disposable);
  return true;
}

function disposeManagedInferenceTarget(
  target: ManagedInferenceTarget | undefined,
): void {
  // SAFETY: Workers RPC stubs implement Symbol.dispose; local test targets may omit it.
  const disposable = target as DisposableManagedInferenceTarget | undefined;
  disposable?.[Symbol.dispose]?.();
}

function toAssistantMessage(
  message: ManagedInferenceResult | Extract<ManagedInferenceStreamEvent, { type: "start" }>["partial"],
): AssistantMessage {
  return message;
}

function applyManagedInferenceEvent(
  event: ManagedInferenceStreamEvent,
  current: AssistantMessage | undefined,
): AppliedManagedInferenceEvent {
  switch (event.type) {
    case "start": {
      if (current) throw new Error("Managed inference stream started twice");
      const partial = toAssistantMessage(event.partial);
      return { event: { type: "start", partial }, partial, terminal: false };
    }
    case "text_start": {
      const partial = appendContent(current, event.contentIndex, event.content);
      return {
        event: { type: "text_start", contentIndex: event.contentIndex, partial },
        partial,
        terminal: false,
      };
    }
    case "text_delta": {
      const partial = requirePartial(current);
      const block = requireContent(partial, event.contentIndex, "text");
      block.text += event.delta;
      return {
        event: { ...event, partial },
        partial,
        terminal: false,
      };
    }
    case "text_end": {
      const partial = replaceContent(current, event.contentIndex, event.content);
      return {
        event: {
          type: "text_end",
          contentIndex: event.contentIndex,
          content: event.content.text,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "thinking_start": {
      const partial = appendContent(current, event.contentIndex, event.content);
      return {
        event: {
          type: "thinking_start",
          contentIndex: event.contentIndex,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "thinking_delta": {
      const partial = requirePartial(current);
      const block = requireContent(partial, event.contentIndex, "thinking");
      block.thinking += event.delta;
      return {
        event: { ...event, partial },
        partial,
        terminal: false,
      };
    }
    case "thinking_end": {
      const partial = replaceContent(current, event.contentIndex, event.content);
      return {
        event: {
          type: "thinking_end",
          contentIndex: event.contentIndex,
          content: event.content.thinking,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "toolcall_start": {
      const partial = appendContent(current, event.contentIndex, event.toolCall);
      return {
        event: {
          type: "toolcall_start",
          contentIndex: event.contentIndex,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "toolcall_delta": {
      const partial = replaceContent(current, event.contentIndex, event.toolCall);
      return {
        event: {
          type: "toolcall_delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "toolcall_end": {
      const partial = replaceContent(current, event.contentIndex, event.toolCall);
      return {
        event: {
          type: "toolcall_end",
          contentIndex: event.contentIndex,
          toolCall: event.toolCall,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "done":
      return {
        event: {
          type: "done",
          reason: event.reason,
          message: toAssistantMessage(event.message),
        },
        partial: current,
        terminal: true,
      };
    case "error":
      return {
        event: {
          type: "error",
          reason: event.reason,
          error: toAssistantMessage(event.error),
        },
        partial: current,
        terminal: true,
      };
  }
}

function appendContent(
  current: AssistantMessage | undefined,
  contentIndex: number,
  content: AssistantMessage["content"][number],
): AssistantMessage {
  const partial = requirePartial(current);
  if (contentIndex !== partial.content.length) {
    throw new Error("Managed inference content index is invalid");
  }
  partial.content.push(content);
  return partial;
}

function replaceContent(
  current: AssistantMessage | undefined,
  contentIndex: number,
  content: AssistantMessage["content"][number],
): AssistantMessage {
  const partial = requirePartial(current);
  if (!partial.content[contentIndex]) {
    throw new Error("Managed inference content index is invalid");
  }
  partial.content[contentIndex] = content;
  return partial;
}

function requireContent<T extends "text" | "thinking">(
  partial: AssistantMessage,
  contentIndex: number,
  type: T,
): Extract<AssistantMessage["content"][number], { type: T }> {
  const content = partial.content[contentIndex];
  if (!content || content.type !== type) {
    throw new Error("Managed inference content sequence is invalid");
  }
  // SAFETY: The runtime type discriminator above matches the requested generic type.
  return content as Extract<AssistantMessage["content"][number], { type: T }>;
}

function requirePartial(
  partial: AssistantMessage | undefined,
): AssistantMessage {
  if (!partial) throw new Error("Managed inference stream has not started");
  return partial;
}


function managedInferenceServiceFromEnv(value: Env): ManagedInferenceService | undefined {
  // SAFETY: Managed deployments bind MANAGED_INFERENCE; standalone deployments omit it.
  return (value as Env & GsvInferenceBindings).MANAGED_INFERENCE;
}

function gsvInferenceErrorEvent(
  aborted: boolean,
): Extract<AssistantMessageEvent, { type: "error" }> {
  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: {
      role: "assistant",
      content: [],
      api: GSV_INFERENCE_API,
      provider: GSV_INFERENCE_PROVIDER,
      model: GSV_INFERENCE_PRODUCT_MODEL,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: aborted ? "aborted" : "error",
      errorMessage: aborted
        ? "GSV inference cancelled"
        : "GSV inference is unavailable",
      timestamp: Date.now(),
    },
  };
}
