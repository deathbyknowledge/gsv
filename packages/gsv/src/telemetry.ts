import * as z from "zod/mini";

export const GSV_TELEMETRY_MARKER = "gsv.telemetry";
export const GSV_TELEMETRY_VERSION = 1;

const installationIdSchema = z.string().check(
  z.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/),
);
const nonNegativeIntegerSchema = z.number().check(z.int(), z.nonnegative());
const positiveIntegerSchema = z.number().check(z.int(), z.positive());
const nonNegativeNumberSchema = z.number().check(z.nonnegative());
const adapterNameSchema = z.string().check(
  z.minLength(1),
  z.maxLength(64),
  z.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
);
const modelNameSchema = z.string().check(
  z.minLength(1),
  z.maxLength(200),
  z.regex(/^@?[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
);
const httpStatusCodeSchema = z.number().check(
  z.int(),
  z.gte(100),
  z.lte(599),
);

export const inferenceWorkloadSchema = z.enum([
  "interactive",
  "background",
  "ipc",
  "compaction",
  "kernel",
  "mail-intake",
  "unknown",
]);

export const inferenceFailureKindSchema = z.enum([
  "rate_limited",
  "capacity",
  "timeout",
  "authentication",
  "billing",
  "invalid_request",
  "context_overflow",
  "network",
  "provider_unavailable",
  "policy",
  "quota",
  "protocol",
  "internal",
  "unknown",
]);

export const inferenceFailureStageSchema = z.enum([
  "policy",
  "admission",
  "provider",
  "stream",
  "settlement",
  "lifecycle",
]);

export const telemetryComponentSchema = z.enum([
  "gateway",
  "accounts",
  "inference",
]);

const processRunFinishedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("process.run.finished"),
  properties: z.strictObject({
    outcome: z.enum(["ok", "error", "aborted"]),
    durationMs: nonNegativeIntegerSchema,
    runKind: z.enum(["interactive", "background", "ipc"]),
    delivery: z.enum(["message", "silence", "none"]),
    queued: z.boolean(),
    inputTokens: z.optional(nonNegativeIntegerSchema),
    outputTokens: z.optional(nonNegativeIntegerSchema),
    cacheReadTokens: z.optional(nonNegativeIntegerSchema),
    cacheWriteTokens: z.optional(nonNegativeIntegerSchema),
  }),
});

const processCompactionCompletedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("process.compaction.completed"),
  properties: z.strictObject({
    trigger: z.enum([
      "manual",
      "auto-preflight",
      "auto-provider-overflow",
    ]),
    durationMs: nonNegativeIntegerSchema,
    archivedMessages: nonNegativeIntegerSchema,
    contextPressure: z.optional(nonNegativeNumberSchema),
  }),
});

const adapterIngressFinishedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("adapter.ingress.finished"),
  properties: z.strictObject({
    adapter: adapterNameSchema,
    outcome: z.enum([
      "delivered",
      "dropped",
      "challenge",
      "handled",
      "replayed",
      "error",
    ]),
    surface: z.enum(["dm", "group", "channel", "thread"]),
    hasMedia: z.boolean(),
    durationMs: nonNegativeIntegerSchema,
  }),
});

const adapterDeliveryFinishedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("adapter.delivery.finished"),
  properties: z.strictObject({
    adapter: adapterNameSchema,
    outcome: z.enum([
      "sent",
      "deduplicated",
      "ambiguous",
      "retryable_error",
      "rejected",
      "error",
    ]),
    hasMedia: z.boolean(),
    durationMs: nonNegativeIntegerSchema,
  }),
});

const adapterRouteDeliveryFailedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("adapter.route_delivery.failed"),
  properties: z.strictObject({
    adapter: adapterNameSchema,
    deliveryKind: z.enum(["message", "approval"]),
    surface: z.enum(["dm", "group", "channel", "thread"]),
    outcome: z.literal("failed"),
    failureKind: z.enum(["permanent", "ambiguous", "exhausted"]),
    attempts: positiveIntegerSchema,
  }),
});

const delegationFinishedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("delegation.finished"),
  properties: z.strictObject({
    outcome: z.enum(["completed", "failed", "timed_out", "killed"]),
    durationMs: nonNegativeIntegerSchema,
  }),
});

const inferenceRequestFinishedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("inference.request.finished"),
  properties: z.strictObject({
    outcome: z.enum(["completed", "failed", "aborted", "abandoned"]),
    purpose: z.enum(["agent", "mail-intake"]),
    // Optional only for compatibility with producers during rolling upgrades.
    workload: z.optional(inferenceWorkloadSchema),
    provider: z.literal("workers-ai"),
    model: z.optional(modelNameSchema),
    stopReason: z.optional(z.enum([
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
    ])),
    durationMs: nonNegativeIntegerSchema,
    inputTokens: nonNegativeIntegerSchema,
    outputTokens: nonNegativeIntegerSchema,
    cacheReadTokens: nonNegativeIntegerSchema,
    cacheWriteTokens: nonNegativeIntegerSchema,
    totalTokens: nonNegativeIntegerSchema,
    costNanoUsd: nonNegativeIntegerSchema,
    // Failure diagnostics are a closed, content-free taxonomy. Managed
    // producers attach all three fields to failed and abandoned outcomes.
    failureKind: z.optional(inferenceFailureKindSchema),
    failureStage: z.optional(inferenceFailureStageSchema),
    retryable: z.optional(z.boolean()),
    providerStatusCode: z.optional(httpStatusCodeSchema),
  }),
});

const inferenceProviderAttemptFailedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("inference.provider_attempt.failed"),
  properties: z.strictObject({
    purpose: z.enum(["agent", "mail-intake"]),
    workload: inferenceWorkloadSchema,
    provider: z.literal("workers-ai"),
    model: modelNameSchema,
    attempt: positiveIntegerSchema,
    durationMs: nonNegativeIntegerSchema,
    failureKind: inferenceFailureKindSchema,
    failureStage: inferenceFailureStageSchema,
    retryable: z.boolean(),
    providerStatusCode: z.optional(httpStatusCodeSchema),
    timeoutKind: z.optional(z.enum(["first_output", "generation"])),
    firstActivityMs: z.optional(nonNegativeIntegerSchema),
    lastActivityMs: z.optional(nonNegativeIntegerSchema),
    outputExposed: z.optional(z.boolean()),
  }),
});

const installationActivatedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("installation.activated"),
  properties: z.strictObject({}),
});

const shipMessageCommittedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("ship.message.committed"),
  properties: z.strictObject({
    delivery: z.enum(["client", "adapter", "background"]),
    hasMedia: z.boolean(),
  }),
});

const targetConnectedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("target.connected"),
  properties: z.strictObject({
    targetKind: z.enum(["machine", "browser"]),
  }),
});

const adapterConnectedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("adapter.connected"),
  properties: z.strictObject({
    adapter: adapterNameSchema,
  }),
});

export const integrationKindSchema = z.enum(["mcp", "ai-provider", "generic"]);

// Closed allowlist so product analytics can break integrations down by
// service without ever carrying a raw provider string or server URL. Extend it
// when the "other" share grows; unknown services always classify as "other".
export const integrationProviderSchema = z.enum([
  "openai-codex",
  "github",
  "google",
  "notion",
  "linear",
  "slack",
  "atlassian",
  "other",
]);

const integrationConnectedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("integration.connected"),
  properties: z.strictObject({
    integrationKind: integrationKindSchema,
    provider: integrationProviderSchema,
  }),
});

const delegationCompletedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("delegation.completed"),
  properties: z.strictObject({
    durationMs: nonNegativeIntegerSchema,
  }),
});

export const telemetryEventSchema = z.discriminatedUnion("name", [
  processRunFinishedSchema,
  processCompactionCompletedSchema,
  adapterIngressFinishedSchema,
  adapterDeliveryFinishedSchema,
  adapterRouteDeliveryFailedSchema,
  delegationFinishedSchema,
  inferenceRequestFinishedSchema,
  inferenceProviderAttemptFailedSchema,
  installationActivatedSchema,
  shipMessageCommittedSchema,
  targetConnectedSchema,
  adapterConnectedSchema,
  integrationConnectedSchema,
  delegationCompletedSchema,
]);

