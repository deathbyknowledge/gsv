import { InferenceBoundaryError } from "../domain";
import { createDeepSeekProvider } from "./deepseek";
import { createSyntheticProvider } from "./synthetic";
import type { ManagedProvider } from "./types";

export type ProviderEnvironment = {
  ENVIRONMENT?: string;
  MANAGED_INFERENCE_PROVIDER?: string;
  DEEPSEEK_API_KEY?: string;
  SYNTHETIC_DELAY_MS?: string;
  SYNTHETIC_FAIL_FIRST_ATTEMPT?: string;
  SYNTHETIC_THROW_REQUEST_PREFIX?: string;
};

export function resolveManagedProvider(env: ProviderEnvironment): ManagedProvider {
  const provider = env.MANAGED_INFERENCE_PROVIDER?.trim().toLowerCase() || "disabled";
  if (provider === "deepseek") {
    if (!env.DEEPSEEK_API_KEY?.trim()) {
      throw new InferenceBoundaryError(
        "Managed inference provider is not configured",
        503,
        "provider_unavailable",
      );
    }
    return createDeepSeekProvider(env.DEEPSEEK_API_KEY);
  }
  if (provider === "synthetic" && env.ENVIRONMENT === "test") {
    return createSyntheticProvider({
      delayMs: parseNonNegativeInteger(env.SYNTHETIC_DELAY_MS, 0),
      failFirstAttempt: env.SYNTHETIC_FAIL_FIRST_ATTEMPT === "true",
      ...(env.SYNTHETIC_THROW_REQUEST_PREFIX
        ? { throwRequestPrefix: env.SYNTHETIC_THROW_REQUEST_PREFIX }
        : {}),
    });
  }
  throw new InferenceBoundaryError(
    "Managed inference provider is not enabled",
    503,
    "provider_disabled",
  );
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
