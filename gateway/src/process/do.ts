/**
 * Process DO — the "smart process" that runs an agent loop.
 *
 * All mutable state (messages, tool calls, metadata) is managed by
 * ProcessStore (SQLite-backed). Communicates with the kernel
 * exclusively via recvFrame RPC in both directions.
 *
 * Agent loop: user message → LLM call → tool dispatch → collect results →
 * LLM call → ... → final text → chat.complete signal.
 * Each "turn" is scheduled via this.schedule() to avoid subrequest limits.
 */

import { Agent as Host } from "agents";
import type {
  Frame,
  RequestFrame,
  ResponseFrame,
  ResponseErrFrame,
  SignalFrame,
} from "../protocol/frames";
import type { ResultOf, SyscallName, ToolDefinition } from "../syscalls";
import type { CodeModeExecArgs, CodeModeRunArgs, CodeModeRunResult } from "../syscalls/codemode";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type {
  AiConfigResult,
  AiContextProfile,
  AiToolsDevice,
} from "../syscalls/ai";
import { isAiContextProfile } from "../syscalls/ai";
import type {
  ProcSendArgs,
  ProcSendResult,
  ProcIpcDeliverArgs,
  ProcIpcDeliverResult,
  ProcAbortResult,
  ProcHilArgs,
  ProcHilResult,
  ProcHilRequest,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcHistoryMessage,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcConversation,
  ProcConversationOpenArgs,
  ProcConversationOpenResult,
  ProcConversationListArgs,
  ProcConversationListResult,
  ProcConversationGetArgs,
  ProcConversationGetResult,
  ProcConversationCloseArgs,
  ProcConversationCloseResult,
  ProcConversationResetArgs,
  ProcConversationResetResult,
  ProcConversationContextPolicy,
  ProcConversationPolicyGetArgs,
  ProcConversationPolicyGetResult,
  ProcConversationPolicySetArgs,
  ProcConversationPolicySetResult,
  ProcConversationOverflowPolicy,
  ProcConversationCompactArgs,
  ProcConversationCompactResult,
  ProcConversationForkArgs,
  ProcConversationForkResult,
  ProcConversationSegment,
  ProcConversationSegmentReadArgs,
  ProcConversationSegmentReadResult,
  ProcConversationSegmentsArgs,
  ProcConversationSegmentsResult,
  ProcArchiveEntry,
  ProcContextState,
  ProcResetResult,
  ProcKillResult,
  ProcSpawnAssignment,
} from "../syscalls/proc";
import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  Context,
  Tool,
  UserMessage,
  ImageContent,
} from "@mariozechner/pi-ai";
import { createGenerationService } from "../inference/service";
import {
  buildCheckpointCommitMessageContext,
  buildCheckpointSummaryContext,
  buildCheckpointTranscript,
  normalizeCheckpointCommitMessage,
  normalizeCheckpointSummary,
} from "./checkpoint";
import {
  ProcessStore,
  parseAssistantMessageMeta,
  stringifyAssistantMessageMeta,
  type MessageRole,
  type MessageRecord,
  type PendingHilRecord,
} from "./store";
import {
  buildToolApprovalFacts,
  parseToolApprovalPolicy,
  resolveToolApproval,
  type ToolApprovalRule,
  type ToolApprovalPolicy,
} from "./approval";
import {
  buildFallbackMediaBlocks,
  buildImageBlock,
  deleteProcessMedia,
  describeStoredProcessMedia,
  parseStoredProcessMedia,
  processMediaPrefix,
  storeIncomingProcessMedia,
} from "./media";
import {
  buildProcContextState,
  estimateContextInputTokens,
} from "./context-pressure";
import { assembleSystemPrompt } from "./context";
import { sendFrameToKernel } from "../shared/utils";
import {
  CODEMODE_EXEC,
  TOOL_TO_SYSCALL,
  SYSCALL_TOOL_NAMES,
} from "../syscalls/constants";
import { RipgitClient } from "../fs/ripgit/client";
import { workspaceRepoRef } from "../fs/ripgit/repos";
import {
  buildCodeModeMcpToolBindings,
  executeCodeMode,
} from "./codemode";
import {
  DEFAULT_CONVERSATION_ID,
  normalizeConversationId,
  type ProcessConversationRecord,
  type ProcessConversationSegmentRecord,
} from "./conversations";

type RunState = {
  runId: string;
  queued: boolean;
  conversationId: string;
  config?: AiConfigResult;
  tools?: ToolDefinition[];
  devices?: AiToolsDevice[];
  mcpServers?: string[];
  systemPrompt?: string;
  approvalPolicy?: ToolApprovalPolicy;
};

type ActiveRunPhase = "toolDispatch" | "toolResults" | "generation";

type CodeModeResponseWaiter = {
  runId: string | null;
  resolve: (frame: ResponseFrame) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type CodeModeApprovalWaiter = {
  runId: string;
  resolve: (approved: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type ProcessArchiveResult = {
  archivedMessages: number;
  archivedTo?: string;
  archives: ProcArchiveEntry[];
};

type ArchivedMessageRecord = {
  id?: number;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  thinking?: ThinkingContent[];
  toolCallId?: string;
  media?: unknown;
  createdAt?: number;
};

const CHECKPOINTED_MESSAGE_COUNT_KEY = "checkpointedMessageCount";
const TOOL_APPROVAL_OVERRIDES_KEY = "toolApprovalOverrides";
const TEXT_ENCODER = new TextEncoder();
const PROCESS_MEDIA_CACHE_LIMIT = 32;
const MAX_PROCESS_MEDIA_READ_BYTES = 25 * 1024 * 1024;
const CODE_MODE_NESTED_SYSCALL_TIMEOUT_MS = 55_000;
const CODE_MODE_APPROVAL_TIMEOUT_MS = 55_000;
const COMPACTION_SUMMARY_WINDOW_CHARS = 24_000;

function isNonInteractiveProfile(profile: AiContextProfile): boolean {
  return profile === "cron";
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeRequiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item))
    : [];
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const identity = value as Partial<ProcessIdentity>;
  return typeof identity.uid === "number"
    && typeof identity.gid === "number"
    && Array.isArray(identity.gids)
    && typeof identity.username === "string"
    && typeof identity.home === "string"
    && typeof identity.cwd === "string"
    && (identity.workspaceId === null || typeof identity.workspaceId === "string");
}

function isIpcCallEnvelope(value: unknown): value is NonNullable<ProcIpcDeliverArgs["call"]> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const call = value as Partial<NonNullable<ProcIpcDeliverArgs["call"]>>;
  return typeof call.callId === "string"
    && call.callId.trim().length > 0
    && typeof call.replyToPid === "string"
    && call.replyToPid.trim().length > 0
    && typeof call.deadlineAt === "number"
    && Number.isFinite(call.deadlineAt);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isConversationOverflowPolicy(value: unknown): value is ProcConversationOverflowPolicy {
  return value === "manual" || value === "auto-compact" || value === "fail";
}

function isWatchedSignalPayload(
  value: unknown,
): value is {
  watched: true;
  sourcePid?: unknown;
  watch?: unknown;
  payload?: unknown;
} {
  return !!value && typeof value === "object" && (value as { watched?: unknown }).watched === true;
}

function isScheduleEventPayload(
  value: unknown,
): value is {
  scheduleId?: unknown;
  scheduleName?: unknown;
  conversationId?: unknown;
  message?: unknown;
  data?: unknown;
  scheduledAtMs?: unknown;
  firedAtMs?: unknown;
} {
  return !!value && typeof value === "object";
}

function formatScheduleEventMessage(payload: unknown): string {
  const value = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const scheduleId = typeof value.scheduleId === "string" && value.scheduleId.trim().length > 0
    ? value.scheduleId.trim()
    : null;
  const scheduleName = typeof value.scheduleName === "string" && value.scheduleName.trim().length > 0
    ? value.scheduleName.trim()
    : null;
  const message = typeof value.message === "string" && value.message.trim().length > 0
    ? value.message.trim()
    : "Scheduled event fired.";
  const scheduledAtMs = typeof value.scheduledAtMs === "number" && Number.isFinite(value.scheduledAtMs)
    ? value.scheduledAtMs
    : null;
  const firedAtMs = typeof value.firedAtMs === "number" && Number.isFinite(value.firedAtMs)
    ? value.firedAtMs
    : Date.now();

  const lines = [
    scheduleName
      ? `Scheduled event \`${scheduleName}\` fired.`
      : "Scheduled event fired.",
  ];
  if (scheduleId) {
    lines.push(`Schedule id: \`${scheduleId}\`.`);
  }
  if (scheduledAtMs !== null) {
    lines.push(`Scheduled at: ${new Date(scheduledAtMs).toISOString()}.`);
  }
  lines.push(`Fired at: ${new Date(firedAtMs).toISOString()}.`, "", message);

  const renderedData = renderJsonBlock(value.data);
  if (renderedData) {
    lines.push("", "Event data:", "```json", renderedData, "```");
  }
  return lines.join("\n");
}

function formatWatchedSignalMessage(signal: string, payload: unknown): string {
  const value = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const sourcePid = typeof value.sourcePid === "string" && value.sourcePid.trim().length > 0
    ? value.sourcePid.trim()
    : null;
  const watch = value.watch && typeof value.watch === "object"
    ? value.watch as Record<string, unknown>
    : null;
  const key = watch && typeof watch.key === "string" && watch.key.trim().length > 0
    ? watch.key.trim()
    : null;
  const watchState = watch && "state" in watch ? watch.state : undefined;
  const renderedState = renderJsonBlock(watchState);
  const renderedPayload = renderJsonBlock(value.payload);

  const lines = [
    `Observed watched signal \`${signal}\`${sourcePid ? ` from process \`${sourcePid}\`` : ""}.`,
  ];
  if (key) {
    lines.push(`Watch key: \`${key}\`.`);
  }
  if (renderedState) {
    lines.push("", "Watch state:", "```json", renderedState, "```");
  }
  if (renderedPayload) {
    lines.push("", "Signal payload:", "```json", renderedPayload, "```");
  }
  return lines.join("\n");
}

function formatIpcMessage(args: ProcIpcDeliverArgs): string {
  const sentAt = Number.isFinite(args.sentAt)
    ? new Date(args.sentAt).toISOString()
    : new Date().toISOString();
  const source = `${args.source.username} uid=${args.source.uid}`;
  const lines = [
    `Message from process \`${args.sourcePid}\` (${source}).`,
    `Sent at: ${sentAt}.`,
    "",
    args.message,
  ];
  const renderedMetadata = renderJsonBlock(args.metadata);
  if (renderedMetadata) {
    lines.push("", "Metadata:", "```json", renderedMetadata, "```");
  }
  if (args.call) {
    lines.push(
      "",
      "IPC call:",
      `Call id: \`${args.call.callId}\``,
      `Deadline: ${new Date(args.call.deadlineAt).toISOString()}`,
      `Reply target: process \`${args.call.replyToPid}\``,
      "",
      "Complete this run before the deadline. The kernel will deliver the final response to the caller.",
    );
  }
  return lines.join("\n");
}

function formatIpcReplyMessage(signal: string, payload: unknown): string {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const callId = typeof record.callId === "string" ? record.callId : "unknown";
  const targetPid = typeof record.targetPid === "string" ? record.targetPid : "unknown";
  const runId = typeof record.runId === "string" ? record.runId : null;
  const error = typeof record.error === "string" && record.error.trim().length > 0
    ? record.error.trim()
    : null;
  const response = "response" in record ? record.response : undefined;
  const renderedResponse = renderJsonBlock(response);

  const lines = [
    signal === "ipc.timeout"
      ? `IPC call \`${callId}\` to process \`${targetPid}\` timed out.`
      : `IPC call \`${callId}\` completed from process \`${targetPid}\`.`,
  ];
  if (runId) {
    lines.push(`Run id: \`${runId}\`.`);
  }
  if (error) {
    lines.push("", "Error:", error);
  }
  if (renderedResponse) {
    lines.push("", "Response:", "```json", renderedResponse, "```");
  }
  return lines.join("\n");
}

function renderJsonBlock(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify(String(value));
  }
}

function emptyProcessArchive(): ProcessArchiveResult {
  return {
    archivedMessages: 0,
    archives: [],
  };
}

function conversationArchiveFilename(conversationId: string, generation: number): string {
  return `${encodeURIComponent(conversationId)}.gen-${generation}.jsonl.gz`;
}

