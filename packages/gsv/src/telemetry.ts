import * as z from "zod/mini";
import { exceptionDiagnosticProperties } from "./diagnostics.js";
export { exceptionDiagnostics, sanitizeExceptionDiagnostics, redactDiagnosticText, type ExceptionDiagnostics } from "./diagnostics.js";

export const GSV_TELEMETRY_MARKER = "gsv.telemetry";
export const GSV_TELEMETRY_VERSION = 1;

export const telemetryErrorTypeSchema = z.enum([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "TimeoutError", "AggregateError", "unknown",
]);

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

/** Ephemeral correlation for metadata RPCs, independent of Process/run identity. */
export const inferenceModelLookupSchema = z.strictObject({
  installationId: installationIdSchema,
  lookupId: z.string().check(z.uuid()),
});
export type InferenceModelLookup = z.infer<typeof inferenceModelLookupSchema>;

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

/** The setup steps a Ship runs after its setup request is accepted. */
export const installationSetupStepSchema = z.enum([
  "bootstrap-system",
  "write-auth-state",
  "write-system-config",
  "write-ai-config",
  "issue-machine-token",
  "ensure-home-layout",
  "provision-personal-agent",
]);

/** The layer that reported an unexpected ripgit failure. The cause stays with ripgit's caller. */
export const ripgitFailureKindSchema = z.enum(["runtime", "repository", "json", "encoding", "binding", "other"]);

/** The ripgit operation that failed, without the repository it addressed. */
export const ripgitRouteSchema = z.enum([
  "apply",
  "import",
  "hyperspace-read",
  "read",
  "git-info-refs",
  "git-upload-pack",
  "git-receive-pack",
  "admin",
  "delete",
  "registration",
  "lifecycle",
  "discovery",
  "other",
]);

export const telemetryComponentSchema = z.enum([
  "gateway",
  "accounts",
  "inference",
  "search",
  "mail",
  "ripgit",
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
    ...exceptionDiagnosticProperties,
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

const adapterQuoteResolvedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("adapter.quote.resolved"),
  properties: z.strictObject({
    ...exceptionDiagnosticProperties,
    adapter: adapterNameSchema,
    surface: z.enum(["dm", "group", "channel", "thread"]),
    outcome: z.enum(["resolved", "unmapped", "unavailable", "failed", "timed_out"]),
    durationMs: nonNegativeIntegerSchema,
  }),
});

const adapterRouteDeliveryFailedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("adapter.route_delivery.failed"),
  properties: z.strictObject({
    ...exceptionDiagnosticProperties,
    adapter: adapterNameSchema,
    deliveryKind: z.enum(["message", "approval"]),
    surface: z.enum(["dm", "group", "channel", "thread"]),
    outcome: z.literal("failed"),
    failureKind: z.enum(["permanent", "ambiguous", "exhausted"]),
    stage: z.optional(z.enum(["route", "media", "adapter"])),
    providerStatusCode: z.optional(httpStatusCodeSchema),
    attempts: positiveIntegerSchema,
  }),
});

const delegationFinishedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("delegation.finished"),
  properties: z.strictObject({
    outcome: z.enum(["completed", "failed", "aborted", "timed_out", "killed"]),
    durationMs: nonNegativeIntegerSchema,
  }),
});

export const inferenceProviderSchema = z.enum(["workers-ai", "modal", "together", "prime-intellect", "gsv", "other"]);

const inferenceRequestFinishedSchema = z.strictObject({
  stream: z.literal("operational"),
  name: z.literal("inference.request.finished"),
  properties: z.strictObject({
    ...exceptionDiagnosticProperties,
    diagnosticId: z.optional(z.string().check(z.uuid())),
    outcome: z.enum(["completed", "failed", "aborted", "abandoned"]),
    purpose: z.enum(["agent", "mail-intake"]),
    // Optional only for compatibility with producers during rolling upgrades.
    workload: z.optional(inferenceWorkloadSchema),
    provider: inferenceProviderSchema,
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
    ...exceptionDiagnosticProperties,
    diagnosticId: z.optional(z.string().check(z.uuid())),
    purpose: z.enum(["agent", "mail-intake"]),
    workload: inferenceWorkloadSchema,
    provider: inferenceProviderSchema,
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

// Closed allowlist so product analytics can break Ship replies down by the
// surface that will receive them without ever carrying a raw peer platform
// string or adapter name. Unknown clients and adapters classify as "other".
export const shipPlatformSchema = z.enum([
  "web",
  "phone",
  "tablet",
  "desktop",
  "cli",
  "telegram",
  "discord",
  "slack",
  "background",
  "other",
]);

const shipMessageCommittedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("ship.message.committed"),
  properties: z.strictObject({
    delivery: z.enum(["client", "adapter", "background"]),
    hasMedia: z.boolean(),
    // Optional only for compatibility with producers during rolling upgrades.
    platform: z.optional(shipPlatformSchema),
    // Present only on the first message a run commits after the person's own
    // message: the time from Process receipt to that commit.
    replyMs: z.optional(nonNegativeIntegerSchema),
  }),
});

// The person's own message to Ship, reported when the Conversation accepts
// it. Text and media never leave the Kernel; only their presence does.
const shipMessageReceivedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("ship.message.received"),
  properties: z.strictObject({
    source: z.enum(["client", "adapter"]),
    platform: shipPlatformSchema,
    hasText: z.boolean(),
    hasMedia: z.boolean(),
  }),
});

