import { env } from "cloudflare:workers";
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
  createGatewayBindingFetch,
  type AiGatewayBinding,
} from "@earendil-works/pi-ai/api/cloudflare-gateway-binding";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_WORKERS_AI_MODEL } from "./default-models";
import * as z from "zod/mini";

export const WORKERS_AI_PROVIDER = "workers-ai";
export const WORKERS_AI_PROVIDER_ALIAS = "workersai";
export { DEFAULT_WORKERS_AI_MODEL };

const PI_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";
const WORKERS_AI_GATEWAY_ID = "default";
const WORKERS_AI_GATEWAY_BASE_URL =
  `https://gateway.ai.cloudflare.com/v1/binding/${WORKERS_AI_GATEWAY_ID}`;
const WORKERS_AI_GATEWAY_COMPAT_URL = `${WORKERS_AI_GATEWAY_BASE_URL}/compat`;
const WORKERS_AI_GATEWAY_MODEL_PREFIX = "workers-ai/";

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

const workersAiContextWindowCache = new Map<string, Promise<number | null>>();
const workersAiGatewayPayloadSchema = z.looseObject({});
type WorkersAiGatewayPayload = z.infer<typeof workersAiGatewayPayloadSchema>;
type PiAiPayload = Parameters<NonNullable<SimpleStreamOptions["onPayload"]>>[0];

const workersAiCatalog = getBuiltinModels(PI_WORKERS_AI_PROVIDER);
if (!workersAiCatalog.some((model) => model.id === GLM_5_3_FLASH.id)) {
  workersAiCatalog.push(GLM_5_3_FLASH);
}

export const workersAiProvider: Provider<"openai-completions"> =
  createProvider<"openai-completions">({
    id: WORKERS_AI_PROVIDER,
    name: "Cloudflare Workers AI",
    auth: {
      apiKey: {
        name: "Workers AI binding",
        resolve: async ({ signal }) => {
          signal.throwIfAborted();
          if (!getWorkersAiBinding()) return undefined;
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
        baseUrl: WORKERS_AI_GATEWAY_COMPAT_URL,
      };
      return [workersAiModel];
    }),
    api: openAICompletionsApi(),
  });

const workersAiGatewayBinding: AiGatewayBinding = {
  gateway(id) {
    const binding = getWorkersAiBinding();
    if (!binding) {
      throw new Error("Workers AI binding is not configured for this worker");
    }
    return binding.gateway(id);
  },
};

export const workersAiBindingFetch = createGatewayBindingFetch({
  binding: workersAiGatewayBinding,
  baseUrl: WORKERS_AI_GATEWAY_BASE_URL,
  gateway: WORKERS_AI_GATEWAY_ID,
});

export function isWorkersAiProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === WORKERS_AI_PROVIDER || normalized === WORKERS_AI_PROVIDER_ALIAS;
}

export function resolveWorkersAiModelMetadata(
  modelName: string,
): Model<"openai-completions"> | null {
  return workersAiProvider.getModels().find((model) => model.id === modelName) ?? null;
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
): Promise<number | null> {
  const catalogModel = resolveWorkersAiModelMetadata(modelName);
  if (catalogModel) return catalogModel.contextWindow;

  const cacheKey = normalizeWorkersAiModelName(modelName);
  const cached = workersAiContextWindowCache.get(cacheKey);
  if (cached) return cached;

  const lookup = lookupWorkersAiModelContextWindow(modelName);
  workersAiContextWindowCache.set(cacheKey, lookup);
  return lookup;
}

export function hasWorkersAiModelPricing(modelName: string): boolean {
  return resolveWorkersAiModelMetadata(modelName) !== null;
}

async function lookupWorkersAiModelContextWindow(
  modelName: string,
): Promise<number | null> {
  const ai = getWorkersAiBinding();
  if (!ai) return null;

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

function getWorkersAiBinding(): Ai | undefined {
  const bindings: { AI?: Ai } = env;
  return bindings.AI;
}
