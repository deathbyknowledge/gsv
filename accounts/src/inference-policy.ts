import {
  MANAGED_INFERENCE_QUANTIZATIONS,
  type ManagedInferencePolicy,
  type ManagedInferenceQuantization,
  type ManagedInferenceRouting,
} from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "./domain";

export type ManagedInferenceControl = {
  enabled: boolean;
  updatedAt: number;
};

export type ManagedInferenceInstallationPolicy = {
  enabled: boolean;
  monthlyLimitNanoUsd: number;
  updatedAt: number | null;
};

type ResolvedPolicyRow = {
  state: string | null;
  control_enabled: number;
  policy_enabled: number;
  monthly_limit_nano_usd: number;
} & RoutingRow;

type RoutingRow = {
  model_id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  reasoning: number;
  input_nano_usd_per_token: number;
  output_nano_usd_per_token: number;
  cache_read_nano_usd_per_token: number;
  cache_write_nano_usd_per_token: number;
  allow_fallbacks: number;
  require_parameters: number;
  data_collection: string;
  zdr: number;
  provider_order_json: string;
  provider_only_json: string;
  provider_ignore_json: string;
  quantizations_json: string;
  provider_sort: string;
  preferred_min_throughput: number | null;
  preferred_max_latency: number | null;
  updated_at: number;
};

export type ManagedInferenceRoutingUpdate = Omit<
  ManagedInferenceRouting,
  "version" | "updatedAt"
>;

export class ManagedInferencePolicyStore {
  constructor(private readonly db: D1Database) {}

  async resolve(
    installationIdValue: string,
  ): Promise<ManagedInferencePolicy> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const row = await this.db.prepare(
      `SELECT
         i.state,
         c.enabled AS control_enabled,
         COALESCE(p.enabled, 0) AS policy_enabled,
         COALESCE(p.monthly_limit_nano_usd, 0) AS monthly_limit_nano_usd,
         r.model_id, r.display_name, r.context_window, r.max_output_tokens,
         r.reasoning, r.input_nano_usd_per_token,
         r.output_nano_usd_per_token, r.cache_read_nano_usd_per_token,
         r.cache_write_nano_usd_per_token, r.allow_fallbacks,
         r.require_parameters, r.data_collection, r.zdr,
         r.provider_order_json, r.provider_only_json,
         r.provider_ignore_json, r.quantizations_json, r.provider_sort,
         r.preferred_min_throughput, r.preferred_max_latency, r.updated_at
       FROM managed_inference_control c
       CROSS JOIN managed_inference_routing r
       LEFT JOIN installations i ON i.id = ? AND i.state != 'deleted'
       LEFT JOIN managed_inference_policies p ON p.installation_id = i.id
       WHERE c.singleton = 1`,
    ).bind(installationId).first<ResolvedPolicyRow>();
    if (!row) throw new Error("managed inference control is unavailable");
    const monthlyLimitNanoUsd = storedMonthlyLimit(
      row.monthly_limit_nano_usd,
    );
    return {
      version: 1,
      installationId,
      enabled: row.control_enabled === 1
        && row.state === "active"
        && row.policy_enabled === 1
        && monthlyLimitNanoUsd > 0,
      monthlyLimitNanoUsd,
      routing: routingFromRow(row),
    };
  }

  async routing(): Promise<ManagedInferenceRouting> {
    const row = await this.db.prepare(
      `SELECT * FROM managed_inference_routing WHERE singleton = 1`,
    ).first<RoutingRow>();
    if (!row) throw new Error("managed inference routing is unavailable");
    return routingFromRow(row);
  }

  async setRouting(
    inputValue: ManagedInferenceRoutingUpdate,
  ): Promise<ManagedInferenceRouting> {
    const input = validateRouting(inputValue);
    const updatedAt = Date.now();
    const result = await this.db.prepare(
      `UPDATE managed_inference_routing SET
         model_id = ?, display_name = ?, context_window = ?,
         max_output_tokens = ?, reasoning = ?,
         input_nano_usd_per_token = ?, output_nano_usd_per_token = ?,
         cache_read_nano_usd_per_token = ?,
         cache_write_nano_usd_per_token = ?, allow_fallbacks = ?,
         require_parameters = ?, data_collection = ?, zdr = ?,
         provider_order_json = ?, provider_only_json = ?,
         provider_ignore_json = ?, quantizations_json = ?,
         provider_sort = ?, preferred_min_throughput = ?,
         preferred_max_latency = ?, updated_at = ?
       WHERE singleton = 1`,
    ).bind(
      input.modelId,
      input.displayName,
      input.contextWindow,
      input.maxOutputTokens,
      input.reasoning ? 1 : 0,
      input.inputNanoUsdPerToken,
      input.outputNanoUsdPerToken,
      input.cacheReadNanoUsdPerToken,
      input.cacheWriteNanoUsdPerToken,
      input.provider.allowFallbacks ? 1 : 0,
      input.provider.requireParameters ? 1 : 0,
      input.provider.dataCollection,
      input.provider.zdr ? 1 : 0,
      JSON.stringify(input.provider.order),
      JSON.stringify(input.provider.only),
      JSON.stringify(input.provider.ignore),
      JSON.stringify(input.provider.quantizations),
      input.provider.sort,
      input.provider.preferredMinThroughput ?? null,
      input.provider.preferredMaxLatency ?? null,
      updatedAt,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("managed inference routing is unavailable");
    }
    return { version: 1, ...input, updatedAt };
  }

  async control(): Promise<ManagedInferenceControl> {
    const row = await this.db.prepare(
      `SELECT enabled, updated_at
       FROM managed_inference_control
       WHERE singleton = 1`,
    ).first<{ enabled: number; updated_at: number }>();
    if (!row) throw new Error("managed inference control is unavailable");
    return {
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
    };
  }

  async setControl(enabledValue: boolean): Promise<ManagedInferenceControl> {
    const enabled = requiredBoolean(enabledValue, "enabled");
    const updatedAt = Date.now();
    const result = await this.db.prepare(
      `UPDATE managed_inference_control
       SET enabled = ?, updated_at = ?
       WHERE singleton = 1`,
    ).bind(enabled ? 1 : 0, updatedAt).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("managed inference control is unavailable");
    }
    return { enabled, updatedAt };
  }

  async setInstallationPolicy(
    installationIdValue: string,
    input: { enabled: boolean; monthlyLimitNanoUsd: number },
  ): Promise<ManagedInferenceInstallationPolicy> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const enabled = requiredBoolean(input.enabled, "enabled");
    const monthlyLimitNanoUsd = requiredMonthlyLimit(
      input.monthlyLimitNanoUsd,
    );
    if (enabled && monthlyLimitNanoUsd === 0) {
      throw new Error("managed inference monthly limit is required when enabled");
    }
    const updatedAt = Date.now();
    const result = await this.db.prepare(
      `INSERT INTO managed_inference_policies (
         installation_id, enabled, monthly_limit_nano_usd, updated_at
       )
       SELECT id, ?, ?, ?
       FROM installations
       WHERE id = ? AND state != 'deleted'
       ON CONFLICT(installation_id) DO UPDATE SET
         enabled = excluded.enabled,
         monthly_limit_nano_usd = excluded.monthly_limit_nano_usd,
         updated_at = excluded.updated_at`,
    ).bind(
      enabled ? 1 : 0,
      monthlyLimitNanoUsd,
      updatedAt,
      installationId,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("installation is unavailable");
    }
    return { enabled, monthlyLimitNanoUsd, updatedAt };
  }
}

