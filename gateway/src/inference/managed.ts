import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  MANAGED_INFERENCE_MODEL,
  MANAGED_INFERENCE_PRODUCT_MODEL,
  MANAGED_INFERENCE_PROVIDER,
  type ManagedInferenceRequest,
  type ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import { stableOpaqueId } from "../shared/stable-id";

const MAX_EVENT_BUFFER_CHARS = 8 * 1024 * 1024;

export type ManagedGenerationIdentity = {
  installationId: string;
  logicalRequestId: string;
  actor: ManagedInferenceRequest["actor"];
};

type ManagedInferenceBindings = {
  INSTALLATION_DIRECTORY?: unknown;
  MANAGED_INFERENCE?: ManagedInferenceService;
};

export function isManagedGeneration(config: {
  provider: string;
  model: string;
}): boolean {
  return config.provider.trim().toLowerCase() === MANAGED_INFERENCE_PROVIDER
    && config.model.trim().toLowerCase() === MANAGED_INFERENCE_MODEL;
}

/**
 * Platform-funded inference is available only in a managed Gateway deployment.
 * Merely adding the inference binding to a standalone deployment must not turn
 * a user-owned installation into a consumer of platform credentials.
 */
export function managedInferenceFromEnv(env: Env): ManagedInferenceService | undefined {
  const bindings = env as Env & ManagedInferenceBindings;
  return bindings.INSTALLATION_DIRECTORY
    ? bindings.MANAGED_INFERENCE
    : undefined;
}

export async function managedLogicalRequestId(
  parts: readonly (string | number | null | undefined)[],
): Promise<string> {
  return await stableOpaqueId("managed-inference", parts);
}

export function streamManagedInference(
  service: ManagedInferenceService,
  request: ManagedInferenceRequest,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void pumpManagedInference(service, request, stream, signal);
  return stream;
}

async function pumpManagedInference(
  service: ManagedInferenceService,
  request: ManagedInferenceRequest,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
): Promise<void> {
  const abortInput = {
    installationId: request.installationId,
    logicalRequestId: request.logicalRequestId,
  };
  const abortUpstream = () => {
    void service.abort(abortInput).catch(() => {});
  };
  signal?.addEventListener("abort", abortUpstream, { once: true });

  try {
    if (signal?.aborted) {
      abortUpstream();
      stream.push(managedGatewayErrorEvent(true));
      return;
    }
    const response = await service.run(request);
    if (signal?.aborted) {
      // The first abort can race admission while run() crosses the service
      // binding. Repeat it once the coordinator is known to exist.
      abortUpstream();
    }
    if (!response.ok) {
      stream.push(managedGatewayErrorEvent(
        signal?.aborted === true,
        await managedErrorResponseMessage(response),
      ));
      return;
    }
    if (!response.body) {
      throw new Error("Managed inference returned no response body");
    }
    await decodeManagedEvents(response.body, stream);
  } catch {
    stream.push(managedGatewayErrorEvent(signal?.aborted === true));
  } finally {
    signal?.removeEventListener("abort", abortUpstream);
  }
}

