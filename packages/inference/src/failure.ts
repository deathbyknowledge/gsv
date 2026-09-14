import type {
  InferenceFailureKind,
  InferenceFailureStage,
} from "@humansandmachines/gsv/telemetry";

export type InferenceFailure = {
  kind: InferenceFailureKind;
  stage: InferenceFailureStage;
  retryable: boolean;
  providerStatusCode?: number;
};

export type ProviderFailureInput = {
  stage: Extract<InferenceFailureStage, "provider" | "stream">;
  statusCode?: number;
  message?: string;
  timedOut?: boolean;
  transportFailed?: boolean;
};

const CONTEXT_OVERFLOW_PATTERN =
  /(?:context(?: length| window)?|input|prompt).*(?:too (?:large|long)|exceed|limit|maximum)|maximum context|request_too_large/i;
const CAPACITY_PATTERN =
  /(?:at|over|out of) capacity|overloaded|no (?:available )?capacity|temporarily unavailable due to demand/i;
const RATE_LIMIT_PATTERN = /rate[\s_-]*limit|too many requests/i;
const AUTHENTICATION_PATTERN =
  /unauthori[sz]ed|forbidden|authentication|invalid (?:api )?key|missing (?:api )?key/i;
const BILLING_PATTERN =
  /payment required|insufficient (?:funds|credits|balance)|out of credits|billing/i;
const PROTOCOL_PATTERN =
  /ended without (?:a )?(?:terminal event|result)|stream ended without finish_reason|non-standard error response/i;
const NETWORK_PATTERN =
  /network|fetch failed|connection|socket|dns|econn|enotfound/i;

export function classifyProviderFailure(
  input: ProviderFailureInput,
): InferenceFailure {
  const statusCode = validHttpStatus(input.statusCode);
  const message = input.message ?? "";

  if (input.timedOut) {
    return inferenceFailure("timeout", input.stage, true, statusCode);
  }
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) {
    return inferenceFailure("context_overflow", input.stage, false, statusCode);
  }
  if (CAPACITY_PATTERN.test(message)) {
    return inferenceFailure("capacity", input.stage, true, statusCode);
  }
  if (RATE_LIMIT_PATTERN.test(message)) {
    return inferenceFailure("rate_limited", input.stage, true, statusCode);
  }
  if (AUTHENTICATION_PATTERN.test(message)) {
    return inferenceFailure("authentication", input.stage, false, statusCode);
  }
  if (BILLING_PATTERN.test(message)) {
    return inferenceFailure("billing", input.stage, false, statusCode);
  }
  if (PROTOCOL_PATTERN.test(message)) {
    return inferenceFailure("protocol", input.stage, true, statusCode);
  }
  if (input.transportFailed) {
    return inferenceFailure("network", input.stage, true, statusCode);
  }

  if (statusCode !== undefined) {
    if (statusCode === 401 || statusCode === 403) {
      return inferenceFailure("authentication", input.stage, false, statusCode);
    }
    if (statusCode === 402) {
      return inferenceFailure("billing", input.stage, false, statusCode);
    }
    if (statusCode === 408 || statusCode === 504) {
      return inferenceFailure("timeout", input.stage, true, statusCode);
    }
    if (statusCode === 413) {
      return inferenceFailure("context_overflow", input.stage, false, statusCode);
    }
    if (statusCode === 429) {
      return inferenceFailure("rate_limited", input.stage, true, statusCode);
    }
    if (statusCode >= 500) {
      return inferenceFailure("provider_unavailable", input.stage, true, statusCode);
    }
    if (statusCode >= 400) {
      return inferenceFailure("invalid_request", input.stage, false, statusCode);
    }
  }
  if (NETWORK_PATTERN.test(message)) {
    return inferenceFailure("network", input.stage, true);
  }
  return inferenceFailure("unknown", input.stage, false, statusCode);
}

export function protocolFailure(): InferenceFailure {
  return inferenceFailure("protocol", "stream", true);
}

export function abandonedFailure(): InferenceFailure {
  return inferenceFailure("timeout", "lifecycle", true);
}

export function inferenceFailure(
  kind: InferenceFailureKind,
  stage: InferenceFailureStage,
  retryable: boolean,
  providerStatusCode?: number,
): InferenceFailure {
  const result: InferenceFailure = {
    kind,
    stage,
    retryable,
  };
  if (providerStatusCode !== undefined) result.providerStatusCode = providerStatusCode;
  return result;
}

function validHttpStatus(value: number | undefined): number | undefined {
  if (
    value === undefined
    || !Number.isSafeInteger(value)
    || value < 100
    || value > 599
  ) {
    return undefined;
  }
  return value;
}
