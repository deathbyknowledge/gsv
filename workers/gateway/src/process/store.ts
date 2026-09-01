/**
 * ProcessStore — SQLite-backed state for a single Process DO.
 *
 * Manages:
 *   - messages: the process history (agent loop working memory)
 *   - pending_tool_calls: in-flight tool calls awaiting results
 *   - message_queue: FIFO queue for messages arriving during an active run
 *   - process_kv: key-value metadata (processId, archiveId, etc.)
 */

import { isToolSyscallName, syscallToolName } from "../syscalls/constants";
import type { SyscallName } from "../syscalls";
import type {
  JsonObject,
  JsonValue,
  ProcAiConfigSnapshot,
  ProcContextState,
  ProcMessageMetadata,
  ProcMessageModelMetadata,
  ProcMessageProviderMetadata,
  ProcTraceSpan,
  ProcTraceSpanKind,
  ProcTraceSpanReference,
  ProcTraceSpanStatus,
  ProcToolResultOutcome,
  ProcUsageCost,
  ProcUsageState,
  ResponsibilityRecord,
  ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import {
  jsonObjectSchema,
  jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { tagAssistantContextIdentity } from "./context-message-metadata";
import {
  buildFallbackMediaBlocks,
  describeStoredProcessMedia,
  parseStoredProcessMedia,
} from "./media";
import {
  INITIAL_HISTORY_GENERATION,
  type HistorySegmentKind,
  type ProcessHistorySegmentRecord,
} from "./history";
import {
  PROCESS_AI_CONFIG_STORE_KEY,
  parseProcessAiConfigSnapshot,
} from "./ai-config";
import { materializeLegacyToolResultImages } from "./tool-result-media";
import { z } from "zod";

const DEFAULT_MESSAGE_READ_LIMIT = 200;
const MAX_TRACE_RUNS = 32;
const MAX_TRACE_SPANS_PER_RUN = 512;

export type ToolCallStatus = "registered" | "pending" | "completed" | "error";

export type ToolCallRecord = {
  id: string;
  dispatchId: string;
  call: string;
  args: JsonValue;
  status: ToolCallStatus;
  result: JsonValue;
  error: string | null;
  outcome: ProcToolResultOutcome | null;
};

export type PendingToolCallRecord = {
  runId: string;
  callId: string;
  call: string;
  args: JsonValue;
  status: "registered" | "pending";
};

export type ProcessTraceSpanList = {
  spans: ProcTraceSpan[];
  count: number;
};

export type MessageRole = "user" | "assistant" | "system" | "toolResult";
export type QueuedMessageRole = Extract<MessageRole, "user" | "system">;

export type MessageRecord = {
  id: number;
  generation: number;
  runId?: string | null;
  role: MessageRole;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  media: string | null;
  origin?: string | null;
  metadata: string | null;
  createdAt: number;
};

type MessageRow = {
  id: number;
  generation: number;
  run_id: string | null;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  media_json: string | null;
  origin_json: string | null;
  metadata_json?: string | null;
  created_at: number;
};

export type AssistantMessageMeta = {
  thinking?: ThinkingContent[];
  toolCalls?: ToolCall[];
};

export type MessageProviderMetadata = ProcMessageProviderMetadata;
export type MessageMetadata = ProcMessageMetadata;

export type QueuedMessage = {
  id: number;
  runId: string;
  generation: number;
  role: QueuedMessageRole;
  kind: string;
  message: string;
  media: string | null;
  origin?: string | null;
  provenance?: string | null;
};

export type EnqueueMessageOptions = {
  role?: QueuedMessageRole;
  kind?: string;
  media?: string;
  origin?: string;
  provenance?: string;
};

export type PendingHilRecord = {
  requestId: string;
  runId: string;
  ownerDispatchId?: string;
  toolCallId: string;
  toolName: string;
  syscall: SyscallName;
  args: JsonObject;
  createdAt: number;
};

type MessageStats = {
  count: number;
  firstMessageId: number | null;
  lastMessageId: number | null;
};

export type ContextEpochRecord = {
  id: string;
  generation: number;
  systemPrompt: string;
  r12yRevision: number;
  r12yCount: number;
  observedR12yRevision: number;
  r12yBaseline: ResponsibilityRecord[];
  sourceManifest: JsonObject;
  observedProjection: JsonObject | null;
  state: "live" | "closed";
  createdAt: number;
  closedAt?: number;
  closeReason?: string;
  archivePath?: string;
};

type ContextEpochRow = {
  epoch_id: string;
  generation: number;
  system_prompt: string;
  r12y_revision: number;
  r12y_count: number;
  observed_r12y_revision: number;
  r12y_baseline_json: string;
  source_manifest_json: string;
  observed_projection_json: string | null;
  state: "live" | "closed";
  created_at: number;
  closed_at: number | null;
  close_reason: string | null;
  archive_path: string | null;
};

type ProcessTraceSpanRow = {
  span_id: string;
  run_id: string;
  parent_span_id: string | null;
  kind: ProcTraceSpanKind;
  name: string;
  status: ProcTraceSpanStatus;
  started_at: number;
  ended_at: number | null;
  reference_json: string | null;
  attributes_json: string | null;
};

const traceReferenceSchema: z.ZodType<ProcTraceSpanReference> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run") }),
  z.object({ kind: z.literal("message"), messageId: z.number().int().positive() }),
  z.object({
    kind: z.literal("tool"),
    callId: z.string(),
    executionId: z.string(),
  }),
  z.object({
    kind: z.literal("approval"),
    requestId: z.string(),
    callId: z.string(),
  }),
  z.object({
    kind: z.literal("delivery"),
    callId: z.string().optional(),
    conversationId: z.string().optional(),
    messageId: z.string().optional(),
  }),
]);

type ToolResultMetadata = {
  toolName: string;
  isError: boolean;
  outcome?: ProcToolResultOutcome;
};

