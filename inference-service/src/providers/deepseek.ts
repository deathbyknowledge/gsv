import type {
  AssistantMessageEventStream,
  Context,
  Model,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ParsedInferenceRequest } from "../domain";
import { DEEPSEEK_V4_FLASH_0731_PRICE } from "../price-book";
import type { ManagedProvider } from "./types";

const models = builtinModels();

export function createDeepSeekProvider(apiKey: string): ManagedProvider {
  if (!apiKey.trim()) {
    throw new Error("DeepSeek managed inference credential is not configured");
  }
  const registered = getBuiltinModels("deepseek").find(
    (candidate) => candidate.id === DEEPSEEK_V4_FLASH_0731_PRICE.apiModel,
  );
  if (!registered) {
    throw new Error("DeepSeek V4 Flash is absent from the provider registry");
  }
  // The July 31 API supports low/high/max. Keep this release-specific map here
  // instead of making the stable gsv/default contract provider-specific.
  const model: Model<"openai-completions"> = {
    ...registered,
    thinkingLevelMap: {
      ...registered.thinkingLevelMap,
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "high",
      max: "max",
    },
  } as Model<"openai-completions">;

  return {
    price: DEEPSEEK_V4_FLASH_0731_PRICE,
    async stream(input): Promise<AssistantMessageEventStream> {
      const userId = await opaqueDeepSeekUserId(
        input.request.installationId,
        input.request.actor.localUid,
      );
      return models.streamSimple(model, input.context, {
        apiKey,
        fetch: deepSeekIsolatingFetch(userId, input.attemptId),
        maxTokens: input.request.maxOutputTokens,
        reasoning: input.reasoning,
        signal: input.signal,
      });
    },
  };
}

export function mapDeepSeekReasoning(
  value: ParsedInferenceRequest["reasoning"],
): ThinkingLevel | undefined {
  if (!value || value === "off") return undefined;
  if (value === "minimal" || value === "low") return "low";
  if (value === "max") return "max";
  return "high";
}

export async function opaqueDeepSeekUserId(
  installationId: string,
  localUid: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([installationId, localUid]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `gsv_${hex}`;
}

export function deepSeekIsolatingFetch(
  userId: string,
  attemptId: string,
  fetchFn: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.protocol !== "https:"
      ||
      url.hostname !== "api.deepseek.com"
      || request.method !== "POST"
      || !url.pathname.endsWith("/chat/completions")
    ) {
      throw new Error("Managed DeepSeek request target is not allowed");
    }
    const body = await request.clone().json<Record<string, unknown>>();
    body.user_id = userId;
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.set("x-client-request-id", attemptId);
    return await fetchFn(new Request(request, {
      headers,
      body: JSON.stringify(body),
    }));
  };
}
