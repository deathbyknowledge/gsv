import {
  createProvider,
  type Api,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_WORKERS_AI_MODEL } from "./default-models";
import * as z from "zod/mini";

export const WORKERS_AI_PROVIDER = "workers-ai";
export const WORKERS_AI_PROVIDER_ALIAS = "workersai";
export { DEFAULT_WORKERS_AI_MODEL };

const PI_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";
const WORKERS_AI_GATEWAY_ID = "default";
const WORKERS_AI_GATEWAY_MODEL_PREFIX = "workers-ai/";

// The 0.84.2 note below is historical: GSV now uses pi-ai 0.85.1's direct binding.
// Production enables node:os through its compatibility date; unit tests request
// it explicitly, resolving the earlier crash when loading the provider module.
// pi-ai 0.84.3+ imports a Node user-agent helper that crashes the current
// Workerd runtime during module evaluation. Keep 0.84.2's binding transport
// and carry the newer catalog entry locally until that incompatibility clears.
const GLM_5_3_FLASH: Model<"openai-completions"> = {
  id: "@cf/zai-org/glm-5.3-flash",
  name: "GLM-5.3-Flash",
  api: "openai-completions",
  provider: PI_WORKERS_AI_PROVIDER,
  baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0.15,
    output: 0.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  contextWindow: 1_310_720,
  maxTokens: 1_310_720,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    sendSessionAffinityHeaders: true,
  },
};

type WorkersAiCatalogProperty = {
  property_id: string;
  value: string;
};

type WorkersAiCatalogModel = {
  id: string;
  name?: string;
  description?: string;
  properties?: WorkersAiCatalogProperty[];
};

export type WorkersAiBinding = AiBinding & {
  models?(options: { search: string; per_page: number }): Promise<WorkersAiCatalogModel[]>;
};
const workersAiGatewayPayloadSchema = z.looseObject({});
type WorkersAiGatewayPayload = z.infer<typeof workersAiGatewayPayloadSchema>;
type PiAiPayload = Parameters<NonNullable<SimpleStreamOptions["onPayload"]>>[0];

const workersAiCatalog = getBuiltinModels(PI_WORKERS_AI_PROVIDER);
if (!workersAiCatalog.some((model) => model.id === GLM_5_3_FLASH.id)) {
  workersAiCatalog.push(GLM_5_3_FLASH);
}