export const telemetryRecordSchema = z.strictObject({
  marker: z.literal(GSV_TELEMETRY_MARKER),
  version: z.literal(GSV_TELEMETRY_VERSION),
  eventId: z.string().check(z.uuid()),
  occurredAt: nonNegativeIntegerSchema,
  installationId: installationIdSchema,
  component: telemetryComponentSchema,
  event: telemetryEventSchema,
});

export type TelemetryComponent = z.infer<typeof telemetryComponentSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryRecord = z.infer<typeof telemetryRecordSchema>;
export type InferenceWorkload = z.infer<typeof inferenceWorkloadSchema>;
export type InferenceFailureKind = z.infer<typeof inferenceFailureKindSchema>;
export type InferenceFailureStage = z.infer<
  typeof inferenceFailureStageSchema
>;
export type IntegrationKind = z.infer<typeof integrationKindSchema>;
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;

const INTEGRATION_PROVIDER_DOMAINS: ReadonlyArray<
  readonly [Exclude<IntegrationProvider, "other">, ReadonlyArray<string>]
> = [
  ["openai-codex", ["openai.com"]],
  ["github", ["github.com", "githubcopilot.com"]],
  ["google", ["google.com", "googleapis.com"]],
  ["notion", ["notion.com", "notion.so"]],
  ["linear", ["linear.app"]],
  ["slack", ["slack.com"]],
  ["atlassian", ["atlassian.com", "atlassian.net"]],
];

function isIntegrationProvider(value: string): value is IntegrationProvider {
  return integrationProviderSchema.safeParse(value).success;
}

/**
 * Classify a free-form OAuth provider name into the closed provider
 * allowlist. Anything outside the allowlist becomes "other" so a record never
 * carries the caller-supplied string.
 */
export function integrationProviderFromName(name: string): IntegrationProvider {
  const normalized = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return isIntegrationProvider(normalized) ? normalized : "other";
}

/**
 * Classify an MCP server URL into the closed provider allowlist by its
 * registrable domain. Only the allowlist value leaves this function; the URL,
 * host, and path are never part of a telemetry record.
 */
export function integrationProviderFromUrl(url: string): IntegrationProvider {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  for (const [provider, domains] of INTEGRATION_PROVIDER_DOMAINS) {
    for (const domain of domains) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return provider;
    }
  }
  return "other";
}

export type TelemetryEnvironment = {
  GSV_TELEMETRY_ENABLED?: boolean | number | string;
};

export type TelemetryRecordInput = {
  installationId: string;
  component: TelemetryComponent;
  event: TelemetryEvent;
};

export function telemetryEnabled(
  env: TelemetryEnvironment | undefined,
): boolean {
  if (!env) return false;
  const enabled = env.GSV_TELEMETRY_ENABLED;
  return enabled === true || enabled === 1 || enabled === "1";
}

export function createTelemetryRecord(
  input: TelemetryRecordInput,
  occurredAt = Date.now(),
  eventId = crypto.randomUUID(),
): TelemetryRecord {
  return telemetryRecordSchema.parse({
    marker: GSV_TELEMETRY_MARKER,
    version: GSV_TELEMETRY_VERSION,
    eventId,
    occurredAt,
    ...input,
  });
}

/**
 * Emit one provider-neutral record for an optional deployment-owned consumer.
 * Telemetry is failure-isolated: a malformed record never affects user work.
 */
export function emitTelemetry(
  env: TelemetryEnvironment | undefined,
  input: TelemetryRecordInput,
): boolean {
  if (!telemetryEnabled(env)) return false;
  try {
    console.log(createTelemetryRecord(input));
    return true;
  } catch {
    console.warn("[GSV telemetry] Rejected invalid telemetry record");
    return false;
  }
}
