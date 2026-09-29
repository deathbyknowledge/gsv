import { z } from "zod";
import type { AiModelListEntry, AiModelSource } from "@humansandmachines/gsv/protocol";
import type { ConsoleConfigEntry } from "./consoleModels";
import type { ConsoleModelListing } from "./consoleSettings";

const storedStackSchema = z.object({
  version: z.literal(1),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    model: z.string(),
    baseUrl: z.string().optional(),
    providerStyle: z.string().optional(),
    transportTarget: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
  })),
});

/**
 * Builds the listing the Kernel would return for a viewer whose stack is the
 * configured personal list, or the system list when none exists. Tests use it
 * so config fixtures keep describing the stack they expect.
 */
export function listingFromConfig(
  config: readonly ConsoleConfigEntry[],
  uid: number | null | undefined,
): ConsoleModelListing | null {
  const candidates: Array<[string, AiModelSource]> = uid !== null && uid !== undefined && uid !== 0
    ? [[`users/${uid}/ai/models`, "personal"], ["config/ai/models", "system"]]
    : [["config/ai/models", "system"]];
  for (const [key, source] of candidates) {
    const raw = config.find((entry) => entry.key === key)?.value;
    if (!raw) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      continue;
    }
    const stack = storedStackSchema.safeParse(decoded);
    if (!stack.success) continue;
    const models: AiModelListEntry[] = stack.data.models.map((entry) => ({
      ...entry,
      source,
      hasCredential: config.some((item) => item.key === `${key}/${entry.id}/api_key` && item.value.length > 0),
    }));
    return { models, preferredModelId: null };
  }
  return null;
}