export function createWorkersAiProvider(
  binding: WorkersAiBinding | undefined,
  gatewayId = WORKERS_AI_GATEWAY_ID,
): Provider<"openai-completions"> {
  const baseUrl = `https://workers-binding.ai/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/compat`;
  return createProvider<"openai-completions">({
    id: WORKERS_AI_PROVIDER,
    name: "Cloudflare Workers AI",
    auth: {
      apiKey: {
        name: "Workers AI binding",
        resolve: async ({ signal }) => {
          signal.throwIfAborted();
          if (!binding) return undefined;
          return {
            auth: {
              headers: {
                "cf-aig-authorization":
                  `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
                "cf-aig-collect-log": "false",
                Authorization: null,
                "x-api-key": null,
              },
            },
            source: "Workers AI binding",
          };
        },
      },
    },
    models: workersAiCatalog.flatMap((model) => {
      if (model.api !== "openai-completions") return [];
      const workersAiModel: Model<"openai-completions"> = {
        ...model,
        provider: WORKERS_AI_PROVIDER,
        baseUrl,
        // The binding URL does not match pi-ai's HTTPS gateway detection.
        compat: {
          maxTokensField: "max_tokens",
          supportsReasoningEffort: false,
          supportsStrictMode: false,
          ...model.compat,
        },
      };
      return [workersAiModel];
    }),
    api: openAICompletionsApi(),
  });
}

export function workersAiBindingFetch(binding: WorkersAiBinding | undefined): typeof fetch {
  if (!binding) {
    throw new Error("Workers AI binding is not configured for this worker");
  }
  return createAiBindingFetch(binding);
}

export function isWorkersAiProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === WORKERS_AI_PROVIDER || normalized === WORKERS_AI_PROVIDER_ALIAS;
}

export function resolveWorkersAiModelMetadata(
  modelName: string,
): Model<"openai-completions"> | null {
  return createWorkersAiProvider(undefined).getModels().find((model) => model.id === modelName) ?? null;
}

export function prepareWorkersAiGatewayPayload(
  payload: PiAiPayload,
  model: Model<Api>,
): WorkersAiGatewayPayload {
  const parsed = workersAiGatewayPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Workers AI generated an invalid request payload");
  }
  return {
    ...parsed.data,
    model: `${WORKERS_AI_GATEWAY_MODEL_PREFIX}${model.id}`,
  };
}

export function extractWorkersAiContextWindow(
  model: WorkersAiCatalogModel,
): number | null {
  for (const property of model.properties ?? []) {
    if (!isContextWindowPropertyId(property.property_id)) continue;
    const tokens = parseTokenQuantity(property.value);
    if (tokens !== null) return tokens;
  }
  return parseContextWindowDescription(model.description ?? "");
}

export async function resolveWorkersAiModelContextWindow(
  modelName: string,
  binding?: WorkersAiBinding,
): Promise<number | null> {
  const catalogModel = resolveWorkersAiModelMetadata(modelName);
  if (catalogModel) return catalogModel.contextWindow;

  return lookupWorkersAiModelContextWindow(modelName, binding);
}

export function hasWorkersAiModelPricing(modelName: string): boolean {
  return resolveWorkersAiModelMetadata(modelName) !== null;
}

async function lookupWorkersAiModelContextWindow(
  modelName: string,
  ai: WorkersAiBinding | undefined,
): Promise<number | null> {
  if (!ai?.models) return null;

  try {
    for (const search of workersAiModelSearchTerms(modelName)) {
      const models = await ai.models({ search, per_page: 50 });
      const exact = models.find((candidate) =>
        isWorkersAiModelMatch(candidate, modelName)
      );
      const contextWindow = exact ? extractWorkersAiContextWindow(exact) : null;
      if (contextWindow !== null) return contextWindow;
    }
  } catch {
    return null;
  }
  return null;
}

function workersAiModelSearchTerms(modelName: string): string[] {
  const lastSegment = modelName.split("/").filter(Boolean).at(-1);
  return Array.from(new Set([
    modelName,
    lastSegment ?? modelName,
  ].map((term) => term.trim()).filter((term) => term.length > 0)));
}

function isWorkersAiModelMatch(
  model: WorkersAiCatalogModel,
  modelName: string,
): boolean {
  const requested = normalizeWorkersAiModelName(modelName);
  return [model.id, model.name].some((candidate) =>
    candidate !== undefined
    && normalizeWorkersAiModelName(candidate) === requested
  );
}

function normalizeWorkersAiModelName(value: string): string {
  return value.trim().toLowerCase().replace(/^@cf\//, "");
}

function isContextWindowPropertyId(propertyId: string): boolean {
  const normalized = propertyId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("context")
    && (
      normalized.includes("window")
      || normalized.includes("token")
      || normalized.includes("length")
    )
  ) || (
    normalized.includes("max")
    && normalized.includes("input")
    && normalized.includes("token")
  );
}

function parseContextWindowDescription(description: string): number | null {
  const normalized = description.replace(/,/g, "");
  const patterns = [
    /(\d+(?:\.\d+)?)\s*[km]\s*(?:token\s*)?context window/i,
    /(\d+(?:\.\d+)?)\s*(?:token|tokens)\s*context window/i,
    /context window[^.]{0,80}?(\d+(?:\.\d+)?)\s*[km]/i,
    /up to\s+(\d+(?:\.\d+)?)\s*[km]\s*tokens/i,
    /up to\s+(\d+(?:\.\d+)?)\s*(?:token|tokens)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const tokens = match ? parseTokenQuantity(match[0]) : null;
    if (tokens !== null) return tokens;
  }
  return null;
}

function parseTokenQuantity(value: string): number | null {
  const normalized = value.toLowerCase().replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([km])?\b/);
  if (!match) return null;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const multiplier = match[2] === "m"
    ? 1_000_000
    : match[2] === "k"
      ? 1_000
      : 1;
  const tokens = Math.round(amount * multiplier);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}
