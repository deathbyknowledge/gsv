/** Owns Process history, context epochs, archives, compaction, and context policy. */

import {
  type JsonObject, type ProcContextEpoch, type ProcContextState, type ProcHistoryContextPolicy,
  type ProcHistoryExportArgs, type ProcHistoryExportResult, type ProcHistoryImportArgs, type ProcHistoryImportResult,
  type ProcHistoryMessage, type ProcHistoryPolicyGetArgs, type ProcHistoryPolicyGetResult,
  type ProcHistoryPolicySetArgs, type ProcHistoryPolicySetResult, type ProcHistorySegmentReadArgs,
  type ProcHistorySegmentReadResult, type ProcHistorySegmentsArgs, type ProcHistorySegmentsResult,
  type ProcHistoryToolResultContent, jsonObjectSchema, type ResponsibilityTransition, type AiConfigResult,
  type AiTextGenerateOptions, type ProcHistoryCompactArgs, type ProcHistoryCompactResult, type ProcUsageState,
  type AiContextResult, type ResponsibilityListResult,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "../do";
import {
  defaultHistoryPolicy, serializeInteractionOrigin, emptyProcessArchive, gunzip, gzipMessageRecords,
  historyArchiveFilename, parseArchivedMessageRecord, serializeArchivedMessage, buildCompactionSummaryContext,
  formatCompactionSummaryMessage, contextBoundaryRemainingTokens, contextRunwayAlertThreshold,
  isCompactionSummaryMessage, messageSnapshotsMatch, parseInteractionOrigin,
} from "./helpers";
import {
  isHistoryOverflowPolicy, isNonNegativeInteger, isPositiveInteger, normalizeOptionalString,
  normalizeToolResultOutcome,
} from "../internal/messages";
import { storedHistoryPolicySchema } from "../internal/schemas";
import {
  type ArchivedMessageRecord, COMPACTION_SUMMARY_MAX_TOKENS, CONTEXT_PROVIDER_OVERFLOW_REASON,
  CONTEXT_RUNWAY_ALERT_EPOCH_KEY, MAX_KILL_ARCHIVE_ATTEMPTS, MAX_PROCESS_MEDIA_READ_BYTES,
} from "../internal/lifecycle";
import type {
  AssistantHistoryContent, RestoredToolResultMetadata, ProcessArchiveResult, CompactionTelemetryProperties,
  HistoryCompactionOptions,
} from "../internal/contracts";
import type { RunFinishPayload } from "../run/finish";
import { extractStoredFsReadResource } from "../tool-result-media";
import { ProcessStore, stringifyAssistantMessageMeta, type MessageRecord, type ContextEpochRecord } from "../store";
import { stringifyStoredProcessMedia } from "../media";
import { raceWithAbort } from "../../shared/abort";
import { emitTelemetry } from "@humansandmachines/gsv/telemetry";
import {
  errorMessageFromUnknown, formatProviderErrorMessage, formatProviderContextOverflowMessage,
} from "../../inference/errors";
import { isRetryableGenerationErrorMessage } from "../../inference/output";
import { nextAiConfigFallback } from "../run-tick-policy";
import type {
  AssistantMessage,
  Context,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  buildProcContextState, estimateContextInputTokens, estimateContextMessagesTokens, measureContextInputTokens,
} from "../context-pressure";
import { formatContextRunwayAlertMessage } from "../../prompts/context-runway";
import {
  assembleSystemPromptSnapshot, contextProjectionFromManifest, contextProjectionsEqual, createContextProjection,
  parseContextProjection, type ContextProjection,
} from "../context";
import type { RunState } from "../run/state";
import { contextSnapshotFromRun, orderMessagesForProvider } from "../run/helpers";
import { formatContextProjectionEvent } from "../../prompts/context-events";
import {
  formatInteractionOriginForContext, formatReplyDestinationForContext, prefixUserMessageContent,
} from "../context/formatters";
import { formatResponsibilityBaseline, formatResponsibilityTransitionEvent } from "../internal/events";

function formatContextOriginLines(
  source: string | null,
  renderSource: boolean,
  replyDestination: ReturnType<typeof formatReplyDestinationForContext> | null,
  renderReplyDestination: boolean,
): string {
  const lines: string[] = [];
  if (renderSource && source !== null) lines.push(`[From: ${source}]`);
  if (renderReplyDestination && replyDestination) {
    lines.push(`[Directed endpoint: ${replyDestination.description}.]`);
  }
  return lines.join("\n");
}

function archivedToolResultMessage(
  host: Process,
  message: ArchivedMessageRecord,
): ProcHistoryMessage {
  const isError = message.isError ?? false;
  const media = archivedMessageMedia(host, message);
  const content: ProcHistoryToolResultContent = {
    toolName: message.toolName ?? "unknown",
    isError,
    outcome: normalizeToolResultOutcome(message.outcome, isError, message.content),
    toolCallId: message.toolCallId ?? null,
    output: message.content,
  };
  if (media.length > 0) content.media = media;
  const resource = extractStoredFsReadResource(message.content);
  if (resource) content.resources = [{ type: "resource", ref: resource }];
  return archivedMessageProjection(message, content);
}

function archivedAssistantMessage(
  host: Process,
  message: ArchivedMessageRecord,
): ProcHistoryMessage {
  const media = archivedMessageMedia(host, message);
  const content: AssistantHistoryContent = {
    text: message.content,
    thinking: message.thinking ?? [],
    toolCalls: message.toolCalls ?? [],
  };
  if (media.length > 0) content.media = media;
  return archivedMessageProjection(message, content);
}

function archivedMessageMedia(host: Process, message: ArchivedMessageRecord) {
  if (message.media === undefined) return [];
  return host.resources.parseOwnedProcessMedia(JSON.stringify(message.media));
}

function archivedMessageProjection(
  message: ArchivedMessageRecord,
  content: ProcHistoryMessage["content"],
): ProcHistoryMessage {
  const projected: ProcHistoryMessage = {
    id: message.id,
    role: message.role,
    content,
    timestamp: message.createdAt,
  };
  if (message.runId) projected.runId = message.runId;
  if (message.origin) projected.origin = message.origin;
  if (message.metadata) projected.metadata = message.metadata;
  return projected;
}

type CompactionFailure = Extract<ProcHistoryCompactResult, { ok: false }>;

type CompactionRequest = {
  summary: string | null;
  keepLast?: number;
  throughMessageId?: number;
  targetPressure?: number;
};

type CompactionSnapshot = {
  generation: number;
  lifecycleEpoch: number;
  selected: MessageRecord[];
  selectedMediaKeys: string[];
  contextEpoch: ContextEpochRecord | null;
  signal?: AbortSignal;
  fromMessageId: number;
  toMessageId: number;
  contextPressure?: number;
};

type InstalledCompaction = {
  segment: ReturnType<ProcessStore["history"]["recordHistorySegment"]>;
  summaryMessageId: number;
  archivedTo: string;
};

type ResolvedCompactionSummary = { ok: true; summary: string };

type ContextEpochCandidate = {
  prompt: string;
  sourceManifest: JsonObject;
};

type KillArchiveSnapshot = {
  generation: number;
  messages: MessageRecord[];
  contextEpoch: ContextEpochRecord | null;
  transitions: ResponsibilityTransition[];
  runBoundaries: JsonObject[];
  activeRun: RunState | null;
  finishPayload: RunFinishPayload | null;
  closedAt: number;
  historyKey?: string;
  contextKey?: string;
};

export type KilledProcessArchive = {
  archive: ProcessArchiveResult;
  contextArchivePath?: string;
  activeRun: RunState | null;
  finishPayload: RunFinishPayload | null;
};

function compactionFailure(error: string): CompactionFailure {
  return { ok: false, error };
}

function validateCompactionRequest(
  args: ProcHistoryCompactArgs,
): CompactionRequest | CompactionFailure {
  const summary = normalizeOptionalString(args.summary);
  const generateSummary = args.generateSummary === true;
  if (!summary && !generateSummary) {
    return compactionFailure("proc.history.compact requires summary or generateSummary");
  }
  if (summary && generateSummary) {
    return compactionFailure(
      "proc.history.compact accepts either summary or generateSummary, not both",
    );
  }
  const hasKeepLast = args.keepLast !== undefined;
  const hasThroughMessageId = args.throughMessageId !== undefined;
  const targetPressure = args.targetPressure;
  const hasTargetPressure = targetPressure !== undefined;
  if (Number(hasKeepLast) + Number(hasThroughMessageId) + Number(hasTargetPressure) !== 1) {
    return compactionFailure(
      "proc.history.compact requires exactly one of targetPressure, keepLast, or throughMessageId",
    );
  }
  if (hasKeepLast && !isNonNegativeInteger(args.keepLast)) {
    return compactionFailure("proc.history.compact keepLast must be a non-negative integer");
  }
  if (hasThroughMessageId && !isPositiveInteger(args.throughMessageId)) {
    return compactionFailure("proc.history.compact throughMessageId must be a positive integer");
  }
  if (
    hasTargetPressure &&
    (!Number.isFinite(targetPressure) || targetPressure <= 0 || targetPressure >= 1)
  ) {
    return compactionFailure("proc.history.compact targetPressure must be > 0 and < 1");
  }
  return {
    summary: summary ?? null,
    keepLast: args.keepLast,
    throughMessageId: args.throughMessageId,
    targetPressure,
  };
}

export class ProcessHistory {
  constructor(private readonly host: Process) {}

  getContextStateForHistory(): ProcContextState | null {
    const stored = this.host.store.state.getContextState();
    const { count: messageCount, lastMessageId } = this.host.store.messages.messageStats();
    if (stored && stored.messageCount === messageCount && stored.lastMessageId === lastMessageId) {
      return stored;
    }
    return stored ? { ...stored, messageCount, lastMessageId } : null;
  }

  handleHistoryPolicyGet(_args: ProcHistoryPolicyGetArgs): ProcHistoryPolicyGetResult {
    return {
      ok: true,
      pid: this.host.pid,
      policy: this.getHistoryContextPolicy(),
    };
  }

  async handleHistoryPolicySet(
    args: ProcHistoryPolicySetArgs,
  ): Promise<ProcHistoryPolicySetResult> {
    const existing = this.getHistoryContextPolicy();
    const overflow = args.overflow ?? existing.overflow;
    if (!isHistoryOverflowPolicy(overflow)) {
      return {
        ok: false,
        error: "proc.history.policy.set overflow must be auto-compact or fail",
      };
    }
    const compactAtPressure = args.compactAtPressure ?? existing.compactAtPressure;
    if (!Number.isFinite(compactAtPressure) || compactAtPressure <= 0 || compactAtPressure > 1) {
      return {
        ok: false,
        error: "proc.history.policy.set compactAtPressure must be > 0 and <= 1",
      };
    }
    const compactToPressure = args.compactToPressure ?? existing.compactToPressure;
    if (
      !Number.isFinite(compactToPressure) ||
      compactToPressure <= 0 ||
      compactToPressure >= compactAtPressure
    ) {
      return {
        ok: false,
        error:
          "proc.history.policy.set compactToPressure must be > 0 and less than compactAtPressure",
      };
    }

    const policy: ProcHistoryContextPolicy = {
      overflow,
      compactAtPressure,
      compactToPressure,
      updatedAt: Date.now(),
    };
    this.host.store.state.setValue("historyPolicy", JSON.stringify(policy));
    await this.emitProcessLifecycle({
      event: "history.policy",
      pid: this.host.pid,
      policy,
    });
    return {
      ok: true,
      pid: this.host.pid,
      policy,
    };
  }

  getHistoryContextPolicy(): ProcHistoryContextPolicy {
    const fallback = defaultHistoryPolicy();
    const raw = this.host.store.state.getValue("historyPolicy");
    if (!raw) {
      return fallback;
    }
    try {
      const result = storedHistoryPolicySchema.safeParse(JSON.parse(raw));
      if (!result.success) {
        return fallback;
      }
      const parsed = result.data;
      const overflow = parsed.overflow;
      const compactAtPressure = parsed.compactAtPressure;
      const compactToPressure = parsed.compactToPressure;
      const effectiveCompactAtPressure =
        compactAtPressure !== undefined &&
        Number.isFinite(compactAtPressure) &&
        compactAtPressure > 0 &&
        compactAtPressure <= 1
          ? compactAtPressure
          : fallback.compactAtPressure;
      const effectiveCompactToPressure =
        compactToPressure !== undefined &&
        Number.isFinite(compactToPressure) &&
        compactToPressure > 0 &&
        compactToPressure < effectiveCompactAtPressure
          ? compactToPressure
          : Math.min(fallback.compactToPressure, effectiveCompactAtPressure / 2);
      return {
        overflow: isHistoryOverflowPolicy(overflow) ? overflow : fallback.overflow,
        compactAtPressure: effectiveCompactAtPressure,
        compactToPressure: effectiveCompactToPressure,
        updatedAt:
          parsed.updatedAt !== undefined && Number.isFinite(parsed.updatedAt)
            ? parsed.updatedAt
            : fallback.updatedAt,
      };
    } catch {
      return fallback;
    }
  }

  async handleHistorySegmentRead(
    args: ProcHistorySegmentReadArgs,
  ): Promise<ProcHistorySegmentReadResult> {
    const segmentId = normalizeOptionalString(args.segmentId);
    if (!segmentId) {
      return {
        ok: false,
        error: "proc.history.segment.read requires segmentId",
      };
    }
    if (args.offset !== undefined && !isNonNegativeInteger(args.offset)) {
      return {
        ok: false,
        error: "proc.history.segment.read offset must be a non-negative integer",
      };
    }
    if (args.limit !== undefined && !isPositiveInteger(args.limit)) {
      return {
        ok: false,
        error: "proc.history.segment.read limit must be a positive integer",
      };
    }

    const segment = this.host.store.history.getHistorySegment(segmentId);
    if (!segment) {
      return { ok: false, error: `History segment not found: ${segmentId}` };
    }

    let archivedMessages: ArchivedMessageRecord[];
    try {
      archivedMessages = await this.readArchivedMessageRecords(segment.archivePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Failed to read segment archive: ${message}` };
    }

    const offset = args.offset ?? 0;
    const limit = Math.min(args.limit ?? 200, 500);
    const page = archivedMessages.slice(offset, offset + limit);
    const messages = page.map((message) => this.toProcHistoryMessageFromArchive(message));

    return {
      ok: true,
      pid: this.host.pid,
      segment,
      messages,
      messageCount: archivedMessages.length,
      truncated: offset + messages.length < archivedMessages.length,
    };
  }

  toProcHistoryMessageFromArchive(message: ArchivedMessageRecord): ProcHistoryMessage {
    if (message.role === "toolResult") {
      return archivedToolResultMessage(this.host, message);
    }

    if (message.role === "assistant") {
      return archivedAssistantMessage(this.host, message);
    }

    if (message.role === "user" && message.media !== undefined) {
      return archivedMessageProjection(message, {
        text: message.content,
        media: archivedMessageMedia(this.host, message),
      });
    }

    return archivedMessageProjection(message, message.content);
  }

  handleHistorySegments(_args: ProcHistorySegmentsArgs): ProcHistorySegmentsResult {
    return {
      ok: true,
      pid: this.host.pid,
      segments: this.host.store.history.listHistorySegments(),
      epochs: this.host.store.epochs.listContextEpochs().map((epoch) => {
        const summary: ProcContextEpoch = {
          id: epoch.id,
          generation: epoch.generation,
          state: epoch.state,
          r12yRevision: epoch.r12yRevision,
          r12yCount: epoch.r12yCount,
          observedR12yRevision: epoch.observedR12yRevision,
          createdAt: epoch.createdAt,
        };
        if (epoch.closedAt !== undefined) summary.closedAt = epoch.closedAt;
        if (epoch.closeReason !== undefined) summary.closeReason = epoch.closeReason;
        if (epoch.archivePath !== undefined) summary.archivePath = epoch.archivePath;
        return summary;
      }),
    };
  }

  async handleHistoryExport(
    args: ProcHistoryExportArgs,
    signal?: AbortSignal,
  ): Promise<ProcHistoryExportResult> {
    const pid = this.host.pid;
    const archiveDir = this.historyArchiveDir();
    const segmentId = normalizeOptionalString(args.segmentId);
    let throughMessageId = args.throughMessageId;
    const throughRunId = normalizeOptionalString(args.throughRunId);
    const selectionCount =
      Number(Boolean(segmentId)) +
      Number(throughMessageId !== undefined) +
      Number(Boolean(throughRunId));
    if (selectionCount !== 1) {
      return {
        ok: false,
        error:
          "history export requires exactly one of segmentId, throughMessageId, or throughRunId",
      };
    }
    if (throughMessageId !== undefined && !isPositiveInteger(throughMessageId)) {
      return {
        ok: false,
        error: "history export throughMessageId must be a positive integer",
      };
    }

    let segment: ReturnType<ProcessStore["history"]["getHistorySegment"]> = null;
    let snapshotMessages: MessageRecord[] = [];
    let includeLiveSuffix = false;
    const temporaryArchivePaths: string[] = [];
    try {
      signal?.throwIfAborted();
      if (this.host.killed) {
        return { ok: false, error: "Process no longer exists" };
      }
      if (throughRunId) {
        throughMessageId = this.host.store.messages.getRunInputMessageId(throughRunId) ?? undefined;
        if (throughMessageId === undefined) {
          return { ok: false, error: `History run not found: ${throughRunId}` };
        }
      }
      if (segmentId) {
        segment = this.host.store.history.getHistorySegment(segmentId);
        if (!segment) {
          return {
            ok: false,
            error: `History segment not found: ${segmentId}`,
          };
        }
        includeLiveSuffix = args.includeLiveSuffix !== false;
        if (includeLiveSuffix) {
          snapshotMessages = this.host.store.messages.getMessagesForGenerationAfter({
            generation: segment.generation,
            afterMessageId: segment.toMessageId,
            throughCreatedAt: segment.createdAt,
          });
        }
      } else {
        snapshotMessages = this.host.store.history.getHistoryPrefixMessages({
          throughMessageId,
        });
        if (
          snapshotMessages.length === 0 ||
          !snapshotMessages.some((message) => message.id === throughMessageId)
        ) {
          return {
            ok: false,
            error: `History message not found: ${throughMessageId}`,
          };
        }
      }

      signal?.throwIfAborted();
      if (segment) {
        const archivePaths = [segment.archivePath];
        if (snapshotMessages.length > 0) {
          const path = await this.archiveForkMessages(archiveDir, snapshotMessages, signal);
          archivePaths.push(path);
          temporaryArchivePaths.push(path);
        }
        return {
          ok: true,
          sourcePid: pid,
          archivePaths,
          temporaryArchivePaths,
          segment,
          includedLiveSuffix: includeLiveSuffix,
        };
      }

      const path = await this.archiveForkMessages(archiveDir, snapshotMessages, signal);
      temporaryArchivePaths.push(path);
      return {
        ok: true,
        sourcePid: pid,
        archivePaths: [path],
        temporaryArchivePaths,
        throughMessageId,
        includedLiveSuffix: false,
      };
    } catch (error) {
      await Promise.allSettled(
        temporaryArchivePaths.map((path) => this.host.storage.delete(path.replace(/^\/+/, ""))),
      );
      return {
        ok: false,
        error: `Failed to export process history: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async archiveForkMessages(
    archiveDir: string,
    messages: MessageRecord[],
    signal?: AbortSignal,
  ): Promise<string> {
    const key = `${archiveDir}/fork-${crypto.randomUUID()}.jsonl.gz`;
    await this.archiveMessageRecords(key, messages, signal);
    return `/${key}`;
  }

  async handleHistoryImport(
    args: ProcHistoryImportArgs,
    signal?: AbortSignal,
  ): Promise<ProcHistoryImportResult> {
    if (
      !Array.isArray(args.archivePaths) ||
      args.archivePaths.length === 0 ||
      args.archivePaths.some((path) => !normalizeOptionalString(path))
    ) {
      return { ok: false, error: "history import requires archivePaths" };
    }

    try {
      const archives: ArchivedMessageRecord[][] = [];
      for (const path of args.archivePaths) {
        signal?.throwIfAborted();
        archives.push(await this.readArchivedMessageRecords(path, signal));
      }
      signal?.throwIfAborted();
      const restoredMessages = this.host.ctx.storage.transactionSync(() => {
        if (this.host.killed) {
          throw new Error("Process no longer exists");
        }
        if (
          this.host.runs.active ||
          this.host.store.messages.messageCount() > 0 ||
          this.host.store.queue.queueSize() > 0
        ) {
          throw new Error("Target process history is not empty");
        }
        const generation = this.host.store.state.getHistoryGeneration();
        let restored = 0;
        for (const archive of archives) {
          for (const message of archive) {
            this.appendRestoredArchivedMessage(message, generation);
            restored += 1;
          }
        }
        return restored;
      });
      return { ok: true, pid: this.host.pid, restoredMessages };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to import process history: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  appendRestoredArchivedMessage(message: ArchivedMessageRecord, generation: number): number {
    let toolCalls: string | undefined;
    if (message.role === "assistant") {
      toolCalls = stringifyAssistantMessageMeta({
        toolCalls: message.toolCalls,
        thinking: message.thinking,
      });
    } else if (message.role === "toolResult") {
      const metadata: RestoredToolResultMetadata = {
        toolName: message.toolName ?? "unknown",
        isError: message.isError ?? false,
      };
      if (message.outcome) {
        metadata.outcome = message.outcome;
      }
      toolCalls = JSON.stringify(metadata);
    } else if (message.toolCalls) {
      toolCalls = JSON.stringify(message.toolCalls);
    }
    const restoredMedia =
      message.media === undefined
        ? null
        : stringifyStoredProcessMedia(
            this.host.resources.parseOwnedProcessMedia(JSON.stringify(message.media)),
          );
    return this.host.store.messages.appendMessage(message.role, message.content, {
      generation,
      toolCalls,
      toolCallId: message.toolCallId,
      media: restoredMedia ?? undefined,
      origin: serializeInteractionOrigin(message.origin) ?? undefined,
      metadata: message.metadata,
      runId: message.runId,
      createdAt: message.createdAt,
    });
  }

  async emitProcessLifecycle(payload: JsonObject): Promise<void> {
    if (this.host.killed) {
      return;
    }
    const pid = this.host.pid;
    await this.host.signals.changed(["lifecycle", "messages"], payload).catch((error) => {
      console.warn(
        `[Process] Failed to emit proc.changed lifecycle for ${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async appendSystemMessage(runId: string, content: string): Promise<number> {
    const messageId = this.host.store.messages.appendMessage("system", content, { runId });
    await this.host.signals.changed(["messages"], { runId, role: "system", content });
    return messageId;
  }

  historyArchiveDir(): string {
    const homeKey = this.host.identity.home.replace(/^\/+/, "").replace(/\/+$/, "");
    return `${homeKey}/processes/${encodeURIComponent(this.host.pid)}/history`;
  }

  private captureKillArchiveSnapshot(): KillArchiveSnapshot {
    const generation = this.host.store.state.getHistoryGeneration();
    const messages = this.host.store.messages.getMessages({ limit: null });
    const contextEpoch = this.host.store.epochs.getLiveContextEpoch();
    const activeRun = this.host.runs.active;
    const closedAt = Date.now();
    return {
      generation,
      messages,
      contextEpoch,
      transitions: contextEpoch
        ? this.host.store.epochs.listContextEpochTransitions(contextEpoch.id)
        : [],
      runBoundaries: contextEpoch
        ? this.host.store.epochs.listContextEpochRuns(contextEpoch.id)
        : [],
      activeRun,
      finishPayload: activeRun
        ? this.host.run.runFinishedPayload(
            activeRun,
            { status: "aborted", reason: "process.kill", resultText: null },
            0,
            closedAt,
          )
        : null,
      closedAt,
      historyKey:
        messages.length > 0
          ? `${this.historyArchiveDir()}/${crypto.randomUUID()}.${historyArchiveFilename(generation)}`
          : undefined,
      contextKey: contextEpoch
        ? `${this.historyArchiveDir()}/epochs/${contextEpoch.id}.json.gz`
        : undefined,
    };
  }

  private killArchiveSnapshotMatches(snapshot: KillArchiveSnapshot): boolean {
    const currentEpoch = this.host.store.epochs.getLiveContextEpoch();
    const epochMatches =
      snapshot.contextEpoch === null
        ? currentEpoch === null
        : JSON.stringify(currentEpoch) === JSON.stringify(snapshot.contextEpoch) &&
          JSON.stringify(
            this.host.store.epochs.listContextEpochTransitions(snapshot.contextEpoch.id),
          ) === JSON.stringify(snapshot.transitions) &&
          JSON.stringify(this.host.store.epochs.listContextEpochRuns(snapshot.contextEpoch.id)) ===
            JSON.stringify(snapshot.runBoundaries);
    const currentRun = this.host.runs.active;
    const currentFinish = currentRun
      ? this.host.run.runFinishedPayload(
          currentRun,
          { status: "aborted", reason: "process.kill", resultText: null },
          0,
          snapshot.closedAt,
        )
      : null;
    return (
      snapshot.generation === this.host.store.state.getHistoryGeneration() &&
      messageSnapshotsMatch(
        snapshot.messages,
        this.host.store.messages.getMessages({ limit: null }),
      ) &&
      epochMatches &&
      JSON.stringify(currentFinish) === JSON.stringify(snapshot.finishPayload)
    );
  }

  private async discardKillArchive(
    snapshot: KillArchiveSnapshot,
    contextArchivePath?: string,
  ): Promise<void> {
    if (snapshot.historyKey) await this.deleteFailedCompactionArchive(snapshot.historyKey);
    const contextKey = contextArchivePath?.replace(/^\/+/, "") ?? snapshot.contextKey;
    if (contextKey) await this.deleteFailedCompactionArchive(contextKey);
  }

  async archiveForKill(): Promise<KilledProcessArchive> {
    for (let attempt = 0; attempt < MAX_KILL_ARCHIVE_ATTEMPTS; attempt += 1) {
      const snapshot = this.captureKillArchiveSnapshot();
      let contextArchivePath: string | undefined;
      try {
        if (snapshot.historyKey) {
          await this.archiveMessageRecords(snapshot.historyKey, snapshot.messages);
        }
        if (snapshot.contextEpoch) {
          contextArchivePath = await this.archiveContextEpoch(
            snapshot.contextEpoch,
            "process.kill",
            snapshot.closedAt,
            undefined,
            {
              messages: snapshot.messages,
              transitions: snapshot.transitions,
              runBoundaries: snapshot.runBoundaries,
              closingBoundary: snapshot.finishPayload
                ? jsonObjectSchema.parse(JSON.parse(JSON.stringify(snapshot.finishPayload)))
                : undefined,
            },
          );
        }
      } catch (error) {
        await this.discardKillArchive(snapshot, contextArchivePath);
        throw error;
      }
      if (this.killArchiveSnapshotMatches(snapshot)) {
        const archivedTo = snapshot.historyKey ? `/${snapshot.historyKey}` : undefined;
        return {
          archive: archivedTo
            ? {
                archivedMessages: snapshot.messages.length,
                archivedTo,
                archives: [
                  {
                    generation: snapshot.generation,
                    messages: snapshot.messages.length,
                    path: archivedTo,
                  },
                ],
              }
            : emptyProcessArchive(),
          contextArchivePath,
          activeRun: this.host.runs.active,
          finishPayload: snapshot.finishPayload,
        };
      }
      await this.discardKillArchive(snapshot, contextArchivePath);
    }
    throw new Error("Process state changed repeatedly during kill archival");
  }

  async archiveHistoryMessages(archiveId: string): Promise<ProcessArchiveResult> {
    const messages = this.host.store.messages.getMessages({ limit: null });
    if (messages.length === 0) return emptyProcessArchive();
    const generation = this.host.store.state.getHistoryGeneration();
    const key = `${this.historyArchiveDir()}/${archiveId}.${historyArchiveFilename(generation)}`;
    await this.archiveMessageRecords(key, messages);
    const archivePath = `/${key}`;
    return {
      archivedMessages: messages.length,
      archivedTo: archivePath,
      archives: [
        {
          generation,
          messages: messages.length,
          path: archivePath,
        },
      ],
    };
  }

  async archiveContextEpoch(
    epoch: ContextEpochRecord,
    reason: string,
    closedAt: number,
    signal?: AbortSignal,
    snapshot?: {
      messages: MessageRecord[];
      transitions: ResponsibilityTransition[];
      runBoundaries: JsonObject[];
      closingBoundary?: JsonObject;
    },
  ): Promise<string> {
    const key = `${this.historyArchiveDir()}/epochs/${epoch.id}.json.gz`;
    const messages =
      snapshot?.messages ?? this.host.store.messages.getMessagesForGeneration(epoch.generation);
    const mediaRewrites = await this.host.resources.persistArchivedMedia(messages, signal);
    const runBoundaries = snapshot?.runBoundaries
      ? [...snapshot.runBoundaries]
      : this.host.store.epochs.listContextEpochRuns(epoch.id);
    if (snapshot?.closingBoundary) runBoundaries.push(snapshot.closingBoundary);
    const manifest = jsonObjectSchema.parse({
      schemaVersion: 1,
      installationId: this.host.installationId,
      process: {
        pid: this.host.pid,
        uid: this.host.identity.uid,
        gid: this.host.identity.gid,
        username: this.host.identity.username,
      },
      epoch: {
        id: epoch.id,
        generation: epoch.generation,
        state: "closed",
        createdAt: epoch.createdAt,
        closedAt,
        closeReason: reason,
        systemPrompt: epoch.systemPrompt,
        r12yRevision: epoch.r12yRevision,
        r12yCount: epoch.r12yCount,
        observedR12yRevision: epoch.observedR12yRevision,
        r12yBaseline: epoch.r12yBaseline,
        r12yTransitions:
          snapshot?.transitions ?? this.host.store.epochs.listContextEpochTransitions(epoch.id),
        sourceManifest: epoch.sourceManifest,
        observedProjection: epoch.observedProjection,
        processActivity: messages.map((message) =>
          serializeArchivedMessage(message, mediaRewrites),
        ),
        runBoundaries,
      },
    });
    const compressed = await raceWithAbort(
      new Response(
        new Blob([JSON.stringify(manifest)]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
      signal,
    );
    await this.writeArchive(key, compressed, signal);
    return `/${key}`;
  }

  async archiveMessageRecords(
    key: string,
    messages: MessageRecord[],
    signal?: AbortSignal,
  ): Promise<void> {
    const mediaRewrites = await this.host.resources.persistArchivedMedia(messages, signal);
    const compressed = await raceWithAbort(
      new Response(gzipMessageRecords(messages, signal, mediaRewrites)).arrayBuffer(),
      signal,
    );
    await this.writeArchive(key, compressed, signal);
  }

  async writeArchive(key: string, body: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    const upload = this.host.storage.put(key, body, {
      httpMetadata: { contentType: "application/gzip" },
    });
    await raceWithAbort(upload, signal, {
      onAbort: () => {
        this.host.startBackground(
          `aborted archive cleanup for ${key}`,
          upload.then(
            () => this.deleteFailedCompactionArchive(key),
            () => undefined,
          ),
        );
      },
    });
  }

  async deleteFailedCompactionArchive(key: string): Promise<void> {
    try {
      await this.host.storage.delete(key);
    } catch (error) {
      console.warn(`[Process] Failed to delete unreferenced archive ${key}:`, error);
    }
  }

  async readArchivedMessageRecords(
    archivePath: string,
    signal?: AbortSignal,
  ): Promise<ArchivedMessageRecord[]> {
    const key = archivePath.replace(/^\/+/, "");
    signal?.throwIfAborted();
    const object = await raceWithAbort(this.host.storage.get(key), signal, {
      onLateResolve: (late) => {
        if (late?.body && !late.body.locked) {
          void late.body.cancel("Archive read was cancelled");
        }
      },
    });
    if (!object) {
      throw new Error(`archive not found: ${archivePath}`);
    }

    const bytes = await raceWithAbort(object.arrayBuffer(), signal, {
      onAbort: () => {
        if (!object.body.locked) {
          void object.body.cancel("Archive read was cancelled");
        }
      },
    });
    signal?.throwIfAborted();
    const jsonl = await gunzip(bytes);
    return jsonl
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => parseArchivedMessageRecord(JSON.parse(line)));
  }

  private compactionStopped(options: HistoryCompactionOptions): boolean {
    return (
      this.host.killed ||
      options.signal?.aborted === true ||
      (options.activeRunId !== undefined && this.host.runs.active?.runId !== options.activeRunId)
    );
  }

  private captureCompactionSnapshot(
    request: CompactionRequest,
    options: HistoryCompactionOptions,
  ): CompactionSnapshot | CompactionFailure {
    if (this.compactionStopped(options)) return compactionFailure("Compaction was cancelled");
    if (!options.allowActive && this.host.runs.active)
      return compactionFailure("Process is active");
    let contextPressure: number | undefined;
    let selected: MessageRecord[];
    if (request.targetPressure !== undefined) {
      const state = this.host.store.state.getContextState();
      const stats = this.host.store.messages.messageStats();
      if (
        !state ||
        state.messageCount !== stats.count ||
        state.lastMessageId !== stats.lastMessageId
      ) {
        return compactionFailure(
          "Context token usage is not current; run the Process once or select an explicit history boundary",
        );
      }
      if (state.inputBudgetTokens === null || state.pressure === null) {
        return compactionFailure(
          "The active model does not expose a context budget; select an explicit history boundary",
        );
      }
      if (state.pressure <= request.targetPressure) {
        return compactionFailure(
          `Context pressure is already at or below the ${Math.round(request.targetPressure * 100)}% target`,
        );
      }
      const records = this.host.store.messages.getMessagesForGeneration();
      selected = this.selectCompactionPrefixToPressure({
        records,
        allMessages: this.host.store.messages.toMessages({ limit: null }),
        protectedIndex: records.length - 1,
        estimatedContextTokens: state.estimatedInputTokens,
        effectiveInputTokens: state.inputTokens,
        inputBudgetTokens: state.inputBudgetTokens,
        targetPressure: request.targetPressure,
      });
      contextPressure = state.pressure;
    } else {
      selected = this.host.store.history.getHistoryPrefixMessages({
        keepLast: request.keepLast,
        throughMessageId: request.throughMessageId,
      });
    }
    if (selected.length === 0) {
      return compactionFailure("No history messages selected for compaction");
    }
    const activeSignal = options.activeRunId
      ? this.host.run.runAbortSignal(options.activeRunId)
      : undefined;
    const signal =
      options.signal && activeSignal
        ? AbortSignal.any([options.signal, activeSignal])
        : (options.signal ?? activeSignal);
    return {
      generation: this.host.store.state.getHistoryGeneration(),
      lifecycleEpoch: this.host.lifecycleEpoch,
      selected,
      selectedMediaKeys: this.host.resources.activeProcessMediaKeys(selected),
      contextEpoch: this.host.store.epochs.getLiveContextEpoch(),
      signal,
      fromMessageId: selected[0]!.id,
      toMessageId: selected.at(-1)!.id,
      contextPressure,
    };
  }

  private async resolveCompactionSummary(
    request: CompactionRequest,
    snapshot: CompactionSnapshot,
    options: HistoryCompactionOptions,
  ): Promise<ResolvedCompactionSummary | CompactionFailure> {
    if (request.summary) return { ok: true, summary: request.summary };
    try {
      return {
        ok: true,
        summary: await this.generateHistoryCompactionSummary(snapshot.selected, snapshot.signal),
      };
    } catch (error) {
      if (this.compactionStopped(options)) return compactionFailure("Compaction was cancelled");
      const message = errorMessageFromUnknown(error);
      const formatted = formatProviderErrorMessage(message);
      if (
        formatted &&
        (formatted !== message ||
          formatted.startsWith("Provider account issue") ||
          formatted.startsWith("Provider rate limit"))
      ) {
        return compactionFailure(formatted);
      }
      return compactionFailure(`Failed to generate compaction summary: ${formatted || message}`);
    }
  }

  private compactionSnapshotMatches(
    snapshot: CompactionSnapshot,
    options: HistoryCompactionOptions,
  ): boolean {
    const currentEpoch = this.host.store.epochs.getLiveContextEpoch();
    const expectedEpoch = snapshot.contextEpoch;
    const epochMatches =
      expectedEpoch === null
        ? currentEpoch === null
        : currentEpoch?.id === expectedEpoch.id &&
          currentEpoch.observedR12yRevision === expectedEpoch.observedR12yRevision &&
          JSON.stringify(currentEpoch.observedProjection) ===
            JSON.stringify(expectedEpoch.observedProjection);
    return (
      !this.compactionStopped(options) &&
      (options.allowActive || this.host.runs.active === null) &&
      this.host.lifecycleEpoch === snapshot.lifecycleEpoch &&
      this.host.store.state.getHistoryGeneration() === snapshot.generation &&
      messageSnapshotsMatch(
        snapshot.selected,
        this.host.store.history.getHistoryPrefixMessages({
          throughMessageId: snapshot.toMessageId,
        }),
      ) &&
      epochMatches
    );
  }

  private async installCompaction(
    snapshot: CompactionSnapshot,
    summary: string,
    options: HistoryCompactionOptions,
  ): Promise<InstalledCompaction | CompactionFailure> {
    const segmentId = crypto.randomUUID();
    const archiveKey = `${this.historyArchiveDir()}/${segmentId}.jsonl.gz`;
    const archivedTo = `/${archiveKey}`;
    const epochClosedAt = Date.now();
    let contextArchivePath: string | undefined;
    let installed = false;
    let summaryMessageId = 0;
    let segment: InstalledCompaction["segment"] | null = null;
    try {
      try {
        await this.archiveMessageRecords(archiveKey, snapshot.selected, snapshot.signal);
        if (snapshot.contextEpoch) {
          contextArchivePath = await this.archiveContextEpoch(
            snapshot.contextEpoch,
            options.reason ?? "history.compacted",
            epochClosedAt,
            snapshot.signal,
          );
        }
      } catch (error) {
        if (this.compactionStopped(options)) return compactionFailure("Compaction was cancelled");
        throw error;
      }
      if (!this.compactionSnapshotMatches(snapshot, options)) {
        return compactionFailure(
          this.compactionStopped(options)
            ? "Compaction was cancelled"
            : "History changed during compaction",
        );
      }
      this.host.ctx.storage.transactionSync(() => {
        if (snapshot.contextEpoch) {
          this.host.store.epochs.deleteContextEpochOwnedMessages(snapshot.contextEpoch.id);
        }
        summaryMessageId = this.host.store.history.compactHistoryPrefix({
          generation: snapshot.generation,
          fromMessageId: snapshot.fromMessageId,
          toMessageId: snapshot.toMessageId,
          summary: formatCompactionSummaryMessage({
            archivedMessages: snapshot.selected.length,
            archivePath: archivedTo,
            summary,
          }),
        });
        segment = this.host.store.history.recordHistorySegment({
          id: segmentId,
          generation: snapshot.generation,
          kind: "compaction",
          fromMessageId: snapshot.fromMessageId,
          toMessageId: snapshot.toMessageId,
          archivePath: archivedTo,
          summaryMessageId,
        });
        this.host.store.state.deleteContextState();
        if (snapshot.contextEpoch) {
          this.host.store.epochs.closeLiveContextEpoch(
            options.reason ?? "history.compacted",
            epochClosedAt,
            contextArchivePath,
          );
        }
      });
      if (options.activeRunId) {
        this.host.mutateActiveRun(options.activeRunId, (run) => {
          delete run.contextEpochId;
          delete run.generationContextId;
          return run;
        });
      }
      installed = true;
    } finally {
      if (!installed) {
        await this.deleteFailedCompactionArchive(archiveKey);
        if (contextArchivePath) {
          await this.deleteFailedCompactionArchive(contextArchivePath.replace(/^\/+/, ""));
        }
      }
    }
    if (!segment) throw new Error("Compaction segment was not recorded");
    return { segment, summaryMessageId, archivedTo };
  }

  async handleHistoryCompact(
    args: ProcHistoryCompactArgs,
    options: HistoryCompactionOptions = {},
  ): Promise<ProcHistoryCompactResult> {
    const telemetryStartedAt = Date.now();
    const pid = this.host.pid;
    const request = validateCompactionRequest(args);
    if ("ok" in request) return request;
    const snapshot = this.captureCompactionSnapshot(request, options);
    if ("ok" in snapshot) return snapshot;
    const resolvedSummary = await this.resolveCompactionSummary(request, snapshot, options);
    if (!resolvedSummary.ok) return resolvedSummary;
    if (this.compactionStopped(options)) return compactionFailure("Compaction was cancelled");
    const installed = await this.installCompaction(snapshot, resolvedSummary.summary, options);
    if ("ok" in installed) return installed;
    const { segment, summaryMessageId, archivedTo } = installed;

    await this.host.resources
      .deleteUnreferencedActiveMedia(snapshot.selectedMediaKeys)
      .catch((error) => {
        console.warn(
          `[Process] Failed to clean compacted history media for ${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    const lifecycleEvent: JsonObject = {
      event: "history.compacted",
      pid,
      generation: snapshot.generation,
      segment,
      archivedMessages: snapshot.selected.length,
      archivedTo,
      summaryMessageId,
    };
    if (options.reason) {
      lifecycleEvent.reason = options.reason;
    }
    await this.emitProcessLifecycle(lifecycleEvent);

    const telemetryProperties: CompactionTelemetryProperties = {
      trigger: options.telemetryTrigger ?? "manual",
      durationMs: Math.max(0, Date.now() - telemetryStartedAt),
      archivedMessages: snapshot.selected.length,
    };
    const contextPressure = options.contextPressure ?? snapshot.contextPressure;
    if (contextPressure !== undefined) {
      telemetryProperties.contextPressure = contextPressure;
    }
    emitTelemetry(this.host.env, {
      installationId: this.host.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "process.compaction.completed",
        properties: telemetryProperties,
      },
    });

    return {
      ok: true,
      pid,
      segment,
      archivedMessages: snapshot.selected.length,
      archivedTo,
      summaryMessageId,
    };
  }

  async generateHistoryCompactionSummary(
    messages: MessageRecord[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.host.killed) {
      throw new Error("Process no longer exists");
    }
    const pid = this.host.pid;
    const primary = await this.resolveCheckpointConfig(signal);
    if (!primary) {
      throw new Error("AI config unavailable");
    }

    const context = buildCompactionSummaryContext(messages);
    const generationOptions: Omit<AiTextGenerateOptions, "timeoutMs"> = {
      maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
      reasoning: "off",
    };
    let config = primary;
    let fallbackIndex = 0;
    let retriedEmptyResponse = false;
    while (true) {
      try {
        const generated = await this.host.run.generateCompactionText({
          config,
          context,
          options: {
            ...generationOptions,
            timeoutMs: config.generationTimeoutMs,
          },
          sessionAffinityKey: `${pid}:compaction`,
          signal,
        });
        const summary = generated.trim();
        if (summary) return summary;
        throw new Error("Generation returned no text");
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason ?? error;
        }
        const message = errorMessageFromUnknown(error);
        if (!retriedEmptyResponse && isRetryableGenerationErrorMessage(message)) {
          retriedEmptyResponse = true;
          continue;
        }
        const formatted =
          formatProviderErrorMessage(message, {
            provider: config.provider,
            model: config.model,
          }) || message;
        const fallback = nextAiConfigFallback(
          primary,
          config,
          primary.fallbacks ?? [],
          fallbackIndex,
        );
        if (!fallback) throw new Error(formatted);
        config = fallback.config;
        fallbackIndex = fallback.nextIndex;
        retriedEmptyResponse = false;
      }
    }
  }

  async resolveCheckpointConfig(signal?: AbortSignal): Promise<AiConfigResult | null> {
    if (this.host.killed) {
      return null;
    }
    if (this.host.runs.active?.config) {
      return this.host.runs.active.config;
    }
    try {
      const config = await this.host.settings.resolveAiConfig(signal);
      return this.host.killed ? null : config;
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn("[Process] Failed to resolve AI config for compaction:", error);
      return null;
    }
  }

  async maybeAppendContextRunwayAlert(runId: string, state: ProcContextState): Promise<boolean> {
    const inputBudgetTokens = state.inputBudgetTokens;
    const remainingInputTokens = state.remainingInputTokens;
    const pressure = state.pressure;
    if (
      inputBudgetTokens === null ||
      remainingInputTokens === null ||
      pressure === null ||
      !Number.isFinite(inputBudgetTokens) ||
      !Number.isFinite(remainingInputTokens) ||
      !Number.isFinite(pressure) ||
      inputBudgetTokens <= 0 ||
      remainingInputTokens < 0
    ) {
      return false;
    }

    const policy = this.getHistoryContextPolicy();
    const boundaryRemainingTokens = contextBoundaryRemainingTokens(
      inputBudgetTokens,
      policy.compactAtPressure,
    );
    const thresholdRemainingTokens = contextRunwayAlertThreshold(
      inputBudgetTokens,
      policy.compactAtPressure,
    );
    if (remainingInputTokens > thresholdRemainingTokens || pressure >= policy.compactAtPressure) {
      return false;
    }

    const epoch = this.host.store.epochs.getLiveContextEpoch();
    if (!epoch || this.host.handleRunStopped(runId)) {
      return false;
    }

    const content = formatContextRunwayAlertMessage({
      remainingInputTokens,
      runwayBeforeBoundaryTokens: Math.max(0, remainingInputTokens - boundaryRemainingTokens),
      policy,
    });
    const timestamp = Date.now();
    const messageId = this.host.ctx.storage.transactionSync(() => {
      const liveEpoch = this.host.store.epochs.getLiveContextEpoch();
      if (
        !liveEpoch ||
        liveEpoch.id !== epoch.id ||
        this.host.store.state.getValue(CONTEXT_RUNWAY_ALERT_EPOCH_KEY) === epoch.id
      ) {
        return null;
      }
      if (!liveEpoch.observedProjection) {
        return null;
      }
      const id = this.host.store.epochs.appendContextEpochMessage({
        epochId: liveEpoch.id,
        kind: "context.runway",
        content,
        runId,
        createdAt: timestamp,
      });
      this.host.store.state.setValue(CONTEXT_RUNWAY_ALERT_EPOCH_KEY, epoch.id);
      return id;
    });
    if (messageId === null) {
      return false;
    }

    await this.emitProcessLifecycle({
      event: "context.runway",
      pid: this.host.pid,
      runId,
      epochId: epoch.id,
      messageId,
      provider: state.provider,
      model: state.model,
      inputBudgetTokens,
      remainingInputTokens,
      boundaryRemainingTokens,
      thresholdRemainingTokens,
      pressure,
      compactAtPressure: policy.compactAtPressure,
      overflow: policy.overflow,
    });
    return true;
  }

  async applyHistoryContextPolicy(
    runId: string,
    config: AiConfigResult,
    state: ProcContextState,
    context: Context,
    trigger: "preflight" | "provider-overflow" = "preflight",
  ): Promise<"ready" | "compacted" | "stopped"> {
    const pressure = state.pressure;
    const policy = this.getHistoryContextPolicy();
    if (trigger === "preflight") {
      if (pressure === null || !Number.isFinite(pressure)) {
        return "ready";
      }
      if (pressure < policy.compactAtPressure) {
        return "ready";
      }
    }

    if (policy.overflow === "fail") {
      const lines = [
        "Context limit policy stopped this run.",
        trigger === "provider-overflow"
          ? "The AI provider reported that the request exceeds its context window."
          : `Policy: fail at ${Math.round(policy.compactAtPressure * 100)}% context pressure.`,
      ];
      if (pressure !== null && Number.isFinite(pressure)) {
        lines.push(`Current estimate: ${Math.round(pressure * 100)}%.`);
      }
      lines.push("Compact the history or reset the process before sending more work.");
      const message = lines.join("\n");
      await this.host.run.failWithSystemMessage(runId, "context.policy.fail", message);
      return "stopped";
    }

    const selected = this.selectAutoCompactionPrefix(runId, state, context, policy, trigger);
    if (selected.length === 0) {
      const message = [
        "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
        `Policy targets ${Math.round(policy.compactToPressure * 100)}% context pressure.`,
        "Compact manually or reset this process.",
      ].join("\n");
      await this.host.run.failWithSystemMessage(runId, "context.auto_compact.empty", message);
      return "stopped";
    }

    const compactionOptions: HistoryCompactionOptions = {
      allowActive: true,
      reason: "auto-compact",
      activeRunId: runId,
      telemetryTrigger: trigger === "preflight" ? "auto-preflight" : "auto-provider-overflow",
    };
    if (pressure !== null) compactionOptions.contextPressure = pressure;
    const result = await this.handleHistoryCompact(
      {
        throughMessageId: selected.at(-1)!.id,
        generateSummary: true,
      },
      compactionOptions,
    );
    if (this.host.handleRunStopped(runId)) {
      return "stopped";
    }
    if (!result.ok) {
      const message =
        trigger === "provider-overflow"
          ? `Auto-compaction failed after provider context overflow: ${result.error}`
          : `Auto-compaction failed before model call: ${result.error}`;
      await this.host.run.failWithSystemMessage(runId, "context.auto_compact.failed", message);
      return "stopped";
    }

    if (this.host.handleRunStopped(runId)) {
      return "stopped";
    }
    const lifecycleEvent: JsonObject = {
      event: "history.auto_compacted",
      pid: this.host.pid,
      provider: config.provider,
      model: config.model,
      trigger,
      policy,
      segment: result.segment,
      archivedMessages: result.archivedMessages,
    };
    if (pressure !== null && Number.isFinite(pressure)) {
      lifecycleEvent.pressure = pressure;
    }
    await this.emitProcessLifecycle(lifecycleEvent);
    return "compacted";
  }

  selectAutoCompactionPrefix(
    runId: string,
    state: ProcContextState,
    context: Context,
    policy: ProcHistoryContextPolicy,
    trigger: "preflight" | "provider-overflow",
  ): MessageRecord[] {
    const records = this.host.store.messages.getMessagesForGeneration();
    if (records.length <= 1) {
      return [];
    }

    const firstActiveRunIndex = records.findIndex((message) => message.runId === runId);
    const runInputMessageId = this.host.store.messages.getRunInputMessageId(runId);
    const runInputIndex =
      runInputMessageId === null
        ? -1
        : records.findIndex((message) => message.id === runInputMessageId);
    const protectedIndex =
      firstActiveRunIndex >= 0
        ? firstActiveRunIndex
        : runInputIndex >= 0
          ? runInputIndex
          : records.length - 1;
    if (protectedIndex <= 0) {
      return [];
    }

    const allMessages = this.host.store.messages.toMessages({
      limit: null,
      contextEpochId: this.host.runs.active?.contextEpochId,
      generationContextId: this.host.runs.active?.generationContextId,
    });
    if (allMessages.length !== records.length) {
      throw new Error("Process history and rendered message counts diverged during compaction");
    }

    const estimatedContextTokens = Math.max(1, estimateContextInputTokens(context));
    const inputBudgetTokens = state.inputBudgetTokens;
    const measuredInputTokens = Math.max(1, state.inputTokens);
    const effectiveInputTokens =
      trigger === "provider-overflow" && inputBudgetTokens !== null
        ? Math.max(measuredInputTokens, inputBudgetTokens)
        : measuredInputTokens;
    return this.selectCompactionPrefixToPressure({
      records,
      allMessages,
      protectedIndex,
      estimatedContextTokens,
      effectiveInputTokens,
      inputBudgetTokens,
      targetPressure: policy.compactToPressure,
    });
  }

  private selectCompactionPrefixToPressure(input: {
    records: MessageRecord[];
    allMessages: Message[];
    protectedIndex: number;
    estimatedContextTokens: number;
    effectiveInputTokens: number;
    inputBudgetTokens: number | null;
    targetPressure: number;
  }): MessageRecord[] {
    const {
      records,
      allMessages,
      protectedIndex,
      targetPressure,
      inputBudgetTokens,
    } = input;
    if (
      records.length <= 1 ||
      protectedIndex <= 0 ||
      allMessages.length !== records.length
    ) {
      return [];
    }

    const estimatedContextTokens = Math.max(1, input.estimatedContextTokens);
    const effectiveInputTokens = Math.max(1, input.effectiveInputTokens);
    const targetInputTokens =
      inputBudgetTokens !== null
        ? inputBudgetTokens * targetPressure
        : effectiveInputTokens * targetPressure;
    if (
      estimatedContextTokens <= targetInputTokens &&
      effectiveInputTokens <= targetInputTokens
    ) {
      return [];
    }
    const estimateScale = effectiveInputTokens / estimatedContextTokens;
    const summaryTokens = estimateContextMessagesTokens([
      {
        role: "user",
        content: `[GSV EVENT]\n${formatCompactionSummaryMessage({
          archivedMessages: protectedIndex,
          archivePath: "/home/process/history/compactions/segment.jsonl.gz",
          summary: "x".repeat(COMPACTION_SUMMARY_MAX_TOKENS * 4),
        })}`,
        timestamp: Date.now(),
      },
    ]);
    const estimateTargetTokens =
      inputBudgetTokens !== null
        ? inputBudgetTokens * targetPressure
        : estimatedContextTokens * targetPressure;
    const requiredEstimatedRemoval = Math.max(
      estimatedContextTokens - estimateTargetTokens + summaryTokens,
      (effectiveInputTokens - targetInputTokens) / estimateScale + summaryTokens,
    );

    let low = 1;
    let high = protectedIndex;
    while (low < high) {
      const candidate = Math.floor((low + high) / 2);
      const candidateTokens = estimateContextMessagesTokens(allMessages.slice(0, candidate));
      if (candidateTokens >= requiredEstimatedRemoval) {
        high = candidate;
      } else {
        low = candidate + 1;
      }
    }

    let requestedCut = low;
    const firstNonSummaryIndex = records
      .slice(0, protectedIndex)
      .findIndex((message) => !isCompactionSummaryMessage(message));
    if (firstNonSummaryIndex < 0) {
      return [];
    }
    requestedCut = Math.max(requestedCut, firstNonSummaryIndex + 1);

    let selected = this.host.store.history.getHistoryPrefixMessages({
      throughMessageId: records[requestedCut - 1]!.id,
    });
    if (selected.length > protectedIndex) {
      selected = this.host.store.history.getHistoryPrefixMessages({
        keepLast: records.length - requestedCut,
      });
    }
    if (
      selected.length === 0 ||
      selected.length > protectedIndex ||
      selected.every(isCompactionSummaryMessage)
    ) {
      return [];
    }
    return selected;
  }

  async updateContextState(
    runId: string,
    config: AiConfigResult,
    context: Context,
    options: {
      confirmedUsage?: AssistantMessage["usage"];
      usageState?: ProcUsageState;
    } = {},
  ): Promise<ProcContextState> {
    const pid = this.host.pid;
    const { count: messageCount, lastMessageId } = this.host.store.messages.messageStats();
    const revision = this.host.store.state.nextContextStateRevision();
    const state = buildProcContextState({
      revision,
      runId,
      messageCount,
      lastMessageId,
      provider: config.provider,
      model: config.model,
      reasoning: config.reasoning,
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxTokens,
      measurement: measureContextInputTokens(
        context,
        {
          provider: config.provider,
          model: config.model,
          contextEpochId:
            this.host.runs.active?.runId === runId
              ? this.host.runs.active.contextEpochId
              : undefined,
          generationContextId:
            this.host.runs.active?.runId === runId
              ? this.host.runs.active.generationContextId
              : undefined,
        },
        options.confirmedUsage,
      ),
      usageState: options.usageState,
      historyUsage: this.host.store.state.getHistoryUsage(),
    });
    this.host.store.state.setContextState(state);
    await this.host.signals
      .changed(["context"], {
        context: state,
      })
      .catch((error) => {
        console.warn(
          `[Process] Failed to emit proc.changed context for ${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return state;
  }

  async finishProviderContextOverflowRun(
    runId: string,
    config: AiConfigResult,
    providerMessage?: string,
  ): Promise<void> {
    const message = formatProviderContextOverflowMessage(providerMessage, {
      provider: config.provider,
      model: config.model,
    });
    await this.host.run.failWithSystemMessage(runId, CONTEXT_PROVIDER_OVERFLOW_REASON, message);
  }

  async finishInsufficientCompactionRun(
    runId: string,
    policy: ProcHistoryContextPolicy,
    beforePressure: number,
    afterPressure: number,
  ): Promise<void> {
    const message = [
      "Auto-compaction could not reduce this process history to its configured context target.",
      `Pressure: ${Math.round(beforePressure * 100)}% before, ${Math.round(afterPressure * 100)}% after.`,
      `Policy: compact at ${Math.round(policy.compactAtPressure * 100)}% and target ${Math.round(policy.compactToPressure * 100)}%.`,
      "Compact more history manually or reset the process.",
    ].join("\n");
    await this.host.run.failWithSystemMessage(
      runId,
      "context.auto_compact.insufficient",
      message,
    );
  }

  async ensureContextEpoch(
    runId: string,
    run: RunState,
    config: AiConfigResult,
    contextSnapshot: AiContextResult = contextSnapshotFromRun(run, config),
    currentProjection: ContextProjection = createContextProjection(contextSnapshot),
  ): Promise<ContextEpochRecord | null> {
    let epoch = this.host.store.epochs.getLiveContextEpoch();
    if (epoch) {
      const initialProjection = contextProjectionFromManifest(epoch.sourceManifest);
      const observedProjection = parseContextProjection(epoch.observedProjection);
      if (!run.systemPrompt || !initialProjection || !observedProjection) {
        epoch = await this.refreshIncompleteContextEpoch(
          runId,
          run,
          config,
          contextSnapshot,
          currentProjection,
          epoch,
          initialProjection,
          observedProjection,
        );
        if (!epoch || this.host.handleRunStopped(runId)) return null;
      }
    }

    if (!epoch) {
      epoch = await this.createInitialContextEpoch(
        runId,
        run,
        config,
        contextSnapshot,
        currentProjection,
      );
      if (!epoch || this.host.handleRunStopped(runId)) return null;
    }

    return this.installRunContextEpoch(runId, run, epoch);
  }

  async refreshIncompleteContextEpoch(
    runId: string,
    run: RunState,
    config: AiConfigResult,
    contextSnapshot: AiContextResult,
    currentProjection: ContextProjection,
    epoch: ContextEpochRecord,
    initialProjection: ContextProjection | null,
    observedProjection: ContextProjection | null,
  ): Promise<ContextEpochRecord | null> {
    const candidate =
      initialProjection && observedProjection
        ? await this.assembleContextEpochCandidate(
            run,
            config,
            {
              responsibilities: epoch.r12yBaseline,
              count: epoch.r12yCount,
              revision: epoch.r12yRevision,
            },
            contextSnapshot,
            initialProjection,
          )
        : null;
    if (this.host.handleRunStopped(runId)) return null;
    if (
      candidate &&
      candidate.prompt === epoch.systemPrompt &&
      JSON.stringify(candidate.sourceManifest) === JSON.stringify(epoch.sourceManifest)
    ) {
      return epoch;
    }
    return await this.replaceContextEpoch(
      runId,
      run,
      config,
      contextSnapshot,
      currentProjection,
      epoch,
    );
  }

  async replaceContextEpoch(
    runId: string,
    run: RunState,
    config: AiConfigResult,
    contextSnapshot: AiContextResult,
    currentProjection: ContextProjection,
    priorEpoch: ContextEpochRecord,
  ): Promise<ContextEpochRecord | null> {
    const ledger = await this.loadResponsibilityBaseline();
    if (this.host.handleRunStopped(runId)) return null;
    const replacement = await this.assembleContextEpochCandidate(
      run,
      config,
      ledger,
      contextSnapshot,
      currentProjection,
    );
    if (this.host.handleRunStopped(runId)) return null;
    const closedAt = Date.now();
    const generationMessages = this.host.store.messages.getMessagesForGeneration(
      priorEpoch.generation,
    );
    const nextEpochFirstMessageId = generationMessages.find(
      (message) => message.runId === runId,
    )?.id;
    const archivePath = await this.archiveContextEpoch(
      priorEpoch,
      "context.changed",
      closedAt,
      this.host.run.runAbortSignal(runId),
      {
        messages:
          nextEpochFirstMessageId === undefined
            ? generationMessages
            : generationMessages.filter((message) => message.id < nextEpochFirstMessageId),
        transitions: this.host.store.epochs.listContextEpochTransitions(priorEpoch.id),
        runBoundaries: this.host.store.epochs.listContextEpochRuns(priorEpoch.id),
      },
    );
    if (this.host.handleRunStopped(runId)) {
      await this.deleteFailedCompactionArchive(archivePath.replace(/^\/+/, ""));
      return null;
    }
    let installed: ContextEpochRecord | null = null;
    try {
      installed = this.host.ctx.storage.transactionSync(() => {
        const current = this.host.store.epochs.getLiveContextEpoch();
        if (
          !current ||
          current.id !== priorEpoch.id ||
          current.observedR12yRevision !== priorEpoch.observedR12yRevision ||
          JSON.stringify(current.observedProjection) !==
            JSON.stringify(priorEpoch.observedProjection)
        ) {
          throw new Error("Context epoch changed while installing its replacement");
        }
        this.host.store.epochs.deleteContextEpochOwnedMessages(current.id);
        this.host.store.epochs.closeLiveContextEpoch("context.changed", closedAt, archivePath);
        return this.createContextEpoch(replacement, ledger, currentProjection, closedAt);
      });
      return installed;
    } finally {
      if (!installed) {
        await this.deleteFailedCompactionArchive(archivePath.replace(/^\/+/, ""));
      }
    }
  }

  async createInitialContextEpoch(
    runId: string,
    run: RunState,
    config: AiConfigResult,
    contextSnapshot: AiContextResult,
    currentProjection: ContextProjection,
  ): Promise<ContextEpochRecord | null> {
    const ledger = await this.loadResponsibilityBaseline();
    if (this.host.handleRunStopped(runId)) return null;
    const candidate = await this.assembleContextEpochCandidate(
      run,
      config,
      ledger,
      contextSnapshot,
      currentProjection,
      run.systemPrompt,
    );
    if (this.host.handleRunStopped(runId)) return null;
    return this.host.ctx.storage.transactionSync(
      () =>
        this.host.store.epochs.getLiveContextEpoch() ??
        this.createContextEpoch(candidate, ledger, currentProjection, Date.now()),
    );
  }

  private createContextEpoch(
    candidate: ContextEpochCandidate,
    ledger: ResponsibilityListResult,
    projection: ContextProjection,
    now: number,
  ): ContextEpochRecord {
    return this.host.store.epochs.createContextEpoch({
      id: crypto.randomUUID(),
      generation: this.host.store.state.getHistoryGeneration(),
      systemPrompt: candidate.prompt,
      r12yRevision: ledger.revision,
      r12yCount: ledger.count,
      r12yBaseline: ledger.responsibilities,
      sourceManifest: candidate.sourceManifest,
      observedProjection: jsonObjectSchema.parse(projection),
      now,
    });
  }

  private loadResponsibilityBaseline(): Promise<ResponsibilityListResult> {
    return this.host.kernel.kernelRpc("r12y.list", { includeTerminal: false, limit: 500 });
  }

  installRunContextEpoch(
    runId: string,
    run: RunState,
    epoch: ContextEpochRecord,
  ): ContextEpochRecord | null {
    const active = this.host.mutateActiveRun(runId, (current) => {
      const next = {
        ...current,
        systemPrompt: epoch.systemPrompt,
        contextEpochId: epoch.id,
      };
      if (current.contextEpochId !== epoch.id) {
        delete next.generationContextId;
      }
      return next;
    });
    if (!active) return null;
    run.systemPrompt = epoch.systemPrompt;
    if (run.contextEpochId !== epoch.id) delete run.generationContextId;
    run.contextEpochId = epoch.id;
    return epoch;
  }

  async assembleContextEpochCandidate(
    run: RunState,
    config: AiConfigResult,
    ledger: ResponsibilityListResult,
    contextSnapshot: AiContextResult,
    projection: ContextProjection,
    promptOverride?: string,
  ): Promise<ContextEpochCandidate> {
    const promptConfig: AiConfigResult = {
      ...config,
      system: { timezone: projection.runtime.timezone },
      skillIndex: projection.skills.entries.map((entry) => ({
        id: entry.id,
        name: entry.id,
        description: entry.description,
        source: { kind: "home", label: "home", writable: true },
      })),
      skillIndexMode: projection.skills.mode,
    };
    if (contextSnapshot.systemContextFiles !== undefined) {
      promptConfig.systemContextFiles = contextSnapshot.systemContextFiles;
    } else {
      delete promptConfig.systemContextFiles;
    }
    const snapshot = promptOverride
      ? { prompt: promptOverride, sources: [] }
      : await assembleSystemPromptSnapshot({
          config: promptConfig,
          identity: this.host.identity,
          ownerIdentity: config.owner ?? undefined,
          targets: projection.targets,
          mcpServers: projection.mcpServers,
          runtime: projection.runtime,
          r12y: formatResponsibilityBaseline(ledger),
          storage: this.host.storage,
          ripgit: this.host.ripgit,
        });
    const modelManifest: JsonObject = {
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      contextWindowTokens: config.contextWindowTokens,
    };
    if (config.reasoning !== undefined) modelManifest.reasoning = config.reasoning;
    const offeredTools = (run.tools ?? []).map((tool): JsonObject => {
      const record: JsonObject = {
        name: tool.name,
        inputSchema: tool.inputSchema,
      };
      if (tool.description !== undefined) record.description = tool.description;
      return record;
    });
    const sourceManifest = jsonObjectSchema.parse({
      version: 2,
      process: {
        pid: this.host.pid,
        uid: this.host.identity.uid,
        username: this.host.identity.username,
      },
      historyGeneration: this.host.store.state.getHistoryGeneration(),
      model: modelManifest,
      contextProjection: projection,
      offeredTools,
      promptSources: snapshot.sources,
      recoveredRunPrompt: promptOverride !== undefined,
    });
    return { prompt: snapshot.prompt, sourceManifest };
  }

  async syncContextProjection(
    runId: string,
    epoch: ContextEpochRecord,
    current: ContextProjection,
  ): Promise<boolean> {
    const observed = parseContextProjection(epoch.observedProjection);
    if (!observed) {
      throw new Error(`Context epoch ${epoch.id} has no observed projection`);
    }
    if (contextProjectionsEqual(observed, current)) {
      return true;
    }

    const content = formatContextProjectionEvent(observed, current);
    if (!content) {
      throw new Error("Context projection changed without a renderable event");
    }
    const createdAt = Date.now();
    const appended = this.host.ctx.storage.transactionSync(() => {
      const live = this.host.store.epochs.getLiveContextEpoch();
      if (!live || live.id !== epoch.id) {
        throw new Error("Context epoch changed while appending a context event");
      }
      const liveObserved = parseContextProjection(live.observedProjection);
      if (!liveObserved) {
        throw new Error(`Context epoch ${epoch.id} has no observed projection`);
      }
      if (contextProjectionsEqual(liveObserved, current)) {
        return false;
      }
      if (!contextProjectionsEqual(liveObserved, observed)) {
        throw new Error("Context projection changed while appending its event");
      }
      this.host.store.epochs.appendContextEpochMessage({
        epochId: epoch.id,
        kind: "context.projection",
        observedProjection: jsonObjectSchema.parse(current),
        content,
        runId,
        createdAt,
      });
      return true;
    });
    if (appended) {
      await this.host.signals.changed(["messages"], {
        runId,
        event: "context.projection",
        epochId: epoch.id,
      });
    }
    return true;
  }

  async syncResponsibilityDeltas(runId: string, epoch: ContextEpochRecord): Promise<boolean> {
    let observedRevision = epoch.observedR12yRevision;
    let appended = false;
    for (;;) {
      const changes = await this.host.kernel.kernelRpc("r12y.changes", {
        afterRevision: observedRevision,
        limit: 500,
      });
      if (this.host.handleRunStopped(runId)) return false;

      this.host.ctx.storage.transactionSync(() => {
        const live = this.host.store.epochs.getLiveContextEpoch();
        if (!live || live.id !== epoch.id) {
          throw new Error("Context epoch changed while recovering responsibility deltas");
        }
        for (const transition of changes.transitions) {
          if (transition.revision <= live.observedR12yRevision) continue;
          this.host.store.epochs.appendContextEpochTransition(
            epoch.id,
            transition,
            formatResponsibilityTransitionEvent(transition),
            runId,
          );
          appended = true;
        }
        const throughRevision = changes.hasMore
          ? (changes.transitions.at(-1)?.revision ?? live.observedR12yRevision)
          : changes.revision;
        this.host.store.epochs.advanceContextEpochObservedRevision(epoch.id, throughRevision);
        observedRevision = Math.max(observedRevision, throughRevision);
      });

      if (!changes.hasMore) break;
      if (changes.transitions.length === 0) {
        throw new Error("Responsibility change pagination made no progress");
      }
    }

    if (appended) await this.host.signals.changed(["messages"], { runId });
    return true;
  }

  consumeRuntimeEventsInContext(runId: string, count: number): void {
    if (this.host.killed || count <= 0) {
      return;
    }
    const run = this.host.runs.active;
    if (!run || run.runId !== runId) {
      return;
    }
    const remaining = Math.max(0, (run.pendingRuntimeEvents ?? 0) - count);
    if (remaining > 0) {
      run.pendingRuntimeEvents = remaining;
    } else {
      delete run.pendingRuntimeEvents;
    }
    this.host.runs.active = run;
  }

  private async hydrateContextMedia(
    records: MessageRecord[],
    messages: Context["messages"],
  ): Promise<void> {
    const budget = { remainingBytes: MAX_PROCESS_MEDIA_READ_BYTES };
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (!record.media) continue;
      const content = await this.host.resources.hydrateMediaContent(
        record.content,
        record.media,
        budget,
      );
      if (record.role === "user") {
        messages[index] = {
          role: "user",
          content,
          timestamp: record.createdAt,
        } satisfies UserMessage;
      } else if (record.role === "toolResult") {
        const message = messages[index];
        if (message?.role === "toolResult") {
          messages[index] = { ...message, content } satisfies ToolResultMessage;
        }
      }
    }
  }

  private annotateContextOrigins(records: MessageRecord[], messages: Context["messages"]): void {
    let previousSource: string | null | undefined;
    let previousReplyDestinationKey: string | undefined;
    const seenRunIds = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const ownsDistinctRun = Boolean(record.runId && !seenRunIds.has(record.runId));
      if (record.runId) seenRunIds.add(record.runId);
      if (record.role !== "user" && record.role !== "system") continue;

      const origin = parseInteractionOrigin(record.origin);
      const source = formatInteractionOriginForContext(origin);
      const shouldRenderSource = source !== null && source !== previousSource;
      if (record.role === "user" || source !== null) previousSource = source;

      const replyDestination = ownsDistinctRun ? formatReplyDestinationForContext(origin) : null;
      const shouldRenderReplyDestination =
        replyDestination !== null && replyDestination.key !== previousReplyDestinationKey;
      if (replyDestination) previousReplyDestinationKey = replyDestination.key;

      const message = messages[index];
      if (message?.role !== "user" || (!shouldRenderSource && !shouldRenderReplyDestination)) {
        continue;
      }
      messages[index] = prefixUserMessageContent(message, formatContextOriginLines(
        source,
        shouldRenderSource,
        replyDestination,
        shouldRenderReplyDestination,
      ));
    }
  }

  async buildContextMessages(
    contextEpochId?: string,
    generationContextId?: string,
  ): Promise<Context["messages"]> {
    const records = this.host.store.messages.getMessages({ limit: null });
    const messages = this.host.store.messages.toMessages({
      limit: null,
      contextEpochId,
      generationContextId,
    });
    await this.hydrateContextMedia(records, messages);
    this.annotateContextOrigins(records, messages);
    return orderMessagesForProvider(messages);
  }
}