// Closed categories for a run that a person's conversation message started
// and that ended without a normal completion. The cause stays in Process
// history; the record carries the category only.
export const conversationReplyFailureSchema = z.enum([
  "generation",
  "context",
  "media",
  "no_send",
  "command",
  "delivery",
  "runtime",
  "superseded",
  "cancelled",
  "killed",
  "other",
]);

const conversationReplyFailedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("conversation.reply.failed"),
  properties: z.strictObject({
    outcome: z.enum(["error", "aborted"]),
    failure: conversationReplyFailureSchema,
    // Whether the run had already committed a message before it ended.
    replied: z.boolean(),
    durationMs: nonNegativeIntegerSchema,
  }),
});

const onboardingWelcomeActivatedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("onboarding.welcome.activated"),
  properties: z.strictObject({}),
});

// The first Ship message accepted after the welcome responsibility opened,
// once per owner, with the time it took to arrive.
const onboardingWelcomeDeliveredSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("onboarding.welcome.delivered"),
  properties: z.strictObject({
    durationMs: nonNegativeIntegerSchema,
    delivery: z.enum(["client", "adapter", "background"]),
    platform: shipPlatformSchema,
  }),
});

// Where a signup came from, as closed classes of the website's Try Ship links,
// never a visitor identity. The signup link carries free-form slugs; only these
// allowlist values leave the classifier, and anything else becomes "other".
export const attributionSlugSchema = z.string().check(z.regex(/^[a-z0-9-]{1,32}$/));
export const attributionPlacementSchema = z.enum(["hero", "final-call", "example", "other"]);
// Extend this list when the website adds an example; unknown ids classify as "other".
export const attributionExampleSchema = z.enum([
  "bill", "delivery", "dentist", "jessica", "kawah", "refund", "saturday", "steve", "tickets", "other",
]);

const installationAttributedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("installation.attributed"),
  properties: z.strictObject({
    origin: z.enum(["website", "direct"]),
    placement: z.optional(attributionPlacementSchema),
    example: z.optional(attributionExampleSchema),
  }),
});

