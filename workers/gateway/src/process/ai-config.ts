import type { ProcAiConfig } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

export const PROCESS_AI_CONFIG_STORE_KEY = "aiConfig";

const positiveTimestampSchema = z.number().finite().positive();
const storedProcessAiConfigSchema = z.object({
  version: z.literal(2),
  modelId: z.string().optional(),
  reasoning: z.string().optional(),
  updatedAt: positiveTimestampSchema.optional().catch(undefined),
}).strict();

const PROCESS_AI_ROOT_FILES = [
  "effective.json",
  "local.json",
  "model",
  "models",
  "reasoning",
] as const;

export function processAiConfigDirEntries(parts: string[] = []): string[] {
  return parts.filter(Boolean).length === 0 ? [...PROCESS_AI_ROOT_FILES].sort() : [];
}

export function createProcessAiConfig(
  input: { modelId?: string | null; reasoning?: string | null },
  now = Date.now(),
): ProcAiConfig | null {
  const modelId = normalizeProcessAiModelId(input.modelId);
  const reasoning = normalizeProcessAiReasoning(input.reasoning);
  if (!modelId && !reasoning) {
    return null;
  }
  const config: ProcAiConfig = {
    version: 2,
    updatedAt: now,
  };
  if (modelId) config.modelId = modelId;
  if (reasoning) config.reasoning = reasoning;
  return config;
}

export function parseProcessAiConfig(raw: string): ProcAiConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = storedProcessAiConfigSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return createProcessAiConfig({
    modelId: parsed.data.modelId,
    reasoning: parsed.data.reasoning,
  }, parsed.data.updatedAt ?? Date.now());
}

export function normalizeProcessAiModelId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)
    ? normalized
    : undefined;
}

export function normalizeProcessAiReasoning(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "off" ||
      normalized === "minimal" ||
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high" ||
      normalized === "xhigh"
    ? normalized
    : undefined;
}
