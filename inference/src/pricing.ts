import type {
  ManagedInferenceRequest,
  ManagedInferenceResult,
  ManagedInferenceRouting,
} from "@humansandmachines/gsv/protocol";

export function reservationNanoUsd(
  input: ManagedInferenceRequest,
  routing: ManagedInferenceRouting,
): number {
  const encodedContext = new TextEncoder().encode(JSON.stringify({
    systemPrompt: input.systemPrompt ?? "",
    messages: input.messages,
    tools: input.tools ?? [],
  }));
  const contextOverhead = 1_024
    + input.messages.length * 16
    + (input.tools?.length ?? 0) * 16;
  const inputTokens = Math.min(
    routing.contextWindow,
    encodedContext.byteLength + contextOverhead,
  );
  return checkedNanoUsd(
    inputTokens * routing.inputNanoUsdPerToken
      + Math.min(input.maxOutputTokens, routing.maxOutputTokens)
        * routing.outputNanoUsdPerToken,
  );
}

export function usageNanoUsd(
  usage: ManagedInferenceResult["usage"],
  routing: ManagedInferenceRouting,
): number {
  return checkedNanoUsd(
    usage.input * routing.inputNanoUsdPerToken
      + usage.output * routing.outputNanoUsdPerToken
      + usage.cacheRead * routing.cacheReadNanoUsdPerToken
      + usage.cacheWrite * routing.cacheWriteNanoUsdPerToken,
  );
}

function checkedNanoUsd(value: number): number {
  const rounded = Math.ceil(value);
  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw new Error("Managed inference cost is outside the supported range");
  }
  return rounded;
}