function routingFromRow(row: RoutingRow): ManagedInferenceRouting {
  const dataCollection = row.data_collection;
  if (dataCollection !== "allow" && dataCollection !== "deny") {
    throw new Error("stored managed inference data collection is invalid");
  }
  const sort = row.provider_sort;
  if (
    sort !== "default"
    && sort !== "price"
    && sort !== "throughput"
    && sort !== "latency"
  ) {
    throw new Error("stored managed inference provider sort is invalid");
  }
  return validateStoredRouting({
    version: 1,
    modelId: row.model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    reasoning: storedBoolean(row.reasoning, "reasoning"),
    inputNanoUsdPerToken: row.input_nano_usd_per_token,
    outputNanoUsdPerToken: row.output_nano_usd_per_token,
    cacheReadNanoUsdPerToken: row.cache_read_nano_usd_per_token,
    cacheWriteNanoUsdPerToken: row.cache_write_nano_usd_per_token,
    provider: {
      allowFallbacks: storedBoolean(row.allow_fallbacks, "allowFallbacks"),
      requireParameters: storedBoolean(
        row.require_parameters,
        "requireParameters",
      ),
      dataCollection,
      zdr: storedBoolean(row.zdr, "zdr"),
      order: storedStringList(row.provider_order_json, "provider order"),
      only: storedStringList(row.provider_only_json, "provider only"),
      ignore: storedStringList(row.provider_ignore_json, "provider ignore"),
      quantizations: storedQuantizations(row.quantizations_json),
      sort,
      ...(row.preferred_min_throughput === null
        ? {}
        : { preferredMinThroughput: row.preferred_min_throughput }),
      ...(row.preferred_max_latency === null
        ? {}
        : { preferredMaxLatency: row.preferred_max_latency }),
    },
    updatedAt: requiredNonNegativeInteger(row.updated_at, "updatedAt"),
  });
}