const toolCallStatusSchema = z.enum([
  "registered",
  "pending",
  "completed",
  "error",
]);
const messageRoleSchema = z.enum(["user", "assistant", "system", "toolResult"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional().catch(undefined);
const optionalNonNegativeNumberSchema = z.number().finite().nonnegative().optional().catch(undefined);
const optionalPositiveIntegerSchema = z.number().finite().positive().transform(Math.trunc).optional().catch(undefined);
const usageCostSourceSchema = z.enum(["provider", "model-pricing", "mixed"]);
const usageCostInputSchema = z.object({
  input: optionalNonNegativeNumberSchema,
  output: optionalNonNegativeNumberSchema,
  cacheRead: optionalNonNegativeNumberSchema,
  cacheWrite: optionalNonNegativeNumberSchema,
  total: optionalNonNegativeNumberSchema,
  source: usageCostSourceSchema.optional().catch(undefined),
});
const usageStateInputSchema = z.object({
  inputTokens: optionalNonNegativeNumberSchema,
  input: optionalNonNegativeNumberSchema,
  outputTokens: optionalNonNegativeNumberSchema,
  output: optionalNonNegativeNumberSchema,
  cacheReadTokens: optionalNonNegativeNumberSchema,
  cacheRead: optionalNonNegativeNumberSchema,
  cacheWriteTokens: optionalNonNegativeNumberSchema,
  cacheWrite: optionalNonNegativeNumberSchema,
  totalTokens: optionalNonNegativeNumberSchema,
  generations: optionalPositiveIntegerSchema,
  costIncomplete: z.literal(true).optional().catch(undefined),
  updatedAt: optionalNonNegativeNumberSchema,
  cost: usageCostInputSchema.nullable().optional().catch(undefined),
});
const usageCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  total: z.number().nonnegative(),
  currency: z.literal("USD"),
  source: usageCostSourceSchema,
});
const usageStateSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  cost: usageCostSchema.nullable(),
  generations: z.number().int().nonnegative().optional(),
  costIncomplete: z.literal(true).optional(),
  updatedAt: z.number().nonnegative().optional(),
});
const contextStateInputSchema = z.object({
  revision: z.number().finite().nonnegative().transform(Math.trunc).optional().catch(undefined),
  runId: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  lastMessageId: z.number().int().nonnegative().nullable().optional(),
  provider: z.string(),
  model: z.string(),
  reasoning: z.string().optional(),
  contextWindowTokens: z.number().nonnegative().nullable(),
  maxOutputTokens: z.number().nonnegative(),
  estimatedInputTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  confirmedInputTokens: optionalNonNegativeNumberSchema,
  estimatedTrailingInputTokens: optionalNonNegativeNumberSchema,
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  usage: usageStateSchema.optional(),
  historyUsage: usageStateSchema.optional(),
  inputBudgetTokens: z.number().finite().nonnegative().nullable().optional().catch(undefined),
  remainingInputTokens: z.number().finite().nonnegative().nullable().optional().catch(undefined),
  availableInputTokens: z.number().finite().nonnegative().nullable(),
  pressure: z.number().nullable(),
  level: z.enum(["unknown", "ok", "warn", "critical", "full"]),
  source: z.enum(["estimate", "provider", "mixed"]),
  updatedAt: z.number().nonnegative(),
});
const providerMetadataSchema = z.object({
  api: optionalNonEmptyStringSchema,
  provider: optionalNonEmptyStringSchema,
  model: optionalNonEmptyStringSchema,
  responseModel: optionalNonEmptyStringSchema,
  responseId: optionalNonEmptyStringSchema,
  stopReason: optionalNonEmptyStringSchema,
});
const modelMetadataSchema = z.object({
  provider: optionalNonEmptyStringSchema,
  model: optionalNonEmptyStringSchema,
});
const fallbackMetadataSchema = z.object({
  used: z.literal(true).optional().catch(undefined),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  reason: optionalNonEmptyStringSchema,
});
const messageMetadataInputSchema = z.object({
  contextEpochId: optionalNonEmptyStringSchema,
  generationContextId: optionalNonEmptyStringSchema,
  provider: z.unknown().optional(),
  fallback: z.unknown().optional(),
  usage: z.unknown().optional(),
});
const thinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const toolCallSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: jsonObjectSchema,
  thoughtSignature: z.string().optional(),
});
const assistantMessageMetaSchema = z.object({
  thinking: z.array(thinkingContentSchema).optional(),
  toolCalls: z.array(toolCallSchema).optional(),
});
const toolResultMetaSchema = z.object({
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  outcome: z.enum(["completed", "failed", "cancelled", "denied"]).optional(),
});
const failedToolResultSchema = z.object({ status: z.literal("failed") });

function normalizeStoredToolResultOutcome(value: string | null): ProcToolResultOutcome | null {
  if (
    value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "denied"
  ) {
    return value;
  }
  return null;
}

export function resolvedToolResultOutcome(result: JsonValue): "completed" | "failed" {
  return failedToolResultSchema.safeParse(result).success ? "failed" : "completed";
}

export class ProcessStore {
  constructor(private readonly sql: SqlStorage) {}

  // --- History ---

  getHistoryGeneration(): number {
    const stored = Number.parseInt(this.getValue("historyGeneration") ?? "", 10);
    return Number.isSafeInteger(stored) && stored > 0
      ? stored
      : INITIAL_HISTORY_GENERATION;
  }

  resetHistory(): number {
    const generation = this.getHistoryGeneration() + 1;
    this.clearMessages();
    this.clearTraceSpans();
    this.setValue("historyGeneration", String(generation));
    return generation;
  }

  startTraceSpan(input: {
    id: string;
    runId: string;
    parentId?: string;
    kind: ProcTraceSpanKind;
    name: string;
    startedAt: number;
    reference?: ProcTraceSpanReference;
    attributes?: JsonObject;
  }): boolean {
    const count = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM process_trace_spans WHERE run_id = ?",
      input.runId,
    ).toArray()[0]?.count ?? 0;
    if (count >= MAX_TRACE_SPANS_PER_RUN) return false;

