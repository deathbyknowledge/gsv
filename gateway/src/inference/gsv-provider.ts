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
  type ManagedInferenceService,
  type ManagedInferenceStreamEvent,
} from "@humansandmachines/gsv/protocol";
import type {
  InferenceAttribution,
  InferenceProviderFactory,
} from "./provider";

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

export function gsvInferenceProviderFactoryFromEnv(
  env: Env,
): InferenceProviderFactory | undefined {
  const service = (env as Env & GsvInferenceBindings).MANAGED_INFERENCE;
  return service ? createGsvInferenceProviderFactory(service) : undefined;
}

export function gsvInferenceFeaturesFromEnv(env: Env): string[] {
  return (env as Env & GsvInferenceBindings).MANAGED_INFERENCE
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
  const reasoning = "reasoning" in (options ?? {})
    ? (options as SimpleStreamOptions).reasoning
    : undefined;
  return {
    version: 1,
    installationId: attribution.installationId,
    logicalRequestId: attribution.logicalRequestId,
    actor: attribution.actor,
    model: GSV_INFERENCE_PRODUCT_MODEL,
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
    messages: context.messages as ManagedInferenceRequest["messages"],
    ...(context.tools && context.tools.length > 0
      ? { tools: context.tools as ManagedInferenceRequest["tools"] }
      : {}),
    maxOutputTokens: options?.maxTokens ?? GSV_INFERENCE_MODEL_METADATA.maxTokens,
    ...(reasoning ? { reasoning } : {}),
    timeoutMs: options?.timeoutMs ?? 180_000,
  };
}