function formatCompactionSummaryMessage(input: {
  archivedMessages: number;
  archivePath: string;
  summary: string;
}): string {
  return [
    "Conversation compacted.",
    "",
    `Archived messages: ${input.archivedMessages}`,
    `Archive: ${input.archivePath}`,
    "",
    "Summary:",
    input.summary,
  ].join("\n");
}

function conversationPolicyKey(conversationId: string): string {
  return `conversationPolicy:${normalizeConversationId(conversationId)}`;
}

function defaultConversationPolicy(conversationId: string): ProcConversationContextPolicy {
  return {
    conversationId: normalizeConversationId(conversationId),
    overflow: "manual",
    compactAtPressure: 0.9,
    keepLast: 80,
    updatedAt: 0,
  };
}

function buildCompactionSummaryContext(messages: MessageRecord[]): Context {
  const transcript = renderCompactionTranscriptWindow(messages, COMPACTION_SUMMARY_WINDOW_CHARS);
  return {
    systemPrompt: [
      "Summarize a compacted GSV process conversation segment.",
      "Return concise markdown only.",
      "Preserve facts needed to continue the conversation: user goals, decisions, constraints, tool results, process events, files, ids, and unresolved next steps.",
      "Do not mention that you are an AI or that you summarized the transcript.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          "Conversation segment JSONL:",
          transcript || "(no messages)",
          "",
          "Write the replacement summary that will remain visible in the live process conversation.",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
  };
}

function renderCompactionTranscriptWindow(messages: MessageRecord[], maxChars: number): string {
  const lines = messages.map((message) => JSON.stringify(serializeArchivedMessage(message)));
  const transcript = lines.join("\n");
  if (transcript.length <= maxChars) {
    return transcript;
  }

  const omitted = "\n... middle messages omitted for summary budget ...\n";
  const headBudget = Math.floor((maxChars - omitted.length) * 0.35);
  const tailBudget = Math.max(0, maxChars - omitted.length - headBudget);
  return `${transcript.slice(0, headBudget).trimEnd()}${omitted}${transcript.slice(-tailBudget).trimStart()}`;
}

export class Process extends Host<Env> {
  private readonly store: ProcessStore;
  private readonly generation = createGenerationService();
  private readonly ripgit: RipgitClient | null;
  private readonly mediaCache = new Map<string, string>();
  private readonly codeModeResponses = new Map<string, CodeModeResponseWaiter>();
  private readonly codeModeApprovals = new Map<string, CodeModeApprovalWaiter>();
  private activeRunPhase: { runId: string; phase: ActiveRunPhase } | null = null;
  private deferredAbortContinuationRunId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new ProcessStore(ctx.storage.sql);
    this.store.init();
    this.ripgit = env.RIPGIT
      ? new RipgitClient(env.RIPGIT)
      : null;
  }

  private get currentRun(): RunState | null {
    const raw = this.store.getValue("currentRun");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RunState>;
    if (typeof parsed.runId !== "string") {
      return null;
    }
    return {
      ...parsed,
      runId: parsed.runId,
      queued: parsed.queued ?? false,
      conversationId: normalizeConversationId(parsed.conversationId),
    };
  }

  private set currentRun(state: RunState | null) {
    if (state) {
      const conversationId = normalizeConversationId(state.conversationId);
      this.store.ensureConversation(conversationId);
      this.store.setValue("currentRun", JSON.stringify({
        ...state,
        conversationId,
      }));
    } else {
      this.store.deleteValue("currentRun");
    }
  }

  get pid(): string {
    const pid = this.store.getValue("pid");
    if (!pid) throw new Error("Process not initialized — pid missing");
    return pid;
  }

  get identity(): ProcessIdentity {
    const raw = this.store.getValue("identity");
    if (!raw) throw new Error("Process not initialized — identity missing");
    return JSON.parse(raw);
  }

  get profile(): AiContextProfile {
    const raw = this.store.getValue("profile");
    if (isAiContextProfile(raw)) {
      return raw;
    }
    return "task";
  }

  get initialized(): boolean {
    return this.store.getValue("pid") !== null;
  }

  /**
   * Single entry point — called by the Kernel to deliver frames.
   */
  async recvFrame(frame: Frame) {
    switch (frame.type) {
      case "req":
        return this.handleReq(frame);
      case "res":
        await this.handleRes(frame);
        return null;
      case "sig":
        await this.handleSig(frame);
        return null;
      default:
        return null;
    }
  }

  private async handleRes(frame: ResponseFrame): Promise<void> {
    const codeModeWaiter = this.codeModeResponses.get(frame.id);
    if (codeModeWaiter) {
      this.codeModeResponses.delete(frame.id);
      clearTimeout(codeModeWaiter.timeoutId);
      codeModeWaiter.resolve(frame);
      return;
    }

    const pending = this.store.getPending(frame.id);
    if (!pending) {
      console.warn(
        `[Process] Unknown or already resolved tool call: ${frame.id}`,
      );
      return;
    }

    if (frame.ok) {
      this.store.resolve(frame.id, frame.data ?? null);
    } else {
      this.store.fail(frame.id, frame.error.message);
    }

    if (this.store.getPendingHilForRun(pending.runId)) {
      return;
    }

    if (
      this.activeRunPhase?.runId === pending.runId
      && this.activeRunPhase.phase === "toolDispatch"
    ) {
      return;
    }

    if (this.store.isRunResolved(pending.runId)) {
      await this.continueAgentLoop(pending.runId);
    }
  }

  /**
   * Handle a request frame from the kernel.
   * proc.send, proc.history, proc.reset, proc.kill are delivered here.
   */
  private async handleReq(frame: RequestFrame): Promise<ResponseFrame | null> {
    try {
      let data: ResultOf<SyscallName>;

      switch (frame.call) {
        case "proc.setidentity": {
          const idArgs = frame.args as unknown as {
            pid: string;
            identity: ProcessIdentity;
            profile: AiContextProfile;
            assignment?: ProcSpawnAssignment;
          };
          this.store.setValue("pid", idArgs.pid);
          this.store.setValue("identity", JSON.stringify(idArgs.identity));
          this.store.setValue("profile", idArgs.profile);
          this.store.setProcessContextFiles(idArgs.assignment?.contextFiles ?? []);
          let startedRunId: string | undefined;
          if (idArgs.assignment?.autoStart && !this.currentRun) {
            startedRunId = crypto.randomUUID();
            this.currentRun = {
              runId: startedRunId,
              queued: false,
              conversationId: DEFAULT_CONVERSATION_ID,
            };
            this.scheduleTick(startedRunId);
          }
          data = { ok: true, startedRunId };
          break;
        }
        case "proc.send":
          data = await this.handleProcSend(
            frame.args as ProcSendArgs,
          );
          break;
        case "proc.ipc.deliver":
          data = this.handleProcIpcDeliver(
            frame.args as ProcIpcDeliverArgs,
          );
          break;
        case "proc.abort":
          data = await this.handleProcAbort();
          break;
        case "proc.hil":
          data = await this.handleProcHil(
            frame.args as ProcHilArgs,
          );
          break;
        case "codemode.run":
          data = await this.handleCodeModeRun(
            frame.args as CodeModeRunArgs,
          );
          break;
        case "proc.history":
          data = await this.handleProcHistory(
            frame.args as ProcHistoryArgs,
          );
          break;
        case "proc.media.read":
          data = await this.handleProcMediaRead(
            frame.args as ProcMediaReadArgs,
          );
          break;
        case "proc.conversation.open":
          data = this.handleConversationOpen(
            (frame.args ?? {}) as ProcConversationOpenArgs,
          );
          break;
        case "proc.conversation.list":
          data = this.handleConversationList(
            (frame.args ?? {}) as ProcConversationListArgs,
          );
          break;
        case "proc.conversation.get":
          data = this.handleConversationGet(
            (frame.args ?? {}) as ProcConversationGetArgs,
          );
          break;
        case "proc.conversation.close":
          data = this.handleConversationClose(
            (frame.args ?? {}) as ProcConversationCloseArgs,
          );
          break;
        case "proc.conversation.reset":
          data = await this.handleConversationReset(
            (frame.args ?? {}) as ProcConversationResetArgs,
          );
          break;
        case "proc.conversation.policy.get":
          data = this.handleConversationPolicyGet(
            (frame.args ?? {}) as ProcConversationPolicyGetArgs,
          );
          break;
        case "proc.conversation.policy.set":
          data = await this.handleConversationPolicySet(
            (frame.args ?? {}) as ProcConversationPolicySetArgs,
          );
          break;
        case "proc.conversation.compact":
          data = await this.handleConversationCompact(
            (frame.args ?? {}) as ProcConversationCompactArgs,
          );
          break;
        case "proc.conversation.fork":
          data = await this.handleConversationFork(
            (frame.args ?? {}) as ProcConversationForkArgs,
          );
          break;
        case "proc.conversation.segment.read":
          data = await this.handleConversationSegmentRead(
            (frame.args ?? {}) as ProcConversationSegmentReadArgs,
          );
          break;
        case "proc.conversation.segments":
          data = this.handleConversationSegments(
            (frame.args ?? {}) as ProcConversationSegmentsArgs,
          );
          break;
        case "proc.reset":
          data = await this.handleProcReset();
          break;
        case "proc.kill":
          data = await this.handleProcKill(
            frame.args as { pid?: string; archive?: boolean },
          );
          break;
        default:
          return {
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: 400,
              message: `Unknown process command: ${(frame as { call: string }).call}`,
            },
          };
      }

      return { type: "res", id: frame.id, ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: 500, message },
      };
    }
  }

  private async handleProcSend(args: ProcSendArgs): Promise<ProcSendResult> {
    const runId = crypto.randomUUID();
    const conversationId = normalizeConversationId(args.conversationId);
    const conversation = this.store.ensureConversation(conversationId);
    if (conversation.status === "closed") {
      return { ok: false, error: `Conversation is closed: ${conversationId}` };
    }
    const media = await storeIncomingProcessMedia(
      this.env.STORAGE,
      this.identity.uid,
      this.pid,
      args.media,
      { ai: this.env.AI },
    );

    if (this.currentRun) {
      this.store.enqueue(runId, args.message, media ?? undefined, undefined, conversationId);
      return { ok: true, status: "started", runId, queued: true };
    }

    this.store.appendMessage("user", args.message, {
      conversationId,
      media: media ?? undefined,
    });
    this.currentRun = { runId, queued: false, conversationId };
    this.scheduleTick(runId);

    return { ok: true, status: "started", runId };
  }

  private handleProcIpcDeliver(args: ProcIpcDeliverArgs): ProcIpcDeliverResult {
    if (!args || typeof args !== "object") {
      return { ok: false, error: "proc.ipc.deliver requires arguments" };
    }

    const sourcePid = normalizeRequiredText(args.sourcePid);
    if (!sourcePid) {
      return { ok: false, error: "proc.ipc.deliver requires sourcePid" };
    }

    if (!isProcessIdentity(args.source)) {
      return { ok: false, error: "proc.ipc.deliver requires source identity" };
    }

    const message = normalizeRequiredText(args.message);
    if (!message) {
      return { ok: false, error: "proc.ipc.deliver requires message" };
    }

    if (
      args.metadata !== undefined
      && (!args.metadata || typeof args.metadata !== "object" || Array.isArray(args.metadata))
    ) {
      return { ok: false, error: "proc.ipc.deliver metadata must be an object" };
    }

    if (args.call !== undefined && !isIpcCallEnvelope(args.call)) {
      return { ok: false, error: "proc.ipc.deliver call must be a valid call envelope" };
    }

    const runId = crypto.randomUUID();
    const conversationId = normalizeConversationId(args.conversationId);
    const conversation = this.store.ensureConversation(conversationId);
    if (conversation.status === "closed") {
      return { ok: false, error: `Conversation is closed: ${conversationId}` };
    }

    const deliveredArgs: ProcIpcDeliverArgs = {
      sourcePid,
      source: args.source,
      conversationId,
      message,
      metadata: args.metadata,
      sentAt: Number.isFinite(args.sentAt) ? args.sentAt : Date.now(),
      ...(args.call ? { call: args.call } : {}),
    };
    const renderedMessage = formatIpcMessage(deliveredArgs);

    if (this.currentRun) {
      this.store.enqueue(runId, renderedMessage, undefined, undefined, conversationId);
      return {
        ok: true,
        status: "started",
        pid: this.pid,
        sourcePid,
        conversationId,
        runId,
        queued: true,
      };
    }

    this.store.appendMessage("user", renderedMessage, { conversationId });
    this.currentRun = { runId, queued: false, conversationId };
    this.scheduleTick(runId);

    return {
      ok: true,
      status: "started",
      pid: this.pid,
      sourcePid,
      conversationId,
      runId,
    };
  }

  private async handleProcAbort(): Promise<ProcAbortResult> {
    const pid = this.pid;
    const run = this.currentRun;
    if (!run) {
      return { ok: true, pid, aborted: false };
    }

    const runId = run.runId;
    const pendingHil = this.store.getPendingHilForRun(runId);
    const inToolResultPhase =
      this.activeRunPhase?.runId === runId && this.activeRunPhase.phase === "toolResults";
    let interruptedToolCalls = 0;

    if (!inToolResultPhase) {
      interruptedToolCalls = await this.ingestToolResults(runId, this.store.getResults(runId), {
        interruptPending: true,
      });
    }

    if (pendingHil) {
      const codeModeApproval = this.codeModeApprovals.get(pendingHil.requestId);
      if (codeModeApproval) {
        this.resolveCodeModeApproval(pendingHil.requestId, false);
        this.store.clearPendingHil();
      } else {
        this.store.clearPendingHil();
        await this.appendSyntheticToolResult(
          runId,
          pendingHil.toolCallId,
          pendingHil.syscall,
          "User interrupted tool execution",
        );
      }
      interruptedToolCalls += 1;
    }

    this.rejectCodeModeWaiters(runId, "User interrupted CodeMode execution");

    this.currentRun = null;
    await this.sendSignal("chat.complete", {
      text: null,
      aborted: true,
      reason: "user",
      pid,
      runId,
      conversationId: run.conversationId,
    });

    let continuedQueuedRunId: string | undefined;
    if (inToolResultPhase) {
      this.deferredAbortContinuationRunId = runId;
    } else {
      continuedQueuedRunId = this.promoteNextQueuedRun() ?? undefined;
    }

    return {
      ok: true,
      pid,
      aborted: true,
      runId,
      interruptedToolCalls,
      continuedQueuedRunId,
    };
  }

  private async handleProcHil(args: ProcHilArgs): Promise<ProcHilResult> {
    const pid = this.pid;
    if (args.decision !== "approve" && args.decision !== "deny") {
      return { ok: false, error: "proc.hil requires decision=approve|deny" };
    }

    const pendingHil = this.store.getPendingHil(args.requestId);
    if (!pendingHil) {
      return { ok: false, error: `Pending tool confirmation not found: ${args.requestId}` };
    }

    const run = this.currentRun;
    if (!run || run.runId !== pendingHil.runId) {
      this.store.clearPendingHil();
      this.resolveCodeModeApproval(args.requestId, false);
      return { ok: false, error: `Run is no longer active for confirmation: ${args.requestId}` };
    }

    const remembered = args.decision === "approve" && args.remember === true
      ? this.rememberToolApproval(pendingHil, run)
      : false;

    const codeModeApproval = this.codeModeApprovals.get(args.requestId);
    if (codeModeApproval) {
      this.store.clearPendingHil();
      this.resolveCodeModeApproval(args.requestId, args.decision === "approve");
      return {
        ok: true,
        pid,
        requestId: args.requestId,
        decision: args.decision,
        resumed: true,
        remembered,
        pendingHil: null,
      };
    }

    this.store.clearPendingHil();

    if (args.decision === "approve") {
      await this.sendSignal("chat.tool_call", {
        name: pendingHil.toolName,
        syscall: pendingHil.syscall,
        args: pendingHil.args,
        callId: pendingHil.toolCallId,
        pid,
        runId: pendingHil.runId,
        conversationId: pendingHil.conversationId,
      });
      if (this.handleRunStopped(pendingHil.runId)) {
        return {
          ok: true,
          pid,
          requestId: args.requestId,
          decision: args.decision,
          resumed: false,
          remembered,
          pendingHil: null,
        };
      }
      if (pendingHil.syscall === CODEMODE_EXEC) {
        await this.executeCodeModeTool(
          pendingHil.runId,
          pendingHil.toolCallId,
          pendingHil.args,
          await this.resolveToolApprovalPolicy(run),
          pendingHil.conversationId,
        );
      } else {
        await this.dispatchSyscall(
          pendingHil.runId,
          pendingHil.toolCallId,
          pendingHil.syscall as SyscallName,
          pendingHil.args,
        );
      }
    } else {
      await this.appendSyntheticToolResult(
        pendingHil.runId,
        pendingHil.toolCallId,
        pendingHil.syscall,
        "Tool execution denied by user",
      );
    }

    if (this.handleRunStopped(pendingHil.runId)) {
      return {
        ok: true,
        pid,
        requestId: args.requestId,
        decision: args.decision,
        resumed: false,
        remembered,
        pendingHil: null,
      };
    }

    const nextPendingHil = await this.processToolCalls(
      pendingHil.runId,
      pendingHil.remainingToolCalls,
    );
    if (this.handleRunStopped(pendingHil.runId)) {
      return {
        ok: true,
        pid,
        requestId: args.requestId,
        decision: args.decision,
        resumed: false,
        remembered,
        pendingHil: nextPendingHil ? this.toProcHilRequest(nextPendingHil) : null,
      };
    }

    if (!nextPendingHil && this.store.isRunResolved(pendingHil.runId)) {
      this.scheduleTick(pendingHil.runId);
    }

    return {
      ok: true,
      pid,
      requestId: args.requestId,
      decision: args.decision,
      resumed: true,
      remembered,
      pendingHil: nextPendingHil ? this.toProcHilRequest(nextPendingHil) : null,
    };
  }

  private async handleProcHistory(args: ProcHistoryArgs): Promise<ProcHistoryResult> {
    const pid = this.pid;
    const conversationId = normalizeConversationId(args.conversationId);
    const limit = args.limit ?? 200;
    const offset = args.offset ?? 0;
    const beforeMessageId = args.beforeMessageId;
    const afterMessageId = args.afterMessageId;
    const tail = args.tail === true;

    if (!isPositiveInteger(limit)) {
      return { ok: false, error: "proc.history limit must be a positive integer" };
    }
    if (!isNonNegativeInteger(offset)) {
      return { ok: false, error: "proc.history offset must be a non-negative integer" };
    }
    if (beforeMessageId !== undefined && !isPositiveInteger(beforeMessageId)) {
      return { ok: false, error: "proc.history beforeMessageId must be a positive integer" };
    }
    if (afterMessageId !== undefined && !isPositiveInteger(afterMessageId)) {
      return { ok: false, error: "proc.history afterMessageId must be a positive integer" };
    }
    const cursorCount = (tail ? 1 : 0)
      + (beforeMessageId !== undefined ? 1 : 0)
      + (afterMessageId !== undefined ? 1 : 0);
    if (cursorCount > 1) {
      return { ok: false, error: "proc.history accepts only one cursor: tail, beforeMessageId, or afterMessageId" };
    }
    if (cursorCount > 0 && args.offset !== undefined) {
      return { ok: false, error: "proc.history offset cannot be combined with cursor pagination" };
    }

    this.store.ensureConversation(conversationId);
    const total = this.store.messageCount(conversationId);
    const records = this.store.getMessages({
      conversationId,
      limit,
      offset,
      beforeMessageId,
      afterMessageId,
      tail,
    });
    const firstMessageId = records[0]?.id ?? null;
    const lastMessageId = records[records.length - 1]?.id ?? null;
    const hasMoreBefore = firstMessageId === null
      ? false
      : this.store.hasMessageBefore(conversationId, firstMessageId);
    const hasMoreAfter = lastMessageId === null
      ? false
      : this.store.hasMessageAfter(conversationId, lastMessageId);

    const messages: ProcHistoryMessage[] = records.map((r) => {
      if (r.role === "toolResult") {
        let meta: { toolName?: string; isError?: boolean } = {};
        if (r.toolCalls) {
          try {
            meta = JSON.parse(r.toolCalls) as { toolName?: string; isError?: boolean };
          } catch {
            meta = {};
          }
        }

        return {
          id: r.id,
          role: r.role,
          content: {
            toolName: meta.toolName ?? "unknown",
            isError: meta.isError ?? false,
            toolCallId: r.toolCallId ?? null,
            output: r.content,
          },
          timestamp: r.createdAt,
        };
      }

      if (r.role === "assistant" && r.toolCalls) {
        const meta = parseAssistantMessageMeta(r.toolCalls);
        return {
          id: r.id,
          role: r.role,
          content: {
            text: r.content,
            thinking: meta.thinking ?? [],
            toolCalls: meta.toolCalls ?? [],
          },
          timestamp: r.createdAt,
        };
      }

      if (r.role === "user" && r.media) {
        const media = parseStoredProcessMedia(r.media);
        return {
          id: r.id,
          role: r.role,
          content: {
            text: r.content,
            media,
          },
          timestamp: r.createdAt,
        };
      }

      return {
        id: r.id,
        role: r.role,
        content: r.content,
        timestamp: r.createdAt,
      };
    });

    return {
      ok: true,
      pid,
      conversationId,
      messages,
      messageCount: total,
      truncated: cursorCount > 0 ? hasMoreBefore || hasMoreAfter : offset + messages.length < total,
      hasMoreBefore,
      hasMoreAfter,
      pendingHil: this.toProcHilRequest(this.store.getPendingHil()),
      context: await this.getContextStateForHistory(conversationId),
    };
  }

  private async handleProcMediaRead(args: ProcMediaReadArgs): Promise<ProcMediaReadResult> {
    const key = typeof args.key === "string" ? args.key.trim() : "";
    if (!key) {
      return { ok: false, error: "proc.media.read requires key" };
    }

    const prefix = processMediaPrefix(this.identity.uid, this.pid);
    if (!key.startsWith(prefix)) {
      return { ok: false, error: "media key is outside this process" };
    }

    const object = await this.env.STORAGE.get(key);
    if (!object) {
      return { ok: false, error: "media not found" };
    }
    if (object.size > MAX_PROCESS_MEDIA_READ_BYTES) {
      return { ok: false, error: "media is too large to read inline" };
    }

    const mimeType = object.httpMetadata?.contentType
      || (typeof args.mimeType === "string" && args.mimeType.trim() ? args.mimeType.trim() : "application/octet-stream");
    const data = uint8ArrayToBase64(new Uint8Array(await object.arrayBuffer()));

    return {
      ok: true,
      key,
      mimeType,
      size: object.size,
      dataUrl: `data:${mimeType};base64,${data}`,
    };
  }

  private async getContextStateForHistory(conversationId: string): Promise<ProcContextState | null> {
    const stored = this.store.getContextState(conversationId);
    const { count: messageCount, lastMessageId } = this.store.messageStats(conversationId);
    if (
      stored
      && stored.messageCount === messageCount
      && stored.lastMessageId === lastMessageId
    ) {
      return stored;
    }
    return stored ? { ...stored, messageCount, lastMessageId } : null;
  }

  private handleConversationOpen(args: ProcConversationOpenArgs): ProcConversationOpenResult {
    const { conversation, created } = this.store.openConversation({
      conversationId: args.conversationId,
      title: args.title,
    });
    return {
      ok: true,
      pid: this.pid,
      conversation: this.toProcConversation(conversation),
      created,
    };
  }

  private handleConversationList(args: ProcConversationListArgs): ProcConversationListResult {
    return {
      ok: true,
      pid: this.pid,
      conversations: this.store
        .listConversations({ includeClosed: args.includeClosed })
        .map((record) => this.toProcConversation(record)),
    };
  }

  private handleConversationGet(args: ProcConversationGetArgs): ProcConversationGetResult {
    const conversationId = normalizeConversationId(args.conversationId);
    const conversation = this.store.getConversation(conversationId);
    return {
      ok: true,
      pid: this.pid,
      conversation: conversation ? this.toProcConversation(conversation) : null,
    };
  }

  private handleConversationClose(args: ProcConversationCloseArgs): ProcConversationCloseResult {
    if (typeof args.conversationId !== "string" || args.conversationId.trim().length === 0) {
      return { ok: false, error: "proc.conversation.close requires conversationId" };
    }
    const conversationId = normalizeConversationId(args.conversationId);
    const closed = this.store.closeConversation(conversationId);
    return {
      ok: true,
      pid: this.pid,
      conversationId,
      closed,
    };
  }

  private async handleConversationReset(
    args: ProcConversationResetArgs,
  ): Promise<ProcConversationResetResult> {
    const pid = this.pid;
    const conversationId = normalizeConversationId(args.conversationId);
    this.store.ensureConversation(conversationId);
    const archivedMessages = this.store.messageCount(conversationId);
    let archivedTo: string | undefined;

    if (args.archive !== false && archivedMessages > 0) {
      const archiveId = crypto.randomUUID();
      const key = await this.archiveConversationMessages(
        pid,
        conversationId,
        archiveId,
      );
      archivedTo = key ? `/${key}` : undefined;
    }

    this.resetConversationExecutionState(conversationId);
    const conversation = this.store.resetConversation(conversationId);

    return {
      ok: true,
      pid,
      conversationId,
      generation: conversation.generation,
      archivedMessages,
      archivedTo,
    };
  }

  private handleConversationPolicyGet(
    args: ProcConversationPolicyGetArgs,
  ): ProcConversationPolicyGetResult {
    const conversationId = normalizeConversationId(args.conversationId);
    this.store.ensureConversation(conversationId);
    return {
      ok: true,
      pid: this.pid,
      policy: this.getConversationContextPolicy(conversationId),
    };
  }

  private async handleConversationPolicySet(
    args: ProcConversationPolicySetArgs,
  ): Promise<ProcConversationPolicySetResult> {
    const conversationId = normalizeConversationId(args.conversationId);
    this.store.ensureConversation(conversationId);
    const existing = this.getConversationContextPolicy(conversationId);
    const overflow = args.overflow ?? existing.overflow;
    if (!isConversationOverflowPolicy(overflow)) {
      return { ok: false, error: "proc.conversation.policy.set overflow must be manual, auto-compact, or fail" };
    }
    const compactAtPressure = args.compactAtPressure ?? existing.compactAtPressure;
    if (
      typeof compactAtPressure !== "number" ||
      !Number.isFinite(compactAtPressure) ||
      compactAtPressure <= 0 ||
      compactAtPressure > 1
    ) {
      return { ok: false, error: "proc.conversation.policy.set compactAtPressure must be > 0 and <= 1" };
    }
    const keepLast = args.keepLast ?? existing.keepLast;
    if (!isNonNegativeInteger(keepLast)) {
      return { ok: false, error: "proc.conversation.policy.set keepLast must be a non-negative integer" };
    }

    const policy: ProcConversationContextPolicy = {
      conversationId,
      overflow,
      compactAtPressure,
      keepLast,
      updatedAt: Date.now(),
    };
    this.store.setValue(conversationPolicyKey(conversationId), JSON.stringify(policy));
    await this.emitProcessLifecycle({
      event: "conversation.policy",
      pid: this.pid,
      conversationId,
      policy,
    });
    return {
      ok: true,
      pid: this.pid,
      policy,
    };
  }

  private getConversationContextPolicy(conversationId: string): ProcConversationContextPolicy {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const fallback = defaultConversationPolicy(normalizedConversationId);
    const raw = this.store.getValue(conversationPolicyKey(normalizedConversationId));
    if (!raw) {
      return fallback;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ProcConversationContextPolicy>;
      const overflow = parsed.overflow;
      const compactAtPressure = parsed.compactAtPressure;
      const keepLast = parsed.keepLast;
      return {
        conversationId: normalizedConversationId,
        overflow: isConversationOverflowPolicy(overflow) ? overflow : fallback.overflow,
        compactAtPressure:
          typeof compactAtPressure === "number" &&
          Number.isFinite(compactAtPressure) &&
          compactAtPressure > 0 &&
          compactAtPressure <= 1
            ? compactAtPressure
            : fallback.compactAtPressure,
        keepLast: isNonNegativeInteger(keepLast) ? keepLast : fallback.keepLast,
        updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : fallback.updatedAt,
      };
    } catch {
      return fallback;
    }
  }

  private async handleConversationCompact(
    args: ProcConversationCompactArgs,
    options: { allowActive?: boolean; reason?: string } = {},
  ): Promise<ProcConversationCompactResult> {
    const pid = this.pid;
    const conversationId = normalizeConversationId(args.conversationId);
    const explicitSummary = normalizeOptionalString(args.summary);
    const generateSummary = args.generateSummary === true;
    if (!explicitSummary && !generateSummary) {
      return { ok: false, error: "proc.conversation.compact requires summary or generateSummary" };
    }
    if (explicitSummary && generateSummary) {
      return { ok: false, error: "proc.conversation.compact accepts either summary or generateSummary, not both" };
    }

    const hasKeepLast = args.keepLast !== undefined;
    const hasThroughMessageId = args.throughMessageId !== undefined;
    if (hasKeepLast === hasThroughMessageId) {
      return { ok: false, error: "proc.conversation.compact requires exactly one of keepLast or throughMessageId" };
    }
    if (hasKeepLast && !isNonNegativeInteger(args.keepLast)) {
      return { ok: false, error: "proc.conversation.compact keepLast must be a non-negative integer" };
    }
    if (hasThroughMessageId && !isPositiveInteger(args.throughMessageId)) {
      return { ok: false, error: "proc.conversation.compact throughMessageId must be a positive integer" };
    }

    if (!options.allowActive && this.currentRun?.conversationId === conversationId) {
      return { ok: false, error: `Conversation is active: ${conversationId}` };
    }

    const conversation = this.store.ensureConversation(conversationId);
    const selected = this.store.getConversationPrefixMessages({
      conversationId,
      keepLast: hasKeepLast ? args.keepLast : undefined,
      throughMessageId: hasThroughMessageId ? args.throughMessageId : undefined,
    });
    if (selected.length === 0) {
      return { ok: false, error: "No conversation messages selected for compaction" };
    }
    let summary = explicitSummary;
    if (!summary) {
      try {
        summary = await this.generateConversationCompactionSummary(selected);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `Failed to generate compaction summary: ${message}` };
      }
    }

    const fromMessageId = selected[0].id;
    const toMessageId = selected[selected.length - 1].id;
    const segmentId = crypto.randomUUID();
    const archiveKey = [
      "var",
      "sessions",
      this.identity.username,
      pid,
      "conversations",
      encodeURIComponent(conversationId),
      `${segmentId}.jsonl.gz`,
    ].join("/");
    await this.archiveMessageRecords(archiveKey, selected);

    const archivedTo = `/${archiveKey}`;
    const summaryMessageId = this.store.compactConversationPrefix({
      conversationId,
      generation: conversation.generation,
      fromMessageId,
      toMessageId,
      summary: formatCompactionSummaryMessage({
        archivedMessages: selected.length,
        archivePath: archivedTo,
        summary,
      }),
    });
    const segment = this.store.recordConversationSegment({
      id: segmentId,
      conversationId,
      generation: conversation.generation,
      kind: "compaction",
      fromMessageId,
      toMessageId,
      archivePath: archivedTo,
      summaryMessageId,
    });

    await this.emitProcessLifecycle({
      event: "conversation.compacted",
      pid,
      conversationId,
      generation: conversation.generation,
      segment: this.toProcConversationSegment(segment),
      archivedMessages: selected.length,
      archivedTo,
      summaryMessageId,
      ...(options.reason ? { reason: options.reason } : {}),
    });

    return {
      ok: true,
      pid,
      conversationId,
      segment: this.toProcConversationSegment(segment),
      archivedMessages: selected.length,
      archivedTo,
      summaryMessageId,
    };
  }

  private async generateConversationCompactionSummary(messages: MessageRecord[]): Promise<string> {
    const config = await this.resolveCheckpointConfig();
    if (!config) {
      throw new Error("AI config unavailable");
    }

    const generated = await this.generation.generateText({
      purpose: "compaction.summary",
      config,
      context: buildCompactionSummaryContext(messages),
      sessionAffinityKey: `${this.pid}:compaction`,
    });
    const summary = generated.trim();
    if (!summary) {
      throw new Error("summary generation returned empty text");
    }
    return summary;
  }

  private async handleConversationFork(
    args: ProcConversationForkArgs,
  ): Promise<ProcConversationForkResult> {
    const pid = this.pid;
    const sourceConversationId = normalizeConversationId(args.conversationId);
    const segmentId = normalizeOptionalString(args.segmentId);
    const throughMessageId = args.throughMessageId;
    const hasSegmentId = Boolean(segmentId);
    const hasThroughMessageId = throughMessageId !== undefined;
    if (hasSegmentId === hasThroughMessageId) {
      return { ok: false, error: "proc.conversation.fork requires exactly one of segmentId or throughMessageId" };
    }
    if (hasThroughMessageId && !isPositiveInteger(throughMessageId)) {
      return { ok: false, error: "proc.conversation.fork throughMessageId must be a positive integer" };
    }

    const targetConversationId = normalizeConversationId(
      args.targetConversationId ?? crypto.randomUUID(),
    );
    const existingTarget = this.store.getConversation(targetConversationId);
    if (existingTarget && this.store.messageCount(targetConversationId) > 0) {
      return { ok: false, error: `Target conversation already has messages: ${targetConversationId}` };
    }

    const includeLiveSuffix = hasSegmentId ? args.includeLiveSuffix !== false : false;
    let segment: ReturnType<ProcessStore["getConversationSegment"]> = null;
    let archivedMessages: ArchivedMessageRecord[] = [];
    let liveMessages: MessageRecord[] = [];

    if (segmentId) {
      segment = this.store.getConversationSegment(sourceConversationId, segmentId);
      if (!segment) {
        return { ok: false, error: `Conversation segment not found: ${segmentId}` };
      }
      try {
        archivedMessages = await this.readArchivedMessageRecords(segment.archivePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `Failed to read segment archive: ${message}` };
      }
      liveMessages = includeLiveSuffix
        ? this.store.getMessagesForGenerationAfter({
            conversationId: sourceConversationId,
            generation: segment.generation,
            afterMessageId: segment.toMessageId,
            throughCreatedAt: segment.createdAt,
          })
        : [];
    } else {
      liveMessages = this.store.getConversationPrefixMessages({
        conversationId: sourceConversationId,
        throughMessageId,
      });
      if (liveMessages.length === 0 || liveMessages[liveMessages.length - 1]?.id !== throughMessageId) {
        return { ok: false, error: `Message not found in conversation: ${throughMessageId}` };
      }
    }

    const { conversation } = this.store.openConversation({
      conversationId: targetConversationId,
      title: normalizeOptionalString(args.title) ??
        `Fork of ${sourceConversationId} at ${
          segment ? segment.id.slice(0, 8) : `message ${throughMessageId}`
        }`,
    });
    const targetGeneration = conversation.generation;
    let restoredMessages = 0;

    for (const archived of archivedMessages) {
      this.appendRestoredArchivedMessage(archived, targetConversationId, targetGeneration);
      restoredMessages += 1;
    }

    for (const message of liveMessages) {
      this.appendRestoredLiveMessage(message, targetConversationId, targetGeneration);
      restoredMessages += 1;
    }

    await this.emitProcessLifecycle({
      event: "conversation.forked",
      pid,
      sourceConversationId,
      targetConversationId,
      ...(segment ? { segment: this.toProcConversationSegment(segment) } : {}),
      ...(throughMessageId !== undefined ? { throughMessageId } : {}),
      restoredMessages,
      includedLiveSuffix: includeLiveSuffix,
    });

    return {
      ok: true,
      pid,
      sourceConversationId,
      targetConversation: this.toProcConversation(this.store.getConversation(targetConversationId) ?? conversation),
      ...(segment ? { segment: this.toProcConversationSegment(segment) } : {}),
      ...(throughMessageId !== undefined ? { throughMessageId } : {}),
      restoredMessages,
      includedLiveSuffix: includeLiveSuffix,
    };
  }

  private async emitProcessLifecycle(payload: Record<string, unknown>): Promise<void> {
    await this.sendSignal("process.lifecycle", {
      timestamp: Date.now(),
      ...payload,
    }).catch((error) => {
      console.warn(
        `[Process] Failed to emit process.lifecycle for ${this.pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private appendRestoredArchivedMessage(
    message: ArchivedMessageRecord,
    conversationId: string,
    generation: number,
  ): number {
    const toolCalls = message.role === "assistant"
      ? stringifyAssistantMessageMeta({
          toolCalls: message.toolCalls,
          thinking: message.thinking,
        })
      : message.toolCalls
        ? JSON.stringify(message.toolCalls)
        : undefined;
    return this.store.appendMessage(message.role, message.content, {
      conversationId,
      generation,
      toolCalls,
      toolCallId: message.toolCallId,
      media: message.media === undefined ? undefined : JSON.stringify(message.media),
      createdAt: message.createdAt,
    });
  }

  private appendRestoredLiveMessage(
    message: MessageRecord,
    conversationId: string,
    generation: number,
  ): number {
    return this.store.appendMessage(message.role, message.content, {
      conversationId,
      generation,
      toolCalls: message.toolCalls ?? undefined,
      toolCallId: message.toolCallId ?? undefined,
      media: message.media ?? undefined,
      createdAt: message.createdAt,
    });
  }

  private async handleConversationSegmentRead(
    args: ProcConversationSegmentReadArgs,
  ): Promise<ProcConversationSegmentReadResult> {
    const conversationId = normalizeConversationId(args.conversationId);
    const segmentId = normalizeRequiredText(args.segmentId);
    if (!segmentId) {
      return { ok: false, error: "proc.conversation.segment.read requires segmentId" };
    }
    if (args.offset !== undefined && !isNonNegativeInteger(args.offset)) {
      return { ok: false, error: "proc.conversation.segment.read offset must be a non-negative integer" };
    }
    if (args.limit !== undefined && !isPositiveInteger(args.limit)) {
      return { ok: false, error: "proc.conversation.segment.read limit must be a positive integer" };
    }

    const segment = this.store.getConversationSegment(conversationId, segmentId);
    if (!segment) {
      return { ok: false, error: `Conversation segment not found: ${segmentId}` };
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
      pid: this.pid,
      conversationId,
      segment: this.toProcConversationSegment(segment),
      messages,
      messageCount: archivedMessages.length,
      truncated: offset + messages.length < archivedMessages.length,
    };
  }

  private toProcHistoryMessageFromArchive(message: ArchivedMessageRecord): ProcHistoryMessage {
    if (message.role === "toolResult") {
      return {
        id: message.id,
        role: message.role,
        content: {
          toolName: "unknown",
          isError: false,
          toolCallId: message.toolCallId ?? null,
          output: message.content,
        },
        timestamp: message.createdAt,
      };
    }

    if (message.role === "assistant") {
      return {
        id: message.id,
        role: message.role,
        content: {
          text: message.content,
          thinking: message.thinking ?? [],
          toolCalls: message.toolCalls ?? [],
        },
        timestamp: message.createdAt,
      };
    }

    if (message.role === "user" && message.media !== undefined) {
      return {
        id: message.id,
        role: message.role,
        content: {
          text: message.content,
          media: message.media,
        },
        timestamp: message.createdAt,
      };
    }

    return {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
    };
  }

  private handleConversationSegments(
    args: ProcConversationSegmentsArgs,
  ): ProcConversationSegmentsResult {
    const conversationId = normalizeConversationId(args.conversationId);
    this.store.ensureConversation(conversationId);
    return {
      ok: true,
      pid: this.pid,
      conversationId,
      segments: this.store
        .listConversationSegments(conversationId)
        .map((segment) => this.toProcConversationSegment(segment)),
    };
  }

  private toProcConversation(record: ProcessConversationRecord): ProcConversation {
    return {
      id: record.id,
      generation: record.generation,
      status: record.status,
      title: record.title,
      messageCount: this.store.messageCount(record.id),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toProcConversationSegment(
    record: ProcessConversationSegmentRecord,
  ): ProcConversationSegment {
    return {
      id: record.id,
      conversationId: record.conversationId,
      generation: record.generation,
      kind: record.kind,
      fromMessageId: record.fromMessageId,
      toMessageId: record.toMessageId,
      archivePath: record.archivePath,
      summaryMessageId: record.summaryMessageId,
      createdAt: record.createdAt,
    };
  }

  private resetConversationExecutionState(conversationId: string): void {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const activeRun = this.currentRun;
    const stoppedActiveRun = activeRun?.conversationId === normalizedConversationId;

    if (stoppedActiveRun) {
      this.rejectCodeModeWaiters(
        activeRun.runId,
        `Conversation was reset: ${normalizedConversationId}`,
      );
      if (this.activeRunPhase?.runId === activeRun.runId) {
        this.activeRunPhase = null;
      }
      if (this.deferredAbortContinuationRunId === activeRun.runId) {
        this.deferredAbortContinuationRunId = null;
      }
      this.currentRun = null;
    }

    this.store.clearPendingToolCalls(normalizedConversationId);
    this.store.clearPendingHil(normalizedConversationId);
    this.store.clearQueue(normalizedConversationId);
    this.mediaCache.clear();

    if (stoppedActiveRun) {
      this.promoteNextQueuedRun();
    }
  }

  private async handleProcReset(): Promise<ProcResetResult> {
    const pid = this.pid;
    const totalMessages = this.store.totalMessageCount();
    await this.checkpointWorkspace("proc.reset");

    const archive = totalMessages > 0
      ? await this.archiveAllConversationMessages(pid, crypto.randomUUID())
      : emptyProcessArchive();

    this.resetExecutionState();
    this.store.setValue(CHECKPOINTED_MESSAGE_COUNT_KEY, "0");
    this.store.resetAllConversations();

    await deleteProcessMedia(this.env.STORAGE, this.identity.uid, pid);

    return {
      ok: true,
      pid,
      archivedMessages: archive.archivedMessages,
      archivedTo: archive.archivedTo,
      archives: archive.archives,
    };
  }

  private async handleProcKill(args: {
    pid?: string;
    archive?: boolean;
  }): Promise<ProcKillResult> {
    const pid = this.pid;
    const shouldArchive = args.archive !== false;
    const totalMessages = this.store.totalMessageCount();
    await this.checkpointWorkspace("proc.kill");

    const archive = shouldArchive && totalMessages > 0
      ? await this.archiveAllConversationMessages(pid, crypto.randomUUID())
      : emptyProcessArchive();

    this.resetExecutionState();
    this.store.setValue(CHECKPOINTED_MESSAGE_COUNT_KEY, "0");

    // A killed process should restart with a clean conversation and no queued work.
    this.store.resetAllConversations();
    await deleteProcessMedia(this.env.STORAGE, this.identity.uid, pid);

    return {
      ok: true,
      pid,
      archivedMessages: archive.archivedMessages,
      archivedTo: archive.archivedTo,
      archives: archive.archives,
    };
  }

  private resetExecutionState(): void {
    this.rejectCodeModeWaiters(null, "Process execution state was reset");
    this.currentRun = null;
    this.store.clearPendingToolCalls();
    this.store.clearPendingHil();
    this.store.clearQueue();
    this.mediaCache.clear();
  }

  private async handleSig(frame: SignalFrame): Promise<void> {
    if (isWatchedSignalPayload(frame.payload)) {
      await this.handleWatchedSignalTriggered(frame.signal, frame.payload);
      return;
    }

    switch (frame.signal) {
        case "identity.changed": {
        const identity = (frame.payload as { identity: ProcessIdentity })
          ?.identity;
        if (identity) {
          this.store.setValue("identity", JSON.stringify(identity));
        }
        break;
      }
      case "ipc.reply":
      case "ipc.timeout":
        await this.handleIpcSignal(frame.signal, frame.payload);
        break;
      case "schedule.event":
        await this.handleScheduleEventSignal(frame.payload);
        break;
      default:
        console.log(`[Process] Unknown signal: ${frame.signal}`);
        break;
    }
  }
  /**
   * Schedule the next agent loop tick using the DO scheduler.
   * Each tick resets the subrequest counter.
   */
  private scheduleTick(runId: string): void {
    const next = new Date(Date.now() + 10);
    this.schedule(next, "tick", runId);
  }

  private async appendRuntimeMessage(
    role: Extract<MessageRole, "system">,
    content: string,
    opts?: { conversationId?: string },
  ): Promise<number> {
    const conversationId = normalizeConversationId(opts?.conversationId);
    const timestamp = Date.now();
    const messageId = this.store.appendMessage(role, content, {
      conversationId,
      createdAt: timestamp,
    });
    try {
      await this.sendSignal("process.message", {
        pid: this.pid,
        conversationId,
        messageId,
        role,
        content,
        timestamp,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Process] Failed to emit process.message for ${this.pid}: ${message}`);
    }
    return messageId;
  }

  private async handleWatchedSignalTriggered(signal: string, payload: unknown): Promise<void> {
    await this.appendRuntimeMessage("system", formatWatchedSignalMessage(signal, payload), {
      conversationId: DEFAULT_CONVERSATION_ID,
    });
    if (!this.currentRun) {
      const runId = crypto.randomUUID();
      this.currentRun = {
        runId,
        queued: false,
        conversationId: DEFAULT_CONVERSATION_ID,
      };
      this.scheduleTick(runId);
    }
  }

  private async handleIpcSignal(signal: string, payload: unknown): Promise<void> {
    await this.appendRuntimeMessage("system", formatIpcReplyMessage(signal, payload), {
      conversationId: DEFAULT_CONVERSATION_ID,
    });
    if (!this.currentRun) {
      const runId = crypto.randomUUID();
      this.currentRun = {
        runId,
        queued: false,
        conversationId: DEFAULT_CONVERSATION_ID,
      };
      this.scheduleTick(runId);
    }
  }

  private async handleScheduleEventSignal(payload: unknown): Promise<void> {
    if (!isScheduleEventPayload(payload)) {
      return;
    }
    const conversationId = normalizeConversationId(payload.conversationId);
    await this.appendRuntimeMessage("system", formatScheduleEventMessage(payload), {
      conversationId,
    });
    if (!this.currentRun) {
      const runId = crypto.randomUUID();
      this.currentRun = {
        runId,
        queued: false,
        conversationId,
      };
      this.scheduleTick(runId);
    }
  }

  async tick(runId: string): Promise<void> {
    await this.continueAgentLoop(runId);
  }

  private async continueAgentLoop(runId: string): Promise<void> {
    const run = this.currentRun;
    if (!run || run.runId !== runId) {
      console.warn(`[Process] Stale tick for run ${runId}, ignoring`);
      return;
    }

    const conversationId = normalizeConversationId(run.conversationId);

    // Step 1: Collect resolved tool results
    const toolResults = this.store.getResults(runId);
    const hadPendingToolCalls = toolResults.length > 0;

    if (hadPendingToolCalls) {
      this.activeRunPhase = { runId, phase: "toolResults" };
      try {
        await this.ingestToolResults(runId, toolResults);
      } finally {
        if (this.activeRunPhase?.runId === runId && this.activeRunPhase.phase === "toolResults") {
          this.activeRunPhase = null;
        }
      }
      if (this.handleRunStopped(runId)) {
        return;
      }
    }

    // Step 2: Inject queued messages at tool-result boundary
    if (hadPendingToolCalls) {
      const queued = this.store.drainQueue(conversationId);
      for (const qm of queued) {
        this.store.appendMessage("user", qm.message, {
          conversationId: qm.conversationId,
          generation: qm.generation,
          media: qm.media ?? undefined,
        });
      }
      if (queued.length > 0) {
        console.log(
          `[Process] Injected ${queued.length} queued message(s) at tool-result boundary`,
        );
      }
      if (this.handleRunStopped(runId)) {
        return;
      }
    }

    // Step 3: Load config + tools (first tick only, cached on run state)
    if (!run.config) {
      run.config = await this.kernelRpc("ai.config", {
        profile: this.profile,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
      this.currentRun = run;
    }

    if (!run.tools || !run.devices) {
      const toolsResult = await this.kernelRpc("ai.tools");
      if (this.handleRunStopped(runId)) {
        return;
      }
      run.tools = toolsResult.tools;
      run.devices = toolsResult.devices;
      run.mcpServers = toolsResult.mcpServers ?? [];

      this.currentRun = run;
    }

    // Step 4: Assemble prompt (first tick only)
    if (!run.systemPrompt) {
      run.systemPrompt = await assembleSystemPrompt({
        config: run.config!,
        profile: this.profile,
        purpose: "chat.reply",
        identity: this.identity,
        devices: run.devices ?? [],
        mcpServers: run.mcpServers ?? [],
        processContextFiles: this.store.getProcessContextFiles(),
        storage: this.env.STORAGE,
        ripgit: this.ripgit,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
      this.currentRun = run;
    }

    // Step 5: Build pi-ai Context
    let piMessages = await this.buildContextMessages(conversationId);
    const tools: Tool[] = (run.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Tool["parameters"],
    }));

    let context: Context = {
      systemPrompt: run.systemPrompt,
      messages: piMessages,
      tools: tools.length > 0 ? tools : undefined,
    };

    const initialContextState = await this.updateContextState(runId, conversationId, run.config!, context);
    if (this.handleRunStopped(runId)) {
      return;
    }

    const contextPreflight = await this.applyConversationContextPolicy(
      runId,
      conversationId,
      run.config!,
      initialContextState,
    );
    if (contextPreflight === "stopped") {
      return;
    }
    if (contextPreflight === "compacted") {
      if (this.handleRunStopped(runId)) {
        return;
      }
      piMessages = await this.buildContextMessages(conversationId);
      context = {
        systemPrompt: run.systemPrompt,
        messages: piMessages,
        tools: tools.length > 0 ? tools : undefined,
      };
      await this.updateContextState(runId, conversationId, run.config!, context);
      if (this.handleRunStopped(runId)) {
        return;
      }
    }

    // Step 6: Call LLM
    let response: AssistantMessage;
    try {
      this.activeRunPhase = { runId, phase: "generation" };
      response = await this.generation.generate({
        purpose: "chat.reply",
        config: run.config!,
        context,
        sessionAffinityKey: this.pid,
      });
      if (this.activeRunPhase?.runId === runId && this.activeRunPhase.phase === "generation") {
        this.activeRunPhase = null;
      }
      if (this.handleRunStopped(runId)) {
        return;
      }
    } catch (e) {
      if (this.activeRunPhase?.runId === runId && this.activeRunPhase.phase === "generation") {
        this.activeRunPhase = null;
      }
      if (this.handleRunStopped(runId)) {
        return;
      }
      const errorMsg = e instanceof Error ? e.message : String(e);
      const displayError = formatGenerationFailure(errorMsg);
      console.error(`[Process] LLM call failed:`, e);
      this.store.appendMessage("system", displayError, { conversationId });
      await this.sendSignal("chat.complete", {
        text: null,
        error: displayError,
        pid: this.pid,
        runId,
        conversationId,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
      await this.finishRun("chat.error");
      return;
    }

    if (!response.content || response.content.length === 0) {
      const errorMsg = response.errorMessage ?? "LLM returned empty response";
      const displayError = formatGenerationFailure(errorMsg);
      console.error(`[Process] ${errorMsg}`);
      this.store.appendMessage("system", displayError, { conversationId });
      await this.sendSignal("chat.complete", {
        text: null,
        error: displayError,
        pid: this.pid,
        runId,
        conversationId,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
      await this.finishRun("chat.empty");
      return;
    }

    // Step 7: Process response
    const textBlocks = response.content.filter(
      (b): b is TextContent => b.type === "text",
    );
    const text = textBlocks.map((b) => b.text).join("");
    const thinkingBlocks = response.content.filter(
      (b): b is ThinkingContent => b.type === "thinking",
    );
    const toolCalls = response.content.filter(
      (b): b is ToolCall => b.type === "toolCall",
    );

    if (text.trim() || thinkingBlocks.length > 0) {
      await this.sendSignal("chat.text", {
        text,
        thinking: thinkingBlocks,
        pid: this.pid,
        runId,
        conversationId,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
    }

    this.store.appendMessage("assistant", text, {
      conversationId,
      toolCalls: stringifyAssistantMessageMeta({
        thinking: thinkingBlocks,
        toolCalls,
      }),
    });

    piMessages = await this.buildContextMessages(conversationId);
    context = {
      systemPrompt: run.systemPrompt,
      messages: piMessages,
      tools: tools.length > 0 ? tools : undefined,
    };
    await this.updateContextState(runId, conversationId, run.config!, context, response.usage);
    if (this.handleRunStopped(runId)) {
      return;
    }

    if (toolCalls.length > 0) {
      const pendingHil = await this.processToolCalls(runId, toolCalls);
      if (this.handleRunStopped(runId)) {
        return;
      }
      if (!pendingHil && this.store.isRunResolved(runId)) {
        this.scheduleTick(runId);
      }
    } else {
      await this.sendSignal("chat.complete", {
        text,
        pid: this.pid,
        runId,
        conversationId,
        usage: response.usage,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
      await this.finishRun("turn.complete");
    }
  }

  private async finishRun(reason: string): Promise<void> {
    const runId = this.currentRun?.runId;
    this.currentRun = null;
    this.store.clearPendingHil();
    console.log(`[Process] Finished run ${runId}`);

    this.promoteNextQueuedRun();
  }

  private async applyConversationContextPolicy(
    runId: string,
    conversationId: string,
    config: AiConfigResult,
    state: ProcContextState,
  ): Promise<"ready" | "compacted" | "stopped"> {
    const pressure = state.pressure;
    if (pressure === null || !Number.isFinite(pressure)) {
      return "ready";
    }

    const policy = this.getConversationContextPolicy(conversationId);
    if (pressure < policy.compactAtPressure) {
      return "ready";
    }

    if (policy.overflow === "manual") {
      return "ready";
    }

    if (policy.overflow === "fail") {
      const message = [
        "Context limit policy stopped this run.",
        `Policy: fail at ${Math.round(policy.compactAtPressure * 100)}% context pressure.`,
        `Current estimate: ${Math.round(pressure * 100)}%.`,
        "Compact or reset the conversation before sending more work.",
      ].join("\n");
      this.store.appendMessage("system", message, { conversationId });
      await this.sendSignal("chat.complete", {
        text: null,
        error: message,
        pid: this.pid,
        runId,
        conversationId,
      });
      await this.finishRun("context.policy.fail");
      return "stopped";
    }

    const selected = this.store.getConversationPrefixMessages({
      conversationId,
      keepLast: policy.keepLast,
    });
    if (selected.length === 0) {
      if (pressure < 1) {
        return "ready";
      }
      const message = [
        "Context limit reached, but auto-compaction could not archive any older messages.",
        `Policy keeps the newest ${policy.keepLast} messages live.`,
        "Lower the keep-last value, compact manually, or reset this conversation.",
      ].join("\n");
      this.store.appendMessage("system", message, { conversationId });
      await this.sendSignal("chat.complete", {
        text: null,
        error: message,
        pid: this.pid,
        runId,
        conversationId,
      });
      await this.finishRun("context.auto_compact.empty");
      return "stopped";
    }

    const result = await this.handleConversationCompact(
      {
        conversationId,
        keepLast: policy.keepLast,
        generateSummary: true,
      },
      {
        allowActive: true,
        reason: "auto-compact",
      },
    );
    if (!result.ok) {
      const message = `Auto-compaction failed before model call: ${result.error}`;
      this.store.appendMessage("system", message, { conversationId });
      await this.sendSignal("chat.complete", {
        text: null,
        error: message,
        pid: this.pid,
        runId,
        conversationId,
      });
      await this.finishRun("context.auto_compact.failed");
      return "stopped";
    }

    await this.emitProcessLifecycle({
      event: "conversation.auto_compacted",
      pid: this.pid,
      conversationId,
      provider: config.provider,
      model: config.model,
      pressure,
      policy,
      segment: result.segment,
      archivedMessages: result.archivedMessages,
    });
    return "compacted";
  }

  private async updateContextState(
    runId: string,
    conversationId: string,
    config: AiConfigResult,
    context: Context,
    usage?: AssistantMessage["usage"],
  ): Promise<ProcContextState> {
    const { count: messageCount, lastMessageId } = this.store.messageStats(conversationId);
    const state = buildProcContextState({
      conversationId,
      runId,
      messageCount,
      lastMessageId,
      provider: config.provider,
      model: config.model,
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxTokens,
      estimatedInputTokens: estimateContextInputTokens(context),
      usage,
    });
    this.store.setContextState(state);
    await this.sendSignal("process.context", {
      pid: this.pid,
      context: state,
    }).catch((error) => {
      console.warn(
        `[Process] Failed to emit process.context for ${this.pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return state;
  }

  /**
   * Synchronous kernel RPC — for syscalls the kernel handles natively
   * (ai.config, ai.tools, sys.config.get, etc.). Throws on error.
   */
  private async kernelRpc<T extends SyscallName>(
    call: T,
    args: unknown = {},
  ): Promise<ResultOf<T>> {
    const id = crypto.randomUUID();
    const frame = { type: "req", id, call, args } as RequestFrame;
    const response = await sendFrameToKernel(this.pid, frame);

    if (!response || response.type !== "res") {
      throw new Error(`No synchronous response for ${call}`);
    }
    if (!response.ok) {
      throw new Error((response as ResponseErrFrame).error.message);
    }
    return response.data as ResultOf<T>;
  }

  /**
   * Send a signal frame to the kernel for relay to client connections.
   */
  private async sendSignal(signal: string, payload?: unknown): Promise<void> {
    await sendFrameToKernel(this.pid, {
      type: "sig",
      signal,
      payload,
    } as SignalFrame);
  }

  private async checkpointWorkspace(reason: string): Promise<void> {
    const workspaceId = this.identity.workspaceId;
    if (!workspaceId || !this.ripgit) {
      return;
    }

    const messages = this.store.allMessagesForArchive();
    if (messages.length === 0) {
      return;
    }

    const checkpointedCount = Number.parseInt(
      this.store.getValue(CHECKPOINTED_MESSAGE_COUNT_KEY) ?? "0",
      10,
    );
    if (checkpointedCount === messages.length) {
      return;
    }

    const repo = workspaceRepoRef(workspaceId, this.identity.username);
    const existingSummary = await this.readWorkspaceSummary(repo);
    const config = await this.resolveCheckpointConfig();
    const transcript = buildCheckpointTranscript(messages);

    const summary = await this.generateCheckpointSummary(
      config,
      existingSummary,
      messages,
    );
    const commitMessage = await this.generateCheckpointCommitMessage(
      config,
      summary,
      messages,
      reason,
    );

    await this.ripgit.apply(
      repo,
      this.identity.username,
      `${this.identity.username}@gsv.internal`,
      commitMessage,
      [
        {
          type: "put",
          path: ".gsv/summary.md",
          contentBytes: Array.from(TEXT_ENCODER.encode(summary)),
        },
        {
          type: "put",
          path: `.gsv/processes/${this.pid}/chat.jsonl`,
          contentBytes: Array.from(TEXT_ENCODER.encode(transcript)),
        },
      ],
    );

    this.store.setValue(CHECKPOINTED_MESSAGE_COUNT_KEY, String(messages.length));
  }

  private async readWorkspaceSummary(
    repo: ReturnType<typeof workspaceRepoRef>,
  ): Promise<string> {
    if (!this.ripgit) {
      return "";
    }
    const result = await this.ripgit.readPath(repo, ".gsv/summary.md");
    if (result.kind !== "file") {
      return "";
    }
    return new TextDecoder().decode(result.bytes);
  }

  private async resolveCheckpointConfig(): Promise<AiConfigResult | null> {
    if (this.currentRun?.config) {
      return this.currentRun.config;
    }
    try {
      return await this.kernelRpc("ai.config", {
        profile: this.profile,
      });
    } catch (error) {
      console.warn("[Process] Failed to resolve AI config for checkpointing:", error);
      return null;
    }
  }

  private async generateCheckpointSummary(
    config: AiConfigResult | null,
    existingSummary: string,
    messages: MessageRecord[],
  ): Promise<string> {
    if (!config) {
      return normalizeCheckpointSummary(existingSummary);
    }
    try {
      const generated = await this.generation.generateText({
        purpose: "checkpoint.summary",
        config,
        context: buildCheckpointSummaryContext(existingSummary, messages),
        sessionAffinityKey: this.pid,
      });
      return normalizeCheckpointSummary(generated);
    } catch (error) {
      console.warn("[Process] Failed to generate checkpoint summary:", error);
      return normalizeCheckpointSummary(existingSummary);
    }
  }

  private async generateCheckpointCommitMessage(
    config: AiConfigResult | null,
    summary: string,
    messages: MessageRecord[],
    reason: string,
  ): Promise<string> {
    if (!config) {
      return this.defaultCheckpointCommitMessage(reason);
    }
    try {
      const generated = await this.generation.generateText({
        purpose: "checkpoint.commit_message",
        config,
        context: buildCheckpointCommitMessageContext(summary, messages, reason),
        sessionAffinityKey: this.pid,
      });
      return normalizeCheckpointCommitMessage(generated);
    } catch (error) {
      console.warn("[Process] Failed to generate checkpoint commit message:", error);
      return this.defaultCheckpointCommitMessage(reason);
    }
  }

  private defaultCheckpointCommitMessage(reason: string): string {
    const normalizedReason = reason.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
    return normalizedReason ? `checkpoint ${normalizedReason}` : "checkpoint thread state";
  }

  private async archiveConversationMessages(
    pid: string,
    conversationId: string,
    archiveId: string,
  ): Promise<string | null> {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const messages = this.store.allMessagesForArchive(normalizedConversationId);
    if (messages.length === 0) return null;

    const key = [
      "var",
      "sessions",
      this.identity.username,
      pid,
      "conversations",
      encodeURIComponent(normalizedConversationId),
      `${archiveId}.jsonl.gz`,
    ].join("/");

    await this.archiveMessageRecords(key, messages);
    return key;
  }

  private async archiveAllConversationMessages(
    pid: string,
    archiveId: string,
  ): Promise<ProcessArchiveResult> {
    const archiveDir = `var/sessions/${this.identity.username}/${pid}/${archiveId}/`;
    const archives: ProcArchiveEntry[] = [];
    let archivedMessages = 0;

    const conversations = this.store
      .listConversations({ includeClosed: true })
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const conversation of conversations) {
      const messages = this.store.allMessagesForArchive(conversation.id);
      if (messages.length === 0) {
        continue;
      }

      const key = `${archiveDir}${conversationArchiveFilename(
        conversation.id,
        conversation.generation,
      )}`;

      await this.archiveMessageRecords(key, messages);
      archivedMessages += messages.length;
      archives.push({
        conversationId: conversation.id,
        generation: conversation.generation,
        messages: messages.length,
        path: `/${key}`,
      });
    }

    return {
      archivedMessages,
      archivedTo: archivedMessages > 0 ? `/${archiveDir}` : undefined,
      archives,
    };
  }

  private async archiveMessageRecords(key: string, messages: MessageRecord[]): Promise<void> {
    const jsonl = messages
      .map((m) =>
        JSON.stringify(serializeArchivedMessage(m)),
      )
      .join("\n");
    await this.writeMessageArchive(key, jsonl);
  }

  private async writeMessageArchive(key: string, jsonl: string): Promise<void> {
    const compressed = await gzip(jsonl);
    const bucket = this.env.STORAGE;
    await bucket.put(key, compressed, {
      httpMetadata: { contentType: "application/gzip" },
    });
  }

  private async readArchivedMessageRecords(archivePath: string): Promise<ArchivedMessageRecord[]> {
    const key = archivePath.replace(/^\/+/, "");
    const object = await this.env.STORAGE.get(key);
    if (!object) {
      throw new Error(`archive not found: ${archivePath}`);
    }

    const jsonl = await gunzip(await object.arrayBuffer());
    return jsonl
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => parseArchivedMessageRecord(JSON.parse(line)));
  }

  async dispatchSyscall(
    runId: string,
    id: string,
    call: SyscallName,
    args: unknown,
  ): Promise<void> {
    const run = this.currentRun;
    this.store.register(
      id,
      runId,
      call,
      args,
      run?.runId === runId ? run.conversationId : DEFAULT_CONVERSATION_ID,
    );

    const reqFrame: RequestFrame = {
      type: "req",
      id,
      call,
      args,
    } as RequestFrame;

    const response = await sendFrameToKernel(this.pid, reqFrame);

    if (response && response.type === "res") {
      const res = response;
      if (res.ok) {
        this.store.resolve(id, (res as { data?: unknown }).data);
      } else {
        this.store.fail(
          id,
          (res as { error: { message: string } }).error.message,
        );
      }
    }
  }

  private async buildContextMessages(conversationId: string): Promise<Context["messages"]> {
    const records = this.store.getMessages({ conversationId, limit: null });
    const messages = this.store.toMessages({ conversationId, limit: null });

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.role !== "user" || !record.media) {
        continue;
      }

      const content = await this.hydrateUserContent(record.content, record.media);
      messages[index] = {
        role: "user",
        content,
        timestamp: record.createdAt,
      } satisfies UserMessage;
    }

    return messages;
  }

  private async hydrateUserContent(
    text: string,
    rawMedia: string,
  ): Promise<Array<TextContent | ImageContent>> {
    const media = parseStoredProcessMedia(rawMedia);
    const content: Array<TextContent | ImageContent> = [];

    if (text.trim().length > 0) {
      content.push({ type: "text", text });
    }

    for (const item of media) {
      if (item.type === "image" && item.key) {
        const data = await this.loadProcessMedia(item.key);
        if (data) {
          content.push(buildImageBlock(data, item.mimeType));
          continue;
        }
      }

      if (
        (item.type === "audio" || item.type === "video" || item.type === "document")
        && item.transcription
      ) {
        content.push({
          type: "text",
          text: describeStoredProcessMedia(item),
        });
        continue;
      }

      content.push(...buildFallbackMediaBlocks([item]));
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    return content;
  }

  private async loadProcessMedia(key: string): Promise<string | null> {
    const cached = this.mediaCache.get(key);
    if (cached) {
      this.mediaCache.delete(key);
      this.mediaCache.set(key, cached);
      return cached;
    }

    const object = await this.env.STORAGE.get(key);
    if (!object) {
      return null;
    }

    const data = uint8ArrayToBase64(new Uint8Array(await object.arrayBuffer()));
    this.mediaCache.set(key, data);
    while (this.mediaCache.size > PROCESS_MEDIA_CACHE_LIMIT) {
      const oldest = this.mediaCache.keys().next().value;
      if (!oldest) {
        break;
      }
      this.mediaCache.delete(oldest);
    }
    return data;
  }

  private async ingestToolResults(
    runId: string,
    toolResults: ReturnType<ProcessStore["getResults"]>,
    options?: { interruptPending?: boolean },
  ): Promise<number> {
    const run = this.currentRun;
    const conversationId = normalizeConversationId(
      run?.runId === runId
        ? run.conversationId
        : toolResults[0]?.conversationId,
    );
    this.store.clearRun(runId);
    let interrupted = 0;

    for (const result of toolResults) {
      let content: string;
      let ok: boolean;
      let output: unknown;
      let error: string | undefined;
      let isError: boolean;

      if (result.status === "completed") {
        content =
          typeof result.result === "string"
            ? result.result
            : JSON.stringify(result.result ?? null);
        ok = true;
        output = result.result;
        isError = false;
      } else if (result.status === "error") {
        content = `Error: ${result.error}`;
        ok = false;
        error = result.error ?? "Tool execution failed";
        isError = true;
      } else if (options?.interruptPending) {
        content = "Error: User interrupted tool execution";
        ok = false;
        error = "User interrupted tool execution";
        isError = true;
        interrupted += 1;
      } else {
        continue;
      }

      this.store.appendToolResult(
        result.id,
        result.call,
        content,
        isError,
        conversationId,
      );

      await this.sendSignal("chat.tool_result", {
        name: SYSCALL_TOOL_NAMES[result.call] ?? result.call,
        syscall: result.call,
        callId: result.id,
        ok,
        output,
        error,
        pid: this.pid,
        runId,
        conversationId,
      });
    }

    return interrupted;
  }

  private async processToolCalls(
    runId: string,
    toolCalls: ToolCall[],
  ): Promise<PendingHilRecord | null> {
    if (toolCalls.length === 0) {
      return null;
    }

    const run = this.currentRun;
    if (!run || run.runId !== runId) {
      return null;
    }

    const approvalPolicy = await this.resolveToolApprovalPolicy(run);
    if (this.handleRunStopped(runId)) {
      return null;
    }

    this.activeRunPhase = { runId, phase: "toolDispatch" };
    try {
      for (let index = 0; index < toolCalls.length; index += 1) {
        const tc = toolCalls[index];
        const syscall = TOOL_TO_SYSCALL[tc.name];

        if (!syscall) {
          await this.appendSyntheticToolResult(
            runId,
            tc.id,
            tc.name,
            `Unknown tool "${tc.name}"`,
          );
          continue;
        }

        const approval = resolveToolApproval(
          approvalPolicy,
          syscall,
          tc.arguments,
          this.identity,
          this.profile,
        );

        if (approval.action === "deny") {
          await this.appendSyntheticToolResult(
            runId,
            tc.id,
            syscall,
            "Tool execution denied by policy",
          );
          continue;
        }

        if (approval.action === "ask") {
          if (isNonInteractiveProfile(this.profile)) {
            await this.appendSyntheticToolResult(
              runId,
              tc.id,
              syscall,
              "Tool execution requires interactive approval, which is unavailable for this profile",
            );
            continue;
          }
          const pendingHil: PendingHilRecord = {
            requestId: crypto.randomUUID(),
            runId,
            conversationId: run.conversationId,
            generation: this.store.getConversationGeneration(run.conversationId),
            toolCallId: tc.id,
            toolName: tc.name,
            syscall,
            args: tc.arguments as Record<string, unknown>,
            remainingToolCalls: toolCalls.slice(index + 1),
            createdAt: Date.now(),
          };
          this.store.setPendingHil(pendingHil);
          await this.sendSignal("chat.hil", this.toProcHilRequest(pendingHil));
          return pendingHil;
        }

        await this.sendSignal("chat.tool_call", {
          name: tc.name,
          syscall,
          args: tc.arguments,
          callId: tc.id,
          pid: this.pid,
          runId,
          conversationId: run.conversationId,
        });
        if (this.handleRunStopped(runId)) {
          return null;
        }

        if (syscall === CODEMODE_EXEC) {
          await this.executeCodeModeTool(
            runId,
            tc.id,
            tc.arguments,
            approvalPolicy,
            run.conversationId,
          );
        } else {
          await this.dispatchSyscall(
            runId,
            tc.id,
            syscall as SyscallName,
            tc.arguments,
          );
        }
        if (this.handleRunStopped(runId)) {
          return null;
        }
      }

      return null;
    } finally {
      if (this.activeRunPhase?.runId === runId && this.activeRunPhase.phase === "toolDispatch") {
        this.activeRunPhase = null;
      }
    }
  }

  private async handleCodeModeRun(rawArgs: CodeModeRunArgs): Promise<CodeModeRunResult> {
    const args = rawArgs && typeof rawArgs === "object"
      ? rawArgs as Partial<CodeModeRunArgs>
      : {};
    if (typeof args.code !== "string" || args.code.trim().length === 0) {
      return {
        status: "failed",
        error: "codemode requires a non-empty code string",
      };
    }

    try {
      return await executeCodeMode(
        this.env,
        args.code,
        (call, toolArgs) => this.executeCodeModeCommandSyscall(call, toolArgs),
        {
          defaultTarget: normalizeOptionalString(args.target),
          defaultCwd: normalizeOptionalString(args.cwd),
          argv: normalizeStringArray(args.argv),
          args: args.args ?? null,
          mcpToolBindings: await this.getCodeModeMcpToolBindings(),
        },
      );
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeCodeModeTool(
    runId: string,
    toolCallId: string,
    rawArgs: unknown,
    approvalPolicy: ToolApprovalPolicy,
    conversationId: string,
  ): Promise<void> {
    const args = rawArgs && typeof rawArgs === "object"
      ? rawArgs as Partial<CodeModeExecArgs>
      : {};
    this.store.register(
      toolCallId,
      runId,
      CODEMODE_EXEC as SyscallName,
      args,
      conversationId,
    );

    if (typeof args.code !== "string" || args.code.trim().length === 0) {
      this.store.resolve(toolCallId, {
        status: "failed",
        error: "CodeMode requires a non-empty code string",
      });
      return;
    }

    try {
      const result = await executeCodeMode(
        this.env,
        args.code,
        (call, toolArgs) => this.executeCodeModeSyscall(
          runId,
          call,
          toolArgs,
          approvalPolicy,
          conversationId,
        ),
        {
          mcpToolBindings: await this.getCodeModeMcpToolBindings(),
        },
      );
      this.store.resolve(toolCallId, result);
    } catch (error) {
      this.store.resolve(toolCallId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getCodeModeMcpToolBindings() {
    try {
      const result = await this.kernelRpc("sys.mcp.list", {});
      return buildCodeModeMcpToolBindings(result.servers);
    } catch {
      return [];
    }
  }

  private async executeCodeModeSyscall(
    runId: string,
    call: SyscallName,
    args: Record<string, unknown>,
    approvalPolicy: ToolApprovalPolicy,
    conversationId: string,
  ): Promise<unknown> {
    if (this.handleRunStopped(runId)) {
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    const toolCallId = `codemode-${crypto.randomUUID()}`;
    const toolName = SYSCALL_TOOL_NAMES[call] ?? call;
    const approval = resolveToolApproval(
      approvalPolicy,
      call,
      args,
      this.identity,
      this.profile,
    );

    if (approval.action === "deny") {
      throw new Error(`Tool execution denied by policy: ${call}`);
    }

    if (approval.action === "ask") {
      if (isNonInteractiveProfile(this.profile)) {
        throw new Error(
          `Tool execution requires interactive approval, which is unavailable for this profile: ${call}`,
        );
      }
      const approved = await this.waitForCodeModeApproval(
        runId,
        toolCallId,
        toolName,
        call,
        args,
      );
      if (!approved) {
        throw new Error(`Tool execution was not approved: ${call}`);
      }
    }

    await this.sendSignal("chat.tool_call", {
      name: toolName,
      syscall: call,
      args,
      callId: toolCallId,
      pid: this.pid,
      runId,
      conversationId,
    });
    if (this.handleRunStopped(runId)) {
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    let response: ResponseFrame;
    try {
      response = await this.dispatchCodeModeSyscall(
        runId,
        toolCallId,
        call,
        args,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendSignal("chat.tool_result", {
        name: toolName,
        syscall: call,
        callId: toolCallId,
        ok: false,
        error: message,
        pid: this.pid,
        runId,
        conversationId,
      });
      throw error;
    }

    if (response.ok) {
      const output = response.data ?? null;
      await this.sendSignal("chat.tool_result", {
        name: toolName,
        syscall: call,
        callId: toolCallId,
        ok: true,
        output,
        pid: this.pid,
        runId,
        conversationId,
      });
      return output;
    }

    const error = response.error.message;
    await this.sendSignal("chat.tool_result", {
      name: toolName,
      syscall: call,
      callId: toolCallId,
      ok: false,
      error,
      pid: this.pid,
      runId,
      conversationId,
    });
    throw new Error(error);
  }

  private async executeCodeModeCommandSyscall(
    call: SyscallName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const id = `codemode-${crypto.randomUUID()}`;
    const response = await this.dispatchCodeModeSyscall(
      null,
      id,
      call,
      args,
    );

    if (response.ok) {
      return response.data ?? null;
    }

    throw new Error(response.error.message);
  }

  private async waitForCodeModeApproval(
    runId: string,
    toolCallId: string,
    toolName: string,
    call: SyscallName,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const conversationId = normalizeConversationId(
      this.currentRun?.runId === runId
        ? this.currentRun.conversationId
        : DEFAULT_CONVERSATION_ID,
    );
    const approved = new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.codeModeApprovals.delete(requestId);
        if (this.store.getPendingHil(requestId)) {
          this.store.clearPendingHil();
        }
        resolve(false);
      }, CODE_MODE_APPROVAL_TIMEOUT_MS);
      this.codeModeApprovals.set(requestId, { runId, resolve, timeoutId });
    });

    const pendingHil: PendingHilRecord = {
      requestId,
      runId,
      conversationId,
      generation: this.store.getConversationGeneration(conversationId),
      toolCallId,
      toolName,
      syscall: call,
      args,
      remainingToolCalls: [],
      createdAt: Date.now(),
    };
    this.store.setPendingHil(pendingHil);
    await this.sendSignal("chat.hil", this.toProcHilRequest(pendingHil));
    return approved;
  }

  private async dispatchCodeModeSyscall(
    runId: string | null,
    id: string,
    call: SyscallName,
    args: Record<string, unknown>,
  ): Promise<ResponseFrame> {
    const reqFrame: RequestFrame = {
      type: "req",
      id,
      call,
      args,
    } as RequestFrame;

    const pending = new Promise<ResponseFrame>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.codeModeResponses.delete(id);
        reject(new Error(`Timed out waiting for ${call}`));
      }, CODE_MODE_NESTED_SYSCALL_TIMEOUT_MS);
      this.codeModeResponses.set(id, { runId, resolve, reject, timeoutId });
    });

    try {
      const response = await sendFrameToKernel(this.pid, reqFrame);
      if (response && response.type === "res") {
        const waiter = this.codeModeResponses.get(id);
        if (waiter) {
          this.codeModeResponses.delete(id);
          clearTimeout(waiter.timeoutId);
        }
        return response;
      }
      if (response) {
        throw new Error(`Unexpected response frame for ${call}: ${response.type}`);
      }
      return await pending;
    } catch (error) {
      const waiter = this.codeModeResponses.get(id);
      if (waiter) {
        this.codeModeResponses.delete(id);
        clearTimeout(waiter.timeoutId);
      }
      throw error;
    }
  }

  private resolveCodeModeApproval(requestId: string, approved: boolean): void {
    const waiter = this.codeModeApprovals.get(requestId);
    if (!waiter) {
      return;
    }
    this.codeModeApprovals.delete(requestId);
    clearTimeout(waiter.timeoutId);
    waiter.resolve(approved);
  }

  private rejectCodeModeWaiters(runId: string | null, message: string): void {
    for (const [id, waiter] of this.codeModeResponses.entries()) {
      if (runId !== null && waiter.runId !== runId) {
        continue;
      }
      this.codeModeResponses.delete(id);
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error(message));
    }

    for (const [requestId, waiter] of this.codeModeApprovals.entries()) {
      if (runId !== null && waiter.runId !== runId) {
        continue;
      }
      this.codeModeApprovals.delete(requestId);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(false);
    }
  }

  private async resolveToolApprovalPolicy(run: RunState): Promise<ToolApprovalPolicy> {
    if (run.approvalPolicy) {
      return run.approvalPolicy;
    }

    const profilePolicy = parseToolApprovalPolicy(run.config?.profileApprovalPolicy ?? null);
    const overrides = this.loadToolApprovalOverrides();
    run.approvalPolicy = {
      default: profilePolicy.default,
      rules: [
        ...overrides,
        ...profilePolicy.rules,
      ],
    };
    this.currentRun = run;
    return run.approvalPolicy;
  }

  private rememberToolApproval(pendingHil: PendingHilRecord, run: RunState): boolean {
    const rule = this.buildToolApprovalOverride(pendingHil);
    const overrides = this.loadToolApprovalOverrides();
    const key = approvalRuleKey(rule);
    const alreadyStored = overrides.some((override) => approvalRuleKey(override) === key);

    if (!alreadyStored) {
      this.store.setValue(TOOL_APPROVAL_OVERRIDES_KEY, JSON.stringify([rule, ...overrides]));
    }

    if (run.approvalPolicy && !run.approvalPolicy.rules.some((override) => approvalRuleKey(override) === key)) {
      run.approvalPolicy.rules.unshift(rule);
      this.currentRun = run;
    }

    return true;
  }

  private buildToolApprovalOverride(pendingHil: PendingHilRecord): ToolApprovalRule {
    const facts = buildToolApprovalFacts(
      pendingHil.syscall,
      pendingHil.args,
      this.identity,
      this.profile,
    );
    return {
      match: pendingHil.syscall,
      when: {
        target: facts.target,
      },
      action: "auto",
    };
  }

  private loadToolApprovalOverrides(): ToolApprovalRule[] {
    const raw = this.store.getValue(TOOL_APPROVAL_OVERRIDES_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parseToolApprovalPolicy(JSON.stringify({
        default: "auto",
        rules: parsed,
      })).rules;
    } catch {
      return [];
    }
  }

  private async appendSyntheticToolResult(
    runId: string,
    toolCallId: string,
    syscallName: string,
    errorMessage: string,
  ): Promise<void> {
    const run = this.currentRun;
    const conversationId = normalizeConversationId(
      run?.runId === runId ? run.conversationId : DEFAULT_CONVERSATION_ID,
    );
    this.store.appendToolResult(
      toolCallId,
      syscallName,
      `Error: ${errorMessage}`,
      true,
      conversationId,
    );
    await this.sendSignal("chat.tool_result", {
      name: SYSCALL_TOOL_NAMES[syscallName] ?? syscallName,
      syscall: syscallName,
      callId: toolCallId,
      ok: false,
      error: errorMessage,
      pid: this.pid,
      runId,
      conversationId,
    });
  }

  private toProcHilRequest(record: PendingHilRecord | null): ProcHilRequest | null {
    if (!record) {
      return null;
    }

    return {
      requestId: record.requestId,
      runId: record.runId,
      conversationId: record.conversationId,
      callId: record.toolCallId,
      toolName: record.toolName,
      syscall: record.syscall,
      args: record.args,
      createdAt: record.createdAt,
    };
  }

  private handleRunStopped(runId: string): boolean {
    if (this.currentRun?.runId === runId) {
      return false;
    }
    if (this.deferredAbortContinuationRunId === runId) {
      this.deferredAbortContinuationRunId = null;
      this.promoteNextQueuedRun();
    }
    return true;
  }

  private promoteNextQueuedRun(): string | null {
    const next = this.store.dequeue();
    if (!next) {
      return null;
    }
    this.store.appendMessage("user", next.message, {
      conversationId: next.conversationId,
      generation: next.generation,
      media: next.media ?? undefined,
    });
    this.currentRun = {
      runId: next.runId,
      queued: false,
      conversationId: next.conversationId,
    };
    this.scheduleTick(next.runId);
    return next.runId;
  }
}

function serializeArchivedMessage(message: MessageRecord): Record<string, unknown> {
  if (message.role === "assistant") {
    const meta = parseAssistantMessageMeta(message.toolCalls);
    return {
      id: message.id,
      conversation_id: message.conversationId,
      generation: message.generation,
      role: message.role,
      content: message.content,
      tool_calls: meta.toolCalls,
      thinking: meta.thinking,
      tool_call_id: message.toolCallId ?? undefined,
      ts: message.createdAt,
    };
  }

  return {
    id: message.id,
    conversation_id: message.conversationId,
    generation: message.generation,
    role: message.role,
    content: message.content,
    media: message.media ? parseStoredProcessMedia(message.media) : undefined,
    tool_calls: message.toolCalls ? JSON.parse(message.toolCalls) : undefined,
    tool_call_id: message.toolCallId ?? undefined,
    ts: message.createdAt,
  };
}

function parseArchivedMessageRecord(value: unknown): ArchivedMessageRecord {
  if (!value || typeof value !== "object") {
    throw new Error("invalid archived message record");
  }
  const record = value as Record<string, unknown>;
  const role = parseArchivedMessageRole(record.role);
  const content = typeof record.content === "string" ? record.content : "";
  const toolCallId = typeof record.tool_call_id === "string" && record.tool_call_id.trim().length > 0
    ? record.tool_call_id
    : undefined;
  const createdAt = typeof record.ts === "number" && Number.isFinite(record.ts)
    ? record.ts
    : undefined;
  const id = typeof record.id === "number" && Number.isInteger(record.id) && record.id > 0
    ? record.id
    : undefined;

  return {
    id,
    role,
    content,
    toolCalls: Array.isArray(record.tool_calls)
      ? record.tool_calls as ToolCall[]
      : undefined,
    thinking: Array.isArray(record.thinking)
      ? record.thinking as ThinkingContent[]
      : undefined,
    toolCallId,
    media: record.media,
    createdAt,
  };
}

function parseArchivedMessageRole(value: unknown): MessageRole {
  if (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "toolResult"
  ) {
    return value;
  }
  throw new Error(`invalid archived message role: ${String(value)}`);
}

function formatGenerationFailure(message: string): string {
  const normalized = message.trim();
  if (!normalized) {
    return "Generation failed.";
  }
  return `Generation failed: ${normalized}`;
}

function approvalRuleKey(rule: ToolApprovalRule): string {
  return JSON.stringify({
    match: rule.match,
    when: rule.when ?? null,
    action: rule.action,
  });
}

async function gzip(input: string): Promise<ArrayBuffer> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzip(input: ArrayBuffer): Promise<string> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function uint8ArrayToBase64(data: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let index = 0; index < data.length; index += chunkSize) {
    const slice = data.subarray(index, index + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(""));
}
