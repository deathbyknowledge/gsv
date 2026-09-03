/** Owns Process frame routing, admission, lifecycle transitions, and runtime events. */

import {
  ABORTED_RUN_IDS_KEY, IPC_TOMBSTONE_LIMIT, MEDIA_PREPARATION_TIMEOUT_MS, TOOL_EXECUTION_DENIED_BY_USER_MESSAGE,
  USER_INTERRUPTED_TOOL_MESSAGE, USER_SUPERSEDED_TOOL_MESSAGE, PROCESS_KILLED_TOMBSTONE_KEY, PROCESS_RESET_AT_KEY,
  tombstoneKilledProcessStorage, type ProcessKilledTombstone, HANDLED_IPC_CALLS_KEY, RUNTIME_EVENT_IDS_KEY,
  RUNTIME_EVENT_TOMBSTONE_LIMIT, RUNTIME_EVENT_WAKE_MESSAGE, type RuntimeEventAdmission, DELIVERY_NOTICE_IDS_KEY,
  DELIVERY_NOTICE_TOMBSTONE_LIMIT, MAX_CANCELLED_REQUESTS,
} from "../internal/lifecycle";
import type { Process } from "../do";
import {
  parseAssistantMessageMeta, parseMessageMetadata, type EnqueueMessageOptions, type MessageRecord,
  type PendingHilRecord, type QueuedMessage, ProcessStore, type ToolCallRecord,
} from "../store";
import type { RunState, ResponsibilityBatchState } from "../run/state";
import {
  abortedRunIdsSchema, archivedToolResultMetadataSchema, type IpcReplyPayload,
  cancelRequestPayloadSchema, deliveryNoticePayloadSchema, identityChangedPayloadSchema, ipcReplyPayloadSchema,
  watchedSignalPayloadSchema, type CancelRequestPayload,
} from "../internal/schemas";
import { conversationRunState } from "../run/helpers";
import { errorMessageFromUnknown } from "../../inference/errors";
import {
  type ProcAbortArgs, type ProcAbortResult, type ProcHilArgs, type ProcHilResult, type ProcHistoryArgs,
  type ProcHistoryMessage, type ProcHistoryResult, type ProcHistoryToolResultContent, type ProcIpcDeliverArgs,
  type ProcIpcDeliverResult, type ProcMediaInput, type ProcSendArgs, type ProcSendResult, type ResourceBlock,
  type ProcKillResult, type ProcResetResult, type ProcRunToolFinishedSignal, type InteractionOrigin, type JsonObject,
  REQUEST_CANCEL_SIGNAL,
} from "@humansandmachines/gsv/protocol";
import { agentArchiveMediaPath } from "../../shared/process-media-path";
import { parseInteractionOrigin, serializeInteractionOrigin, emptyProcessArchive } from "../history/helpers";
import { storeIncomingProcessMedia, stringifyStoredProcessMedia, deleteProcessMedia } from "../media";
import {
  formatIpcMessage, appendResponsibilityBatch, formatIpcReplyMessage, formatProcessRuntimeEvent,
  formatScheduleEventMessage, formatWatchedSignalMessage, normalizeProcessRuntimeEvent,
} from "../internal/events";
import type { AssistantHistoryContent, AsyncCleanupTask, CodeModeApprovalWaiter } from "../internal/contracts";
import { extractStoredFsReadResource } from "../tool-result-media";
import {
  isNonNegativeInteger, isPositiveInteger, normalizeToolResultOutcome, normalizeOptionalString,
  parseStoredStringArray, cancelResponseBody,
} from "../internal/messages";
import { CODEMODE_EXEC, SYSCALL_TOOL_NAMES } from "../../syscalls/constants";
import { cancelProcessRequests } from "../../shared/utils";
import type {
  ProcessRuntimeEventDeliverArgs, ProcessRuntimeEventDeliverResult, ProcessScheduleDeliverArgs,
  ProcessAdapterDeliverResponseFrame, ProcessInboundFrame, ProcessRequestFrame, ProcessResourceResponseFrame,
  ProcessResourcesRetainResponseFrame, ProcessRuntimeEventDeliverResponseFrame, ProcessScheduleDeliverResponseFrame,
} from "../../protocol/process-frames";
import { AGENT_READ_MAX_BYTES } from "../../syscalls/read";
import type { ResponseErrFrame, ResponseFrame, ResponseOkFrame, SignalFrame } from "../../protocol/frames";
import type { ResultOf, SyscallName } from "../../syscalls";
import { formatAgentToolResponse, materializeToolResponse } from "../tool-response";

type SendAdmissionInput = {
  args: Omit<ProcSendArgs, "media"> & {
    media?: Array<ResourceBlock | ProcMediaInput>;
  };
  admittedRunId?: string;
  identity: Process["identity"];
  incomingMedia: ProcMediaInput[];
  mediaKeys: string[];
  origin: string | null;
  runId: string;
};

type InstalledSend = { result: ProcSendResult; installed: boolean };
type InterruptSendEffects = {
  interrupted: ReturnType<Process["tools"]["recordToolResults"]> | null;
  finish: ReturnType<Process["run"]["recordRunFinish"]> | null;
};
type AbortEffects = {
  approval: ReturnType<Process["store"]["tools"]["getPendingHilForRun"]>;
  interrupted: InterruptSendEffects["interrupted"];
  transition: ReturnType<Process["run"]["commitRunFinishState"]> | null;
};

async function failedCleanupTasks<T extends AsyncCleanupTask>(tasks: T[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks.map(({ run }) => Promise.resolve().then(run)));
  return tasks.filter((_, index) => settled[index]?.status === "rejected");
}

function postKillTasks(
  host: Process,
  pid: string,
  activeRun: RunState | null,
  finishPayload: ReturnType<Process["run"]["runFinishedPayload"]> | null,
): AsyncCleanupTask[] {
  const pendingRequestIds = new Set(host.codeModeResponses.keys());
  const tasks: AsyncCleanupTask[] = [];
  if (activeRun) {
    for (const result of host.store.tools.getResults(activeRun.runId)) {
      if (result.status === "registered" || result.status === "pending") {
        pendingRequestIds.add(result.dispatchId);
      }
      if (result.status !== "pending") continue;
      const payload: ProcRunToolFinishedSignal = {
        pid,
        runId: activeRun.runId,
        executionId: result.dispatchId,
        callId: result.id,
        outcome: "cancelled",
        timestamp: Date.now(),
      };
      tasks.push({
        label: `tool finish notification ${payload.executionId}`,
        run: () => host.sendSignal("proc.run.tool.finished", payload, pid),
      });
    }
  }
  if (finishPayload) {
    tasks.push({
      label: "finish notification",
      run: () => host.sendSignal("proc.run.finished", finishPayload, pid),
    });
  }
  if (pendingRequestIds.size > 0) {
    tasks.push({
      label: "request cancellation",
      run: async () => {
        await cancelProcessRequests(
          host.installationId,
          pid,
          [...pendingRequestIds],
          "Process execution was reset: process.kill",
        );
      },
    });
  }
  return tasks;
}

async function admitQueuedSend(
  host: Process,
  input: SendAdmissionInput,
): Promise<ProcSendResult> {
  const { args, admittedRunId, identity, incomingMedia, mediaKeys, origin, runId } = input;
  const releaseMedia = await host.resources.acquireMediaKeyAdmissions(mediaKeys);
  const releaseAdmission = await host.controller.acquireQueuedSendAdmission();
  try {
    if (!sameAdmissionIdentity(host, identity)) {
      return { ok: false, error: "Process no longer exists" };
    }
    if (admittedRunId) {
      const existing = host.controller.existingRunAdmission(runId);
      if (existing) return existing;
    }
    const media = await storeIncomingProcessMedia(
      host.storage,
      identity.uid,
      host.pid,
      incomingMedia,
      {
        ...(await host.resources.resolveMediaProcessingOptions(incomingMedia)),
        allowedStoredKeys: new Set(
          mediaKeys.filter((key) => agentArchiveMediaPath(identity.home, key) !== null),
        ),
      },
    );
    const missingMediaKey = await host.resources.firstMissingMediaKey(mediaKeys);
    if (missingMediaKey) {
      return { ok: false, error: `media not found: ${missingMediaKey}` };
    }

    const admission = host.ctx.storage.transactionSync((): InstalledSend => {
      if (!sameAdmissionIdentity(host, identity)) {
        return { result: { ok: false, error: "Process no longer exists" }, installed: false };
      }
      if (admittedRunId) {
        const existing = host.controller.existingRunAdmission(runId);
        if (existing) return { result: existing, installed: false };
      }
      if (host.runs.active) {
        const enqueueOptions: EnqueueMessageOptions = {
          media: media ?? undefined,
          origin: origin ?? undefined,
        };
        if (args.interaction) {
          enqueueOptions.kind = "conversation.message";
          enqueueOptions.provenance = JSON.stringify(args.interaction);
        }
        host.store.queue.enqueue(runId, args.message, enqueueOptions);
        return {
          result: { ok: true, status: "started", runId, queued: true },
          installed: true,
        };
      } else {
        host.store.messages.appendMessage("user", args.message, {
          runId,
          media: media ?? undefined,
          origin: origin ?? undefined,
        });
        const nextRun: RunState = { runId };
        if (args.interaction) {
          nextRun.conversationId = args.interaction.conversationId;
          nextRun.inputMessageId = args.interaction.messageId;
        }
        host.runs.active = nextRun;
        return { result: { ok: true, status: "started", runId }, installed: true };
      }
    });
    if (!admission.installed) return admission.result;

    host.maybeStartTaskTitleGeneration(args.message);
    const result = admission.result;
    if (result.ok && result.queued) {
      await host.signals.changed(["queue"], { enqueuedRunId: runId });
      return result;
    }
    await host.controller.scheduleRunOrFinish(runId, "Failed to schedule process run");
    host.controller.announceRun(runId, "proc.send");
    return result;
  } finally {
    releaseAdmission();
    releaseMedia();
  }
}

