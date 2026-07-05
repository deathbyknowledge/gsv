import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";

type OpenAiCodexFetchRequest = {
  model: Model<Api>;
  context: Context;
  fetch: typeof fetch;
  options?: SimpleStreamOptions;
};

type RoutedRequestInit = RequestInit & { timeoutMs?: number };

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);
const ERROR_BODY_PREVIEW_CHARS = 4096;

export function streamWithOpenAiCodexFetch(
  request: OpenAiCodexFetchRequest,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = emptyOpenAiCodexMessage(request.model);
    try {
      const apiKey = request.options?.apiKey;
      if (!apiKey) {
        throw new Error(`No API key for provider: ${request.model.provider}`);
      }

      const accountId = extractAccountId(apiKey);
      let body: unknown = buildRequestBody(request.model, request.context, request.options);
      const nextBody = await request.options?.onPayload?.(body, request.model);
      if (nextBody !== undefined) {
        body = nextBody;
      }

      const response = await request.fetch(resolveCodexUrl(request.model.baseUrl), {
        method: "POST",
        headers: buildSseHeaders(request.model, request.options, accountId, apiKey),
        body: JSON.stringify(body),
        signal: request.options?.signal,
        ...(request.options?.timeoutMs !== undefined ? { timeoutMs: request.options.timeoutMs } : {}),
      } as RoutedRequestInit);

      await request.options?.onResponse?.(providerResponseFromFetchResponse(response), request.model);

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new Error(formatCodexHttpError(response, raw));
      }
      if (!response.body) {
        throw new Error("OpenAI Codex returned no response body");
      }

      stream.push({ type: "start", partial: output });
      await processResponsesStream(
        mapCodexEvents(parseSse(response, request.options?.signal)) as AsyncIterable<never>,
        output,
        stream,
        request.model,
      );
      if (request.options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      stream.push({ type: "done", reason: doneReason(output.stopReason), message: output });
      stream.end();
    } catch (error) {
      output.stopReason = request.options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export function completeWithOpenAiCodexFetch(
  request: OpenAiCodexFetchRequest,
): Promise<AssistantMessage> {
  return streamWithOpenAiCodexFetch(request).result();
}

function doneReason(reason: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" {
  return reason === "length" || reason === "toolUse" ? reason : "stop";
}

function emptyOpenAiCodexMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function buildRequestBody(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    input: convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
      includeSystemPrompt: false,
    }),
    text: { verbosity: providerOption(options, "textVerbosity") ?? "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  const serviceTier = providerOption(options, "serviceTier");
  if (serviceTier !== undefined) {
    body.service_tier = serviceTier;
  }
  if (context.tools && context.tools.length > 0) {
    body.tools = convertResponsesTools(context.tools, { strict: null });
  }

  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  if (clampedReasoning !== undefined) {
    const effort = model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning;
    if (effort !== null) {
      body.reasoning = {
        effort,
        summary: providerOption(options, "reasoningSummary") ?? "auto",
      };
    }
  }
  return body;
}

function buildSseHeaders(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  accountId: string,
  apiKey: string,
): Headers {
  const headers = new Headers(model.headers as HeadersInit | undefined);
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (value === null) {
      headers.delete(key);
    } else {
      headers.set(key, value);
    }
  }
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("User-Agent", "pi (GSV)");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (options?.sessionId) {
    headers.set("session-id", options.sessionId);
    headers.set("x-client-request-id", options.sessionId);
  }
  return headers;
}

function resolveCodexUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

function extractAccountId(token: string): string {
  try {
    const payload = JSON.parse(decodeJwtPart(token.split(".")[1] ?? ""));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) {
      return accountId;
    }
  } catch {
    // Fall through to a stable provider-facing error.
  }
  throw new Error("Failed to extract accountId from OpenAI Codex token");
}

function decodeJwtPart(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
  return atob(padded);
}

function providerOption(options: SimpleStreamOptions | undefined, key: string): unknown {
  return (options as Record<string, unknown> | undefined)?.[key];
}

async function* parseSse(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncIterable<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          yield JSON.parse(data) as Record<string, unknown>;
        }
        index = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* mapCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "error") {
      const error = extractCodexEventError(event);
      throw new Error(`Codex error: ${error.message || error.code || JSON.stringify(event)}`);
    }
    if (type === "response.failed") {
      const response = objectRecord(event.response);
      const nestedError = objectRecord(response?.error);
      throw new Error(
        stringValue(nestedError?.message) ||
          stringValue(nestedError?.code) ||
          "Codex response failed",
      );
    }
    if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
      const response = objectRecord(event.response);
      yield {
        ...event,
        type: "response.completed",
        response: response ? {
          ...response,
          status: normalizeCodexStatus(response.status),
        } : response,
      };
      return;
    }
    yield event;
  }
}

function normalizeCodexStatus(status: unknown): string | undefined {
  return typeof status === "string" && CODEX_RESPONSE_STATUSES.has(status)
    ? status
    : undefined;
}

function extractCodexEventError(event: Record<string, unknown>): { code?: string; message?: string } {
  const nested = objectRecord(event.error);
  return {
    code: stringValue(event.code) ?? stringValue(nested?.code),
    message: stringValue(event.message) ?? stringValue(nested?.message),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerResponseFromFetchResponse(response: Response): ProviderResponse {
  return {
    status: response.status,
    headers: headersToRecord(response.headers),
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function formatCodexHttpError(response: Response, rawBody: string): string {
  const diagnostics = [
    `HTTP ${response.status}`,
    headerDiagnostic(response.headers, "content-type", "content-type"),
    headerDiagnostic(response.headers, "cf-ray", "cf-ray"),
    headerDiagnostic(response.headers, "x-request-id", "request-id") ??
      headerDiagnostic(response.headers, "x-oai-request-id", "request-id"),
  ].filter(Boolean).join("; ");
  const parsedMessage = parseProviderErrorMessage(rawBody);
  const preview = (parsedMessage || rawBody || response.statusText)
    .replace(/\s+/g, " ")
    .slice(0, ERROR_BODY_PREVIEW_CHARS)
    .trim();
  return `OpenAI Codex ${diagnostics}: ${preview || "Request failed"}`;
}

function headerDiagnostic(headers: Headers, header: string, label: string): string | null {
  const value = headers.get(header);
  return value ? `${label}=${value}` : null;
}

function parseProviderErrorMessage(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const error = objectRecord(parsed.error);
    return stringValue(error?.message) ??
      stringValue(parsed.detail) ??
      stringValue(error?.code) ??
      null;
  } catch {
    return null;
  }
}