async function pumpGsvInference(
  service: ManagedInferenceService,
  request: ManagedInferenceRequest,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
): Promise<void> {
  let generationStarted = false;
  let generationAbort: Promise<void> | undefined;
  const abortGeneration = () => {
    if (generationStarted && !generationAbort) {
      generationAbort = (async () => {
        try {
          await service.abort({
            version: 1,
            installationId: request.installationId,
            logicalRequestId: request.logicalRequestId,
          });
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
    const bodyPromise = service.generateStream(request);
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
  }
}

function toAssistantMessage(message: ManagedInferenceResult): AssistantMessage {
  return {
    ...message,
    content: message.content as AssistantMessage["content"],
  };
}

function applyManagedInferenceEvent(
  raw: unknown,
  current: AssistantMessage | undefined,
): {
  event: AssistantMessageEvent;
  partial: AssistantMessage | undefined;
  terminal: boolean;
} {
  const event = requireManagedInferenceEvent(raw);
  switch (event.type) {
    case "start": {
      if (current) throw new Error("Managed inference stream started twice");
      const partial = toAssistantMessage(event.partial as ManagedInferenceResult);
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
          toolCall: event.toolCall as AssistantMessage["content"][number] & {
            type: "toolCall";
          },
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

function requireManagedInferenceEvent(
  value: unknown,
): ManagedInferenceStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Managed inference stream event is invalid");
  }
  switch (value.type) {
    case "start":
      requireManagedMessage(value.partial, true);
      break;
    case "text_start":
    case "text_end":
      requireContentIndex(value.contentIndex);
      requireContentBlock(value.content, "text");
      break;
    case "thinking_start":
    case "thinking_end":
      requireContentIndex(value.contentIndex);
      requireContentBlock(value.content, "thinking");
      break;
    case "text_delta":
    case "thinking_delta":
      requireContentIndex(value.contentIndex);
      requireString(value.delta);
      break;
    case "toolcall_start":
    case "toolcall_end":
      requireContentIndex(value.contentIndex);
      requireContentBlock(value.toolCall, "toolCall");
      break;
    case "toolcall_delta":
      requireContentIndex(value.contentIndex);
      requireString(value.delta);
      requireContentBlock(value.toolCall, "toolCall");
      break;
    case "done":
      if (!isSuccessfulStopReason(value.reason)) {
        throw new Error("Managed inference stop reason is invalid");
      }
      requireManagedMessage(value.message, false);
      if ((value.message as ManagedInferenceResult).stopReason !== value.reason) {
        throw new Error("Managed inference stop reason does not match");
      }
      break;
    case "error":
      if (value.reason !== "error" && value.reason !== "aborted") {
        throw new Error("Managed inference stop reason is invalid");
      }
      requireManagedMessage(value.error, false);
      if ((value.error as ManagedInferenceResult).stopReason !== value.reason) {
        throw new Error("Managed inference stop reason does not match");
      }
      break;
    default:
      throw new Error("Managed inference stream event type is invalid");
  }
  return value as ManagedInferenceStreamEvent;
}

function requireManagedMessage(value: unknown, partial: boolean): void {
  if (
    !isRecord(value)
    || value.role !== "assistant"
    || value.api !== GSV_INFERENCE_API
    || value.provider !== GSV_INFERENCE_PROVIDER
    || value.model !== GSV_INFERENCE_PRODUCT_MODEL
    || !Array.isArray(value.content)
    || !isRecord(value.usage)
    || !Number.isSafeInteger(value.timestamp)
    || (value.timestamp as number) < 0
  ) {
    throw new Error("Managed inference message is invalid");
  }
  for (const block of value.content) requireContentBlock(block);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    const count = value.usage[field];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error("Managed inference usage is invalid");
    }
  }
  if (!isRecord(value.usage.cost)) {
    throw new Error("Managed inference usage is invalid");
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    const cost = value.usage.cost[field];
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      throw new Error("Managed inference usage is invalid");
    }
  }
  const stopReason = value.stopReason;
  if (
    partial
      ? stopReason !== "pending" && !isTerminalStopReason(stopReason)
      : !isTerminalStopReason(stopReason)
  ) {
    throw new Error("Managed inference stop reason is invalid");
  }
  if (value.errorMessage !== undefined) requireString(value.errorMessage);
  if (value.responseModel !== undefined) requireString(value.responseModel);
  if (value.responseId !== undefined) requireString(value.responseId);
}

function requireContentBlock(
  value: unknown,
  expected?: "text" | "thinking" | "toolCall",
): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Managed inference content is invalid");
  }
  if (expected && value.type !== expected) {
    throw new Error("Managed inference content type is invalid");
  }
  if (value.type === "text") {
    requireString(value.text);
    if (value.textSignature !== undefined) requireString(value.textSignature);
    return;
  }
  if (value.type === "thinking") {
    requireString(value.thinking);
    if (value.thinkingSignature !== undefined) {
      requireString(value.thinkingSignature);
    }
    if (value.redacted !== undefined && typeof value.redacted !== "boolean") {
      throw new Error("Managed inference thinking block is invalid");
    }
    return;
  }
  if (value.type === "toolCall") {
    requireString(value.id);
    requireString(value.name);
    if (!isRecord(value.arguments)) {
      throw new Error("Managed inference tool call is invalid");
    }
    if (value.thoughtSignature !== undefined) {
      requireString(value.thoughtSignature);
    }
    return;
  }
  throw new Error("Managed inference content type is invalid");
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
  return content as Extract<AssistantMessage["content"][number], { type: T }>;
}

function requirePartial(
  partial: AssistantMessage | undefined,
): AssistantMessage {
  if (!partial) throw new Error("Managed inference stream has not started");
  return partial;
}

function requireContentIndex(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Managed inference content index is invalid");
  }
}

function requireString(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("Managed inference stream string is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSuccessfulStopReason(
  value: unknown,
): value is "stop" | "length" | "toolUse" {
  return value === "stop" || value === "length" || value === "toolUse";
}

function isTerminalStopReason(value: unknown): boolean {
  return isSuccessfulStopReason(value) || value === "error" || value === "aborted";
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
