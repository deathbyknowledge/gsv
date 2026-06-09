export type ProviderErrorContext = {
  provider?: string;
  model?: string;
};

const BILLING_ERROR_PATTERN =
  /\b(?:insufficient\s+(?:funds|credits|balance)|out\s+of\s+(?:credits?|quota)|no\s+(?:credits?|quota)|billing|payment|balance|credits?|quota\s+exceeded|exceeded\s+quota)\b/i;
const RATE_LIMIT_ERROR_PATTERN =
  /\b(?:rate\s*limit(?:ed)?|too\s+many\s+requests|http\s*429|429)\b/i;

export function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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
