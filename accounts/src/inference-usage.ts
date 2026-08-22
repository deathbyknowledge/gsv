import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceUsageEvent,
} from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "./domain";

const MAX_USAGE_BATCH = 100;
const OPTIONAL_VALUE_MAX_LENGTH = 256;
const OUTCOMES = new Set<ManagedInferenceUsageEvent["outcome"]>([
  "completed",
  "failed",
  "aborted",
  "abandoned",
]);
const STOP_REASONS = new Set<NonNullable<ManagedInferenceUsageEvent["stopReason"]>>([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
]);
const PURPOSES = new Set<ManagedInferenceUsageEvent["purpose"]>([
  "agent",
  "mail-intake",
]);

type UsageEventRow = {
  installation_id: string;
  logical_request_id: string;
  period: string;
  local_uid: number;
  process_id: string | null;
  run_id: string | null;
  purpose: ManagedInferenceUsageEvent["purpose"];
  model: string;
  response_model: string | null;
  provider_response_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  reserved_nano_usd: number;
  cost_nano_usd: number;
  outcome: ManagedInferenceUsageEvent["outcome"];
  stop_reason: ManagedInferenceUsageEvent["stopReason"] | null;
  started_at: number;
  completed_at: number;
};

export class ManagedInferenceUsageStore {
  constructor(private readonly db: D1Database) {}

  async record(eventsValue: ManagedInferenceUsageEvent[]): Promise<void> {
    if (!Array.isArray(eventsValue) || eventsValue.length > MAX_USAGE_BATCH) {
      throw new Error("Managed inference usage batch is invalid");
    }
    const events = eventsValue.map(validateUsageEvent);
    if (events.length === 0) return;
    const receivedAt = Date.now();
    const results = await this.db.batch(events.map((event) => this.db.prepare(
      `INSERT INTO managed_inference_usage_events (
         installation_id, logical_request_id, period, local_uid, process_id,
         run_id, purpose, model, response_model, provider_response_id, input_tokens,
         output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
         reserved_nano_usd, cost_nano_usd, outcome, stop_reason, started_at,
         completed_at, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id, logical_request_id) DO NOTHING`,
    ).bind(
      event.installationId,
      event.logicalRequestId,
      event.period,
      event.actor.localUid,
      event.actor.processId ?? null,
      event.actor.runId ?? null,
      event.purpose,
      event.model,
      event.responseModel ?? null,
      event.providerResponseId ?? null,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.totalTokens,
      event.reservedNanoUsd,
      event.costNanoUsd,
      event.outcome,
      event.stopReason ?? null,
      event.startedAt,
      event.completedAt,
      receivedAt,
    )));

    for (let index = 0; index < results.length; index += 1) {
      if ((results[index]?.meta.changes ?? 0) !== 0) continue;
      const event = events[index];
      if (!event) throw new Error("Managed inference usage batch is invalid");
      const existing = await this.db.prepare(
        `SELECT
           installation_id, logical_request_id, period, local_uid, process_id,
           run_id, purpose, model, response_model, provider_response_id, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
           reserved_nano_usd, cost_nano_usd, outcome, stop_reason, started_at,
           completed_at
         FROM managed_inference_usage_events
         WHERE installation_id = ? AND logical_request_id = ?`,
      ).bind(
        event.installationId,
        event.logicalRequestId,
      ).first<UsageEventRow>();
      if (!existing || usageEventFingerprint(event) !== rowFingerprint(existing)) {
        throw new Error("Managed inference usage event conflicts with an existing event");
      }
    }
  }
}

function validateUsageEvent(
  event: ManagedInferenceUsageEvent,
): ManagedInferenceUsageEvent {
  if (!event || event.constructor !== Object || event.version !== 1) {
    throw new Error("Managed inference usage event is invalid");
  }
  parseOpaqueId(event.installationId, "installationId");
  parseOpaqueId(event.logicalRequestId, "logicalRequestId");
  if (
    !event.actor
    || !Number.isSafeInteger(event.actor.localUid)
    || event.actor.localUid < 0
  ) {
    throw new Error("Managed inference usage actor is invalid");
  }
  optionalValue(event.actor.processId, "processId");
  optionalValue(event.actor.runId, "runId");
  const purpose = event.purpose ?? "agent";
  if (!PURPOSES.has(purpose)) {
    throw new Error("Managed inference usage purpose is invalid");
  }
  if (
    !/^\d{4}-\d{2}$/.test(event.period)
    || event.period !== new Date(event.startedAt).toISOString().slice(0, 7)
  ) {
    throw new Error("Managed inference usage period is invalid");
  }
  if (event.model !== GSV_INFERENCE_PRODUCT_MODEL) {
    throw new Error("Managed inference usage model is invalid");
  }
  optionalValue(event.responseModel, "responseModel");
  optionalValue(event.providerResponseId, "providerResponseId");
  const tokens = [
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.totalTokens,
  ];
  tokens.forEach((value) => nonnegativeInteger(value, "token count"));
  if (
    event.totalTokens !== event.inputTokens
      + event.outputTokens
      + event.cacheReadTokens
      + event.cacheWriteTokens
  ) {
    throw new Error("Managed inference usage token total is invalid");
  }
  nonnegativeInteger(event.reservedNanoUsd, "reservation");
  nonnegativeInteger(event.costNanoUsd, "cost");
  if (!OUTCOMES.has(event.outcome)) {
    throw new Error("Managed inference usage outcome is invalid");
  }
  if (event.stopReason !== undefined && !STOP_REASONS.has(event.stopReason)) {
    throw new Error("Managed inference usage stop reason is invalid");
  }
  if (
    !Number.isSafeInteger(event.startedAt)
    || !Number.isSafeInteger(event.completedAt)
    || event.startedAt < 0
    || event.completedAt < event.startedAt
  ) {
    throw new Error("Managed inference usage timestamps are invalid");
  }
  return purpose === event.purpose ? event : { ...event, purpose };
}

function optionalValue(value: string | undefined, field: string): void {
  if (
    value !== undefined
    && (String(value) !== value
      || value.length < 1
      || value.length > OPTIONAL_VALUE_MAX_LENGTH)
  ) {
    throw new Error(`Managed inference usage ${field} is invalid`);
  }
}

function nonnegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Managed inference usage ${field} is invalid`);
  }
}

function usageEventFingerprint(event: ManagedInferenceUsageEvent): string {
  return JSON.stringify([
    event.installationId,
    event.logicalRequestId,
    event.period,
    event.actor.localUid,
    event.actor.processId ?? null,
    event.actor.runId ?? null,
    event.purpose,
    event.model,
    event.responseModel ?? null,
    event.providerResponseId ?? null,
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.totalTokens,
    event.reservedNanoUsd,
    event.costNanoUsd,
    event.outcome,
    event.stopReason ?? null,
    event.startedAt,
    event.completedAt,
  ]);
}

function rowFingerprint(row: UsageEventRow): string {
  return JSON.stringify([
    row.installation_id,
    row.logical_request_id,
    row.period,
    row.local_uid,
    row.process_id,
    row.run_id,
    row.purpose,
    row.model,
    row.response_model,
    row.provider_response_id,
    row.input_tokens,
    row.output_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.total_tokens,
    row.reserved_nano_usd,
    row.cost_nano_usd,
    row.outcome,
    row.stop_reason,
    row.started_at,
    row.completed_at,
  ]);
}
