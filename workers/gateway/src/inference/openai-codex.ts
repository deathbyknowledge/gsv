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
import { openAiResponseEvents, parseSse } from "./sse";
import type {
  JsonObject,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  jsonObjectSchema,
  jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

type OpenAiCodexFetchRequest = {
  model: Model<Api>;
  context: Context;
  fetch: typeof fetch;
  options?: OpenAiCodexFetchOptions;
};

type OpenAiCodexFetchOptions = SimpleStreamOptions & {
  openAiCodexAccountId?: string;
  reasoningSummary?: "auto" | "concise" | "detailed";
  serviceTier?: "auto" | "default" | "flex" | "scale" | "priority";
  textVerbosity?: "low" | "medium" | "high";
};

type RoutedRequestInit = RequestInit & { timeoutMs?: number };

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const codexResponseStatusSchema = z.enum([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);
const ERROR_BODY_PREVIEW_CHARS = 4096;
const codexJwtClaimsSchema = z.object({
  [JWT_CLAIM_PATH]: z.object({
    chatgpt_account_id: z.string().trim().min(1),
  }),
}).passthrough();
const codexEventSchema = z.object({
  type: z.string(),
}).catchall(z.json());
const nonemptyStringSchema = z.string().min(1);

type CodexEvent = z.infer<typeof codexEventSchema>;
type CodexEventError = {
  code?: string;
  message?: string;
};

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

      const accountId = normalizeAccountId(request.options?.openAiCodexAccountId) ?? extractAccountId(apiKey);
      let body: unknown = buildRequestBody(request.model, request.context, request.options);
      const nextBody = await request.options?.onPayload?.(body, request.model);
      if (nextBody !== undefined) {
        body = nextBody;
      }

      const requestInit: RoutedRequestInit = {
        method: "POST",
        headers: buildSseHeaders(request.model, request.options, accountId, apiKey),
        body: JSON.stringify(body),
        signal: request.options?.signal,
      };
      if (request.options?.timeoutMs !== undefined) {
        requestInit.timeoutMs = request.options.timeoutMs;
      }
      const response = await request.fetch(resolveCodexUrl(request.model.baseUrl), requestInit);

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
        openAiResponseEvents(mapCodexEvents(codexEvents(parseSse(response, request.options?.signal)))),
        output,
        stream,
        request.model,
      );
      if (request.options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "OpenAI Codex returned an error stop reason");
      }
      stream.push({ type: "done", reason: doneReason(output.stopReason), message: output });
      stream.end();
    } catch (error) {
      output.stopReason = request.options?.signal?.aborted || output.stopReason === "aborted" ? "aborted" : "error";
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
  options: OpenAiCodexFetchOptions | undefined,
): JsonObject {
  const body: JsonObject = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    input: jsonValueSchema.parse(convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
      includeSystemPrompt: false,
    })),
    text: { verbosity: options?.textVerbosity ?? "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  const promptCacheKey = clampOpenAIPromptCacheKey(options?.sessionId);
  if (promptCacheKey !== undefined) {
    body.prompt_cache_key = promptCacheKey;
  }

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  const serviceTier = options?.serviceTier;
  if (serviceTier !== undefined) {
    body.service_tier = serviceTier;
  }
  if (context.tools && context.tools.length > 0) {
    body.tools = jsonValueSchema.parse(convertResponsesTools(context.tools, { strict: null }));
  }

  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  if (clampedReasoning !== undefined) {
    const effort = model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning;
    if (effort !== null) {
      body.reasoning = {
        effort,
        summary: options?.reasoningSummary ?? "auto",
      };
    }
  }
  return body;
}

function buildSseHeaders(
  model: Model<Api>,
  options: OpenAiCodexFetchOptions | undefined,
  accountId: string,
  apiKey: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(model.headers ?? {})) {
    if (value !== null) {
      headers.set(key, value);
    }
  }
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

function normalizeAccountId(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
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
    const payload = codexJwtClaimsSchema.parse(JSON.parse(decodeJwtPart(token.split(".")[1] ?? "")));
    return payload[JWT_CLAIM_PATH].chatgpt_account_id;
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

async function* codexEvents(
  events: AsyncIterable<unknown>,
): AsyncIterable<CodexEvent> {
  for await (const event of events) {
    yield codexEventSchema.parse(event);
  }
}

async function* mapCodexEvents(
  events: AsyncIterable<CodexEvent>,
): AsyncIterable<CodexEvent> {
  for await (const event of events) {
    const { type } = event;
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
      let normalizedResponse: JsonObject | null = null;
      if (response) {
        normalizedResponse = { ...response };
        delete normalizedResponse.status;
        const status = normalizeCodexStatus(response.status);
        if (status !== undefined) {
          normalizedResponse.status = status;
        }
      }
      yield {
        ...event,
        type: "response.completed",
        response: normalizedResponse,
      };
      return;
    }
    yield event;
  }
}

function normalizeCodexStatus(status: JsonValue | undefined): string | undefined {
  const parsed = codexResponseStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : undefined;
}

function extractCodexEventError(event: CodexEvent): CodexEventError {
  const nested = objectRecord(event.error);
  return {
    code: stringValue(event.code) ?? stringValue(nested?.code),
    message: stringValue(event.message) ?? stringValue(nested?.message),
  };
}

function objectRecord(value: JsonValue | undefined): JsonObject | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  const parsed = nonemptyStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function providerResponseFromFetchResponse(response: Response): ProviderResponse {
  return {
    status: response.status,
    headers: headersToRecord(response.headers),
  };
}

function headersToRecord(headers: Headers): NonNullable<ProviderResponse["headers"]> {
  const record: NonNullable<ProviderResponse["headers"]> = {};
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
    const parsed = jsonObjectSchema.parse(JSON.parse(rawBody));
    const error = objectRecord(parsed.error);
    return stringValue(error?.message) ??
      stringValue(parsed.detail) ??
      stringValue(error?.code) ??
      null;
  } catch {
    return null;
  }
}

