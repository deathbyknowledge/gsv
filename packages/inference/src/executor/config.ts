import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { InferenceConnection } from "@humansandmachines/gsv/services/inference-execution";
import type { WorkersAiBinding } from "../text/workers-ai";
import type { ExecutorLimits } from "./store";
import type { AudioTranscriptionBinding, AudioSpeechBinding, ImageGenerationBinding, ImageReadingBinding } from "../media";
import * as z from "zod/mini";
import { raceWithAbort } from "../shared/abort";

export type ExecutorEnvironment = {
  INSTALLATION_DIRECTORY: InstallationDirectoryService;
  AI?: WorkersAiBinding & AudioTranscriptionBinding & AudioSpeechBinding & ImageGenerationBinding & ImageReadingBinding;
  INFERENCE_MONTHLY_REQUESTS?: number;
  INFERENCE_MONTHLY_OUTPUT_TOKENS?: number;
  INFERENCE_MAX_OUTPUT_TOKENS?: number;
  INFERENCE_MAX_DURATION_MS?: number;
  INFERENCE_DEFAULT_PROVIDER?: string;
  INFERENCE_DEFAULT_MODEL?: string;
  INFERENCE_API_KEY?: string;
  INFERENCE_BASE_URL?: string;
};

export function executorLimits(env: ExecutorEnvironment): ExecutorLimits {
  return {
    monthlyRequests: limit(env.INFERENCE_MONTHLY_REQUESTS, 10_000),
    monthlyOutputTokens: limit(env.INFERENCE_MONTHLY_OUTPUT_TOKENS, 1_000_000),
    maxOutputTokens: limit(env.INFERENCE_MAX_OUTPUT_TOKENS, 32_768, 1),
    maxDurationMs: Math.min(limit(env.INFERENCE_MAX_DURATION_MS, 180_000, 1), 2_147_483_647),
  };
}

function limit(value: number | undefined, fallback: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid inference operator limit");
  return value;
}

export function opaqueId(value: string): string {
  if (!z.string().check(z.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/)).safeParse(value).success) {
    throw new Error("Invalid inference identity");
  }
  return value;
}

export async function requireActiveInstallation(env: ExecutorEnvironment, installationId: string, signal?: AbortSignal): Promise<void> {
  const pending = env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
  const result = await raceWithAbort(pending, signal, { onAbort: () => {
    // SAFETY: Cloudflare RPC promises may provide explicit disposal.
    (pending as typeof pending & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  } });
  if (!result.found || result.installationId !== installationId || result.state !== "active") {
    throw new Error("Installation is not active");
  }
}

export function executorConnection(env: ExecutorEnvironment, connection: InferenceConnection): InferenceConnection {
  if (connection.provider !== "gsv" || connection.model !== "default" || !env.INFERENCE_DEFAULT_PROVIDER) return connection;
  if (!env.INFERENCE_DEFAULT_MODEL) throw new Error("Default inference model is not configured");
  return {
    ...connection,
    provider: env.INFERENCE_DEFAULT_PROVIDER,
    model: env.INFERENCE_DEFAULT_MODEL,
    apiKey: env.INFERENCE_API_KEY ?? "",
    baseUrl: env.INFERENCE_BASE_URL,
  };
}