function validateRouting(
  value: ManagedInferenceRoutingUpdate,
): ManagedInferenceRoutingUpdate {
  const modelId = requiredModelId(value.modelId);
  const displayName = requiredDisplayName(value.displayName);
  const contextWindow = requiredPositiveInteger(
    value.contextWindow,
    "contextWindow",
  );
  const maxOutputTokens = requiredPositiveInteger(
    value.maxOutputTokens,
    "maxOutputTokens",
  );
  if (maxOutputTokens > contextWindow) {
    throw new Error("maxOutputTokens cannot exceed contextWindow");
  }
  const provider = value.provider;
  if (!provider || typeof provider !== "object") {
    throw new Error("provider is invalid");
  }
  const order = requiredStringList(provider.order, "provider.order");
  const only = requiredStringList(provider.only, "provider.only");
  const ignore = requiredStringList(provider.ignore, "provider.ignore");
  if (only.some((name) => ignore.includes(name))) {
    throw new Error("provider.only and provider.ignore overlap");
  }
  const quantizations = requiredQuantizations(provider.quantizations);
  const sort = provider.sort;
  if (![
    "default",
    "price",
    "throughput",
    "latency",
  ].includes(sort)) {
    throw new Error("provider.sort is invalid");
  }
  const dataCollection = provider.dataCollection;
  if (dataCollection !== "allow" && dataCollection !== "deny") {
    throw new Error("provider.dataCollection is invalid");
  }
  return {
    modelId,
    displayName,
    contextWindow,
    maxOutputTokens,
    reasoning: requiredBoolean(value.reasoning, "reasoning"),
    inputNanoUsdPerToken: requiredPrice(
      value.inputNanoUsdPerToken,
      "inputNanoUsdPerToken",
    ),
    outputNanoUsdPerToken: requiredPrice(
      value.outputNanoUsdPerToken,
      "outputNanoUsdPerToken",
    ),
    cacheReadNanoUsdPerToken: requiredPrice(
      value.cacheReadNanoUsdPerToken,
      "cacheReadNanoUsdPerToken",
    ),
    cacheWriteNanoUsdPerToken: requiredPrice(
      value.cacheWriteNanoUsdPerToken,
      "cacheWriteNanoUsdPerToken",
    ),
    provider: {
      allowFallbacks: requiredBoolean(
        provider.allowFallbacks,
        "provider.allowFallbacks",
      ),
      requireParameters: requiredBoolean(
        provider.requireParameters,
        "provider.requireParameters",
      ),
      dataCollection,
      zdr: requiredBoolean(provider.zdr, "provider.zdr"),
      order,
      only,
      ignore,
      quantizations,
      sort: sort as ManagedInferenceRouting["provider"]["sort"],
      ...optionalPositiveNumber(
        provider.preferredMinThroughput,
        "provider.preferredMinThroughput",
      ),
      ...optionalPositiveNumber(
        provider.preferredMaxLatency,
        "provider.preferredMaxLatency",
      ),
    },
  };
}

function validateStoredRouting(
  value: ManagedInferenceRouting,
): ManagedInferenceRouting {
  const { updatedAt, version: _, ...input } = value;
  return {
    version: 1,
    ...validateRouting(input),
    updatedAt: requiredNonNegativeInteger(updatedAt, "updatedAt"),
  };
}

function requiredModelId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    throw new Error("modelId is invalid");
  }
  return value;
}

function requiredDisplayName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("displayName is invalid");
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} is invalid`);
  }
  return value as number;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value as number;
}

function requiredPrice(value: unknown, field: string): number {
  const price = requiredNonNegativeInteger(value, field);
  if (price > 1_000_000) throw new Error(`${field} is invalid`);
  return price;
}

function requiredStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${field} is invalid`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string"
      || item.length < 1
      || item.length > 80
      || item.trim() !== item
      || /[\u0000-\u001f\u007f,]/.test(item)
      || result.includes(item)
    ) {
      throw new Error(`${field} is invalid`);
    }
    result.push(item);
  }
  return result;
}

function requiredQuantizations(value: unknown): ManagedInferenceQuantization[] {
  const values = requiredStringList(value, "provider.quantizations");
  if (values.some((item) => !MANAGED_INFERENCE_QUANTIZATIONS.includes(
    item as ManagedInferenceQuantization,
  ))) {
    throw new Error("provider.quantizations is invalid");
  }
  return values as ManagedInferenceQuantization[];
}

function optionalPositiveNumber(
  value: unknown,
  field: "provider.preferredMinThroughput" | "provider.preferredMaxLatency",
): Partial<Pick<
  ManagedInferenceRouting["provider"],
  "preferredMinThroughput" | "preferredMaxLatency"
>> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} is invalid`);
  }
  return field === "provider.preferredMinThroughput"
    ? { preferredMinThroughput: value }
    : { preferredMaxLatency: value };
}

function storedBoolean(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`stored managed inference ${field} is invalid`);
  }
  return value === 1;
}

function storedStringList(value: string, field: string): string[] {
  try {
    return requiredStringList(JSON.parse(value), field);
  } catch {
    throw new Error(`stored managed inference ${field} is invalid`);
  }
}

function storedQuantizations(value: string): ManagedInferenceQuantization[] {
  try {
    return requiredQuantizations(JSON.parse(value));
  } catch {
    throw new Error("stored managed inference quantizations are invalid");
  }
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} is invalid`);
  return value;
}

function requiredMonthlyLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("managed inference monthly limit is invalid");
  }
  return value;
}

function storedMonthlyLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("stored managed inference monthly limit is invalid");
  }
  return value;
}