    const cursor = this.sql.exec(
      `INSERT OR IGNORE INTO process_trace_spans (
        span_id, run_id, parent_span_id, kind, name, status,
        started_at, ended_at, reference_json, attributes_json
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?)`,
      input.id,
      input.runId,
      input.parentId ?? null,
      input.kind,
      input.name,
      input.startedAt,
      input.reference ? JSON.stringify(input.reference) : null,
      input.attributes ? JSON.stringify(input.attributes) : null,
    );
    return cursor.rowsWritten > 0;
  }

  finishTraceSpan(
    id: string,
    status: Exclude<ProcTraceSpanStatus, "running">,
    endedAt: number,
    options: {
      reference?: ProcTraceSpanReference;
      attributes?: JsonObject;
    } = {},
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE process_trace_spans
       SET status = ?, ended_at = ?,
           reference_json = COALESCE(?, reference_json),
           attributes_json = COALESCE(?, attributes_json)
       WHERE span_id = ? AND status = 'running'`,
      status,
      endedAt,
      options.reference ? JSON.stringify(options.reference) : null,
      options.attributes ? JSON.stringify(options.attributes) : null,
      id,
    );
    return cursor.rowsWritten > 0;
  }

  setTraceSpanReference(id: string, reference: ProcTraceSpanReference): void {
    this.sql.exec(
      "UPDATE process_trace_spans SET reference_json = ? WHERE span_id = ?",
      JSON.stringify(reference),
      id,
    );
  }

  finishRunTrace(
    runId: string,
    status: Exclude<ProcTraceSpanStatus, "running" | "denied">,
    endedAt: number,
  ): void {
    this.sql.exec(
      `UPDATE process_trace_spans
       SET status = ?, ended_at = ?
       WHERE run_id = ? AND status = 'running' AND kind != 'run'`,
      status === "ok" ? "aborted" : status,
      endedAt,
      runId,
    );
    this.finishTraceSpan(`run:${runId}`, status, endedAt);
    this.pruneTraceRuns();
  }

  getRunTraceStartedAt(runId: string): number | null {
    return this.sql.exec<{ started_at: number }>(
      `SELECT started_at FROM process_trace_spans
       WHERE span_id = ? AND run_id = ? AND kind = 'run'
       LIMIT 1`,
      `run:${runId}`,
      runId,
    ).toArray()[0]?.started_at ?? null;
  }

  listTraceSpans(options: { runId?: string; limit: number }): ProcessTraceSpanList {
    const filter = options.runId ? "WHERE run_id = ?" : "";
    const args = options.runId ? [options.runId] : [];
    const count = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM process_trace_spans ${filter}`,
      ...args,
    ).toArray()[0]?.count ?? 0;
    const rows = this.sql.exec<ProcessTraceSpanRow>(
      `SELECT * FROM process_trace_spans ${filter}
       ORDER BY started_at DESC, span_id DESC
       LIMIT ?`,
      ...args,
      options.limit,
    ).toArray().reverse();
    return {
      count,
      spans: rows.map(processTraceSpanFromRow),
    };
  }

  clearTraceSpans(): void {
    this.sql.exec("DELETE FROM process_trace_spans");
  }

  private pruneTraceRuns(): void {
    this.sql.exec(
      `DELETE FROM process_trace_spans
       WHERE run_id NOT IN (
         SELECT run_id
         FROM process_trace_spans
         GROUP BY run_id
         ORDER BY MIN(started_at) DESC, run_id DESC
         LIMIT ?
       )`,
      MAX_TRACE_RUNS,
    );
  }

  getLiveContextEpoch(): ContextEpochRecord | null {
    const row = this.sql.exec<ContextEpochRow>(
      "SELECT * FROM context_epochs WHERE state = 'live' LIMIT 1",
    ).toArray()[0];
    return row ? contextEpochFromRow(row) : null;
  }

  createContextEpoch(input: {
    id: string;
    generation: number;
    systemPrompt: string;
    r12yRevision: number;
    r12yCount: number;
    r12yBaseline: ResponsibilityRecord[];
    sourceManifest: JsonObject;
    observedProjection: JsonObject;
    now: number;
  }): ContextEpochRecord {
    if (this.getLiveContextEpoch()) {
      throw new Error("A live context epoch already exists");
    }
    this.sql.exec(
      `INSERT INTO context_epochs (
        epoch_id, generation, system_prompt, r12y_revision, r12y_count,
        observed_r12y_revision, r12y_baseline_json,
        source_manifest_json, observed_projection_json,
        state, created_at, closed_at, close_reason,
        archive_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, NULL, NULL, NULL)`,
      input.id,
      input.generation,
      input.systemPrompt,
      input.r12yRevision,
      input.r12yCount,
      input.r12yRevision,
      JSON.stringify(input.r12yBaseline),
      JSON.stringify(input.sourceManifest),
      JSON.stringify(input.observedProjection),
      input.now,
    );
    const epoch = this.getLiveContextEpoch();
    if (!epoch) throw new Error("Context epoch was not persisted");
    return epoch;
  }

  closeLiveContextEpoch(
    reason: string,
    now: number,
    archivePath?: string,
  ): ContextEpochRecord | null {
    const current = this.getLiveContextEpoch();
    if (!current) return null;
    this.sql.exec(
      `UPDATE context_epochs
       SET state = 'closed', closed_at = ?, close_reason = ?, archive_path = ?
       WHERE epoch_id = ? AND state = 'live'`,
      now,
      reason,
      archivePath ?? null,
      current.id,
    );
    return this.getContextEpoch(current.id);
  }

  getContextEpoch(id: string): ContextEpochRecord | null {
    const row = this.sql.exec<ContextEpochRow>(
      "SELECT * FROM context_epochs WHERE epoch_id = ? LIMIT 1",
      id,
    ).toArray()[0];
    return row ? contextEpochFromRow(row) : null;
  }

  listContextEpochs(): ContextEpochRecord[] {
    return this.sql.exec<ContextEpochRow>(
      "SELECT * FROM context_epochs ORDER BY created_at ASC, epoch_id ASC",
    ).toArray().map(contextEpochFromRow);
  }

  appendContextEpochTransition(
    epochId: string,
    transition: ResponsibilityTransition,
    content: string,
    runId: string,
  ): number {
    const epoch = this.getContextEpoch(epochId);
    if (!epoch || epoch.state !== "live") {
      throw new Error(`Live context epoch not found: ${epochId}`);
    }
    if (transition.revision <= epoch.observedR12yRevision) {
      return epoch.observedR12yRevision;
    }
    const messageId = this.appendMessage("system", content, { runId });
    this.sql.exec(
      `INSERT INTO context_epoch_transitions (
        epoch_id, revision, transition_json, message_id, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      epochId,
      transition.revision,
      JSON.stringify(transition),
      messageId,
      transition.createdAtMs,
    );
    this.sql.exec(
      `UPDATE context_epochs
       SET observed_r12y_revision = ?
       WHERE epoch_id = ? AND state = 'live'`,
      transition.revision,
      epochId,
    );
    return transition.revision;
  }

  advanceContextEpochObservedRevision(epochId: string, revision: number): void {
    this.sql.exec(
      `UPDATE context_epochs
       SET observed_r12y_revision = ?
       WHERE epoch_id = ?
         AND state = 'live'
         AND observed_r12y_revision < ?`,
      revision,
      epochId,
      revision,
    );
  }

  appendContextEpochMessage(input: {
    epochId: string;
    kind: string;
    observedProjection?: JsonObject;
    content: string;
    runId: string;
    createdAt: number;
  }): number {
    const epoch = this.getContextEpoch(input.epochId);
    if (!epoch || epoch.state !== "live") {
      throw new Error(`Live context epoch not found: ${input.epochId}`);
    }
    const messageId = this.appendMessage("system", input.content, {
      runId: input.runId,
      createdAt: input.createdAt,
    });
    this.sql.exec(
      `INSERT INTO context_epoch_message_refs (
        epoch_id, message_id, kind, created_at
      ) VALUES (?, ?, ?, ?)`,
      input.epochId,
      messageId,
      input.kind,
      input.createdAt,
    );
    if (input.observedProjection) {
      this.sql.exec(
        `UPDATE context_epochs
         SET observed_projection_json = ?
         WHERE epoch_id = ? AND state = 'live'`,
        JSON.stringify(input.observedProjection),
        input.epochId,
      );
    }
    return messageId;
  }

  listContextEpochTransitions(epochId: string): ResponsibilityTransition[] {
    return this.sql.exec<{ transition_json: string }>(
      `SELECT transition_json
       FROM context_epoch_transitions
       WHERE epoch_id = ?
       ORDER BY revision ASC`,
      epochId,
    ).toArray().map((row) => (
      parseContextEpochJson<ResponsibilityTransition>(row.transition_json)
    ));
  }

  recordContextEpochRun(runId: string, finish: JsonObject, now: number): void {
    const epoch = this.getLiveContextEpoch();
    if (!epoch) return;
    this.sql.exec(
      `INSERT OR IGNORE INTO context_epoch_runs (
        epoch_id, run_id, finish_json, created_at
      ) VALUES (?, ?, ?, ?)`,
      epoch.id,
      runId,
      JSON.stringify(finish),
      now,
    );
  }

  listContextEpochRuns(epochId: string): JsonObject[] {
    return this.sql.exec<{ finish_json: string }>(
      `SELECT finish_json
       FROM context_epoch_runs
       WHERE epoch_id = ?
       ORDER BY created_at ASC, run_id ASC`,
      epochId,
    ).toArray().map((row) => parseContextEpochJson<JsonObject>(row.finish_json));
  }

  deleteContextEpochOwnedMessages(epochId: string): void {
    this.sql.exec(
      `DELETE FROM messages
       WHERE id IN (
         SELECT message_id FROM context_epoch_transitions WHERE epoch_id = ?
         UNION
         SELECT message_id FROM context_epoch_message_refs WHERE epoch_id = ?
       )`,
      epochId,
      epochId,
    );
  }

  getHistoryPrefixMessages(opts: {
    keepLast?: number;
    throughMessageId?: number;
  }): MessageRecord[] {
    const records = this.getMessagesForGeneration();

    if (opts.keepLast !== undefined) {
      const keepLast = Math.max(0, Math.trunc(opts.keepLast));
      const compactCount = normalizeCompactionCut(
        records,
        records.length - keepLast,
        "backward",
      );
      return compactCount > 0 ? records.slice(0, compactCount) : [];
    }

    if (opts.throughMessageId !== undefined) {
      const throughMessageId = Math.trunc(opts.throughMessageId);
      const compactCount = normalizeCompactionCut(
        records,
        records.findLastIndex((record) => record.id <= throughMessageId) + 1,
        "forward",
      );
      return records.slice(0, compactCount);
    }

    return [];
  }

  compactHistoryPrefix(opts: {
    generation: number;
    fromMessageId: number;
    toMessageId: number;
    summary: string;
  }): number {
    const summaryMessageId = opts.fromMessageId;
    const now = Date.now();

    this.sql.exec(
      `DELETE FROM messages
        WHERE generation = ?
          AND id >= ?
          AND id <= ?`,
      opts.generation,
      opts.fromMessageId,
      opts.toMessageId,
    );
    this.sql.exec(
      `INSERT INTO messages (
        id, generation, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      ) VALUES (?, ?, 'system', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      summaryMessageId,
      opts.generation,
      opts.summary,
      now,
    );

    return summaryMessageId;
  }

  recordHistorySegment(input: {
    id: string;
    generation: number;
    kind: HistorySegmentKind;
    fromMessageId: number;
    toMessageId: number;
    archivePath: string;
    summaryMessageId?: number | null;
  }): ProcessHistorySegmentRecord {
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT INTO history_segments (
        id, generation, kind, from_message_id, to_message_id,
        archive_path, summary_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.generation,
      input.kind,
      input.fromMessageId,
      input.toMessageId,
      input.archivePath,
      input.summaryMessageId ?? null,
      createdAt,
    );
    return {
      id: input.id,
      generation: input.generation,
      kind: input.kind,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
      archivePath: input.archivePath,
      summaryMessageId: input.summaryMessageId ?? null,
      createdAt,
    };
  }

  listHistorySegments(): ProcessHistorySegmentRecord[] {
    return [...this.sql.exec<{
      id: string;
      generation: number;
      kind: string;
      from_message_id: number;
      to_message_id: number;
      archive_path: string;
      summary_message_id: number | null;
      created_at: number;
    }>(
      `SELECT id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM history_segments
        ORDER BY created_at ASC, id ASC`,
    )].map((row) => ({
      id: row.id,
      generation: row.generation,
      kind: "compaction",
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      archivePath: row.archive_path,
      summaryMessageId: row.summary_message_id,
      createdAt: row.created_at,
    }));
  }

  getHistorySegment(segmentId: string): ProcessHistorySegmentRecord | null {
    const rows = [...this.sql.exec<{
      id: string;
      generation: number;
      kind: string;
      from_message_id: number;
      to_message_id: number;
      archive_path: string;
      summary_message_id: number | null;
      created_at: number;
    }>(
      `SELECT id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM history_segments
        WHERE id = ?
        LIMIT 1`,
      segmentId,
    )];
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      generation: row.generation,
      kind: "compaction",
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      archivePath: row.archive_path,
      summaryMessageId: row.summary_message_id,
      createdAt: row.created_at,
    };
  }

  // --- Tool calls ---

  register(
    dispatchId: string,
    id: string,
    runId: string,
    call: string,
    args: JsonValue,
  ): void {
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT INTO pending_tool_calls (
        dispatch_id, id, run_id, call, args_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'registered', ?)`,
      dispatchId,
      id,
      runId,
      call,
      JSON.stringify(args),
      createdAt,
    );
    this.startTraceSpan({
      id: `tool:${dispatchId}`,
      runId,
      parentId: `run:${runId}`,
      kind: "tool",
      name: syscallToolName(call) ?? call,
      startedAt: createdAt,
      reference: { kind: "tool", callId: id, executionId: dispatchId },
      attributes: { syscall: call },
    });
  }

  resolve(
    dispatchId: string,
    result: JsonValue,
    outcome: "completed" | "failed" = resolvedToolResultOutcome(result),
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'completed', result_json = ?, outcome = ?
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      JSON.stringify(result ?? null),
      outcome,
      dispatchId,
    );
    if (cursor.rowsWritten > 0) {
      const status = outcome === "completed" ? "ok" : "error";
      const endedAt = Date.now();
      this.finishTraceSpan(`execution:${dispatchId}`, status, endedAt);
      this.finishTraceSpan(`tool:${dispatchId}`, status, endedAt);
    }
    return cursor.rowsWritten > 0;
  }

  fail(
    dispatchId: string,
    error: string,
    outcome: Exclude<ProcToolResultOutcome, "completed"> = "failed",
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'error', error = ?, outcome = ?
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      error,
      outcome,
      dispatchId,
    );
    if (cursor.rowsWritten > 0) {
      const status = outcome === "cancelled"
        ? "aborted"
        : outcome === "denied"
          ? "denied"
          : "error";
      const endedAt = Date.now();
      this.finishTraceSpan(`execution:${dispatchId}`, status, endedAt);
      this.finishTraceSpan(`tool:${dispatchId}`, status, endedAt);
    }
    return cursor.rowsWritten > 0;
  }

  markDispatched(dispatchId: string): boolean {
    const cursor = this.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'pending'
        WHERE dispatch_id = ? AND status = 'registered'`,
      dispatchId,
    );
    if (cursor.rowsWritten > 0) {
      const record = this.sql.exec<{
        id: string;
        run_id: string;
        call: string;
      }>(
        "SELECT id, run_id, call FROM pending_tool_calls WHERE dispatch_id = ?",
        dispatchId,
      ).toArray()[0];
      if (record) {
        this.startTraceSpan({
          id: `execution:${dispatchId}`,
          runId: record.run_id,
          parentId: `tool:${dispatchId}`,
          kind: "tool",
          name: "Execute",
          startedAt: Date.now(),
          reference: {
            kind: "tool",
            callId: record.id,
            executionId: dispatchId,
          },
          attributes: { syscall: record.call },
        });
      }
    }
    return cursor.rowsWritten > 0;
  }

  getPending(dispatchId: string): PendingToolCallRecord | null {
    const rows = [...this.sql.exec<{
      id: string;
      run_id: string;
      call: string;
      args_json: string | null;
      status: "registered" | "pending";
    }>(
      `SELECT id, run_id, call, args_json, status
         FROM pending_tool_calls
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      dispatchId,
    )];
    if (rows.length === 0) return null;
    return {
      runId: rows[0].run_id,
      callId: rows[0].id,
      call: rows[0].call,
      args: rows[0].args_json
        ? jsonValueSchema.parse(JSON.parse(rows[0].args_json))
        : null,
      status: rows[0].status,
    };
  }

  isRunResolved(runId: string): boolean {
    const rows = [...this.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt
         FROM pending_tool_calls
        WHERE run_id = ? AND status IN ('registered', 'pending')`,
      runId,
    )];
    return (rows[0]?.cnt ?? 0) === 0;
  }

  getResults(runId: string): ToolCallRecord[] {
    return [...this.sql.exec<{
      id: string;
      dispatch_id: string;
      call: string;
      args_json: string;
      status: string;
      result_json: string | null;
      error: string | null;
      outcome: string | null;
    }>(
      `SELECT id, dispatch_id, call, args_json, status, result_json, error, outcome
         FROM pending_tool_calls
        WHERE run_id = ?
        ORDER BY created_at ASC, rowid ASC`,
      runId,
    )].map((row) => ({
      id: row.id,
      dispatchId: row.dispatch_id,
      call: row.call,
      args: jsonValueSchema.parse(JSON.parse(row.args_json)),
      status: toolCallStatusSchema.parse(row.status),
      result: row.result_json
        ? jsonValueSchema.parse(JSON.parse(row.result_json))
        : null,
      error: row.error,
      outcome: normalizeStoredToolResultOutcome(row.outcome),
    }));
  }

  clearRun(runId: string): void {
    this.sql.exec("DELETE FROM pending_tool_calls WHERE run_id = ?", runId);
  }

  clearPendingToolCalls(): void {
    this.sql.exec("DELETE FROM pending_tool_calls");
  }

  setPendingHil(record: PendingHilRecord): void {
    this.clearPendingHil();
    this.sql.exec(
      `INSERT INTO pending_hil (
        request_id, run_id, owner_dispatch_id, tool_call_id,
        tool_name, syscall, args_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.runId,
      record.ownerDispatchId ?? null,
      record.toolCallId,
      record.toolName,
      record.syscall,
      JSON.stringify(record.args),
      record.createdAt,
    );
    const dispatchId = record.ownerDispatchId ?? this.sql.exec<{ dispatch_id: string }>(
      `SELECT dispatch_id FROM pending_tool_calls
       WHERE run_id = ? AND id = ?
       ORDER BY created_at DESC LIMIT 1`,
      record.runId,
      record.toolCallId,
    ).toArray()[0]?.dispatch_id;
    this.startTraceSpan({
      id: `approval:${record.requestId}`,
      runId: record.runId,
      parentId: dispatchId ? `tool:${dispatchId}` : `run:${record.runId}`,
      kind: "approval",
      name: `Approve ${record.toolName}`,
      startedAt: record.createdAt,
      reference: {
        kind: "approval",
        requestId: record.requestId,
        callId: record.toolCallId,
      },
      attributes: {
        syscall: record.syscall,
      },
    });
  }

  getPendingHil(requestId?: string): PendingHilRecord | null {
    const rows = [
      ...this.sql.exec<{
        request_id: string;
        run_id: string;
        owner_dispatch_id: string | null;
        tool_call_id: string;
        tool_name: string;
        syscall: string;
        args_json: string;
        created_at: number;
      }>(
        requestId
          ? `SELECT * FROM pending_hil WHERE request_id = ? ORDER BY created_at ASC LIMIT 1`
          : `SELECT * FROM pending_hil ORDER BY created_at ASC LIMIT 1`,
        ...(requestId ? [requestId] : []),
      ),
    ];
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!isToolSyscallName(row.syscall)) {
      throw new Error(`Stored approval references an unsupported syscall: ${row.syscall}`);
    }
    const record: PendingHilRecord = {
      requestId: row.request_id,
      runId: row.run_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      syscall: row.syscall,
      args: jsonObjectSchema.parse(JSON.parse(row.args_json)),
      createdAt: row.created_at,
    };
    if (row.owner_dispatch_id) {
      record.ownerDispatchId = row.owner_dispatch_id;
    }
    return record;
  }

  getPendingHilForRun(runId: string): PendingHilRecord | null {
    const record = this.getPendingHil();
    if (!record || record.runId !== runId) {
      return null;
    }
    return record;
  }

  clearPendingHil(
    status: Exclude<ProcTraceSpanStatus, "running"> = "aborted",
  ): void {
    const approvals = this.sql.exec<{ request_id: string }>(
      "SELECT request_id FROM pending_hil",
    ).toArray();
    this.sql.exec("DELETE FROM pending_hil");
    const endedAt = Date.now();
    for (const approval of approvals) {
      this.finishTraceSpan(`approval:${approval.request_id}`, status, endedAt);
    }
  }

  appendMessage(
    role: MessageRole,
    content: string,
    opts?: {
      generation?: number;
      toolCalls?: string;
      toolCallId?: string;
      media?: string;
      origin?: string;
      metadata?: MessageMetadata | string | null;
      runId?: string;
      createdAt?: number;
    },
  ): number {
    const generation = opts?.generation ?? this.getHistoryGeneration();
    const metadataJson = stringifyMessageMetadata(opts?.metadata);
    this.sql.exec(
      `INSERT INTO messages (
        generation, run_id, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      generation,
      opts?.runId ?? null,
      role,
      content,
      opts?.toolCalls ?? null,
      opts?.toolCallId ?? null,
      opts?.media ?? null,
      opts?.origin ?? null,
      metadataJson,
      opts?.createdAt ?? Date.now(),
    );

    const rows = [...this.sql.exec<{ id: number }>("SELECT last_insert_rowid() as id")];
    const messageId = rows[0]?.id ?? -1;

    if (role === "assistant") {
      const metadata = parseMessageMetadata(metadataJson);
      if (metadata?.usage) {
        this.addHistoryUsage(metadata.usage);
      }
    }

    return messageId;
  }

  updateMessageMedia(messageId: number, runId: string, media: string): void {
    this.sql.exec(
      "UPDATE messages SET media_json = ? WHERE id = ? AND run_id = ?",
      media,
      messageId,
      runId,
    );
  }

  clearMessageMedia(messageId: number, runId: string): void {
    this.sql.exec(
      "UPDATE messages SET media_json = NULL WHERE id = ? AND run_id = ?",
      messageId,
      runId,
    );
  }

  hasMessageMedia(messageId: number, runId: string): boolean {
    return this.sql.exec<{ present: number }>(
      `SELECT media_json IS NOT NULL AS present
         FROM messages
        WHERE id = ? AND run_id = ?`,
      messageId,
      runId,
    ).toArray()[0]?.present === 1;
  }

  referencesMediaKey(key: string): boolean {
    const rows = this.sql.exec<{ media_json: string }>(
      `SELECT media_json FROM messages WHERE media_json IS NOT NULL
       UNION ALL
       SELECT media_json FROM message_queue WHERE media_json IS NOT NULL`,
    );
    for (const row of rows) {
      if (parseStoredProcessMedia(row.media_json).some((item) => item.key === key)) {
        return true;
      }
    }
    return false;
  }

  getMessages(opts?: {
    limit?: number | null;
    offset?: number;
    beforeMessageId?: number;
    afterMessageId?: number;
    tail?: boolean;
  }): MessageRecord[] {
    const limit = opts?.limit === null ? null : opts?.limit ?? DEFAULT_MESSAGE_READ_LIMIT;
    const offset = opts?.offset ?? 0;
    const beforeMessageId = opts?.beforeMessageId;
    const afterMessageId = opts?.afterMessageId;
    const tail = opts?.tail === true;
    const hasLimit = limit !== null;
    const where: string[] = [];
    const args: Array<number> = [];
    if (beforeMessageId !== undefined) {
      where.push("id < ?");
      args.push(beforeMessageId);
    }
    if (afterMessageId !== undefined) {
      where.push("id > ?");
      args.push(afterMessageId);
    }
    const pagination = hasLimit
      ? { clause: "LIMIT ? OFFSET ?", args: [limit, offset] as const }
      : offset > 0
        ? { clause: "LIMIT -1 OFFSET ?", args: [offset] as const }
        : { clause: "", args: [] as const };
    const order = tail || beforeMessageId !== undefined ? "DESC" : "ASC";
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = [...this.sql.exec<MessageRow>(
        `SELECT * FROM messages ${filter} ORDER BY id ${order} ${pagination.clause}`,
      ...args,
      ...pagination.args,
    )];
    if (tail || beforeMessageId !== undefined) {
      rows.reverse();
    }

    return rows.map(messageRecordFromRow);
  }

  hasMessageBefore(messageId: number): boolean {
    const rows = [...this.sql.exec<{ found: number }>(
      "SELECT 1 as found FROM messages WHERE id < ? LIMIT 1",
      messageId,
    )];
    return rows.length > 0;
  }

  hasMessageAfter(messageId: number): boolean {
    const rows = [...this.sql.exec<{ found: number }>(
      "SELECT 1 as found FROM messages WHERE id > ? LIMIT 1",
      messageId,
    )];
    return rows.length > 0;
  }

  getMessagesForGeneration(generation: number = this.getHistoryGeneration()): MessageRecord[] {
    return [...this.sql.exec<MessageRow>(
      `SELECT * FROM messages
        WHERE generation = ?
        ORDER BY id ASC`,
      generation,
    )].map(messageRecordFromRow);
  }

  getRunInputMessageId(runId: string): number | null {
    const row = this.sql.exec<{ id: number }>(
      `SELECT id FROM messages
        WHERE generation = ? AND run_id = ? AND role = 'user'
        ORDER BY id ASC
        LIMIT 1`,
      this.getHistoryGeneration(),
      runId,
    ).toArray()[0];
    return row?.id ?? null;
  }

  getMessagesForGenerationAfter(opts: {
    generation: number;
    afterMessageId: number;
    throughCreatedAt?: number;
  }): MessageRecord[] {
    const args: number[] = [opts.generation, opts.afterMessageId];
    const createdAtFilter = opts.throughCreatedAt === undefined
      ? ""
      : "AND created_at <= ?";
    if (opts.throughCreatedAt !== undefined) {
      args.push(opts.throughCreatedAt);
    }

    return [...this.sql.exec<MessageRow>(
      `SELECT * FROM messages
        WHERE generation = ?
          AND id > ?
          ${createdAtFilter}
        ORDER BY id ASC`,
      ...args,
    )].map(messageRecordFromRow);
  }

  messageCount(): number {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM messages",
    )];
    return rows[0]?.cnt ?? 0;
  }

  messageStats(): MessageStats {
    const rows = [...this.sql.exec<{ cnt: number; first_id: number | null; last_id: number | null }>(
      "SELECT COUNT(*) as cnt, MIN(id) as first_id, MAX(id) as last_id FROM messages",
    )];
    return {
      count: rows[0]?.cnt ?? 0,
      firstMessageId: rows[0]?.first_id ?? null,
      lastMessageId: rows[0]?.last_id ?? null,
    };
  }

  clearMessages(): number {
    const count = this.messageCount();
    this.sql.exec("DELETE FROM messages");
    this.deleteContextState();
    this.deleteHistoryUsage();
    return count;
  }

  // we could use `this.ctx.storage.kv` but the sqlite tables
  // it generates are private and can't see it, so we implement
  // it ourselves so we can inspect the tables.

  getValue(key: string): string | null {
    const rows = [...this.sql.exec<{ value: string }>(
      "SELECT value FROM process_kv WHERE key = ?",
      key,
    )];
    return rows[0]?.value ?? null;
  }

  setValue(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO process_kv (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  deleteValue(key: string): void {
    this.sql.exec("DELETE FROM process_kv WHERE key = ?", key);
  }

  getAiConfigSnapshot(): ProcAiConfigSnapshot | null {
    const raw = this.getValue(PROCESS_AI_CONFIG_STORE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return parseProcessAiConfigSnapshot(raw);
    } catch {
      return null;
    }
  }

  setAiConfigSnapshot(snapshot: ProcAiConfigSnapshot): void {
    this.setValue(PROCESS_AI_CONFIG_STORE_KEY, JSON.stringify(snapshot));
  }

  clearAiConfigSnapshot(): void {
    this.deleteValue(PROCESS_AI_CONFIG_STORE_KEY);
  }

  getContextState(): ProcContextState | null {
    const raw = this.getValue("contextState");
    if (!raw) {
      return null;
    }
    try {
      return normalizeContextState(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  setContextState(state: ProcContextState): void {
    this.setValue("contextState", JSON.stringify(state));
  }

  getContextStateRevision(): number {
    const stored = Number.parseInt(this.getValue("contextStateRevision") ?? "", 10);
    return Math.max(
      Number.isSafeInteger(stored) && stored >= 0 ? stored : 0,
      this.getContextState()?.revision ?? 0,
    );
  }

  nextContextStateRevision(): number {
    const current = this.getContextStateRevision();
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Context state revision exhausted");
    }
    const revision = current + 1;
    this.setValue("contextStateRevision", String(revision));
    return revision;
  }

  deleteContextState(): void {
    this.deleteValue("contextState");
  }

  getHistoryUsage(): ProcUsageState | null {
    const raw = this.getValue("historyUsage");
    if (!raw) {
      return null;
    }
    try {
      return normalizeUsageState(JSON.parse(raw)) ?? null;
    } catch {
      return null;
    }
  }

  addHistoryUsage(usage: ProcUsageState): ProcUsageState {
    const normalizedUsage = normalizeUsageState(usage);
    if (!normalizedUsage) {
      return this.getHistoryUsage() ?? emptyUsageState();
    }
    const merged = mergeUsageStates(
      this.getHistoryUsage(),
      normalizedUsage,
    );
    this.setValue("historyUsage", JSON.stringify(merged));
    return merged;
  }

  deleteHistoryUsage(): void {
    this.deleteValue("historyUsage");
  }

  // --- Message conversion to pi-ai format ---

  toMessages(opts?: {
    limit?: number | null;
    offset?: number;
    /** Only usage confirmed against this exact prompt epoch is reusable. */
    contextEpochId?: string;
    /** Only usage confirmed against this exact system-prompt/tool shape is reusable. */
    generationContextId?: string;
  }): Message[] {
    const records = this.getMessages(opts);
    const messages: Message[] = [];

    for (const r of records) {
      switch (r.role) {
        case "user": {
          const media = parseStoredProcessMedia(r.media);
          if (media.length === 0) {
            messages.push({
              role: "user",
              content: r.content,
              timestamp: r.createdAt,
            } satisfies UserMessage);
            break;
          }

          const content = buildFallbackUserContent(r.content, media);
          messages.push({
            role: "user",
            content,
            timestamp: r.createdAt,
          } satisfies UserMessage);
          break;
        }

        case "system": {
          messages.push({
            role: "user",
            content: `[GSV EVENT]\n${r.content}`,
            timestamp: r.createdAt,
          } satisfies UserMessage);
          break;
        }

        case "assistant": {
          const content: (TextContent | ThinkingContent | ToolCall)[] = [];
          const meta = parseAssistantMessageMeta(r.toolCalls);
          const metadata = parseMessageMetadata(r.metadata);
          if (meta.thinking) {
            content.push(...meta.thinking);
          }
          if (r.content) {
            content.push({ type: "text", text: r.content });
          }
          if (meta.toolCalls) {
            content.push(...meta.toolCalls);
          }
          const message: AssistantMessage = {
            role: "assistant",
            content,
            api: metadata?.provider?.api ?? "",
            provider: metadata?.provider?.provider ?? "",
            model: metadata?.provider?.model ?? "",
            usage: usageStateToPiUsage(
              (
                opts?.contextEpochId === undefined
                || metadata?.contextEpochId === opts.contextEpochId
              ) && (
                opts?.generationContextId === undefined
                || metadata?.generationContextId === opts.generationContextId
              )
                ? metadata?.usage
                : undefined,
            ),
            stopReason: normalizeAssistantStopReason(metadata?.provider?.stopReason),
            timestamp: r.createdAt,
          };
          if (metadata?.provider?.responseModel) {
            message.responseModel = metadata.provider.responseModel;
          }
          if (metadata?.provider?.responseId) {
            message.responseId = metadata.provider.responseId;
          }
          tagAssistantContextIdentity(
            message,
            metadata?.contextEpochId,
            metadata?.generationContextId,
          );
          messages.push(message);
          break;
        }

        case "toolResult": {
          const meta = r.toolCalls
            ? toolResultMetaSchema.parse(JSON.parse(r.toolCalls))
            : {};
          const media = parseStoredProcessMedia(r.media);
          const legacyImageContent = media.length === 0
            ? materializeLegacyToolResultImages(r.content)
            : null;
          messages.push({
            role: "toolResult",
            toolCallId: requiredToolCallId(r),
            toolName: meta.toolName ?? "unknown",
            content: legacyImageContent ?? [
              { type: "text", text: r.content },
              ...buildFallbackMediaBlocks(media),
            ],
            isError: meta.isError ?? false,
            timestamp: r.createdAt,
          } satisfies ToolResultMessage);
          break;
        }
      }
    }

    return messages;
  }

  /**
   * Append a tool result message. Stores presentation metadata in the
   * tool_calls column so proc.history can expose a structured result.
   */
  appendToolResult(
    toolCallId: string,
    syscallName: string,
    content: string,
    isError: boolean,
    runId?: string,
    outcome?: ProcToolResultOutcome,
    media?: string,
  ): number {
    const toolName = syscallToolName(syscallName) ?? syscallName;
    const toolResultMeta: ToolResultMetadata = {
      toolName,
      isError,
    };
    if (outcome) {
      toolResultMeta.outcome = outcome;
    }
    return this.appendMessage("toolResult", content, {
      runId,
      toolCallId,
      media,
      toolCalls: JSON.stringify(toolResultMeta),
    });
  }

  // --- Message queue ---

  enqueue(
    runId: string,
    message: string,
    options: EnqueueMessageOptions = {},
  ): void {
    const generation = this.getHistoryGeneration();
    this.sql.exec(
      `INSERT INTO message_queue (
        run_id, generation, role, kind, message, media_json, origin_json,
        provenance_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      generation,
      options.role ?? "user",
      options.kind ?? "message",
      message,
      options.media ?? null,
      options.origin ?? null,
      options.provenance ?? null,
      Date.now(),
    );
  }

  dequeue(): QueuedMessage | null {
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        generation: number;
        role: string;
        kind: string;
        message: string;
        media_json: string | null;
        origin_json: string | null;
        provenance_json: string | null;
      }>(
        `SELECT id, run_id, generation, role, kind, message, media_json,
                origin_json, provenance_json
           FROM message_queue
          ORDER BY id ASC
          LIMIT 1`,
      ),
    ];
    if (rows.length === 0) return null;
    const row = rows[0];
    this.sql.exec("DELETE FROM message_queue WHERE id = ?", row.id);
    return {
      id: row.id,
      runId: row.run_id,
      generation: row.generation,
      role: queuedMessageRole(row.role),
      kind: row.kind,
      message: row.message,
      media: row.media_json,
      origin: row.origin_json,
      provenance: row.provenance_json,
    };
  }

  drainQueue(): QueuedMessage[] {
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        generation: number;
        role: string;
        kind: string;
        message: string;
        media_json: string | null;
        origin_json: string | null;
        provenance_json: string | null;
      }>(
        `SELECT id, run_id, generation, role, kind, message, media_json,
                origin_json, provenance_json
           FROM message_queue
          ORDER BY id ASC`,
      ),
    ];
    if (rows.length === 0) return [];
    this.sql.exec("DELETE FROM message_queue");
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      generation: row.generation,
      role: queuedMessageRole(row.role),
      kind: row.kind,
      message: row.message,
      media: row.media_json,
      origin: row.origin_json,
      provenance: row.provenance_json,
    }));
  }

  clearQueue(): void {
    this.sql.exec("DELETE FROM message_queue");
  }

  queueSize(): number {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM message_queue",
    )];
    return rows[0]?.cnt ?? 0;
  }

  locateRunAdmission(runId: string): "queued" | "recorded" | null {
    const queued = this.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM message_queue WHERE run_id = ? LIMIT 1",
      runId,
    ).toArray()[0]?.present === 1;
    if (queued) return "queued";

    const recorded = this.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM messages WHERE run_id = ? LIMIT 1",
      runId,
    ).toArray()[0]?.present === 1;
    return recorded ? "recorded" : null;
  }
}

function normalizeCompactionCut(
  records: MessageRecord[],
  requested: number,
  direction: "backward" | "forward",
): number {
  let cut = Math.max(0, Math.min(records.length, requested));
  for (let start = 0; start < records.length; start += 1) {
    const record = records[start];
    if (record?.role !== "assistant") continue;
    const callIds = new Set(
      parseAssistantMessageMeta(record.toolCalls).toolCalls?.map((call) => call.id) ?? [],
    );
    if (callIds.size === 0) continue;

    const matched = new Set<string>();
    let end = start + 1;
    for (let index = start + 1; index < records.length; index += 1) {
      const candidate = records[index];
      if (
        candidate?.role === "toolResult"
        && candidate.toolCallId !== null
        && callIds.has(candidate.toolCallId)
      ) {
        matched.add(candidate.toolCallId);
        end = index + 1;
        if (matched.size === callIds.size) break;
      }
    }
    if (matched.size < callIds.size) {
      end = records.length;
    }
    if (cut > start && cut < end) {
      cut = direction === "backward" ? start : end;
    }
  }
  return cut;
}

function messageRecordFromRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    generation: row.generation,
    runId: row.run_id,
    role: messageRoleSchema.parse(row.role),
    content: row.content,
    toolCalls: row.tool_calls,
    toolCallId: row.tool_call_id,
    media: row.media_json,
    origin: row.origin_json,
    metadata: row.metadata_json ?? null,
    createdAt: row.created_at,
  };
}

function requiredToolCallId(record: MessageRecord): string {
  if (record.toolCallId === null) {
    throw new Error(`Stored tool result message ${record.id} has no tool call id`);
  }
  return record.toolCallId;
}

function queuedMessageRole(value: string): QueuedMessageRole {
  if (value === "user" || value === "system") {
    return value;
  }
  throw new Error(`Invalid queued message role: ${value}`);
}

export function parseMessageMetadata(raw: string | null | undefined): MessageMetadata | null {
  if (!raw) {
    return null;
  }
  try {
    return normalizeMessageMetadata(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function stringifyMessageMetadata(
  metadata: MessageMetadata | string | null | undefined,
): string | null {
  if (metadata === undefined || metadata === null) {
    return null;
  }
  const serialized = z.string().safeParse(metadata);
  if (serialized.success) {
    const normalized = parseMessageMetadata(serialized.data);
    return normalized ? JSON.stringify(normalized) : null;
  }
  const objectMetadata = messageMetadataInputSchema.safeParse(metadata);
  if (!objectMetadata.success) {
    return null;
  }
  const normalized = normalizeMessageMetadata(objectMetadata.data);
  return normalized ? JSON.stringify(normalized) : null;
}

export function normalizeMessageMetadata(
  value: Parameters<typeof messageMetadataInputSchema.safeParse>[0],
): MessageMetadata | null {
  const parsed = messageMetadataInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const provider = normalizeProviderMetadata(parsed.data.provider);
  const fallback = normalizeFallbackMetadata(parsed.data.fallback);
  const usage = normalizeUsageState(parsed.data.usage);
  const contextEpochId = parsed.data.contextEpochId?.trim() || undefined;
  const generationContextId = parsed.data.generationContextId?.trim() || undefined;
  if (!contextEpochId && !generationContextId && !provider && !fallback && !usage) {
    return null;
  }
  const metadata: MessageMetadata = {};
  if (contextEpochId) metadata.contextEpochId = contextEpochId;
  if (generationContextId) metadata.generationContextId = generationContextId;
  if (provider) metadata.provider = provider;
  if (fallback) metadata.fallback = fallback;
  if (usage) metadata.usage = usage;
  return metadata;
}

function normalizeProviderMetadata(
  value: Parameters<typeof providerMetadataSchema.safeParse>[0],
): MessageProviderMetadata | null {
  const parsed = providerMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const provider: MessageProviderMetadata = {};
  if (parsed.data.api) provider.api = parsed.data.api;
  if (parsed.data.provider) provider.provider = parsed.data.provider;
  if (parsed.data.model) provider.model = parsed.data.model;
  if (parsed.data.responseModel) provider.responseModel = parsed.data.responseModel;
  if (parsed.data.responseId) provider.responseId = parsed.data.responseId;
  if (parsed.data.stopReason) provider.stopReason = parsed.data.stopReason;
  return Object.keys(provider).length > 0 ? provider : null;
}

function normalizeFallbackMetadata(
  value: Parameters<typeof fallbackMetadataSchema.safeParse>[0],
): MessageMetadata["fallback"] | null {
  const parsed = fallbackMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const from = normalizeModelMetadata(parsed.data.from);
  const to = normalizeModelMetadata(parsed.data.to);
  if (!from && !to && !parsed.data.reason && parsed.data.used !== true) {
    return null;
  }
  const fallback: NonNullable<MessageMetadata["fallback"]> = { used: true };
  if (from) fallback.from = from;
  if (to) fallback.to = to;
  if (parsed.data.reason) fallback.reason = parsed.data.reason;
  return fallback;
}

function normalizeModelMetadata(
  value: Parameters<typeof modelMetadataSchema.safeParse>[0],
): ProcMessageModelMetadata | null {
  const parsed = modelMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  if (!parsed.data.provider && !parsed.data.model) {
    return null;
  }
  const model: ProcMessageModelMetadata = {};
  if (parsed.data.provider) model.provider = parsed.data.provider;
  if (parsed.data.model) model.model = parsed.data.model;
  return model;
}

function normalizeContextState(value: JsonValue): ProcContextState | null {
  const parsed = contextStateInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const inputBudgetTokens = parsed.data.inputBudgetTokens === undefined
    ? parsed.data.availableInputTokens
    : parsed.data.inputBudgetTokens;
  const remainingInputTokens = parsed.data.remainingInputTokens === undefined
    ? inputBudgetTokens === null
      ? null
      : Math.max(0, inputBudgetTokens - parsed.data.inputTokens)
    : parsed.data.remainingInputTokens;
  const confirmedInputTokens = parsed.data.confirmedInputTokens
    ?? (parsed.data.source === "provider" ? parsed.data.inputTokens : 0);
  const estimatedTrailingInputTokens = parsed.data.estimatedTrailingInputTokens
    ?? (parsed.data.source === "estimate"
      ? parsed.data.inputTokens
      : Math.max(0, parsed.data.inputTokens - confirmedInputTokens));
  const state: ProcContextState = {
    revision: parsed.data.revision ?? 0,
    provider: parsed.data.provider,
    model: parsed.data.model,
    contextWindowTokens: parsed.data.contextWindowTokens,
    maxOutputTokens: parsed.data.maxOutputTokens,
    estimatedInputTokens: parsed.data.estimatedInputTokens,
    inputTokens: parsed.data.inputTokens,
    confirmedInputTokens,
    estimatedTrailingInputTokens,
    inputBudgetTokens,
    remainingInputTokens,
    availableInputTokens: inputBudgetTokens,
    pressure: parsed.data.pressure,
    level: parsed.data.level,
    source: parsed.data.source,
    updatedAt: parsed.data.updatedAt,
  };
  if (parsed.data.runId !== undefined) state.runId = parsed.data.runId;
  if (parsed.data.messageCount !== undefined) state.messageCount = parsed.data.messageCount;
  if (parsed.data.lastMessageId !== undefined) state.lastMessageId = parsed.data.lastMessageId;
  if (parsed.data.reasoning !== undefined) state.reasoning = parsed.data.reasoning;
  if (parsed.data.outputTokens !== undefined) state.outputTokens = parsed.data.outputTokens;
  if (parsed.data.totalTokens !== undefined) state.totalTokens = parsed.data.totalTokens;
  if (parsed.data.usage !== undefined) state.usage = parsed.data.usage;
  if (parsed.data.historyUsage !== undefined) state.historyUsage = parsed.data.historyUsage;
  return state;
}

export function normalizeUsageState(
  value: Parameters<typeof usageStateInputSchema.safeParse>[0],
): ProcUsageState | null {
  const parsed = usageStateInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const inputTokens = parsed.data.inputTokens ?? parsed.data.input ?? 0;
  const outputTokens = parsed.data.outputTokens ?? parsed.data.output ?? 0;
  const cacheReadTokens = parsed.data.cacheReadTokens ?? parsed.data.cacheRead ?? 0;
  const cacheWriteTokens = parsed.data.cacheWriteTokens ?? parsed.data.cacheWrite ?? 0;
  const usage: ProcUsageState = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: parsed.data.totalTokens
      ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: normalizeUsageCost(parsed.data.cost),
  };
  if (parsed.data.generations !== undefined) usage.generations = parsed.data.generations;
  if (parsed.data.costIncomplete === true) usage.costIncomplete = true;
  if (parsed.data.updatedAt !== undefined) usage.updatedAt = parsed.data.updatedAt;
  return usage;
}

function normalizeUsageCost(
  value: Parameters<typeof usageCostInputSchema.safeParse>[0],
): ProcUsageCost | null {
  const parsed = usageCostInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const input = parsed.data.input ?? 0;
  const output = parsed.data.output ?? 0;
  const cacheRead = parsed.data.cacheRead ?? 0;
  const cacheWrite = parsed.data.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: parsed.data.total ?? input + output + cacheRead + cacheWrite,
    currency: "USD",
    source: parsed.data.source ?? "provider",
  };
}

function mergeUsageStates(
  current: ProcUsageState | null,
  next: ProcUsageState,
): ProcUsageState {
  const cost = mergeUsageCosts(current?.cost ?? null, next.cost);
  const currentGenerations = current?.generations ?? 0;
  const nextGenerations = next.generations ?? 1;
  const costIncomplete = current?.costIncomplete === true
    || next.costIncomplete === true
    || next.cost === null
    || (current !== null && current.cost === null);

  const merged: ProcUsageState = {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    cost,
    generations: currentGenerations + nextGenerations,
    updatedAt: Date.now(),
  };
  if (costIncomplete) merged.costIncomplete = true;
  return merged;
}

function mergeUsageCosts(
  current: ProcUsageCost | null,
  next: ProcUsageCost | null,
): ProcUsageCost | null {
  if (!current && !next) {
    return null;
  }
  if (!current) {
    return next === null ? null : cloneUsageCost(next);
  }
  if (!next) {
    return cloneUsageCost(current);
  }
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    total: current.total + next.total,
    currency: "USD",
    source: current.source === next.source ? current.source : "mixed",
  };
}

function cloneUsageCost(cost: ProcUsageCost): ProcUsageCost {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    total: cost.total,
    currency: "USD",
    source: cost.source,
  };
}

function emptyUsageState(): ProcUsageState {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: null,
    generations: 0,
  };
}

function usageStateToPiUsage(usage: ProcUsageState | null | undefined): AssistantMessage["usage"] {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    cacheWrite: usage?.cacheWriteTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cost: {
      input: usage?.cost?.input ?? 0,
      output: usage?.cost?.output ?? 0,
      cacheRead: usage?.cost?.cacheRead ?? 0,
      cacheWrite: usage?.cost?.cacheWrite ?? 0,
      total: usage?.cost?.total ?? 0,
    },
  };
}

function normalizeAssistantStopReason(
  value: string | undefined,
): AssistantMessage["stopReason"] {
  return value === "length" || value === "toolUse" || value === "error" || value === "aborted"
    ? value
    : "stop";
}

function processTraceSpanFromRow(row: ProcessTraceSpanRow): ProcTraceSpan {
  const span: ProcTraceSpan = {
    id: row.span_id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    startedAt: row.started_at,
  };
  if (row.parent_span_id) span.parentId = row.parent_span_id;
  if (row.ended_at !== null) span.endedAt = row.ended_at;
  if (row.reference_json) {
    span.reference = traceReferenceSchema.parse(JSON.parse(row.reference_json));
  }
  if (row.attributes_json) {
    span.attributes = jsonObjectSchema.parse(JSON.parse(row.attributes_json));
  }
  return span;
}

function contextEpochFromRow(row: ContextEpochRow): ContextEpochRecord {
  const epoch: ContextEpochRecord = {
    id: row.epoch_id,
    generation: row.generation,
    systemPrompt: row.system_prompt,
    r12yRevision: row.r12y_revision,
    r12yCount: row.r12y_count,
    observedR12yRevision: row.observed_r12y_revision,
    r12yBaseline: parseContextEpochJson<ResponsibilityRecord[]>(row.r12y_baseline_json),
    sourceManifest: parseContextEpochJson<JsonObject>(row.source_manifest_json),
    observedProjection: row.observed_projection_json
      ? parseContextEpochJson<JsonObject>(row.observed_projection_json)
      : null,
    state: row.state,
    createdAt: row.created_at,
  };
  if (row.closed_at !== null) epoch.closedAt = row.closed_at;
  if (row.close_reason) epoch.closeReason = row.close_reason;
  if (row.archive_path) epoch.archivePath = row.archive_path;
  return epoch;
}

function parseContextEpochJson<Value>(value: string): Value {
  // SAFETY: context epoch JSON is written only by ProcessStore from typed records.
  return JSON.parse(value) as Value;
}

export function parseAssistantMessageMeta(raw: string | null): AssistantMessageMeta {
  if (!raw) {
    return {};
  }

  let parsed: z.input<typeof assistantMessageMetaSchema>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const legacyToolCalls = z.array(toolCallSchema).safeParse(parsed);
  if (legacyToolCalls.success) {
    return { toolCalls: legacyToolCalls.data };
  }
  const metadata = assistantMessageMetaSchema.safeParse(parsed);
  return metadata.success ? metadata.data : {};
}

function buildFallbackUserContent(
  text: string,
  media: ReturnType<typeof parseStoredProcessMedia>,
): TextContent[] {
  const content: TextContent[] = [];
  if (text.trim().length > 0) {
    content.push({ type: "text", text });
  }

  const fallbackBlocks = buildFallbackMediaBlocks(media);
  if (fallbackBlocks.length > 0) {
    content.push(...fallbackBlocks);
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: media.map((item) => describeStoredProcessMedia(item)).join("\n"),
    });
  }

  return content;
}

export function stringifyAssistantMessageMeta(
  meta: AssistantMessageMeta,
): string | undefined {
  const thinking = meta.thinking?.length ? meta.thinking : undefined;
  const toolCalls = meta.toolCalls?.length ? meta.toolCalls : undefined;

  if (!thinking && !toolCalls) {
    return undefined;
  }
  if (!thinking && toolCalls) {
    return JSON.stringify(toolCalls);
  }

  return JSON.stringify({
    thinking,
    toolCalls,
  });
}
