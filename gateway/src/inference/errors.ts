import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";

export type ProviderErrorContext = {
  provider?: string;
  model?: string;
  contextWindowTokens?: number | null;
};

export const NON_STANDARD_PROVIDER_ERROR =
  "Provider returned a non-standard error response.";

const BILLING_ERROR_PATTERN =
  /\b(?:http\s*402|error\s*code:\s*402|402|payment[\s_-]+required|insufficient[\s_-]+(?:funds|credits|balance|quota)|out[\s_-]+of[\s_-]+(?:credits?|quota)|no[\s_-]+(?:credits?|quota)|billing|payment|balance(?:[\s_-]+low)?|credits?|quota[\s_-]+exceeded|exceeded[\s_-]+quota)\b/i;
const RATE_LIMIT_ERROR_PATTERN =
  /\b(?:rate\s*limit(?:ed)?|too\s+many\s+requests|http\s*429|429)\b/i;

type ProviderErrorClassifier = {
  name: string;
  matches: (text: string) => boolean;
};

const PROMOTABLE_PROVIDER_ERROR_CLASSIFIERS: ProviderErrorClassifier[] = [
  { name: "account", matches: isProviderAccountErrorText },
  { name: "rate-limit", matches: isProviderRateLimitErrorText },
  { name: "context-overflow", matches: isProviderContextOverflowErrorText },
];

export function errorMessageFromUnknown(error: unknown): string {
  return extractErrorText(error, new Set()) ?? NON_STANDARD_PROVIDER_ERROR;
}

function extractErrorText(error: unknown, seen: Set<object>): string | null {
  if (error instanceof Error) {
    if (seen.has(error)) {
      return null;
    }
    seen.add(error);

    const text = normalizeOptionalErrorText(error.message);
    const causeText = extractErrorText((error as { cause?: unknown }).cause, seen);
    if (causeText && (!text || isRecognizedProviderErrorText(causeText))) {
      return causeText;
    }
    return text ?? causeText;
  }
  if (typeof error === "string") {
    return normalizeOptionalErrorText(error);
  }
  if (!error || typeof error !== "object") {
    return null;
  }

  if (seen.has(error)) {
    return null;
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  for (const field of ["message", "detail", "error_description", "errorDescription"]) {
    const text = normalizeOptionalErrorText(record[field]);
    if (text) {
      return text;
    }
  }

  const nestedError = record.error;
  if (typeof nestedError === "string") {
    const text = normalizeOptionalErrorText(nestedError);
    if (text) {
      return text;
    }
  }
  const nested = extractErrorText(nestedError, seen) ??
    extractErrorText(record.cause, seen) ??
    extractErrorText(record.response, seen) ??
    extractErrorText(record.data, seen);
  if (nested) {
    return nested;
  }

  const errors = record.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const text = extractErrorText(item, seen);
      if (text) {
        return text;
      }
    }
  }

  const statusOrCode = extractStatusOrCodeText(record);
  if (statusOrCode) {
    return statusOrCode;
  }

  return null;
}

export function formatProviderErrorMessage(
  message: string,
  context?: ProviderErrorContext,
): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  if (
    trimmed.startsWith("Provider account issue") ||
    trimmed.startsWith("Provider rate limit")
  ) {
    return trimmed;
  }

  const normalized = normalizeErrorText(trimmed);
  const source = formatProviderSource(context);
  if (isProviderAccountErrorText(normalized)) {
    return [
      `Provider account issue${source}: ${normalized}`,
      "Check credits, quota, or billing for the configured AI provider.",
    ].join("\n");
  }

  if (isProviderRateLimitErrorText(normalized)) {
    return [
      `Provider rate limit${source}: ${normalized}`,
      "Wait and retry, or switch to another configured AI provider or model.",
    ].join("\n");
  }

  return normalized;
}

export function isProviderContextOverflow(
  message: AssistantMessage,
  contextWindowTokens?: number | null,
): boolean {
  if (requiresUsageForOverflowDetection(message) && !hasAssistantUsage(message)) {
    return false;
  }
  return isContextOverflow(message, normalizeContextWindowTokens(contextWindowTokens));
}

export function isProviderContextOverflowErrorMessage(
  message: string,
  context?: ProviderErrorContext,
): boolean {
  return isProviderContextOverflow(
    buildProviderErrorAssistantMessage(message, context),
    context?.contextWindowTokens,
  );
}

export function formatProviderContextOverflowMessage(
  providerMessage: string | undefined,
  context?: ProviderErrorContext,
): string {
  const source = formatProviderModelLabel(context);
  const lines = [
    source
      ? `Context limit reached for ${source}.`
      : "Context limit reached at the AI provider.",
    "The provider reported that this request exceeds the model context window.",
    "Compact or reset the conversation, remove attachments, or switch to a model with a larger context window.",
  ];
  const normalized = providerMessage
    ? formatProviderErrorMessage(providerMessage, context)
    : "";
  if (normalized) {
    lines.push("", `Provider message: ${normalized}`);
  }
  return lines.join("\n");
}

function requiresUsageForOverflowDetection(message: AssistantMessage): boolean {
  return message.stopReason === "stop" || message.stopReason === "length";
}

function hasAssistantUsage(message: AssistantMessage): boolean {
  const usage = (message as { usage?: unknown }).usage;
  return !!usage && typeof usage === "object";
}

function buildProviderErrorAssistantMessage(
  errorMessage: string,
  context: ProviderErrorContext | undefined,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "gsv-provider-error",
    provider: context?.provider ?? "unknown",
    model: context?.model ?? "unknown",
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
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

function normalizeContextWindowTokens(value: number | null | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function formatProviderModelLabel(context: ProviderErrorContext | undefined): string {
  const provider = context?.provider?.trim();
  const model = context?.model?.trim();
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return provider || model || "";
}

function normalizeErrorText(message: string): string {
  return message.trim().replace(/\s+/g, " ");
}

function normalizeOptionalErrorText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function extractStatusOrCodeText(record: Record<string, unknown>): string | null {
  for (const field of ["code", "type"]) {
    const text = normalizeOptionalErrorText(record[field]);
    if (text && isRecognizedProviderStatusOrCode(text)) {
      return text;
    }
  }

  for (const field of ["status", "statusCode"]) {
    const status = providerStatusCode(record[field]);
    if (status) {
      return `HTTP ${status}`;
    }
  }

  return null;
}

function isRecognizedProviderStatusOrCode(text: string): boolean {
  return isRecognizedProviderErrorText(text);
}

function isRecognizedProviderErrorText(text: string): boolean {
  return PROMOTABLE_PROVIDER_ERROR_CLASSIFIERS.some((classifier) => classifier.matches(text));
}

function isProviderAccountErrorText(text: string): boolean {
  return BILLING_ERROR_PATTERN.test(text);
}

function isProviderRateLimitErrorText(text: string): boolean {
  return RATE_LIMIT_ERROR_PATTERN.test(text);
}

function isProviderContextOverflowErrorText(text: string): boolean {
  return isProviderContextOverflowErrorMessage(text);
}

function providerStatusCode(value: unknown): 402 | 429 | null {
  const status = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : null;

  return status === 402 || status === 429 ? status : null;
}

function formatProviderSource(context: ProviderErrorContext | undefined): string {
  const provider = context?.provider?.trim();
  const model = context?.model?.trim();
  if (!provider && !model) {
    return "";
  }
  if (provider && model) {
    return ` from ${provider}/${model}`;
  }
  return ` from ${provider ?? model}`;
}