async function decodeManagedEvents(
  body: ReadableStream<Uint8Array>,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalEvent: AssistantMessageEvent | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_EVENT_BUFFER_CHARS) {
        throw new Error("Managed inference event exceeded its size limit");
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          if (terminalEvent) throw new Error("Managed inference emitted data after completion");
          const event = parseManagedEvent(JSON.parse(line));
          if (event.type === "done" || event.type === "error") {
            terminalEvent = event;
          } else {
            stream.push(event);
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      if (terminalEvent) throw new Error("Managed inference emitted data after completion");
      const event = parseManagedEvent(JSON.parse(tail));
      if (event.type === "done" || event.type === "error") {
        terminalEvent = event;
      } else {
        stream.push(event);
      }
    }
    if (!terminalEvent) {
      throw new Error("Managed inference ended without a terminal event");
    }
    stream.push(terminalEvent);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseManagedEvent(value: unknown): AssistantMessageEvent {
  const event = record(value, "Managed inference event");
  const type = stringField(event.type, "Managed inference event type");
  if (type === "done") {
    const reason = event.reason;
    if (reason !== "stop" && reason !== "length" && reason !== "toolUse") {
      throw new Error("Managed inference completion reason is invalid");
    }
    return {
      type,
      reason,
      message: parseManagedMessage(event.message, false),
    };
  }
  if (type === "error") {
    const reason = event.reason;
    if (reason !== "aborted" && reason !== "error") {
      throw new Error("Managed inference error reason is invalid");
    }
    return {
      type,
      reason,
      error: parseManagedMessage(event.error, false),
    };
  }

  const partial = parseManagedMessage(event.partial, true);
  if (type === "start") {
    return { type, partial };
  }
  const contentIndex = nonNegativeInteger(event.contentIndex, "contentIndex");
  switch (type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return { type, contentIndex, partial };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return {
        type,
        contentIndex,
        delta: stringField(event.delta, `${type}.delta`),
        partial,
      };
    case "text_end":
    case "thinking_end":
      return {
        type,
        contentIndex,
        content: stringField(event.content, `${type}.content`),
        partial,
      };
    case "toolcall_end": {
      const toolCall = parseContentBlock(event.toolCall);
      if (toolCall.type !== "toolCall") {
        throw new Error("Managed inference toolcall_end is invalid");
      }
      return { type, contentIndex, toolCall, partial };
    }
    default:
      throw new Error("Managed inference event type is unsupported");
  }
}

function parseManagedMessage(value: unknown, partial: boolean): AssistantMessage {
  const message = record(value, "Managed inference message");
  if (
    message.role !== "assistant"
    || message.api !== "gsv-managed"
    || message.provider !== MANAGED_INFERENCE_PROVIDER
    || message.model !== MANAGED_INFERENCE_PRODUCT_MODEL
  ) {
    throw new Error("Managed inference message identity is invalid");
  }
  if (!Array.isArray(message.content)) {
    throw new Error("Managed inference message content is invalid");
  }
  const stopReason = message.stopReason;
  const allowed = stopReason === "stop"
    || stopReason === "length"
    || stopReason === "toolUse"
    || stopReason === "error"
    || stopReason === "aborted"
    || (partial && stopReason === "pending");
  if (!allowed) throw new Error("Managed inference stop reason is invalid");
  const errorMessage = message.errorMessage === undefined
    ? undefined
    : stringField(message.errorMessage, "Managed inference error message").slice(0, 4_096);
  return {
    role: "assistant",
    content: message.content.map(parseContentBlock),
    api: "gsv-managed",
    provider: MANAGED_INFERENCE_PROVIDER,
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    usage: parseUsage(message.usage),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: finiteNumber(message.timestamp, "Managed inference timestamp"),
  };
}

function parseContentBlock(value: unknown): AssistantMessage["content"][number] {
  const block = record(value, "Managed inference content block");
  if (block.type === "text") {
    return { type: "text", text: stringField(block.text, "text content") };
  }
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: stringField(block.thinking, "thinking content"),
      ...(typeof block.thinkingSignature === "string"
        ? { thinkingSignature: block.thinkingSignature }
        : {}),
      ...(typeof block.redacted === "boolean" ? { redacted: block.redacted } : {}),
    };
  }
  if (block.type === "toolCall") {
    const args = record(block.arguments, "tool call arguments");
    const toolCall: ToolCall = {
      type: "toolCall",
      id: stringField(block.id, "tool call id"),
      name: stringField(block.name, "tool call name"),
      arguments: args,
      ...(typeof block.thoughtSignature === "string"
        ? { thoughtSignature: block.thoughtSignature }
        : {}),
    };
    return toolCall;
  }
  throw new Error("Managed inference content block type is unsupported");
}

function parseUsage(value: unknown): Usage {
  const usage = record(value, "Managed inference usage");
  const cost = record(usage.cost, "Managed inference cost");
  return {
    input: nonNegativeInteger(usage.input, "usage.input"),
    output: nonNegativeInteger(usage.output, "usage.output"),
    cacheRead: nonNegativeInteger(usage.cacheRead, "usage.cacheRead"),
    cacheWrite: nonNegativeInteger(usage.cacheWrite, "usage.cacheWrite"),
    ...(usage.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: nonNegativeInteger(usage.cacheWrite1h, "usage.cacheWrite1h") }),
    totalTokens: nonNegativeInteger(usage.totalTokens, "usage.totalTokens"),
    cost: {
      input: nonNegativeNumber(cost.input, "usage.cost.input"),
      output: nonNegativeNumber(cost.output, "usage.cost.output"),
      cacheRead: nonNegativeNumber(cost.cacheRead, "usage.cost.cacheRead"),
      cacheWrite: nonNegativeNumber(cost.cacheWrite, "usage.cost.cacheWrite"),
      total: nonNegativeNumber(cost.total, "usage.cost.total"),
    },
  };
}

async function managedErrorResponseMessage(response: Response): Promise<string> {
  try {
    const value = await response.json<unknown>();
    const body = record(value, "Managed inference error response");
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error.trim().slice(0, 4_096);
    }
  } catch {
    // The caller receives the stable product error below.
  }
  return "Managed inference temporarily unavailable";
}

function managedGatewayErrorEvent(
  aborted: boolean,
  errorMessage?: string,
): Extract<AssistantMessageEvent, { type: "error" }> {
  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: {
      role: "assistant",
      content: [],
      api: "gsv-managed",
      provider: MANAGED_INFERENCE_PROVIDER,
      model: MANAGED_INFERENCE_PRODUCT_MODEL,
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
        ? "Managed inference cancelled"
        : errorMessage ?? "Managed inference temporarily unavailable",
      timestamp: Date.now(),
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}