async function admitInterruptingSend(
  host: Process,
  input: SendAdmissionInput,
): Promise<ProcSendResult> {
  const { args, admittedRunId, identity, incomingMedia, mediaKeys, origin, runId } = input;
  const releaseMedia = await host.resources.acquireMediaKeyAdmissions(mediaKeys);
  try {
    const missingMediaKey = await host.resources.firstMissingMediaKey(mediaKeys);
    if (missingMediaKey) {
      return { ok: false, error: `media not found: ${missingMediaKey}` };
    }
    const committingRunId = host.runControlCommit?.runId;
    if (committingRunId) {
      await host.run.awaitRunControlCommit(committingRunId);
    }
    if (!sameAdmissionIdentity(host, identity)) {
      return { ok: false, error: "Process no longer exists" };
    }
    if (admittedRunId) {
      const existing = host.controller.existingRunAdmission(runId);
      if (existing) return existing;
    }

    const activeRun = host.runs.active;
    if (activeRun) {
      host.tools.cancelPendingRequests(activeRun.runId, USER_SUPERSEDED_TOOL_MESSAGE);
    }
    const admission = host.ctx.storage.transactionSync(() => {
      if (!sameAdmissionIdentity(host, identity)) return null;
      if (activeRun && host.runs.active?.runId !== activeRun.runId) return null;
      if (admittedRunId && host.controller.existingRunAdmission(runId)) return null;

      const effects: InterruptSendEffects = { interrupted: null, finish: null };
      if (activeRun) {
        host.controller.rememberAbortedRun(activeRun.runId);
        effects.interrupted = host.tools.recordToolResults(
          activeRun.runId,
          host.store.tools.getResults(activeRun.runId),
          { interruptPending: USER_SUPERSEDED_TOOL_MESSAGE },
        );
        host.store.tools.clearPendingHil();
        effects.finish = host.run.recordRunFinish(activeRun, {
          resultText: null,
          status: "aborted",
          reason: "user.superseded",
        });
      }

      const hasMedia = incomingMedia.length > 0;
      const messageId = host.store.messages.appendMessage("user", args.message, {
        runId,
        media: hasMedia ? (stringifyStoredProcessMedia(incomingMedia) ?? undefined) : undefined,
        origin: origin ?? undefined,
      });
      const nextRun: RunState = { runId };
      if (args.interaction) {
        nextRun.conversationId = args.interaction.conversationId;
        nextRun.inputMessageId = args.interaction.messageId;
      }
      if (hasMedia) nextRun.pendingMediaMessageId = messageId;
      host.runs.active = nextRun;
      return { effects, messageId };
    });

    if (!admission) {
      const existing = admittedRunId ? host.controller.existingRunAdmission(runId) : null;
      return existing ?? { ok: false, error: "Process no longer exists" };
    }
    const { effects, messageId } = admission;
    if (activeRun) {
      host.tools.rejectCodeModeWaiters(activeRun.runId, USER_SUPERSEDED_TOOL_MESSAGE);
      host.streams.deleteRun(activeRun.runId);
    }
    const recordedTools = effects.interrupted;
    if (recordedTools && activeRun) {
      host.startBackground(
        `interrupted tool notifications for ${activeRun.runId}`,
        host.tools.completeToolResultIngestion(activeRun.runId, recordedTools),
      );
      if (recordedTools.appended > 0) {
        host.startBackground(
          `superseded run message notification for ${activeRun.runId}`,
          host.signals.changed(["messages"], { runId: activeRun.runId }),
        );
      }
    }
    if (effects.finish) host.run.completeRunFinish(effects.finish);

    host.maybeStartTaskTitleGeneration(args.message);
    if (incomingMedia.length > 0) {
      try {
        await host.run.schedule(
          new Date(Date.now() + MEDIA_PREPARATION_TIMEOUT_MS),
          "onMediaPreparationTimeout",
          runId,
        );
      } catch (error) {
        await host.resources.failPendingMedia(
          runId,
          messageId,
          `Failed to schedule media timeout: ${errorMessageFromUnknown(error)}`,
          "media.error",
        );
        return { ok: true, status: "started", runId };
      }
      host.startBackground(
        `media preparation for ${runId}`,
        host.resources.prepareRunMedia(runId, messageId, incomingMedia),
      );
    } else {
      await host.controller.scheduleRunOrFinish(runId, "Failed to schedule process run");
    }
    host.controller.announceRun(runId, "proc.send");
    return { ok: true, status: "started", runId };
  } finally {
    releaseMedia();
  }
}

function sameAdmissionIdentity(
  host: Process,
  identity: Process["identity"],
): boolean {
  return (
    host.isInitialized() &&
    host.identity.uid === identity.uid &&
    host.identity.gid === identity.gid &&
    host.identity.home === identity.home
  );
}