// A record entering the owner's responsibility ledger through the ordinary
// create syscall: Ship or a helper committing to something (`process`) or the
// person adding one (`account`). Kernel-seeded records never pass this path.
const responsibilityCreatedSchema = z.strictObject({
  stream: z.literal("product"),
  name: z.literal("responsibility.created"),
  properties: z.strictObject({
    source: z.enum(["process", "account"]),
    parent: z.boolean(),
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
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("memory.review.admission.failed"),
    properties: z.strictObject({ diagnosticId: z.string().check(z.uuid()) }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("installation.setup.failed"),
    properties: z.strictObject({
      diagnosticId: z.string().check(z.uuid()),
      outcome: z.literal("failed"),
      stage: z.enum(["authorization", "recovery", "activation", "setup"]),
      step: z.optional(installationSetupStepSchema),
      errorType: telemetryErrorTypeSchema,
      durationMs: nonNegativeIntegerSchema,
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("ripgit.request.failed"),
    properties: z.strictObject({
      diagnosticId: z.string().check(z.uuid()),
      outcome: z.literal("failed"),
      route: ripgitRouteSchema,
      kind: ripgitFailureKindSchema,
      durationMs: nonNegativeIntegerSchema,
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("inference.client.finished"),
    properties: z.strictObject({
      ...exceptionDiagnosticProperties,
      diagnosticId: z.string().check(z.uuid()),
      boundary: z.enum(["execution", "managed"]),
      phase: z.enum(["acquisition", "request", "stream", "abort"]),
      outcome: z.enum(["completed", "failed", "cancelled", "timed_out"]),
      workload: inferenceWorkloadSchema,
      durationMs: nonNegativeIntegerSchema,
      errorType: z.optional(telemetryErrorTypeSchema),
      httpStatus: z.optional(httpStatusCodeSchema),
      rpcRemote: z.optional(z.boolean()),
      rpcRetryable: z.optional(z.boolean()),
      rpcOverloaded: z.optional(z.boolean()),
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("inference.metadata.finished"),
    properties: z.strictObject({
      lookupId: z.string().check(z.uuid()),
      outcome: z.enum(["ok", "error", "timeout"]),
      durationMs: nonNegativeIntegerSchema,
      cache: z.optional(z.enum(["hit", "miss"])),
      sqlDurationMs: z.optional(nonNegativeNumberSchema),
      queryAttempts: z.optional(positiveIntegerSchema),
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("process.compaction.failed"),
    properties: z.strictObject({
      trigger: z.enum(["manual", "auto-preflight", "auto-provider-overflow"]),
      stage: z.enum(["admission", "summary", "archive"]),
      outcome: z.enum(["failed", "aborted", "rejected"]), durationMs: nonNegativeIntegerSchema,
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("entitlements.refresh.finished"),
    properties: z.strictObject({
      outcome: z.enum(["refreshed", "unavailable", "invalid"]), durationMs: nonNegativeIntegerSchema,
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("web_search.request.finished"),
    properties: z.strictObject({
      outcome: z.enum(["completed", "failed", "cancelled", "rejected"]),
      stage: z.enum(["policy", "admission", "provider", "settlement"]),
      durationMs: nonNegativeIntegerSchema, admitted: z.boolean(),
      resultCount: z.optional(nonNegativeIntegerSchema),
      costNanoUsd: z.optional(nonNegativeIntegerSchema),
      costConfirmed: z.boolean(),
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("mail.intake.finished"),
    properties: z.strictObject({
      outcome: z.enum(["accepted", "duplicate", "rejected", "error"]),
      reason: z.optional(z.enum(["invalid", "quota", "disabled", "size"])),
      durationMs: nonNegativeIntegerSchema,
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("mail.delivery.finished"),
    properties: z.strictObject({
      outcome: z.enum(["accepted", "failed", "unknown"]),
      reason: z.enum(["none", "disabled", "quota", "inactive", "invalid", "provider_unknown"]),
      durationMs: nonNegativeIntegerSchema,
    }),
  }),
  z.strictObject({
    stream: z.literal("operational"), name: z.literal("mail.work.deferred"),
    properties: z.strictObject({
      stage: z.enum(["storage", "summary", "completion", "outbound_claim", "outbound_callback"]),
      reason: z.enum(["quota", "unavailable"]),
    }),
  }),
  processRunFinishedSchema,
  processCompactionCompletedSchema,
  adapterIngressFinishedSchema,
  adapterDeliveryFinishedSchema,
  adapterQuoteResolvedSchema,
  adapterRouteDeliveryFailedSchema,
  delegationFinishedSchema,
  inferenceRequestFinishedSchema,
  inferenceProviderAttemptFailedSchema,
  installationActivatedSchema,
  installationAttributedSchema,
  shipMessageCommittedSchema,
  shipMessageReceivedSchema,
  conversationReplyFailedSchema,
  onboardingWelcomeActivatedSchema,
  onboardingWelcomeDeliveredSchema,
  responsibilityCreatedSchema,
  targetConnectedSchema,
  adapterConnectedSchema,
  integrationConnectedSchema,
  delegationCompletedSchema,
]);

// The owning component is part of the allowlist, not a claim made by an arbitrary producer.
export type TelemetryEventOwnership = Record<z.infer<typeof telemetryEventSchema>["name"], readonly z.infer<typeof telemetryComponentSchema>[]>;
export const telemetryEventComponents = {
  "memory.review.admission.failed": ["gateway"],
  "installation.setup.failed": ["gateway", "accounts"],
  "ripgit.request.failed": ["ripgit"],
  "inference.client.finished": ["gateway", "inference"],
  "inference.metadata.finished": ["gateway", "inference", "accounts"],
  "entitlements.refresh.finished": ["inference", "search", "mail"],
  "web_search.request.finished": ["search"],
  "mail.intake.finished": ["mail"],
  "mail.delivery.finished": ["mail"],
  "mail.work.deferred": ["mail"],
  "process.run.finished": ["gateway"],
  "process.compaction.completed": ["gateway"],
  "process.compaction.failed": ["gateway"],
  "adapter.ingress.finished": ["gateway"],
  "adapter.delivery.finished": ["gateway"],
  "adapter.quote.resolved": ["gateway"],
  "adapter.route_delivery.failed": ["gateway"],
  "delegation.finished": ["gateway"],
  "inference.request.finished": ["inference"],
  "inference.provider_attempt.failed": ["inference"],
  "installation.activated": ["accounts"],
  "installation.attributed": ["accounts"],
  "ship.message.committed": ["gateway"],
  "ship.message.received": ["gateway"],
  "conversation.reply.failed": ["gateway"],
  "onboarding.welcome.activated": ["gateway"],
  "onboarding.welcome.delivered": ["gateway"],
  "responsibility.created": ["gateway"],
  "target.connected": ["gateway"],
  "adapter.connected": ["gateway"],
  "integration.connected": ["gateway"],
  "delegation.completed": ["gateway"],
} satisfies TelemetryEventOwnership;

export const telemetryRecordSchema = z.strictObject({
  marker: z.literal(GSV_TELEMETRY_MARKER),
  version: z.literal(GSV_TELEMETRY_VERSION),
  eventId: z.string().check(z.uuid()),
  occurredAt: nonNegativeIntegerSchema,
  installationId: installationIdSchema,
  component: telemetryComponentSchema,
  event: telemetryEventSchema,
}).check(z.refine((record) => telemetryEventComponents[record.event.name].some((component) => component === record.component)));

export type TelemetryComponent = z.infer<typeof telemetryComponentSchema>;
export type InstallationSetupStep = z.infer<typeof installationSetupStepSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryRecord = z.infer<typeof telemetryRecordSchema>;
export type InferenceWorkload = z.infer<typeof inferenceWorkloadSchema>;
export type InferenceProvider = z.infer<typeof inferenceProviderSchema>;
export type InferenceFailureKind = z.infer<typeof inferenceFailureKindSchema>;
export type InferenceFailureStage = z.infer<
  typeof inferenceFailureStageSchema
>;
export type IntegrationKind = z.infer<typeof integrationKindSchema>;
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;
export type ShipPlatform = z.infer<typeof shipPlatformSchema>;
export type ConversationReplyFailure = z.infer<typeof conversationReplyFailureSchema>;
export type AttributionPlacement = z.infer<typeof attributionPlacementSchema>;
export type AttributionExample = z.infer<typeof attributionExampleSchema>;
/** A signup's origin after classification: only allowlist values, stored and reported as such. */
export type SignupAttribution = { placement: AttributionPlacement; example?: AttributionExample };

/**
 * Classify the slugs a Try Ship link carried into the closed attribution
 * allowlists. The website names its hero and final-call sections and its
 * example panels (`details-<id>`); anything else is "other", and the raw slugs
 * never enter a record.
 */
export function signupAttributionFromSlugs(placement: string, example?: string): SignupAttribution {
  const place = placement.trim().toLowerCase();
  const classified: SignupAttribution = {
    placement: place === "hero" || place === "hero-heading"
      ? "hero"
      : place === "final-call" || place === "early-access"
        ? "final-call"
        : place === "example" || place.startsWith("details-")
          ? "example"
          : "other",
  };
  if (example !== undefined) {
    const parsed = attributionExampleSchema.safeParse(example.trim().toLowerCase());
    classified.example = parsed.success ? parsed.data : "other";
  }
  return classified;
}

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

/** Keep operator-selected transport names out of telemetry without losing the event. */
export function inferenceProviderFromName(name?: string): InferenceProvider {
  if (name === undefined) return "gsv";
  const parsed = inferenceProviderSchema.safeParse(name);
  return parsed.success ? parsed.data : "other";
}

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

// Rust clients (CLI and machine daemon) report their operating system as the
// peer platform; the Instrument UI reports its own closed set. Legacy UI
// builds reported "browser" before they self-identified.
const CLI_PEER_PLATFORMS = new Set(["macos", "linux", "windows", "freebsd", "openbsd", "netbsd"]);
const ADAPTER_SHIP_PLATFORMS: readonly ShipPlatform[] = ["telegram", "discord", "slack"];

/**
 * Classify the free-form `peer.platform` string a connected client reported
 * into the closed Ship platform allowlist. Only allowlist values leave this
 * function; the reported string itself never enters a telemetry record.
 */
export function shipPlatformFromPeer(platform: string | undefined): ShipPlatform {
  const normalized = (platform ?? "").trim().toLowerCase();
  if (normalized === "browser") return "web";
  if (CLI_PEER_PLATFORMS.has(normalized)) return "cli";
  if (
    normalized === "web"
    || normalized === "phone"
    || normalized === "tablet"
    || normalized === "desktop"
  ) {
    return normalized;
  }
  return "other";
}

/**
 * Classify an adapter name into the closed Ship platform allowlist. Adapters
 * outside the allowlist become "other" so the record never carries a
 * deployment-specific adapter slug.
 */
export function shipPlatformFromAdapter(adapter: string): ShipPlatform {
  const normalized = adapter.trim().toLowerCase();
  return ADAPTER_SHIP_PLATFORMS.find((platform) => platform === normalized) ?? "other";
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
