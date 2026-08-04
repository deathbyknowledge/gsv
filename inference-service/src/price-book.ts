export type TokenUsage = {
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  outputTokens: number;
};

export type InferencePrice = {
  version: string;
  provider: string;
  modelRevision: string;
  apiModel: string;
  cacheHitInputMicrounitsPerMillionTokens: number;
  cacheMissInputMicrounitsPerMillionTokens: number;
  outputMicrounitsPerMillionTokens: number;
};

export const DEEPSEEK_V4_FLASH_0731_PRICE: InferencePrice = {
  version: "deepseek-v4-flash-0731:2026-07-31",
  provider: "deepseek",
  modelRevision: "DeepSeek-V4-Flash-0731",
  apiModel: "deepseek-v4-flash",
  cacheHitInputMicrounitsPerMillionTokens: 2_800,
  cacheMissInputMicrounitsPerMillionTokens: 140_000,
  outputMicrounitsPerMillionTokens: 280_000,
};

export const SYNTHETIC_PRICE: InferencePrice = {
  version: "synthetic:v1",
  provider: "synthetic",
  modelRevision: "synthetic-v1",
  apiModel: "synthetic",
  cacheHitInputMicrounitsPerMillionTokens: 10_000,
  cacheMissInputMicrounitsPerMillionTokens: 100_000,
  outputMicrounitsPerMillionTokens: 200_000,
};

export function maximumRequestCostMicrounits(
  price: InferencePrice,
  inputTokenCeiling: number,
  maxOutputTokens: number,
): number {
  return tokenCostMicrounits(
    {
      cacheHitInputTokens: 0,
      cacheMissInputTokens: inputTokenCeiling,
      outputTokens: maxOutputTokens,
    },
    price,
  );
}

export function tokenCostMicrounits(
  usage: TokenUsage,
  price: InferencePrice,
): number {
  const normalized = normalizeUsage(usage);
  const numerator =
    normalized.cacheHitInputTokens * price.cacheHitInputMicrounitsPerMillionTokens
    + normalized.cacheMissInputTokens * price.cacheMissInputMicrounitsPerMillionTokens
    + normalized.outputTokens * price.outputMicrounitsPerMillionTokens;
  return Math.ceil(numerator / 1_000_000);
}

export function normalizeUsage(usage: TokenUsage): TokenUsage {
  return {
    cacheHitInputTokens: nonNegativeInteger(usage.cacheHitInputTokens),
    cacheMissInputTokens: nonNegativeInteger(usage.cacheMissInputTokens),
    outputTokens: nonNegativeInteger(usage.outputTokens),
  };
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Inference token usage must be a non-negative safe integer");
  }
  return value;
}