function storedToolResultMetadata(raw: string | null) {
  if (!raw) return {};
  try {
    const parsed = archivedToolResultMetadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function processHistoryContent(
  host: Process,
  record: MessageRecord,
): ProcHistoryMessage["content"] {
  const media = record.media ? host.resources.parseOwnedProcessMedia(record.media) : [];
  if (record.role === "toolResult") {
    const meta = storedToolResultMetadata(record.toolCalls);
    const isError = meta.isError ?? false;
    const content: ProcHistoryToolResultContent = {
      toolName: meta.toolName ?? "unknown",
      isError,
      outcome: normalizeToolResultOutcome(meta.outcome, isError, record.content),
      toolCallId: record.toolCallId ?? null,
      output: record.content,
    };
    if (media.length > 0) content.media = media;
    const resource = extractStoredFsReadResource(record.content);
    if (resource) content.resources = [{ type: "resource", ref: resource }];
    return content;
  }
  if (record.role === "assistant" && record.toolCalls) {
    const assistant = parseAssistantMessageMeta(record.toolCalls);
    const content: AssistantHistoryContent = {
      text: record.content,
      thinking: assistant.thinking ?? [],
      toolCalls: assistant.toolCalls ?? [],
    };
    if (media.length > 0) content.media = media;
    return content;
  }
  return media.length > 0 ? { text: record.content, media } : record.content;
}

function processHistoryMessage(host: Process, record: MessageRecord): ProcHistoryMessage {
  const projected: ProcHistoryMessage = {
    id: record.id,
    role: record.role,
    content: processHistoryContent(host, record),
    timestamp: record.createdAt,
  };
  const origin = parseInteractionOrigin(record.origin);
  const metadata = parseMessageMetadata(record.metadata);
  if (record.runId) projected.runId = record.runId;
  if (origin) projected.origin = origin;
  if (metadata) projected.metadata = metadata;
  return projected;
}

function successfulHilResult(
  pid: string,
  args: Pick<ProcHilArgs, "requestId" | "decision">,
  remembered: boolean,
  resumed: boolean,
  pendingHil: Extract<ProcHilResult, { ok: true }>["pendingHil"] = null,
): ProcHilResult {
  return {
    ok: true,
    pid,
    requestId: args.requestId,
    decision: args.decision,
    resumed,
    remembered,
    pendingHil,
  };
}

function errorResponse(id: string, code: number, message: string): ResponseErrFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function requestErrorCode(killed: boolean, call: string): number {
  return killed && call !== "proc.kill" ? 410 : 500;
}

type HistoryQuery = {
  includeMessages: boolean;
  limit: number;
  offset: number;
  beforeMessageId?: number;
  afterMessageId?: number;
  tail: boolean;
  cursorCount: number;
};

function historyQuery(
  args: ProcHistoryArgs,
): HistoryQuery | Extract<ProcHistoryResult, { ok: false }> {
  const limit = args.limit ?? 200;
  const offset = args.offset ?? 0;
  if (!isPositiveInteger(limit)) {
    return { ok: false, error: "proc.history limit must be a positive integer" };
  }
  if (!isNonNegativeInteger(offset)) {
    return { ok: false, error: "proc.history offset must be a non-negative integer" };
  }
  if (args.beforeMessageId !== undefined && !isPositiveInteger(args.beforeMessageId)) {
    return { ok: false, error: "proc.history beforeMessageId must be a positive integer" };
  }
  if (args.afterMessageId !== undefined && !isPositiveInteger(args.afterMessageId)) {
    return { ok: false, error: "proc.history afterMessageId must be a positive integer" };
  }
  const tail = args.tail === true;
  const cursorCount =
    Number(tail) +
    Number(args.beforeMessageId !== undefined) +
    Number(args.afterMessageId !== undefined);
  if (cursorCount > 1) {
    return {
      ok: false,
      error: "proc.history accepts only one cursor: tail, beforeMessageId, or afterMessageId",
    };
  }
  if (cursorCount > 0 && args.offset !== undefined) {
    return {
      ok: false,
      error: "proc.history offset cannot be combined with cursor pagination",
    };
  }
  return {
    includeMessages: args.includeMessages !== false,
    limit,
    offset,
    beforeMessageId: args.beforeMessageId,
    afterMessageId: args.afterMessageId,
    tail,
    cursorCount,
  };
}

async function resetProcess(host: Process): Promise<ProcResetResult> {
  if (host.killed) throw new Error("Process no longer exists");
  if (host.lifecyclePhase !== "ready") {
    throw new Error(`Process lifecycle is ${host.lifecyclePhase}`);
  }
  host.lifecyclePhase = "resetting";
  host.lifecycleEpoch += 1;
  const lifecycleEpoch = host.lifecycleEpoch;
  const pid = host.pid;
  const identity = host.identity;
  try {
    const activeRunId = host.runs.active?.runId;
    if (activeRunId) await host.run.awaitRunControlCommit(activeRunId);
    await host.controller.resetExecutionState("process.reset");
    const totalMessages = host.store.messages.messageCount();
    const archive =
      totalMessages > 0
        ? await host.history.archiveHistoryMessages(crypto.randomUUID())
        : emptyProcessArchive();
    const contextEpoch = host.store.epochs.getLiveContextEpoch();
    const epochClosedAt = Date.now();
    const contextArchivePath = contextEpoch
      ? await host.history.archiveContextEpoch(contextEpoch, "process.reset", epochClosedAt)
      : undefined;
    let resetInstalled = false;
    try {
      host.ctx.storage.transactionSync(() => {
        if (
          host.killed ||
          host.lifecyclePhase !== "resetting" ||
          host.lifecycleEpoch !== lifecycleEpoch
        ) {
          throw new Error("Process lifecycle changed during reset");
        }
        if (contextEpoch) {
          host.store.epochs.deleteContextEpochOwnedMessages(contextEpoch.id);
          host.store.epochs.closeLiveContextEpoch(
            "process.reset",
            epochClosedAt,
            contextArchivePath,
          );
        }
        host.store.resetHistory();
      });
      resetInstalled = true;
    } finally {
      if (!resetInstalled && contextArchivePath) {
        await host.history.deleteFailedCompactionArchive(contextArchivePath.replace(/^\/+/, ""));
      }
    }

    await deleteProcessMedia(host.storage, identity.uid, pid);
    const result: ProcResetResult = {
      ok: true,
      pid,
      archivedMessages: archive.archivedMessages,
      archivedTo: archive.archivedTo,
      archives: archive.archives,
    };
    if (contextArchivePath) result.contextEpochArchives = [contextArchivePath];
    return result;
  } finally {
    if (!host.killed && host.lifecyclePhase === "resetting") {
      host.lifecyclePhase = "ready";
    }
  }
}

async function killProcess(
  host: Process,
  args: { pid?: string; archive?: boolean },
): Promise<ProcKillResult> {
  if (host.killed) {
    if (!host.killedTombstone) throw new Error("Process no longer exists");
    return await host.controller.completeKilledProcessCleanup();
  }
  if (host.lifecyclePhase !== "ready") {
    throw new Error(`Process lifecycle is ${host.lifecyclePhase}`);
  }
  host.lifecyclePhase = "killing";
  host.lifecycleEpoch += 1;
  try {
    const committingRunId = host.runs.active?.runId;
    if (committingRunId) await host.run.awaitRunControlCommit(committingRunId);
    const initialized = host.settings.initialized;
    const pid = host.pid;
    const identity = initialized ? host.identity : null;
    let archive = emptyProcessArchive();
    const contextEpochArchives = initialized
      ? host.store.epochs
          .listContextEpochs()
          .flatMap((epoch) => (epoch.archivePath ? [epoch.archivePath] : []))
      : [];
    let activeRun = initialized ? host.runs.active : null;
    let finishPayload = activeRun
      ? host.run.runFinishedPayload(
          activeRun,
          {
            status: "aborted",
            reason: "process.kill",
            resultText: null,
          },
          0,
        )
      : null;

    if (args.archive !== false && initialized) {
      const archived = await host.history.archiveForKill();
      archive = archived.archive;
      activeRun = archived.activeRun;
      finishPayload = archived.finishPayload;
      if (archived.contextArchivePath) contextEpochArchives.push(archived.contextArchivePath);
    }
    const result: Extract<ProcKillResult, { ok: true }> = {
      ok: true,
      pid,
      archivedMessages: archive.archivedMessages,
      archivedTo: archive.archivedTo,
      archives: archive.archives,
    };
    if (contextEpochArchives.length > 0) result.contextEpochArchives = contextEpochArchives;
    const pendingCleanup: ProcessKilledTombstone["pendingCleanup"] = ["alarm"];
    if (identity) {
      pendingCleanup.push("media");
    }
    const killedTombstone = {
      version: 1,
      pid,
      uid: identity?.uid ?? null,
      result,
      cleanup: "pending",
      pendingCleanup,
    } satisfies ProcessKilledTombstone;
    const bestEffort = postKillTasks(host, pid, activeRun, finishPayload);

    tombstoneKilledProcessStorage(host.ctx.storage, killedTombstone);
    host.killedTombstone = killedTombstone;
    host.killed = true;
    try {
      host.controller.terminateKilledExecution(
        new Error("Process execution was reset: process.kill"),
      );
    } catch {
      console.warn(`[Process] Post-kill execution cleanup failed for ${pid}`);
    }

    return await host.controller.completeKilledProcessCleanup(async () => {
      for (const task of await failedCleanupTasks(bestEffort)) {
        console.warn(`[Process] Post-kill ${task.label} failed for ${pid}`);
      }
    });
  } finally {
    if (!host.killed && host.lifecyclePhase === "killing") {
      host.lifecyclePhase = "ready";
    }
  }
}

export class ProcessController {
  constructor(private readonly host: Process) {}

  async scheduleRunOrFinish(runId: string, prefix: string): Promise<boolean> {
    try {
      await this.host.run.scheduleTick(runId);
      return true;
    } catch (error) {
      if (this.host.handleRunStopped(runId)) return false;
      const message = `${prefix}: ${errorMessageFromUnknown(error)}`;
      await this.appendRuntimeMessage(message, { runId });
      await this.host.run.finishRun(runId, {
        reason: "schedule.error",
        status: "error",
        resultText: null,
        error: message,
      });
      return false;
    }
  }

  announceRun(runId: string, reason: string): void {
    if (this.host.handleRunStopped(runId)) return;
    this.host.startBackground(
      `run announcement for ${runId}`,
      this.host.signals.announceRun(runId, reason),
    );
  }

  claimNextQueuedRun(): QueuedMessage | null {
    if (this.host.runs.active) {
      return null;
    }
    const next = this.host.store.queue.dequeue();
    if (!next) {
      return null;
    }
    this.host.store.messages.appendMessage(next.role, next.message, {
      generation: next.generation,
      runId: next.runId,
      media: next.media ?? undefined,
      origin: next.origin ?? undefined,
    });
    const run: RunState = {
      runId: next.runId,
      ...conversationRunState(next.kind, next.provenance),
    };
    if (next.kind === "ipc.call") run.returnToCaller = true;
    this.host.runs.active = run;
    return next;
  }

  async promoteNextQueuedRun(
    claimed: QueuedMessage | null = this.claimNextQueuedRun(),
  ): Promise<string | null> {
    if (!claimed || this.host.runs.active?.runId !== claimed.runId) {
      return null;
    }
    const next = claimed;
    try {
      await this.host.run.scheduleTick(next.runId);
      this.host.startBackground(
        `run announcement for ${next.runId}`,
        this.host.signals.announceRun(next.runId, "queue.promote"),
      );
    } catch (error) {
      await this.host.run.finishRun(next.runId, {
        reason: "schedule.error",
        status: "error",
        resultText: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return next.runId;
  }

  async acquireQueuedSendAdmission(): Promise<() => void> {
    const previous = this.host.queuedSendAdmission;
    let release!: () => void;
    this.host.queuedSendAdmission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  rememberAbortedRun(runId: string): void {
    const runIds = abortedRunIdsSchema.parse(
      JSON.parse(this.host.store.state.getValue(ABORTED_RUN_IDS_KEY) ?? "[]"),
    );
    if (!runIds.includes(runId)) {
      runIds.push(runId);
      this.host.store.state.setValue(
        ABORTED_RUN_IDS_KEY,
        JSON.stringify(runIds.slice(-IPC_TOMBSTONE_LIMIT)),
      );
    }
  }

  isAbortedRun(runId: string): boolean {
    const runIds = abortedRunIdsSchema.parse(
      JSON.parse(this.host.store.state.getValue(ABORTED_RUN_IDS_KEY) ?? "[]"),
    );
    return runIds.includes(runId);
  }

  async handleProcSend(
    args: Omit<ProcSendArgs, "media"> & {
      media?: Array<ResourceBlock | ProcMediaInput>;
    },
    admittedRunId?: string,
  ): Promise<ProcSendResult> {
    if (!this.host.isInitialized()) {
      return { ok: false, error: "Process no longer exists" };
    }
    const identity = this.host.identity;
    const runId = admittedRunId ?? crypto.randomUUID();
    if (admittedRunId) {
      const existing = this.existingRunAdmission(runId);
      if (existing) return existing;
    }

    let incomingMedia: ProcMediaInput[];
    try {
      incomingMedia = await this.host.resources.resolveIncomingMedia(args.media);
    } catch (error) {
      return { ok: false, error: errorMessageFromUnknown(error) };
    }
    const mediaKeys = [
      ...new Set(incomingMedia.flatMap((item) => (item.key === undefined ? [] : [item.key]))),
    ].sort();
    const origin = serializeInteractionOrigin(args.origin);
    const userCanInterrupt = args.origin?.kind !== "process" && args.origin?.kind !== "scheduler";

    return userCanInterrupt
      ? admitInterruptingSend(this.host, {
          args,
          admittedRunId,
          identity,
          incomingMedia,
          mediaKeys,
          origin,
          runId,
        })
      : admitQueuedSend(this.host, {
          args,
          admittedRunId,
          identity,
          incomingMedia,
          mediaKeys,
          origin,
          runId,
        });
  }

  existingRunAdmission(runId: string): Extract<ProcSendResult, { ok: true }> | null {
    if (this.host.runs.active?.runId === runId) {
      return { ok: true, status: "started", runId, replayed: "active" };
    }
    const located = this.host.store.queue.locateRunAdmission(runId);
    if (!located) return null;
    return {
      ok: true,
      status: "started",
      runId,
      ...(located === "queued"
        ? { queued: true, replayed: "queued" as const }
        : { replayed: "recorded" as const }),
    };
  }

  async handleProcIpcDeliver(args: ProcIpcDeliverArgs): Promise<ProcIpcDeliverResult> {
    const runId = args.runId.trim();
    if (!runId) {
      return { ok: false, error: "proc.ipc.deliver requires runId" };
    }

    const sourcePid = args.sourcePid.trim();
    if (!sourcePid) {
      return { ok: false, error: "proc.ipc.deliver requires sourcePid" };
    }

    const message = args.message.trim();
    if (!message) {
      return { ok: false, error: "proc.ipc.deliver requires message" };
    }

    const deliveredArgs: ProcIpcDeliverArgs = {
      runId,
      sourcePid,
      source: args.source,
      message,
      metadata: args.metadata,
      origin: args.origin ?? {
        kind: "process",
        sourcePid,
        uid: args.source.uid,
      },
      sentAt: Number.isFinite(args.sentAt) ? args.sentAt : Date.now(),
    };
    if (args.call) {
      deliveredArgs.call = args.call;
    }
    const renderedMessage = formatIpcMessage(deliveredArgs);
    const origin = serializeInteractionOrigin(deliveredArgs.origin);
    const releaseAdmission = await this.acquireQueuedSendAdmission();
    try {
      if (!this.host.isInitialized()) {
        return { ok: false, error: "Target process no longer exists" };
      }
      const queued = this.host.ctx.storage.transactionSync(() => {
        if (!this.host.isInitialized()) return null;
        if (this.host.runs.active) {
          const enqueueOptions: EnqueueMessageOptions = {
            origin: origin ?? undefined,
          };
          if (args.call) enqueueOptions.kind = "ipc.call";
          this.host.store.queue.enqueue(runId, renderedMessage, enqueueOptions);
          return true;
        }
        this.host.store.messages.appendMessage("user", renderedMessage, {
          runId,
          origin: origin ?? undefined,
        });
        const nextRun: RunState = { runId };
        if (args.call) {
          nextRun.returnToCaller = true;
        }
        this.host.runs.active = nextRun;
        return false;
      });
      if (queued === null) {
        return { ok: false, error: "Target process no longer exists" };
      }

      this.host.maybeStartTaskTitleGeneration(message);
      if (queued) {
        this.host.startBackground(
          `IPC queue notification for ${runId}`,
          this.host.signals.changed(["queue"], { enqueuedRunId: runId }),
        );
        return {
          ok: true,
          status: "started",
          pid: this.host.pid,
          sourcePid,
          runId,
          queued: true,
        };
      }
      await this.scheduleRunOrFinish(runId, "Failed to schedule delegated task");
      this.announceRun(runId, "proc.ipc.deliver");
      return {
        ok: true,
        status: "started",
        pid: this.host.pid,
        sourcePid,
        runId,
      };
    } finally {
      releaseAdmission();
    }
  }

  async handleProcHistory(args: ProcHistoryArgs): Promise<ProcHistoryResult> {
    const pid = this.host.pid;
    const query = historyQuery(args);
    if ("ok" in query) return query;

    const total = this.host.store.messages.messageCount();
    const records = query.includeMessages ? this.host.store.messages.getMessages(query) : [];
    const firstMessageId = records[0]?.id ?? null;
    const lastMessageId = records[records.length - 1]?.id ?? null;
    const hasMoreBefore =
      firstMessageId === null ? false : this.host.store.messages.hasMessageBefore(firstMessageId);
    const hasMoreAfter =
      lastMessageId === null ? false : this.host.store.messages.hasMessageAfter(lastMessageId);
    const activeRun = this.host.runs.active;

    const messages = records.map((record) => processHistoryMessage(this.host, record));

    return {
      ok: true,
      pid,
      messages,
      messageCount: total,
      truncated:
        query.cursorCount > 0
          ? hasMoreBefore || hasMoreAfter
          : query.offset + messages.length < total,
      hasMoreBefore,
      hasMoreAfter,
      activeRunId: activeRun?.runId ?? null,
      pendingHil: this.host.tools.toProcHilRequest(this.host.store.tools.getPendingHil()),
      context: this.host.history.getContextStateForHistory(),
      contextRevision: this.host.store.state.getContextStateRevision(),
      historyPolicy: this.host.history.getHistoryContextPolicy(),
    };
  }

  async handleProcAbort(args: ProcAbortArgs = {}): Promise<ProcAbortResult> {
    const pid = this.host.pid;
    if (this.host.killed) {
      throw new Error("Process no longer exists");
    }
    const candidate = this.host.runs.active;
    if (!candidate || (args.runId !== undefined && args.runId !== candidate.runId)) {
      return { ok: true, pid, aborted: false };
    }
    await this.host.run.awaitRunControlCommit(candidate.runId);
    const run = this.host.runs.active;
    if (!run || run.runId !== candidate.runId) {
      return { ok: true, pid, aborted: false };
    }

    const runId = run.runId;
    this.host.tools.cancelPendingRequests(runId, USER_INTERRUPTED_TOOL_MESSAGE);
    const effects = this.host.ctx.storage.transactionSync((): AbortEffects | null => {
      const active = this.host.runs.active;
      if (this.host.killed || !active || active.runId !== runId) return null;
      this.rememberAbortedRun(runId);
      const approval = this.host.store.tools.getPendingHilForRun(runId);
      const interrupted = this.host.tools.recordToolResults(
        runId,
        this.host.store.tools.getResults(runId),
        { interruptPending: USER_INTERRUPTED_TOOL_MESSAGE },
      );
      const transition = this.host.run.commitRunFinishState(active, {
        resultText: null,
        status: "aborted",
        reason: "user",
      });
      return { approval, interrupted, transition };
    });
    if (!effects) return { ok: true, pid, aborted: false };
    const { approval, interrupted: recordedTools, transition: completed } = effects;
    if (!completed || !recordedTools) {
      return { ok: true, pid, aborted: false };
    }

    if (approval) this.host.tools.resolveCodeModeApproval(approval.requestId, false);
    this.host.tools.rejectCodeModeWaiters(runId, "User interrupted CodeMode execution");
    this.host.startBackground(
      `interrupted tool notifications for ${runId}`,
      this.host.tools.completeToolResultIngestion(runId, recordedTools),
    );
    if (recordedTools.appended > 0) {
      this.host.startBackground(
        `aborted run message notification for ${runId}`,
        this.host.signals.changed(["messages"], { runId }),
      );
    }
    await this.host.run.completeRunTransition(completed);

    return {
      ok: true,
      pid,
      aborted: true,
      runId,
      interruptedToolCalls: recordedTools.interrupted,
      continuedQueuedRunId: completed.next?.runId,
    };
  }

  private rememberHilApproval(
    args: ProcHilArgs,
    pending: PendingHilRecord,
    run: RunState,
  ): boolean {
    return args.decision === "approve" && args.remember === true
      ? this.host.tools.rememberToolApproval(pending, run)
      : false;
  }

  private async rejectUnofferedHil(
    args: ProcHilArgs,
    pending: PendingHilRecord,
    toolCall: ToolCallRecord | undefined,
    ownerDispatchId: string | undefined,
    offeredToolName: string,
  ): Promise<ProcHilResult> {
    const error = `Tool "${offeredToolName}" was not offered for this generation`;
    this.host.store.tools.clearPendingHil("error");
    if (ownerDispatchId) {
      if (this.host.store.tools.getPending(ownerDispatchId)) {
        this.host.store.tools.fail(ownerDispatchId, error);
      }
      this.host.tools.resolveCodeModeApproval(args.requestId, false);
    } else if (toolCall) {
      this.host.store.tools.fail(toolCall.dispatchId, error);
    }
    const next = await this.host.tools.processToolCalls(pending.runId);
    if (!next && !this.host.handleRunStopped(pending.runId)) {
      await this.host.tools.resumeResolvedToolRun(pending.runId);
    }
    return { ok: false, error };
  }

  private async resolveCodeModeHil(
    args: ProcHilArgs,
    pending: PendingHilRecord,
    run: RunState,
    approval: CodeModeApprovalWaiter,
  ): Promise<ProcHilResult> {
    const remembered = this.rememberHilApproval(args, pending, run);
    this.host.store.tools.clearPendingHil(args.decision === "approve" ? "ok" : "denied");
    if (args.decision === "deny") {
      await this.host.tools.failStartedTool(
        pending.runId,
        pending.ownerDispatchId ?? approval.dispatchId,
        TOOL_EXECUTION_DENIED_BY_USER_MESSAGE,
        "denied",
      );
    }
    this.host.tools.resolveCodeModeApproval(args.requestId, args.decision === "approve");
    await this.host.signals.announceRun(pending.runId, "proc.hil.resume");
    return successfulHilResult(this.host.pid, args, remembered, true);
  }

  private async resolveMissingHilTool(
    args: ProcHilArgs,
    pending: PendingHilRecord,
    toolCalls: ToolCallRecord[],
  ): Promise<ProcHilResult> {
    this.host.store.tools.clearPendingHil(args.decision === "deny" ? "denied" : "error");
    const outerCodeMode = pending.ownerDispatchId
      ? toolCalls.find(
          (result) =>
            result.dispatchId === pending.ownerDispatchId &&
            result.call === CODEMODE_EXEC &&
            result.status === "pending",
        )
      : undefined;
    const error = outerCodeMode
      ? args.decision === "deny"
        ? TOOL_EXECUTION_DENIED_BY_USER_MESSAGE
        : "CodeMode execution was interrupted while waiting for tool approval"
      : `Registered tool call not found: ${pending.runId}/${pending.toolCallId}`;
    if (outerCodeMode) {
      await this.host.tools.failStartedTool(
        pending.runId,
        outerCodeMode.dispatchId,
        error,
        args.decision === "deny" ? "denied" : "failed",
      );
      await this.host.signals.announceRun(pending.runId, "proc.hil.resume");
    }
    return outerCodeMode && args.decision === "deny"
      ? successfulHilResult(this.host.pid, args, false, true)
      : { ok: false, error };
  }

  private async resolveRegisteredHilTool(
    args: ProcHilArgs,
    pending: PendingHilRecord,
    run: RunState,
    toolCall: ToolCallRecord,
  ): Promise<ProcHilResult> {
    const remembered = this.rememberHilApproval(args, pending, run);
    this.host.store.tools.clearPendingHil(args.decision === "approve" ? "ok" : "denied");
    if (args.decision === "approve") {
      const dispatchReady = await this.host.tools.beginToolDispatch(
        pending.runId,
        toolCall.dispatchId,
      );
      if (dispatchReady) {
        await this.host.signals.toolStarted({
          name: pending.toolName,
          syscall: pending.syscall,
          args: pending.args,
          callId: pending.toolCallId,
          executionId: toolCall.dispatchId,
          pid: this.host.pid,
          runId: pending.runId,
        });
      }
      if (this.host.handleRunStopped(pending.runId)) {
        return successfulHilResult(this.host.pid, args, remembered, false);
      }
      if (dispatchReady) {
        this.host.tools.launchToolDispatch(
          pending.runId,
          toolCall.dispatchId,
          pending.syscall,
          pending.args,
          this.host.tools.resolveToolApprovalPolicy(run),
        );
      }
    } else {
      this.host.store.tools.fail(
        toolCall.dispatchId,
        TOOL_EXECUTION_DENIED_BY_USER_MESSAGE,
        "denied",
      );
    }

    const next = await this.host.tools.processToolCalls(pending.runId);
    const pendingRequest = next ? this.host.tools.toProcHilRequest(next) : null;
    if (this.host.handleRunStopped(pending.runId)) {
      return successfulHilResult(this.host.pid, args, remembered, false, pendingRequest);
    }
    if (!next) {
      await this.host.tools.resumeResolvedToolRun(pending.runId);
      await this.host.signals.announceRun(pending.runId, "proc.hil.resume");
    }
    return successfulHilResult(this.host.pid, args, remembered, true, pendingRequest);
  }

  async handleProcHil(args: ProcHilArgs): Promise<ProcHilResult> {
    if (args.decision !== "approve" && args.decision !== "deny") {
      return { ok: false, error: "proc.hil requires decision=approve|deny" };
    }

    const pendingHil = this.host.store.tools.getPendingHil(args.requestId);
    if (!pendingHil) {
      return {
        ok: false,
        error: `Pending tool confirmation not found: ${args.requestId}`,
      };
    }

    const run = this.host.runs.active;
    if (!run || run.runId !== pendingHil.runId) {
      this.host.store.tools.clearPendingHil();
      this.host.tools.resolveCodeModeApproval(args.requestId, false);
      return {
        ok: false,
        error: `Run is no longer active for confirmation: ${args.requestId}`,
      };
    }

    const toolCalls = this.host.store.tools.getResults(pendingHil.runId);
    const codeModeApproval = this.host.codeModeApprovals.get(args.requestId);
    const toolCall = toolCalls.find(
      (result) => result.id === pendingHil.toolCallId && result.status === "registered",
    );
    const codeModeOwnerDispatchId = pendingHil.ownerDispatchId ?? codeModeApproval?.dispatchId;
    const offeredToolName = codeModeOwnerDispatchId
      ? SYSCALL_TOOL_NAMES[CODEMODE_EXEC]!
      : pendingHil.toolName;
    if (args.decision === "approve" && !this.host.tools.wasToolOffered(run, offeredToolName)) {
      return await this.rejectUnofferedHil(
        args,
        pendingHil,
        toolCall,
        codeModeOwnerDispatchId,
        offeredToolName,
      );
    }
    if (codeModeApproval) {
      return await this.resolveCodeModeHil(args, pendingHil, run, codeModeApproval);
    }

    if (!toolCall) {
      return await this.resolveMissingHilTool(args, pendingHil, toolCalls);
    }
    return await this.resolveRegisteredHilTool(args, pendingHil, run, toolCall);
  }

  terminateKilledExecution(reason: Error): void {
    this.host.settings.abortTitleGeneration(reason);
    this.host.resources.abortMediaUploads(reason);
    for (const controller of this.host.requestControllers.values()) {
      controller.abort(reason);
    }
    this.host.requestControllers.clear();
    for (const controller of this.host.runAbortControllers.values()) {
      controller.abort(reason);
    }
    this.host.runAbortControllers.clear();
    this.host.tools.rejectCodeModeWaiters(null, "Process execution state was reset");
    this.host.cancelledRequests.clear();
    this.host.activeTickRunIds.clear();
    this.host.deferredTickRunIds.clear();
  }

  async resetExecutionState(reason: string): Promise<void> {
    const resetError = new Error(`Process execution was reset: ${reason}`);
    this.host.settings.abortTitleGeneration(resetError);
    this.host.resources.abortMediaUploads(resetError);
    const activeRun = this.host.runs.active;
    this.host.tools.cancelPendingRequests(null, resetError.message);
    this.host.tools.rejectCodeModeWaiters(null, "Process execution state was reset");
    const effects = this.host.ctx.storage.transactionSync(() => {
      this.host.store.state.setValue(PROCESS_RESET_AT_KEY, String(Date.now()));
      const result: InterruptSendEffects = { interrupted: null, finish: null };
      if (activeRun && this.host.runs.active?.runId === activeRun.runId) {
        this.rememberAbortedRun(activeRun.runId);
        result.interrupted = this.host.tools.recordToolResults(
          activeRun.runId,
          this.host.store.tools.getResults(activeRun.runId),
          { interruptPending: resetError.message },
        );
        result.finish = this.host.run.recordRunFinish(activeRun, {
          status: "aborted",
          reason,
          resultText: null,
        });
      }
      this.host.runs.active = null;
      this.host.store.tools.clearPendingToolCalls();
      this.host.store.tools.clearPendingHil();
      this.host.store.queue.clearQueue();
      return result;
    });
    if (activeRun) this.host.streams.deleteRun(activeRun.runId);
    if (activeRun && effects.interrupted) {
      this.host.startBackground(
        `reset tool notifications for ${activeRun.runId}`,
        this.host.tools.completeToolResultIngestion(activeRun.runId, effects.interrupted),
      );
    }
    if (effects.finish) this.host.run.completeRunFinish(effects.finish);
  }

  async handleProcReset(): Promise<ProcResetResult> {
    if (this.host.resetTransition) return await this.host.resetTransition;
    if (this.host.killTransition) {
      await this.host.killTransition;
      throw new Error("Process no longer exists");
    }
    const transition = resetProcess(this.host);
    this.host.resetTransition = transition;
    try {
      return await transition;
    } finally {
      if (this.host.resetTransition === transition) this.host.resetTransition = null;
    }
  }

  async handleProcKill(args: { pid?: string; archive?: boolean }): Promise<ProcKillResult> {
    if (this.host.killed) {
      if (!this.host.killedTombstone) throw new Error("Process no longer exists");
      return await this.completeKilledProcessCleanup();
    }
    if (this.host.killTransition) return await this.host.killTransition;
    if (this.host.resetTransition) await this.host.resetTransition;
    const transition = killProcess(this.host, args);
    this.host.killTransition = transition;
    try {
      return await transition;
    } finally {
      if (this.host.killTransition === transition) this.host.killTransition = null;
    }
  }

  async completeKilledProcessCleanup(
    beforeCleanup?: () => Promise<void>,
  ): Promise<Extract<ProcKillResult, { ok: true }>> {
    if (this.host.killedCleanupTransition) {
      return await this.host.killedCleanupTransition;
    }
    const cleanup = (async () => {
      await beforeCleanup?.();
      return await this.runKilledProcessCleanup();
    })();
    this.host.killedCleanupTransition = cleanup;
    try {
      return await cleanup;
    } finally {
      if (this.host.killedCleanupTransition === cleanup) {
        this.host.killedCleanupTransition = null;
      }
    }
  }

  async runKilledProcessCleanup(): Promise<Extract<ProcKillResult, { ok: true }>> {
    const tombstone = this.host.killedTombstone;
    if (!tombstone) {
      throw new Error("Process terminal state is unavailable");
    }
    if (tombstone.cleanup === "completed") {
      return tombstone.result;
    }
    const cleanup = tombstone.pendingCleanup.map<{
      kind: ProcessKilledTombstone["pendingCleanup"][number];
      label: string;
      run: () => Promise<void>;
    }>((kind) => {
      switch (kind) {
        case "alarm":
          return {
            kind,
            label: "alarm cleanup",
            run: () => this.host.ctx.storage.deleteAlarm(),
          };
        case "media": {
          if (tombstone.uid === null) {
            throw new Error("Process media cleanup identity is unavailable");
          }
          const uid = tombstone.uid;
          return {
            kind,
            label: "media cleanup",
            run: async () => {
              await deleteProcessMedia(this.host.storage, uid, tombstone.pid);
            },
          };
        }
      }
    });
    const failed = await failedCleanupTasks(cleanup);
    const pendingCleanup = failed.map(({ kind }) => kind);
    for (const task of failed) {
      console.warn(`[Process] Post-kill ${task.label} failed for ${tombstone.pid}`);
    }
    if (pendingCleanup.length > 0) {
      const pending = {
        ...tombstone,
        cleanup: "pending",
        pendingCleanup,
      } satisfies ProcessKilledTombstone;
      this.host.ctx.storage.kv.put(PROCESS_KILLED_TOMBSTONE_KEY, pending);
      this.host.killedTombstone = pending;
      throw new Error("Process was killed but terminal cleanup is pending");
    }
    const completed = {
      ...tombstone,
      cleanup: "completed",
      pendingCleanup: [],
    } satisfies ProcessKilledTombstone;
    this.host.ctx.storage.kv.put(PROCESS_KILLED_TOMBSTONE_KEY, completed);
    this.host.killedTombstone = completed;
    return completed.result;
  }

  async appendRuntimeMessage(content: string, opts?: { runId?: string }): Promise<void> {
    const timestamp = Date.now();
    const messageId = this.host.store.messages.appendMessage("system", content, {
      runId: opts?.runId,
      createdAt: timestamp,
    });
    const change: JsonObject = {
      messageId,
      role: "system",
      content,
      timestamp,
    };
    if (opts?.runId) {
      change.runId = opts.runId;
    }
    await this.host.signals.changed(["messages"], change);
  }

  async handleIpcSignal(signal: string, payload: IpcReplyPayload): Promise<void> {
    const content = formatIpcReplyMessage(signal, payload);
    const callId = normalizeOptionalString(payload.callId);
    const sourceRunId = normalizeOptionalString(payload.sourceRunId);
    const createdAt = payload.createdAt ?? null;
    const handledId =
      signal === "ipc.overdue" && callId
        ? `overdue:${callId}:${payload.checkInCount ?? payload.deadlineAt ?? "unknown"}`
        : callId;
    const timestamp = Date.now();
    if (this.host.killed || this.host.lifecyclePhase !== "ready") {
      return;
    }
    const pid = this.host.pid;
    if (!this.host.store.state.getValue("identity")) {
      return;
    }
    const resetAt = Number(this.host.store.state.getValue(PROCESS_RESET_AT_KEY) ?? 0);
    const handled = abortedRunIdsSchema.parse(
      JSON.parse(this.host.store.state.getValue(HANDLED_IPC_CALLS_KEY) ?? "[]"),
    );
    if (
      (handledId && handled.includes(handledId)) ||
      (sourceRunId && this.isAbortedRun(sourceRunId)) ||
      (createdAt !== null && createdAt <= resetAt)
    ) {
      return;
    }

    const currentRun = this.host.runs.active;
    const nextRunId = currentRun ? null : crypto.randomUUID();
    const { messageId, wakeRunId } = this.host.ctx.storage.transactionSync(() => {
      if (handledId) {
        handled.push(handledId);
        this.host.store.state.setValue(
          HANDLED_IPC_CALLS_KEY,
          JSON.stringify(handled.slice(-IPC_TOMBSTONE_LIMIT)),
        );
      }
      const messageOptions: Parameters<ProcessStore["messages"]["appendMessage"]>[2] = {
        createdAt: timestamp,
      };
      if (nextRunId) {
        messageOptions.runId = nextRunId;
      }
      const messageId = this.host.store.messages.appendMessage("system", content, messageOptions);

      let wakeRunId: string | null = null;
      if (!currentRun) {
        if (!nextRunId) {
          throw new Error("Runtime event run id was not allocated");
        }
        this.host.runs.active = { runId: nextRunId };
      } else if (sourceRunId && sourceRunId !== currentRun.runId) {
        wakeRunId = crypto.randomUUID();
        this.host.store.queue.enqueue(wakeRunId, RUNTIME_EVENT_WAKE_MESSAGE, {
          role: "system",
          kind: "runtime.wake",
          provenance: JSON.stringify({
            source: "process",
            eventType: "runtime.wake",
          }),
        });
      } else {
        currentRun.pendingRuntimeEvents = (currentRun.pendingRuntimeEvents ?? 0) + 1;
        this.host.runs.active = currentRun;
      }
      return { messageId, wakeRunId };
    });

    this.host.startBackground(
      `IPC message notification for ${pid}`,
      this.host.signals.changed(["messages"], {
        messageId,
        role: "system",
        content,
        timestamp,
      }),
    );
    if (wakeRunId) {
      this.host.startBackground(
        `IPC queue notification for ${pid}`,
        this.host.signals.changed(["queue"], { enqueuedRunId: wakeRunId }),
      );
    } else if (nextRunId) {
      const scheduled = await this.scheduleRunOrFinish(
        nextRunId,
        "Failed to schedule delegated task",
      );
      if (scheduled) this.announceRun(nextRunId, "delegated-task");
    }
  }

  async handleProcessRuntimeEventDeliver(
    args: ProcessRuntimeEventDeliverArgs,
  ): Promise<ProcessRuntimeEventDeliverResult> {
    const event = normalizeProcessRuntimeEvent(args?.event);
    const eventId = normalizeOptionalString(args?.eventId);
    if (!eventId || !/^[a-zA-Z0-9._:-]{1,200}$/.test(eventId)) {
      throw new Error("Runtime event id is invalid");
    }
    const runId = eventId;
    const admission =
      event.type === "r12y.ready"
        ? await this.handleRuntimeEvent(null, event.type, {
            runId,
            kind: event.type,
            dedupeId: eventId,
            provenance: JSON.stringify({
              source: "kernel",
              eventId,
              eventType: event.type,
              batchId: event.batchId,
              ledgerRevision: event.ledgerRevision,
            }),
            responsibilityBatch: {
              batchId: event.batchId,
              ledgerRevision: event.ledgerRevision,
              responsibilityIds: event.responsibilityIds,
            },
          })
        : await this.handleRuntimeEvent(formatProcessRuntimeEvent(event), event.type, {
            distinctRun: true,
            runId,
          });
    if (!admission.ok) {
      throw new Error(admission.error);
    }
    return {
      eventId,
      runId: admission.runId,
      queued: admission.queued,
    };
  }

  async handleProcScheduleDeliver(
    args: ProcessScheduleDeliverArgs,
  ): Promise<{ runId: string; queued: boolean }> {
    const origin: InteractionOrigin = {
      kind: "scheduler",
      scheduleId: args.scheduleId,
    };
    if (args.replyTo) {
      origin.replyTo = args.replyTo;
    }
    const admission = await this.handleRuntimeEvent(
      formatScheduleEventMessage(args),
      "schedule.event",
      {
        origin,
        distinctRun: args.replyTo !== undefined,
        runId: args.runId,
        kind: "schedule.event",
        provenance: JSON.stringify({
          source: "kernel",
          eventId: args.runId,
          eventType: "schedule.event",
        }),
      },
    );
    if (!admission.ok) {
      throw new Error(admission.error);
    }
    this.host.maybeStartTaskTitleGeneration(args.message);
    return { runId: admission.runId, queued: admission.queued };
  }

  async handleRuntimeEvent(
    content: string | null,
    reason: string,
    options: {
      origin?: InteractionOrigin;
      distinctRun?: boolean;
      runId?: string;
      kind?: string;
      provenance?: string;
      dedupeId?: string;
      responsibilityBatch?: ResponsibilityBatchState;
    } = {},
  ): Promise<RuntimeEventAdmission> {
    if (!this.host.isInitialized()) {
      return { ok: false, error: "Process no longer exists" };
    }
    if (options.dedupeId) {
      const existing = this.runtimeEventAdmission(options.dedupeId);
      if (existing) return existing;
    }
    if (options.runId) {
      const existing = this.existingRunAdmission(options.runId);
      if (existing) {
        return {
          ok: true,
          runId: options.runId,
          queued: existing.queued === true,
        };
      }
    }
    const timestamp = Date.now();
    const currentRun = this.host.runs.active;
    const nextRunId = currentRun ? null : (options.runId ?? crypto.randomUUID());
    const { messageId, wakeRunId } = this.host.ctx.storage.transactionSync(() => {
      if (currentRun && options.distinctRun) {
        if (content === null) {
          throw new Error("A distinct runtime event requires model-visible content");
        }
        const wakeRunId = options.runId ?? crypto.randomUUID();
        this.host.store.queue.enqueue(wakeRunId, content, {
          role: "system",
          kind: options.kind ?? "runtime.event",
          origin: serializeInteractionOrigin(options.origin) ?? undefined,
          provenance: options.provenance,
        });
        return { messageId: -1, wakeRunId };
      }
      let messageId = -1;
      if (content !== null) {
        const messageOptions: Parameters<ProcessStore["messages"]["appendMessage"]>[2] = {
          createdAt: timestamp,
        };
        if (nextRunId) {
          messageOptions.runId = nextRunId;
        }
        if (options.origin) {
          messageOptions.origin = serializeInteractionOrigin(options.origin) ?? undefined;
        }
        messageId = this.host.store.messages.appendMessage("system", content, messageOptions);
      }
      if (!currentRun) {
        if (!nextRunId) {
          throw new Error("Runtime event run id was not allocated");
        }
        const nextRun: RunState = { runId: nextRunId };
        if (options.responsibilityBatch) {
          nextRun.responsibilityBatches = [options.responsibilityBatch];
        }
        this.host.runs.active = nextRun;
      } else {
        currentRun.pendingRuntimeEvents = (currentRun.pendingRuntimeEvents ?? 0) + 1;
        if (options.responsibilityBatch) {
          appendResponsibilityBatch(currentRun, options.responsibilityBatch);
        }
        this.host.runs.active = currentRun;
      }
      if (options.dedupeId) {
        const admittedRunId = nextRunId ?? currentRun?.runId;
        if (!admittedRunId) throw new Error("Runtime event receipt has no run id");
        this.recordRuntimeEventAdmission(options.dedupeId, admittedRunId);
      }
      return { messageId, wakeRunId: null };
    });

    if (messageId >= 0 && content !== null) {
      this.host.startBackground(
        `runtime event message notification for ${nextRunId ?? wakeRunId ?? "active run"}`,
        this.host.signals.changed(["messages"], {
          messageId,
          role: "system",
          content,
          timestamp,
        }),
      );
    }
    if (wakeRunId) {
      this.host.startBackground(
        `runtime event queue notification for ${wakeRunId}`,
        this.host.signals.changed(["queue"], { enqueuedRunId: wakeRunId }),
      );
    } else if (nextRunId) {
      const scheduled = await this.scheduleRunOrFinish(
        nextRunId,
        "Failed to schedule runtime event",
      );
      if (scheduled) this.announceRun(nextRunId, reason);
    }
    const admittedRunId =
      nextRunId ?? wakeRunId ?? (this.host.killed ? null : this.host.runs.active?.runId);
    if (!admittedRunId) {
      return { ok: false, error: "runtime event was not assigned to a run" };
    }
    return {
      ok: true,
      runId: admittedRunId,
      queued: wakeRunId !== null,
    };
  }

  runtimeEventAdmission(eventId: string): Extract<RuntimeEventAdmission, { ok: true }> | null {
    const runId = this.host.store.state.getValue(`runtimeEvent:${eventId}`);
    if (!runId) return null;
    const located = this.host.store.queue.locateRunAdmission(runId);
    return {
      ok: true,
      runId,
      queued: located === "queued",
    };
  }

  recordRuntimeEventAdmission(eventId: string, runId: string): void {
    const ids = parseStoredStringArray(this.host.store.state.getValue(RUNTIME_EVENT_IDS_KEY));
    if (!ids.includes(eventId)) ids.push(eventId);
    const expired = ids.splice(0, Math.max(0, ids.length - RUNTIME_EVENT_TOMBSTONE_LIMIT));
    for (const expiredId of expired) {
      this.host.store.state.deleteValue(`runtimeEvent:${expiredId}`);
    }
    this.host.store.state.setValue(`runtimeEvent:${eventId}`, runId);
    this.host.store.state.setValue(RUNTIME_EVENT_IDS_KEY, JSON.stringify(ids));
  }

  private async handleKilledFrame(frame: ProcessInboundFrame) {
    if (frame.type === "res") {
      await cancelResponseBody(frame, "Process no longer exists");
      return null;
    }
    if (frame.type !== "req") return null;
    await frame.body?.stream.cancel("Process no longer exists").catch(() => {});
    if (frame.call !== "proc.kill" || !this.host.killedTombstone) {
      return errorResponse(frame.id, 410, "Process no longer exists");
    }
    try {
      const data = await this.completeKilledProcessCleanup();
      return { type: "res", id: frame.id, ok: true, data } satisfies ResponseOkFrame;
    } catch (error) {
      return errorResponse(frame.id, 500, errorMessageFromUnknown(error));
    }
  }

  private async handleTransitioningFrame(frame: ProcessInboundFrame) {
    if (
      frame.type === "req" &&
      (frame.call === "proc.kill" || frame.call === "proc.reset" || frame.call === "proc.abort")
    ) {
      return await this.handleReq(frame);
    }
    if (frame.type === "sig" && frame.signal === REQUEST_CANCEL_SIGNAL) {
      await this.handleSig(frame);
      return null;
    }
    if (frame.type === "sig" && frame.signal === "identity.changed") {
      while (!this.host.killed && this.host.lifecyclePhase !== "ready") {
        const transition =
          this.host.lifecyclePhase === "resetting"
            ? this.host.resetTransition
            : this.host.killTransition;
        if (!transition) {
          throw new Error(`Process lifecycle ${this.host.lifecyclePhase} has no active transition`);
        }
        await transition.catch(() => undefined);
      }
      if (!this.host.killed && this.host.lifecyclePhase === "ready") {
        await this.handleSig(frame);
      }
      return null;
    }
    if (frame.type === "req") {
      await frame.body?.stream.cancel("Process lifecycle transition in progress").catch(() => {});
      return errorResponse(frame.id, 409, `Process lifecycle is ${this.host.lifecyclePhase}`);
    }
    if (frame.type === "res") {
      await cancelResponseBody(frame, "Process lifecycle transition in progress");
    }
    return null;
  }

  async recvFrame(frame: ProcessInboundFrame) {
    if (this.host.killed) return await this.handleKilledFrame(frame);
    if (this.host.lifecyclePhase !== "ready") return await this.handleTransitioningFrame(frame);
    if (frame.type === "req") return await this.handleReq(frame);
    if (frame.type === "res") await this.handleRes(frame);
    else await this.handleSig(frame);
    return null;
  }

  async handleRes(frame: ResponseFrame): Promise<void> {
    const codeModeWaiter = this.host.codeModeResponses.get(frame.id);
    if (codeModeWaiter) {
      this.host.codeModeResponses.delete(frame.id);
      clearTimeout(codeModeWaiter.timeoutId);
      if (frame.ok) {
        this.host.tools.rememberShellSessionTargetFromResult(
          codeModeWaiter.call,
          codeModeWaiter.args,
          frame.data ?? null,
        );
      }
      codeModeWaiter.resolve(frame);
      return;
    }

    const pending = this.host.store.tools.getPending(frame.id);
    if (!pending) {
      await cancelResponseBody(frame, "Response is no longer pending");
      return;
    }

    if (frame.ok) {
      try {
        const result = await materializeToolResponse(
          pending.call,
          frame.data ?? null,
          frame.body,
          this.host.run.runAbortSignal(pending.runId),
          { maxTextBytes: AGENT_READ_MAX_BYTES },
        );
        if (this.host.killed || !this.host.store.tools.getPending(frame.id)) {
          return;
        }
        this.host.tools.rememberShellSessionTargetFromResult(pending.call, pending.args, result);
        await this.host.tools.resolveStartedTool(
          pending.runId,
          frame.id,
          formatAgentToolResponse(pending.call, pending.args, result),
        );
      } catch (error) {
        if (this.host.killed) {
          return;
        }
        await this.host.tools.failStartedTool(
          pending.runId,
          frame.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      await this.host.tools.failStartedTool(pending.runId, frame.id, frame.error.message);
    }
  }

  private async handleHistoryOrLifecycleRequest(frame: ProcessRequestFrame) {
    let data: ResultOf<SyscallName>;
    switch (frame.call) {
      case "proc.history.policy.get":
        data = this.host.history.handleHistoryPolicyGet(frame.args);
        break;
      case "proc.history.policy.set":
        data = await this.host.history.handleHistoryPolicySet(frame.args);
        break;
      case "proc.history.compact":
        data = await this.handleCancellableRequest(frame.id, (signal) =>
          this.host.history.handleHistoryCompact(frame.args, { signal }),
        );
        break;
      case "proc.history.export":
        data = await this.handleCancellableRequest(frame.id, (signal) =>
          this.host.history.handleHistoryExport(frame.args, signal),
        );
        break;
      case "proc.history.import":
        data = await this.handleCancellableRequest(frame.id, (signal) =>
          this.host.history.handleHistoryImport(frame.args, signal),
        );
        break;
      case "proc.history.segment.read":
        data = await this.host.history.handleHistorySegmentRead(frame.args);
        break;
      case "proc.history.segments":
        data = this.host.history.handleHistorySegments(frame.args);
        break;
      case "proc.reset":
        data = await this.handleProcReset();
        break;
      case "proc.kill":
        data = await this.handleProcKill(frame.args);
        break;
      default:
        return errorResponse(frame.id, 400, `Unknown process command: ${frame.call}`);
    }
    return { type: "res" as const, id: frame.id, ok: true as const, data };
  }

  async handleReq(
    frame: ProcessRequestFrame,
  ): Promise<
    | ResponseFrame
    | ProcessRuntimeEventDeliverResponseFrame
    | ProcessScheduleDeliverResponseFrame
    | ProcessAdapterDeliverResponseFrame
    | ProcessResourcesRetainResponseFrame
    | ProcessResourceResponseFrame
    | null
  > {
    try {
      if (frame.call === "proc.runtime.event.deliver") {
        const result = await this.handleProcessRuntimeEventDeliver(frame.args);
        return { type: "res", id: frame.id, ok: true, data: result };
      }
      if (frame.call === "proc.adapter.deliver") {
        const { runId, ...args } = frame.args;
        const result = await this.handleProcSend(args, runId);
        return { type: "res", id: frame.id, ok: true, data: result };
      }
      if (frame.call === "proc.schedule.deliver") {
        const result = await this.handleProcScheduleDeliver(frame.args);
        return { type: "res", id: frame.id, ok: true, data: result };
      }
      if (frame.call === "proc.resources.retain") {
        const resources = await this.handleCancellableRequest(frame.id, (signal) =>
          this.host.resources.handleProcessResourcesRetain(frame, signal),
        );
        return { type: "res", id: frame.id, ok: true, data: { resources } };
      }
      if (frame.call === "proc.resource.write") {
        const resource = await this.host.resources.handleProcessResourceWrite(frame);
        return { type: "res", id: frame.id, ok: true, data: { resource } };
      }
      let data: ResultOf<SyscallName>;

      switch (frame.call) {
        case "proc.setidentity": {
          data = this.host.settings.initialize(frame.args);
          break;
        }
        case "proc.send":
          data = await this.handleProcSend(
            frame.args,
            frame.args.interaction ? `run:${frame.args.interaction.messageId}` : undefined,
          );
          break;
        case "proc.ipc.deliver":
          data = await this.handleProcIpcDeliver(frame.args);
          break;
        case "proc.abort":
          data = await this.handleProcAbort(frame.args);
          break;
        case "proc.hil":
          data = await this.handleProcHil(frame.args);
          break;
        case "codemode.run":
          data = await this.handleCancellableRequest(frame.id, (signal) =>
            this.host.tools.handleCodeModeRun(frame.args, signal, frame.id),
          );
          break;
        case "proc.history":
          data = await this.handleProcHistory(frame.args);
          break;
        case "proc.trace":
          data = this.host.trace.list(frame.args);
          break;
        case "proc.ai.config.get":
          data = this.host.settings.getAiConfig(frame.args);
          break;
        case "proc.ai.config.set":
          data = await this.host.settings.setAiConfig(frame.args);
          break;
        case "proc.run.attach":
          data = await this.host.resources.handleProcRunAttach(frame.args);
          break;
        default:
          return await this.handleHistoryOrLifecycleRequest(frame);
      }

      return { type: "res", id: frame.id, ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(frame.id, requestErrorCode(this.host.killed, frame.call), message);
    }
  }

  async handleSig(frame: SignalFrame): Promise<void> {
    const watchedSignal = watchedSignalPayloadSchema.safeParse(frame.payload);
    if (watchedSignal.success) {
      await this.handleRuntimeEvent(
        formatWatchedSignalMessage(frame.signal, watchedSignal.data),
        "signal.watch",
      );
      return;
    }

    switch (frame.signal) {
      case REQUEST_CANCEL_SIGNAL: {
        const parsed = cancelRequestPayloadSchema.safeParse(frame.payload);
        if (parsed.success) this.cancelRequest(parsed.data);
        break;
      }
      case "identity.changed": {
        const parsed = identityChangedPayloadSchema.safeParse(frame.payload);
        if (parsed.success) {
          this.host.store.state.setValue("identity", JSON.stringify(parsed.data.identity));
        }
        break;
      }
      case "ipc.reply":
      case "ipc.overdue":
      case "ipc.timeout": {
        const parsed = ipcReplyPayloadSchema.safeParse(frame.payload);
        await this.handleIpcSignal(frame.signal, parsed.success ? parsed.data : {});
        break;
      }
      case "proc.delivery.notice": {
        const parsed = deliveryNoticePayloadSchema.safeParse(frame.payload);
        if (parsed.success) {
          const { message, noticeId, runId } = parsed.data;
          const noticeKey = `deliveryNotice:${noticeId}`;
          const messageId = this.host.ctx.storage.transactionSync(() => {
            if (this.host.store.state.getValue(noticeKey)) return null;
            const id = this.host.store.messages.appendMessage("system", message, {
              runId,
            });
            this.host.store.state.setValue(noticeKey, String(id));
            const noticeIds = abortedRunIdsSchema.parse(
              JSON.parse(this.host.store.state.getValue(DELIVERY_NOTICE_IDS_KEY) ?? "[]"),
            );
            noticeIds.push(noticeId);
            const expired = noticeIds.splice(
              0,
              Math.max(0, noticeIds.length - DELIVERY_NOTICE_TOMBSTONE_LIMIT),
            );
            for (const expiredId of expired) {
              this.host.store.state.deleteValue(`deliveryNotice:${expiredId}`);
            }
            this.host.store.state.setValue(DELIVERY_NOTICE_IDS_KEY, JSON.stringify(noticeIds));
            return id;
          });
          if (messageId !== null) {
            const change: JsonObject = {
              messageId,
            };
            if (runId) {
              change.runId = runId;
            }
            await this.host.signals.changed(["messages"], change);
          }
        }
        break;
      }
      default:
        console.log(`[Process] Unknown signal: ${frame.signal}`);
        break;
    }
  }

  async handleCancellableRequest<T>(
    requestId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const cancelled = this.host.cancelledRequests.get(requestId);
    this.host.cancelledRequests.delete(requestId);
    if (cancelled) {
      controller.abort(new Error(cancelled));
    }
    this.host.requestControllers.set(requestId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.host.requestControllers.get(requestId) === controller) {
        this.host.requestControllers.delete(requestId);
      }
    }
  }

  cancelRequest(payload: CancelRequestPayload): void {
    const requestId = payload.id;
    const reason = payload.reason?.trim() ? payload.reason.trim() : "Request cancelled";
    const controller = this.host.requestControllers.get(requestId);
    if (controller) {
      controller.abort(new Error(reason));
      return;
    }
    if (this.host.cancelledRequests.size >= MAX_CANCELLED_REQUESTS) {
      const oldest = this.host.cancelledRequests.keys().next().value;
      if (oldest) {
        this.host.cancelledRequests.delete(oldest);
      }
    }
    this.host.cancelledRequests.set(requestId, reason);
  }
}
