import type {
  ManagedInferenceRequest,
  ManagedInferenceResult,
} from "@humansandmachines/gsv/protocol";

export const MANAGED_INFERENCE_CONTEXT_WINDOW = 1_048_576;
export const MANAGED_INFERENCE_MAX_OUTPUT_TOKENS = 384_000;

export const MANAGED_INFERENCE_MODEL_COST = {
  input: 0.08,
  output: 0.18,
  cacheRead: 0.016,
  cacheWrite: 0,
} as const;

const NANO_USD_PER_TOKEN = {
  input: 80,
  output: 180,
  cacheRead: 16,
  cacheWrite: 0,
} as const;

export function reservationNanoUsd(input: ManagedInferenceRequest): number {
  const encodedContext = new TextEncoder().encode(JSON.stringify({
    systemPrompt: input.systemPrompt ?? "",
    messages: input.messages,
    tools: input.tools ?? [],
  }));
  const contextOverhead = 1_024
    + input.messages.length * 16
    + (input.tools?.length ?? 0) * 16;
  const inputTokens = Math.min(
    MANAGED_INFERENCE_CONTEXT_WINDOW,
    encodedContext.byteLength + contextOverhead,
  );
  return checkedNanoUsd(
    inputTokens * NANO_USD_PER_TOKEN.input
      + input.maxOutputTokens * NANO_USD_PER_TOKEN.output,
  );
}

export function usageNanoUsd(usage: ManagedInferenceResult["usage"]): number {
  return checkedNanoUsd(
    usage.input * NANO_USD_PER_TOKEN.input
      + usage.output * NANO_USD_PER_TOKEN.output
      + usage.cacheRead * NANO_USD_PER_TOKEN.cacheRead
      + usage.cacheWrite * NANO_USD_PER_TOKEN.cacheWrite,
  );
}

function checkedNanoUsd(value: number): number {
  const rounded = Math.ceil(value);
  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw new Error("Managed inference cost is outside the supported range");
  }
  return rounded;
}
