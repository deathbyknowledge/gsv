export type ProviderErrorContext = {
  provider?: string;
  model?: string;
};

export const NON_STANDARD_PROVIDER_ERROR =
  "Provider returned a non-standard error response.";

const BILLING_ERROR_PATTERN =
  /\b(?:http\s*402|error\s*code:\s*402|402|payment[\s_-]+required|insufficient[\s_-]+(?:funds|credits|balance|quota)|out[\s_-]+of[\s_-]+(?:credits?|quota)|no[\s_-]+(?:credits?|quota)|billing|payment|balance(?:[\s_-]+low)?|credits?|quota[\s_-]+exceeded|exceeded[\s_-]+quota)\b/i;
const RATE_LIMIT_ERROR_PATTERN =
  /\b(?:rate\s*limit(?:ed)?|too\s+many\s+requests|http\s*429|429)\b/i;

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
  if (BILLING_ERROR_PATTERN.test(normalized)) {
    return [
      `Provider account issue${source}: ${normalized}`,
      "Check credits, quota, or billing for the configured AI provider.",
    ].join("\n");
  }

  if (RATE_LIMIT_ERROR_PATTERN.test(normalized)) {
    return [
      `Provider rate limit${source}: ${normalized}`,
      "Wait and retry, or switch to another configured AI provider or model.",
    ].join("\n");
  }

  return normalized;
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
  return BILLING_ERROR_PATTERN.test(text) || RATE_LIMIT_ERROR_PATTERN.test(text);
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
