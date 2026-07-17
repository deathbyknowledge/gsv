/**
 * Process DO — the "smart process" that runs an agent loop.
 *
 * All mutable state (messages, tool calls, metadata) is managed by
 * ProcessStore (SQLite-backed). Communicates with the kernel
 * exclusively via recvFrame RPC in both directions.
 *
 * Agent loop: user message → LLM call → tool dispatch → collect results →
 * LLM call → ... → proc.run.finished signal.
 * Each "turn" is scheduled via this.schedule() to avoid subrequest limits.
 */

import { Agent as Host } from "agents";
import type {
  Frame,
  FrameBody,
  RequestFrame,
  ResponseFrame,
  ResponseErrFrame,
  ResponseOkFrame,
  SignalFrame,
} from "../protocol/frames";
import type { ArgsOf, ResultOf, SyscallName, ToolDefinition } from "../syscalls";
import type { CodeModeExecArgs, CodeModeRunArgs, CodeModeRunResult } from "../syscalls/codemode";
import { COMPACTION_SUMMARY_SYSTEM_PROMPT } from "../prompts/compaction";
import type {
  AiConfigResult,
  AiTextGenerateConfig,
  AiTextGenerateOptions,
  AiToolsDevice,
  AdapterMessageDestination,
  InteractionOrigin,
  NetFetchArgs,
  ProcessIdentity,
  ProcSendArgs,
  ProcSendResult,
  ProcIpcDeliverArgs,
  ProcIpcDeliverResult,
  ProcAbortArgs,
  ProcAbortResult,
  ProcAiConfigGetArgs,
  ProcAiConfigGetResult,
  ProcAiConfigSetArgs,
  ProcAiConfigSetResult,
  ProcHilArgs,
  ProcHilResult,
  ProcHilRequest,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcHistoryMessage,
  ProcHistoryToolResultContent,
  ProcMediaInput,
  ProcMediaDeleteArgs,
  ProcMediaDeleteResult,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcMediaWriteArgs,
  ProcMediaWriteResult,
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
  ProcConversationSegmentReadArgs,
  ProcConversationSegmentReadResult,
  ProcConversationSegmentsArgs,
  ProcConversationSegmentsResult,
  ProcConversationArchiveKind,
  ProcConversationTimelineEntry,
  ProcConversationTimelineArgs,
  ProcConversationTimelineResult,
  ProcConversationGenerationsArgs,
  ProcConversationGenerationsResult,
  ProcConversationGenerationManifest,
  ProcConversationGenerationManifestArgs,
  ProcConversationGenerationManifestResult,
  ProcConversationLiveGeneration,
  ProcArchiveEntry,
  ProcContextState,
  ProcUsageCostSource,
  ProcUsageState,
  ProcToolResultOutcome,
  ProcResetResult,
  ProcKillResult,
  ProcSpawnAssignment,
} from "@humansandmachines/gsv/protocol";
import { REQUEST_CANCEL_SIGNAL } from "@humansandmachines/gsv/protocol";
import type { AdapterSurface } from "../adapter-interface";
import type {
  ProcessAdapterDeliverResponseFrame,
  ProcessInboundFrame,
  ProcessRequestFrame,
  ProcessRunAttachArgs,
  ProcessRunAttachResult,
  ProcessScheduleDeliverArgs,
  ProcessScheduleDeliverResponseFrame,
} from "../protocol/process-frames";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
  Context,
  Message,
  Tool,
  UserMessage,
  ImageContent,
} from "@earendil-works/pi-ai";
import { createGenerationService } from "../inference/service";
import {
  errorMessageFromUnknown,
  formatProviderErrorMessage,
  formatProviderContextOverflowMessage,
  isProviderContextOverflow,
  isProviderContextOverflowErrorMessage,
} from "../inference/errors";
import {
  describeAssistantResponseFailure,
  hasRawToolCallMarkupOutput,
  isRetryableAssistantResponseFailure,
  isRetryableGenerationErrorMessage,
} from "../inference/output";
import {
  ProcessStore,
  parseAssistantMessageMeta,
  parseMessageMetadata,
  normalizeMessageMetadata,
  stringifyAssistantMessageMeta,
  type MessageRole,
  type MessageMetadata,
  type MessageRecord,
  type PendingHilRecord,
  type QueuedMessage,
} from "./store";
import {
  parseToolApprovalPolicy,
  resolveToolApproval,
  resolveToolApprovalTarget,
  type ToolApprovalRule,
  type ToolApprovalPolicy,
} from "./approval";
import {
  buildImageBlock,
  deleteProcessMedia,
  describeStoredProcessMedia,
  parseStoredProcessMedia,
  processMediaPath,
  processMediaPrefix,
  storeIncomingProcessMedia,
  stringifyStoredProcessMedia,
  type StoredProcessMedia,
  type StoreIncomingProcessMediaOptions,
} from "./media";
import {
  buildProcContextState,
  estimateContextInputTokens,
} from "./context-pressure";
import {
  hasWorkersAiModelPricing,
  isWorkersAiProvider,
} from "../inference/workers-ai";
import { isVectorImageMimeType } from "../inference/image-mime";
import { stableOpaqueId } from "../shared/stable-id";
import {
  agentArchiveMediaPath,
  agentArchiveMediaPrefix,
  isValidAgentArchiveMediaObject,
} from "../shared/process-media-path";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../shared/message-media-limits";
import { assembleSystemPrompt } from "./context";
import {
  cancelProcessRequests,
  requestProcessNetFetch,
  sendFrameToKernel,
} from "../shared/utils";
import { raceWithAbort } from "../shared/abort";
import { encodeBase64Bytes } from "../shared/base64";
import {
  CODEMODE_EXEC,
  TOOL_TO_SYSCALL,
  SYSCALL_TOOL_NAMES,
} from "../syscalls/constants";
import { RipgitClient } from "../fs/ripgit/client";
import {
  buildCodeModeMcpToolBindings,
  executeCodeMode,
} from "./codemode";
import {
  createCodeModeRequest,
} from "../codemode/request";
import { formatAgentToolResponse, materializeToolResponse } from "./tool-response";
import {
  DEFAULT_CONVERSATION_ID,
  normalizeConversationId,
  type ProcessConversationRecord,
} from "./conversations";
import {
  createProcessAiConfigSnapshot,
  isProcessAiConfigKey,
  redactProcessAiConfigSnapshot,
} from "./ai-config";
import { runProcessSqlMigrations } from "./schema/migrations";
import { hasCapability } from "../kernel/capabilities";
import {
  normalizeNetFetchTimeoutMs,
  normalizeTarget,
  requestNetFetchWithSignal,
  requestToNetFetchArgs,
  responseFromNetFetchResult,
} from "../kernel/net";

type RunState = {
  runId: string;
  conversationId: string;
  origin?: InteractionOrigin;
  tickGeneration?: number;
  pendingMediaMessageId?: number;
  pendingRuntimeEvents?: number;
  config?: AiConfigResult;
  aiTextGenerateConfig?: AiTextGenerateConfig;
  tools?: ToolDefinition[];
  devices?: AiToolsDevice[];
  mcpServers?: string[];
  systemPrompt?: string;
  approvalPolicy?: ToolApprovalPolicy;
  outputMedia?: RunOutputMedia[];
  stagedOutputMediaKeys?: string[];
  outputMediaPersisted?: boolean;
};

type RunOutputMedia = ProcMediaInput & {
  key: string;
  path: string;
  size: number;
};

type RunFinishStatus = "ok" | "error" | "aborted";

type RunFinishOptions = {
  reason: string;
  status?: RunFinishStatus;
  text?: string | null;
  error?: string | null;
  usage?: unknown;
};

type StreamSeqCounter = {
  value: number;
};

type RoutedFetchInit = RequestInit & { timeoutMs?: number };

type CodeModeResponseWaiter = {
  runId: string | null;
  call: SyscallName;
  args: Record<string, unknown>;
  resolve: (frame: ResponseFrame) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type CodeModeApprovalWaiter = {
  runId: string;
  dispatchId: string;
  resolve: (approved: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type ProcessArchiveResult = {
  archivedMessages: number;
  archivedTo?: string;
  archives: ProcArchiveEntry[];
};

type PreparedToolArgs = {
  args: unknown;
  missingShellSessionTarget: boolean;
};

type ArchivedMessageRecord = {
  id?: number;
  runId?: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  thinking?: ThinkingContent[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  outcome?: ProcToolResultOutcome;
  media?: unknown;
  origin?: InteractionOrigin;
  metadata?: MessageMetadata;
  createdAt?: number;
};

type ArchivedMediaRewrite =
  | { key: string; path: string }
  | { missing: true };

type RuntimeEventAdmission =
  | { ok: true; runId: string; queued: boolean }
  | { ok: false; error: string };

const TOOL_APPROVAL_OVERRIDES_KEY = "toolApprovalOverrides";
const MAX_RUN_FINISH_DELIVERY_ATTEMPTS = 10;
const HANDLED_IPC_CALLS_KEY = "handledIpcCalls";
const ABORTED_RUN_IDS_KEY = "abortedRunIds";
const DELIVERY_NOTICE_IDS_KEY = "deliveryNoticeIds";
const PROCESS_RESET_AT_KEY = "processResetAt";
const PENDING_RUN_FINISHES_KEY = "pendingRunFinishes";
const IPC_TOMBSTONE_LIMIT = 256;
const DELIVERY_NOTICE_TOMBSTONE_LIMIT = 256;
const SHELL_SESSION_TARGET_KEY_PREFIX = "shellSessionTarget:";
const UNKNOWN_SHELL_SESSION_TARGET_MESSAGE =
  "Shell session continuation requires an explicit target because this process does not know which device owns the session";
const USER_INTERRUPTED_TOOL_MESSAGE = "User interrupted tool execution";
const USER_SUPERSEDED_TOOL_MESSAGE =
  "Cancelled for this agent run because a newer user message arrived; the underlying operation may still complete";
const TOOL_EXECUTION_DENIED_BY_USER_MESSAGE = "Tool execution denied by user";
const RUNTIME_EVENT_WAKE_MESSAGE =
  "A runtime event arrived while you were busy. Review the process event above and continue.";
const MAX_PROCESS_MEDIA_READ_BYTES = 25 * 1024 * 1024;
const CODE_MODE_NESTED_SYSCALL_TIMEOUT_MS = 55_000;
const CODE_MODE_APPROVAL_TIMEOUT_MS = 55_000;
const TOOL_DISPATCH_TIMEOUT_MS = 10 * 60_000;
const MEDIA_PREPARATION_TIMEOUT_MS = 10 * 60_000;
const COMPACTION_SUMMARY_WINDOW_CHARS = 24_000;
const COMPACTION_GENERATION_TIMEOUT_MS = 30_000;
const CONTEXT_PROVIDER_OVERFLOW_REASON = "context.provider_overflow";
const MAX_RETRYABLE_GENERATION_ATTEMPTS = 3;
const MAX_CANCELLED_REQUESTS = 128;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeToolResultOutcome(
  value: unknown,
  isError: boolean,
  content: string,
): ProcToolResultOutcome {
  if (
    value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "denied"
  ) {
    return value;
  }
  if (!isError) {
    return "completed";
  }

  const reason = content.startsWith("Error: ")
    ? content.slice("Error: ".length)
    : content;
  if (reason === TOOL_EXECUTION_DENIED_BY_USER_MESSAGE) {
    return "denied";
  }
  if (reason === USER_INTERRUPTED_TOOL_MESSAGE || reason === USER_SUPERSEDED_TOOL_MESSAGE) {
    return "cancelled";
  }
  return "failed";
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function cancelResponseBody(frame: ResponseFrame, reason: string): Promise<void> {
  if (frame.ok && frame.body) {
    await frame.body.stream.cancel(reason).catch(() => {});
  }
}

function buildAssistantMessageMetadata(
  response: AssistantMessage,
  config: AiConfigResult,
  fallback?: MessageMetadata["fallback"],
): MessageMetadata | undefined {
  const usage = assistantUsageToProcUsageState(
    response.usage,
    resolveUsageCostSource(response, config),
  );
  const metadata = normalizeMessageMetadata({
    provider: {
      api: response.api,
      provider: response.provider || config.provider,
      model: response.model || config.model,
      responseModel: response.responseModel,
      responseId: response.responseId,
      stopReason: response.stopReason,
    },
    fallback,
    usage,
  });
  return metadata ?? undefined;
}

function modelMetadataFromAiConfig(config: AiConfigResult): NonNullable<MessageMetadata["fallback"]>["from"] {
  return {
    provider: config.provider,
    model: config.model,
  };
}

function assistantUsageToProcUsageState(
  usage: AssistantMessage["usage"] | undefined,
  costSource: ProcUsageCostSource | null,
): ProcUsageState | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = normalizeNonNegativeNumber(usage.input) ?? 0;
  const outputTokens = normalizeNonNegativeNumber(usage.output) ?? 0;
  const cacheReadTokens = normalizeNonNegativeNumber(usage.cacheRead) ?? 0;
  const cacheWriteTokens = normalizeNonNegativeNumber(usage.cacheWrite) ?? 0;
  const totalTokens = normalizeNonNegativeNumber(usage.totalTokens) ?? inputTokens + outputTokens;
  const cost = costSource
    ? {
        input: normalizeNonNegativeNumber(usage.cost?.input) ?? 0,
        output: normalizeNonNegativeNumber(usage.cost?.output) ?? 0,
        cacheRead: normalizeNonNegativeNumber(usage.cost?.cacheRead) ?? 0,
        cacheWrite: normalizeNonNegativeNumber(usage.cost?.cacheWrite) ?? 0,
        total: normalizeNonNegativeNumber(usage.cost?.total)
          ?? (normalizeNonNegativeNumber(usage.cost?.input) ?? 0)
            + (normalizeNonNegativeNumber(usage.cost?.output) ?? 0)
            + (normalizeNonNegativeNumber(usage.cost?.cacheRead) ?? 0)
            + (normalizeNonNegativeNumber(usage.cost?.cacheWrite) ?? 0),
        currency: "USD" as const,
        source: costSource,
      }
    : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cost,
    ...(costSource ? {} : { costIncomplete: true }),
    updatedAt: Date.now(),
  };
}

function resolveUsageCostSource(
  response: AssistantMessage,
  config: AiConfigResult,
): ProcUsageCostSource | null {
  if (isWorkersAiProvider(config.provider) || isWorkersAiProvider(response.provider)) {
    const pricedModel = [response.model, response.responseModel, config.model]
      .filter((model): model is string => typeof model === "string" && model.length > 0)
      .some((model) => hasWorkersAiModelPricing(model));
    return pricedModel || usageCostHasValue(response.usage) ? "model-pricing" : null;
  }
  return usageCostHasValue(response.usage) || !usageHasPositiveTokens(response.usage)
    ? "provider"
    : null;
}

function usageCostHasValue(usage: AssistantMessage["usage"] | undefined): boolean {
  if (!usage) {
    return false;
  }
  return [
    usage.cost?.input,
    usage.cost?.output,
    usage.cost?.cacheRead,
    usage.cost?.cacheWrite,
    usage.cost?.total,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function usageHasPositiveTokens(usage: AssistantMessage["usage"] | undefined): boolean {
  if (!usage) {
    return false;
  }
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
    && typeof identity.cwd === "string";
}

function isIpcCallEnvelope(value: unknown): value is NonNullable<ProcIpcDeliverArgs["call"]> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const call = value as Partial<NonNullable<ProcIpcDeliverArgs["call"]>>;
  return typeof call.callId === "string"
    && call.callId.trim().length > 0
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
  return value === "auto-compact" || value === "fail";
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
  const source = `${args.source.username} (${args.sourcePid})`;
  const lines = args.call
    ? [
        `Delegated task from ${source}.`,
        `Received: ${sentAt}.`,
        "",
        args.message,
      ]
    : [
        `Message from ${source}.`,
        `Sent: ${sentAt}.`,
        "",
        args.message,
      ];
  const renderedMetadata = renderJsonBlock(args.metadata);
  if (renderedMetadata) {
    lines.push("", "Additional context:", "```json", renderedMetadata, "```");
  }
  if (args.call) {
    lines.push(
      "",
      `Please complete this task before ${new Date(args.call.deadlineAt).toISOString()}.`,
      "Your final answer will be returned to the caller automatically.",
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
  const error = typeof record.error === "string" && record.error.trim().length > 0
    ? record.error.trim()
    : null;
  const response = "response" in record ? record.response : undefined;
  const responseText = response && typeof response === "object" && !Array.isArray(response)
    ? (response as Record<string, unknown>).text
    : null;
  const renderedResponse = renderJsonBlock(response);

  const lines = [
    signal === "ipc.timeout"
      ? `Delegated task to process \`${targetPid}\` timed out.`
      : `Delegated task from process \`${targetPid}\` finished.`,
  ];
  if (callId !== "unknown") {
    lines.push(`Task id: \`${callId}\`.`);
  }
  if (error) {
    lines.push("", "Error:", error);
  }
  if (typeof responseText === "string" && responseText.trim().length > 0) {
    lines.push("", "Result:", responseText.trim());
  } else if (renderedResponse) {
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

function compareConversationTimelineEntries(
  a: ProcConversationTimelineEntry,
  b: ProcConversationTimelineEntry,
): number {
  const generationDelta = a.generation - b.generation;
  if (generationDelta !== 0) return generationDelta;
  if (a.type === "live" || b.type === "live") {
    return timelineEntryTypeRank(a.type) - timelineEntryTypeRank(b.type);
  }
  const timeDelta = timelineEntryTimestamp(a) - timelineEntryTimestamp(b);
  if (timeDelta !== 0) return timeDelta;
  return timelineEntryTypeRank(a.type) - timelineEntryTypeRank(b.type);
}

function timelineEntryTimestamp(entry: ProcConversationTimelineEntry): number {
  return entry.type === "live" ? entry.updatedAt : entry.createdAt;
}

function timelineEntryTypeRank(type: ProcConversationTimelineEntry["type"]): number {
  switch (type) {
    case "archive": return 0;
    case "segment": return 1;
    case "live": return 2;
  }
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
    overflow: "auto-compact",
    compactAtPressure: 0.9,
    keepLast: 80,
    updatedAt: 0,
  };
}

function buildCompactionSummaryContext(messages: MessageRecord[]): Context {
  const transcript = renderCompactionTranscriptWindow(messages, COMPACTION_SUMMARY_WINDOW_CHARS);
  return {
    systemPrompt: COMPACTION_SUMMARY_SYSTEM_PROMPT,
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
  const complete: string[] = [];
  let completeChars = 0;
  for (const message of messages) {
    const remaining = maxChars - completeChars - (complete.length > 0 ? 1 : 0);
    if (message.content.length > remaining) break;
    const line = JSON.stringify(serializeArchivedMessage(message));
    if (line.length > remaining) break;
    complete.push(line);
    completeChars += line.length + (complete.length > 1 ? 1 : 0);
  }
  if (complete.length === messages.length) {
    return complete.join("\n");
  }

  const omissionBudget = JSON.stringify({ omitted_messages: messages.length }).length + 2;
  const recordsBudget = Math.max(0, maxChars - omissionBudget);
  const headBudget = Math.floor(recordsBudget * 0.35);
  const tailBudget = recordsBudget - headBudget;
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  let firstOmitted = 0;
  let lastOmitted = messages.length;

  while (firstOmitted < messages.length) {
    const line = fitCompactionRecord(messages[firstOmitted]!, headBudget - headChars);
    if (!line) break;
    head.push(line);
    headChars += line.length + 1;
    firstOmitted += 1;
  }
  while (lastOmitted > firstOmitted) {
    const line = fitCompactionRecord(messages[lastOmitted - 1]!, tailBudget - tailChars);
    if (!line) break;
    tail.unshift(line);
    tailChars += line.length + 1;
    lastOmitted -= 1;
  }

  const omitted = JSON.stringify({ omitted_messages: lastOmitted - firstOmitted });
  return [...head, omitted, ...tail].join("\n");
}

function fitCompactionRecord(message: MessageRecord, maxChars: number): string | null {
  if (maxChars <= 0) return null;
  if (message.content.length <= maxChars) {
    const full = JSON.stringify(serializeArchivedMessage(message));
    if (full.length <= maxChars) return full;
  }

  let previewChars = Math.min(message.content.length, Math.floor(maxChars / 6));
  while (previewChars >= 0) {
    const preview = JSON.stringify({
      id: message.id,
      role: message.role,
      content_preview: message.content.slice(0, previewChars),
      content_omitted_chars: message.content.length - previewChars,
      record_truncated: true,
    });
    if (preview.length <= maxChars) return preview;
    if (previewChars === 0) break;
    previewChars = Math.floor(previewChars / 2);
  }
  return null;
}

export class Process extends Host<Env> {
  private readonly store: ProcessStore;
  private readonly generation = createGenerationService();
  private readonly ripgit: RipgitClient | null;
  private readonly codeModeResponses = new Map<string, CodeModeResponseWaiter>();
  private readonly codeModeApprovals = new Map<string, CodeModeApprovalWaiter>();
  private readonly requestControllers = new Map<string, AbortController>();
  private readonly cancelledRequests = new Map<string, string>();
  private readonly runAbortControllers = new Map<string, AbortController>();
  private readonly activeTickRunIds = new Set<string>();
  private readonly deferredTickRunIds = new Set<string>();
  private readonly mediaWriteAdmissions = new Map<string, Promise<void>>();
  private readonly mediaUploadAbortControllers = new Map<string, AbortController>();
  private lifecycleTransition: Promise<void> = Promise.resolve();
  private lifecycleEpoch = 0;
  private queuedSendAdmission: Promise<void> = Promise.resolve();
  private killed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    runProcessSqlMigrations(ctx.storage);
    this.store = new ProcessStore(ctx.storage.sql);
    this.store.ensureConversation(DEFAULT_CONVERSATION_ID);
    this.ripgit = env.RIPGIT
      ? new RipgitClient(env.RIPGIT)
      : null;
    const recoveredRun = this.currentRun;
    if (
      recoveredRun?.pendingMediaMessageId !== undefined
      && this.store.hasMessageMedia(recoveredRun.pendingMediaMessageId, recoveredRun.runId)
    ) {
      delete recoveredRun.pendingMediaMessageId;
      this.currentRun = recoveredRun;
    }
    if (
      recoveredRun
      && !this.store.getPendingHilForRun(recoveredRun.runId)
      && recoveredRun.pendingMediaMessageId === undefined
    ) {
      this.ctx.waitUntil(this.scheduleTick(recoveredRun.runId));
    }
    const pendingFinishes = JSON.parse(
      this.store.getValue(PENDING_RUN_FINISHES_KEY) ?? "[]",
    ) as Array<{ runId: string }>;
    for (const finish of pendingFinishes) {
      this.ctx.waitUntil(this.onRunFinishDelivery(finish.runId));
    }
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

  private isInitialized(): boolean {
    return this.store.getValue("pid") !== null
      && this.store.getValue("identity") !== null;
  }

  /**
   * Whether this process may request human-in-the-loop approval. Stored per
   * process at spawn time; defaults to interactive when unset.
   */
  get interactive(): boolean {
    const raw = this.store.getValue("interactive");
    if (raw === "0") return false;
    return true;
  }

  /**
   * The kernel conversation id this executor's primary ("default") thread maps
   * to, when assigned at spawn. Drives where the primary thread's transcripts
   * are archived/hydrated under the agent home, decoupling them from the pid.
   */
  private get primaryConversationId(): string | null {
    return this.store.getValue("primaryConversationId");
  }

  /**
   * Single entry point — called by the Kernel to deliver frames.
   */
  async recvFrame(frame: ProcessInboundFrame) {
    if (this.killed) {
      if (frame.type === "req") {
        await frame.body?.stream.cancel("Process no longer exists").catch(() => {});
        return {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: 410, message: "Process no longer exists" },
        } satisfies ResponseErrFrame;
      }
      if (frame.type === "res") {
        await cancelResponseBody(frame, "Process no longer exists");
      }
      return null;
    }
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
      if (frame.ok) {
        this.rememberShellSessionTargetFromResult(
          codeModeWaiter.call,
          codeModeWaiter.args,
          frame.data ?? null,
        );
      }
      codeModeWaiter.resolve(frame);
      return;
    }

    const pending = this.store.getPending(frame.id);
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
          this.runAbortSignal(pending.runId),
        );
        this.rememberShellSessionTargetFromResult(pending.call, pending.args, result);
        this.store.resolve(
          frame.id,
          formatAgentToolResponse(pending.call, pending.args, result),
        );
      } catch (error) {
        this.store.fail(
          frame.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      this.store.fail(frame.id, frame.error.message);
    }

    await this.resumeResolvedToolRun(pending.runId);
  }

  /**
   * Handle a request frame from the kernel.
   * proc.send, proc.history, proc.reset, proc.kill are delivered here.
   */
  private async handleReq(
    frame: ProcessRequestFrame,
  ): Promise<ResponseFrame | ProcessScheduleDeliverResponseFrame | ProcessAdapterDeliverResponseFrame | null> {
    try {
      if (frame.call === "proc.adapter.deliver") {
        const { runId, ...args } = frame.args;
        const result = await this.handleProcSend(args, runId);
        return { type: "res", id: frame.id, ok: true, data: result };
      }
      if (frame.call === "proc.schedule.deliver") {
        const result = await this.handleProcScheduleDeliver(frame.args);
        return { type: "res", id: frame.id, ok: true, data: result };
      }

      let data: ResultOf<SyscallName>;

      switch (frame.call) {
        case "proc.setidentity": {
          const idArgs = frame.args as unknown as {
            pid: string;
            identity: ProcessIdentity;
            interactive?: boolean;
            assignment?: ProcSpawnAssignment;
            conversationId?: string;
            hydrateFrom?: string;
          };
          this.store.setValue("pid", idArgs.pid);
          this.store.setValue("identity", JSON.stringify(idArgs.identity));
          if (idArgs.interactive !== undefined) {
            this.store.setValue("interactive", idArgs.interactive ? "1" : "0");
          }
          if (idArgs.conversationId) {
            this.store.setValue("primaryConversationId", idArgs.conversationId);
          }
          this.store.setProcessContextFiles(idArgs.assignment?.contextFiles ?? []);
          if (idArgs.hydrateFrom) {
            await this.hydratePrimaryConversation(idArgs.hydrateFrom);
          }
          let startedRunId: string | undefined;
          if (idArgs.assignment?.autoStart && !this.currentRun) {
            startedRunId = crypto.randomUUID();
            this.currentRun = {
              runId: startedRunId,
              conversationId: DEFAULT_CONVERSATION_ID,
            };
            await this.scheduleTick(startedRunId);
            await this.announceRun(startedRunId, DEFAULT_CONVERSATION_ID, "assignment.autostart");
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
          data = await this.handleProcIpcDeliver(
            frame.args as ProcIpcDeliverArgs,
          );
          break;
        case "proc.abort":
          data = await this.handleProcAbort(frame.args as ProcAbortArgs);
          break;
        case "proc.hil":
          data = await this.handleProcHil(
            frame.args as ProcHilArgs,
          );
          break;
        case "codemode.run":
          data = await this.handleCancellableRequest(frame.id, (signal) =>
            this.handleCodeModeRun(frame.args as CodeModeRunArgs, signal)
          );
          break;
        case "proc.history":
          data = await this.handleProcHistory(
            frame.args as ProcHistoryArgs,
          );
          break;
        case "proc.ai.config.get":
          data = this.handleProcAiConfigGet(
            (frame.args ?? {}) as ProcAiConfigGetArgs,
          );
          break;
        case "proc.ai.config.set":
          data = await this.handleProcAiConfigSet(
            (frame.args ?? {}) as ProcAiConfigSetArgs,
          );
          break;
        case "proc.media.read":
          return {
            type: "res",
            id: frame.id,
            ok: true,
            ...await this.handleProcMediaRead(frame.args as ProcMediaReadArgs),
          };
        case "proc.media.write":
          data = await this.handleProcMediaWrite(
            frame.args as ProcMediaWriteArgs,
            frame.body,
          );
          break;
        case "proc.media.delete":
          data = await this.handleProcMediaDelete(
            frame.args as ProcMediaDeleteArgs,
            frame.body,
          );
          break;
        case "proc.run.attach":
          data = await this.handleProcRunAttach(
            frame.args as ProcessRunAttachArgs,
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
          data = await this.handleCancellableRequest(frame.id, (signal) =>
            this.handleConversationCompact(
              (frame.args ?? {}) as ProcConversationCompactArgs,
              { signal },
            )
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
        case "proc.conversation.timeline":
          data = this.handleConversationTimeline(
            (frame.args ?? {}) as ProcConversationTimelineArgs,
          );
          break;
        case "proc.conversation.generations":
          data = this.handleConversationGenerations(
            (frame.args ?? {}) as ProcConversationGenerationsArgs,
          );
          break;
        case "proc.conversation.generation.manifest":
          data = this.handleConversationGenerationManifest(
            (frame.args ?? {}) as ProcConversationGenerationManifestArgs,
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

  private async handleProcSend(
    args: ProcSendArgs,
    admittedRunId?: string,
  ): Promise<ProcSendResult> {
    if (!this.isInitialized()) {
      return { ok: false, error: "Process no longer exists" };
    }
    if (args.media !== undefined && !Array.isArray(args.media)) {
      return { ok: false, error: "proc.send media must be an array" };
    }
    if (args.media?.some((item) => !item || typeof item !== "object")) {
      return { ok: false, error: "proc.send media entries must be objects" };
    }
    if (args.media?.some((item) => "data" in item)) {
      return { ok: false, error: "proc.send media.data was removed; use proc.media.write" };
    }
    const mediaPrefix = processMediaPrefix(this.identity.uid, this.pid);
    if (args.media?.some((item) =>
      typeof item.key === "string"
      && item.key.length > 0
      && (!item.key.startsWith(mediaPrefix) || !processMediaPath(item.key))
    )) {
      return { ok: false, error: "media key is outside this process" };
    }
    const mediaKeys = [...new Set((args.media ?? []).flatMap((item) =>
      typeof item.key === "string" && item.key.length > 0 ? [item.key] : []
    ))].sort();
    const runId = admittedRunId ?? crypto.randomUUID();
    if (admittedRunId) {
      const existing = this.existingRunAdmission(runId);
      if (existing) return existing;
    }
    const conversationId = normalizeConversationId(args.conversationId);
    const conversation = this.store.ensureConversation(conversationId);
    if (conversation.status === "closed") {
      return { ok: false, error: `Conversation is closed: ${conversationId}` };
    }
    const origin = serializeInteractionOrigin(args.origin);
    const userCanInterrupt =
      args.origin?.kind !== "process" && args.origin?.kind !== "scheduler";

    if (!userCanInterrupt) {
      const releaseMedia = await this.acquireMediaKeyAdmissions(mediaKeys);
      const releaseAdmission = await this.acquireQueuedSendAdmission();
      try {
        if (admittedRunId) {
          const existing = this.existingRunAdmission(runId);
          if (existing) return existing;
        }
        const media = await storeIncomingProcessMedia(
          this.env.STORAGE,
          this.identity.uid,
          this.pid,
          args.media,
          await this.resolveMediaProcessingOptions(args.media),
        );
        const releaseLifecycle = await this.acquireLifecycleTransition();
        try {
          if (!this.isInitialized()) {
            return { ok: false, error: "Process no longer exists" };
          }
          const missingMediaKey = await this.firstMissingMediaKey(mediaKeys);
          if (missingMediaKey) {
            return { ok: false, error: `media not found: ${missingMediaKey}` };
          }
          if (admittedRunId) {
            const existing = this.existingRunAdmission(runId);
            if (existing) return existing;
          }
          if (this.currentRun) {
            this.store.enqueue(runId, args.message, media ?? undefined, conversationId, origin ?? undefined);
            await this.emitProcChanged(["queue"], { conversationId, enqueuedRunId: runId });
            return { ok: true, status: "started", runId, queued: true };
          }

          this.store.appendMessage("user", args.message, {
            conversationId,
            runId,
            media: media ?? undefined,
            origin: origin ?? undefined,
          });
          this.currentRun = { runId, conversationId, ...(args.origin ? { origin: args.origin } : {}) };
          this.ctx.waitUntil(this.scheduleTick(runId).catch(async (error) => {
            if (this.currentRun?.runId !== runId) {
              return;
            }
            await this.finishRun(runId, {
              reason: "schedule.error",
              status: "error",
              text: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }));
          this.ctx.waitUntil(this.announceRun(runId, conversationId, "proc.send"));
          return { ok: true, status: "started", runId };
        } finally {
          releaseLifecycle();
        }
      } finally {
        releaseAdmission();
        releaseMedia();
      }
    }

    const hasMedia = (args.media?.length ?? 0) > 0;
    const releaseMedia = await this.acquireMediaKeyAdmissions(mediaKeys);
    const releaseLifecycle = await this.acquireLifecycleTransition();
    try {
      if (!this.isInitialized()) {
        return { ok: false, error: "Process no longer exists" };
      }
      const missingMediaKey = await this.firstMissingMediaKey(mediaKeys);
      if (missingMediaKey) {
        return { ok: false, error: `media not found: ${missingMediaKey}` };
      }
      if (admittedRunId) {
        const existing = this.existingRunAdmission(runId);
        if (existing) return existing;
      }
      const activeRun = this.currentRun;
      let interrupted: { interrupted: number; appended: number } | null = null;
      if (activeRun) {
        this.cancelPendingRequests(activeRun.runId, USER_SUPERSEDED_TOOL_MESSAGE);
        this.rememberAbortedRun(activeRun.runId);
        interrupted = this.ingestToolResults(
          activeRun.runId,
          this.store.getResults(activeRun.runId),
          { interruptPending: USER_SUPERSEDED_TOOL_MESSAGE },
        );
        this.store.clearPendingHil();
        this.rejectCodeModeWaiters(
          activeRun.runId,
          USER_SUPERSEDED_TOOL_MESSAGE,
        );
      }

      const messageId = this.store.appendMessage("user", args.message, {
        conversationId,
        runId,
        media: hasMedia ? stringifyStoredProcessMedia(args.media!) ?? undefined : undefined,
        origin: origin ?? undefined,
      });
      this.currentRun = {
        runId,
        conversationId,
        ...(args.origin ? { origin: args.origin } : {}),
        ...(hasMedia ? { pendingMediaMessageId: messageId } : {}),
      };
      if (activeRun) {
        this.emitRunFinished(activeRun, {
          text: null,
          status: "aborted",
          reason: "user.superseded",
        });
      }
      if (hasMedia) {
        this.ctx.waitUntil(this.schedule(
          new Date(Date.now() + MEDIA_PREPARATION_TIMEOUT_MS),
          "onMediaPreparationTimeout",
          runId,
        ).catch((error) => this.failPendingMedia(
          runId,
          messageId,
          `Failed to schedule media timeout: ${error instanceof Error ? error.message : String(error)}`,
          "media.error",
        )));
      } else {
        this.ctx.waitUntil(this.scheduleTick(runId).catch(async (error) => {
          if (this.currentRun?.runId !== runId) {
            return;
          }
          const message = `Failed to schedule process run: ${error instanceof Error ? error.message : String(error)}`;
          await this.appendRuntimeMessage(message, { conversationId, runId });
          await this.finishRun(runId, {
            reason: "schedule.error",
            status: "error",
            text: null,
            error: message,
          });
        }));
      }
      if (activeRun && interrupted?.appended) {
        this.ctx.waitUntil(this.emitProcChanged(["messages"], {
          conversationId: activeRun.conversationId,
          runId: activeRun.runId,
        }));
      }
      this.ctx.waitUntil(this.announceRun(runId, conversationId, "proc.send"));

      if (hasMedia) {
        this.ctx.waitUntil(this.prepareRunMedia(
          runId,
          conversationId,
          messageId,
          args.media!,
        ));
      }
      return { ok: true, status: "started", runId };
    } finally {
      releaseLifecycle();
      releaseMedia();
    }
  }

  private existingRunAdmission(
    runId: string,
  ): Extract<ProcSendResult, { ok: true }> | null {
    if (this.currentRun?.runId === runId) {
      return { ok: true, status: "started", runId, replayed: "active" };
    }
    const located = this.store.locateRunAdmission(runId);
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

  private async prepareRunMedia(
    runId: string,
    conversationId: string,
    messageId: number,
    input: NonNullable<ProcSendArgs["media"]>,
  ): Promise<void> {
    const signal = this.runAbortSignal(runId);
    try {
      const options = await raceWithAbort(
        this.resolveMediaProcessingOptions(input),
        signal,
      );
      const media = await raceWithAbort(
        storeIncomingProcessMedia(
          this.env.STORAGE,
          this.identity.uid,
          this.pid,
          input,
          { ...options, signal },
        ),
        signal,
      );
      const releaseLifecycle = await this.acquireLifecycleTransition();
      let admitted = false;
      try {
        const run = this.currentRun;
        this.ctx.storage.transactionSync(() => {
          if (run?.runId === runId && run.pendingMediaMessageId === messageId) {
            if (media) {
              this.store.updateMessageMedia(messageId, runId, media);
            }
            delete run.pendingMediaMessageId;
            this.currentRun = run;
            admitted = true;
          }
        });
      } finally {
        releaseLifecycle();
      }
      if (admitted && media) {
        this.ctx.waitUntil(this.emitProcChanged(["messages"], {
          conversationId,
          runId,
          messageId,
        }).catch((error) => {
          console.warn(`[Process] Failed to emit media change for ${this.pid}:`, error);
        }));
      }
      if (!admitted) {
        return;
      }
      try {
        await this.scheduleTick(runId);
      } catch (error) {
        if (this.currentRun?.runId !== runId) {
          return;
        }
        const message = `Failed to schedule process run: ${error instanceof Error ? error.message : String(error)}`;
        await this.appendRuntimeMessage(message, { conversationId, runId });
        await this.finishRun(runId, {
          reason: "schedule.error",
          status: "error",
          text: null,
          error: message,
        });
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      const prefix = processMediaPrefix(this.identity.uid, this.pid);
      const keys = input.flatMap((item) =>
        typeof item.key === "string" && item.key.startsWith(prefix) ? [item.key] : []
      );
      const releaseLifecycle = await this.acquireLifecycleTransition();
      let unreferenced: string[];
      try {
        this.store.clearMessageMedia(messageId, runId);
        unreferenced = keys.filter((key) => !this.store.referencesMediaKey(key));
      } finally {
        releaseLifecycle();
      }
      if (unreferenced.length > 0) {
        await this.env.STORAGE.delete(unreferenced);
      }
      await this.failPendingMedia(
        runId,
        messageId,
        `Failed to prepare message media: ${error instanceof Error ? error.message : String(error)}`,
        "media.error",
      );
    }
  }

  private async failPendingMedia(
    runId: string,
    messageId: number,
    message: string,
    reason: "media.error" | "media.timeout",
  ): Promise<void> {
    const releaseLifecycle = await this.acquireLifecycleTransition();
    try {
      const run = this.currentRun;
      if (run?.runId !== runId || run.pendingMediaMessageId !== messageId) {
        return;
      }
      this.runAbortControllers.get(runId)?.abort(new Error(message));
      this.runAbortControllers.delete(runId);
      const conversationId = normalizeConversationId(run.conversationId);
      this.store.appendMessage("system", message, { conversationId, runId });
      this.emitRunFinished(run, {
        reason,
        status: "error",
        text: null,
        error: message,
      });
      this.currentRun = null;
      const next = this.claimNextQueuedRun();
      this.ctx.waitUntil(this.emitProcChanged(["messages"], { conversationId, runId }));
      this.promoteNextQueuedRun(next);
    } finally {
      releaseLifecycle();
    }
  }

  private async resolveMediaProcessingOptions(
    media: ProcSendArgs["media"],
  ): Promise<StoreIncomingProcessMediaOptions> {
    if (!media || media.length === 0) {
      return { ai: this.env.AI };
    }

    const config = await this.resolveAiConfig();
    return {
      ai: this.env.AI,
      audioTranscriptionProvider: config.media?.transcriptionProvider,
      audioTranscriptionModel: config.media?.transcriptionModel,
      audioTranscriptionApiKey: config.media?.transcriptionApiKey,
      maxTranscriptionBytes: config.media?.transcriptionMaxBytes,
      imageReadingProvider: config.media?.imageReadingProvider,
      imageReadingModel: config.media?.imageReadingModel,
      imageReadingApiKey: config.media?.imageReadingApiKey,
      imageReadingPrompt: config.media?.imageReadingPrompt,
      imageReadingInputFormat: config.media?.imageReadingInputFormat,
      imageReadingMaxBytes: config.media?.imageReadingMaxBytes,
      imageReadingMaxTokens: config.media?.imageReadingMaxTokens,
      imageReadingTimeoutMs: config.media?.imageReadingTimeoutMs,
    };
  }

  private handleProcAiConfigGet(args: ProcAiConfigGetArgs): ProcAiConfigGetResult {
    const snapshot = this.store.getAiConfigSnapshot();
    return {
      ok: true,
      pid: this.pid,
      config: args.redacted === false ? snapshot : redactProcessAiConfigSnapshot(snapshot),
    };
  }

  private async handleProcAiConfigSet(args: ProcAiConfigSetArgs): Promise<ProcAiConfigSetResult> {
    if (!args || typeof args !== "object") {
      return { ok: false, error: "proc.ai.config.set requires arguments" };
    }

    let snapshot: ReturnType<typeof createProcessAiConfigSnapshot> | null;
    if ("clear" in args && args.clear === true) {
      snapshot = null;
    } else if ("values" in args && args.values && typeof args.values === "object" && !Array.isArray(args.values)) {
      snapshot = createProcessAiConfigSnapshot(args.values, args.profile);
    } else if ("key" in args && typeof args.key === "string" && "value" in args) {
      if (!isProcessAiConfigKey(args.key)) {
        return { ok: false, error: `Unsupported AI config key: ${args.key}` };
      }
      const current = this.store.getAiConfigSnapshot();
      const values = { ...(current?.values ?? {}) };
      const value = String(args.value ?? "").trim();
      if (value) {
        values[args.key] = value;
      } else {
        delete values[args.key];
      }

      snapshot = createProcessAiConfigSnapshot(values, current?.profile);
    } else {
      return { ok: false, error: "proc.ai.config.set requires clear, values, or key/value" };
    }

    if (snapshot && (Object.keys(snapshot.values).length > 0 || snapshot.profile)) {
      this.store.setAiConfigSnapshot(snapshot);
    } else {
      snapshot = null;
      this.store.clearAiConfigSnapshot();
    }

    const config = redactProcessAiConfigSnapshot(snapshot);
    await this.emitProcChanged(["ai.config"], { aiConfig: config });
    return { ok: true, pid: this.pid, config };
  }

  private async handleProcIpcDeliver(args: ProcIpcDeliverArgs): Promise<ProcIpcDeliverResult> {
    if (!args || typeof args !== "object") {
      return { ok: false, error: "proc.ipc.deliver requires arguments" };
    }

    const runId = normalizeOptionalString(args.runId);
    if (!runId) {
      return { ok: false, error: "proc.ipc.deliver requires runId" };
    }

    const sourcePid = normalizeOptionalString(args.sourcePid);
    if (!sourcePid) {
      return { ok: false, error: "proc.ipc.deliver requires sourcePid" };
    }

    if (!isProcessIdentity(args.source)) {
      return { ok: false, error: "proc.ipc.deliver requires source identity" };
    }

    const message = normalizeOptionalString(args.message);
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

    const conversationId = normalizeConversationId(args.conversationId);
    const deliveredArgs: ProcIpcDeliverArgs = {
      runId,
      sourcePid,
      source: args.source,
      conversationId,
      message,
      metadata: args.metadata,
      origin: args.origin ?? { kind: "process", sourcePid, uid: args.source.uid },
      sentAt: Number.isFinite(args.sentAt) ? args.sentAt : Date.now(),
      ...(args.call ? { call: args.call } : {}),
    };
    const renderedMessage = formatIpcMessage(deliveredArgs);
    const origin = serializeInteractionOrigin(deliveredArgs.origin);
    const releaseAdmission = await this.acquireQueuedSendAdmission();
    try {
      const releaseLifecycle = await this.acquireLifecycleTransition();
      try {
        if (!this.isInitialized()) {
          return { ok: false, error: "Target process no longer exists" };
        }
        const conversation = this.store.ensureConversation(conversationId);
        if (conversation.status === "closed") {
          return { ok: false, error: `Conversation is closed: ${conversationId}` };
        }

        if (this.currentRun) {
          this.store.enqueue(runId, renderedMessage, undefined, conversationId, origin ?? undefined);
          this.ctx.waitUntil(this.emitProcChanged(["queue"], {
            conversationId,
            enqueuedRunId: runId,
          }));
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

        this.store.appendMessage("user", renderedMessage, {
          conversationId,
          runId,
          origin: origin ?? undefined,
        });
        this.currentRun = {
          runId,
          conversationId,
          ...(deliveredArgs.origin ? { origin: deliveredArgs.origin } : {}),
        };
        this.ctx.waitUntil(this.scheduleTick(runId)
          .then(() => this.announceRun(runId, conversationId, "proc.ipc.deliver"))
          .catch((error) => this.finishRun(runId, {
            reason: "schedule.error",
            status: "error",
            text: null,
            error: `Failed to schedule delegated task: ${errorMessageFromUnknown(error)}`,
          })));

        return {
          ok: true,
          status: "started",
          pid: this.pid,
          sourcePid,
          conversationId,
          runId,
        };
      } finally {
        releaseLifecycle();
      }
    } finally {
      releaseAdmission();
    }
  }

  private async handleProcAbort(args: ProcAbortArgs = {}): Promise<ProcAbortResult> {
    const pid = this.pid;
    const releaseLifecycle = await this.acquireLifecycleTransition();
    try {
      const run = this.currentRun;
      if (!run || (args.runId !== undefined && args.runId !== run.runId)) {
        return { ok: true, pid, aborted: false };
      }

      const runId = run.runId;
      this.cancelPendingRequests(runId, USER_INTERRUPTED_TOOL_MESSAGE);
      this.rememberAbortedRun(runId);
      const pendingHil = this.store.getPendingHilForRun(runId);
      const interrupted = this.ingestToolResults(runId, this.store.getResults(runId), {
        interruptPending: USER_INTERRUPTED_TOOL_MESSAGE,
      });

      if (pendingHil) {
        this.resolveCodeModeApproval(pendingHil.requestId, false);
      }
      this.store.clearPendingHil();
      this.rejectCodeModeWaiters(runId, "User interrupted CodeMode execution");

      this.emitRunFinished(run, {
        text: null,
        status: "aborted",
        reason: "user",
      });
      this.currentRun = null;
      const next = this.claimNextQueuedRun();

      if (interrupted.appended > 0) {
        this.ctx.waitUntil(this.emitProcChanged(["messages"], {
          conversationId: run.conversationId,
          runId,
        }));
      }
      this.promoteNextQueuedRun(next);

      return {
        ok: true,
        pid,
        aborted: true,
        runId,
        interruptedToolCalls: interrupted.interrupted,
        continuedQueuedRunId: next?.runId,
      };
    } finally {
      releaseLifecycle();
    }
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

    const toolCalls = this.store.getResults(pendingHil.runId);
    const codeModeApproval = this.codeModeApprovals.get(args.requestId);
    const toolCall = toolCalls.find(
      (result) => result.id === pendingHil.toolCallId && result.status === "registered",
    );
    if (codeModeApproval) {
      const remembered = args.decision === "approve" && args.remember === true
        ? this.rememberToolApproval(pendingHil, run)
        : false;
      if (args.decision === "deny") {
        this.store.fail(
          pendingHil.ownerDispatchId ?? codeModeApproval.dispatchId,
          TOOL_EXECUTION_DENIED_BY_USER_MESSAGE,
          "denied",
        );
      }
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

    if (!toolCall) {
      this.store.clearPendingHil();
      const outerCodeMode = pendingHil.ownerDispatchId
        ? toolCalls.find((result) => (
            result.dispatchId === pendingHil.ownerDispatchId
            && result.call === CODEMODE_EXEC
            && result.status === "pending"
          ))
        : undefined;
      const error = outerCodeMode
        ? args.decision === "deny"
          ? TOOL_EXECUTION_DENIED_BY_USER_MESSAGE
          : "CodeMode execution was interrupted while waiting for tool approval"
        : `Registered tool call not found: ${pendingHil.runId}/${pendingHil.toolCallId}`;
      if (outerCodeMode) {
        this.store.fail(
          outerCodeMode.dispatchId,
          error,
          args.decision === "deny" ? "denied" : "failed",
        );
        await this.scheduleTick(pendingHil.runId);
      }
      if (outerCodeMode && args.decision === "deny") {
        return {
          ok: true,
          pid,
          requestId: args.requestId,
          decision: args.decision,
          resumed: true,
          remembered: false,
          pendingHil: null,
        };
      }
      return { ok: false, error };
    }

    const remembered = args.decision === "approve" && args.remember === true
      ? this.rememberToolApproval(pendingHil, run)
      : false;

    this.store.clearPendingHil();
    if (args.decision === "approve") {
      const dispatchReady = await this.beginToolDispatch(
        pendingHil.runId,
        toolCall.dispatchId,
      );
      if (dispatchReady) {
        await this.emitToolStarted({
          name: pendingHil.toolName,
          syscall: pendingHil.syscall,
          args: pendingHil.args,
          callId: pendingHil.toolCallId,
          pid,
          runId: pendingHil.runId,
          conversationId: pendingHil.conversationId,
        });
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
      if (dispatchReady) {
        this.launchToolDispatch(
          pendingHil.runId,
          toolCall.dispatchId,
          pendingHil.syscall as SyscallName,
          toolCall.args,
          this.resolveToolApprovalPolicy(run),
        );
      }
    } else {
      this.store.fail(
        toolCall.dispatchId,
        TOOL_EXECUTION_DENIED_BY_USER_MESSAGE,
        "denied",
      );
    }

    const nextPendingHil = await this.processToolCalls(pendingHil.runId);
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

    if (!nextPendingHil) {
      await this.resumeResolvedToolRun(pendingHil.runId);
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
    const activeRun = this.currentRun;

    const messages: ProcHistoryMessage[] = records.map((r) => {
      const origin = parseInteractionOrigin(r.origin);
      const metadata = parseMessageMetadata(r.metadata);
      const run = r.runId ? { runId: r.runId } : {};
      const metadataPart = metadata ? { metadata } : {};
      if (r.role === "toolResult") {
        let meta: { toolName?: string; isError?: boolean; outcome?: unknown } = {};
        if (r.toolCalls) {
          try {
            meta = JSON.parse(r.toolCalls) as typeof meta;
          } catch {
            meta = {};
          }
        }
        const isError = meta.isError ?? false;
        const content = {
          toolName: meta.toolName ?? "unknown",
          isError,
          outcome: normalizeToolResultOutcome(meta.outcome, isError, r.content),
          toolCallId: r.toolCallId ?? null,
          output: r.content,
        } satisfies ProcHistoryToolResultContent;

        return {
          id: r.id,
          role: r.role,
          content,
          timestamp: r.createdAt,
          ...run,
          ...(origin ? { origin } : {}),
          ...metadataPart,
        };
      }

      if (r.role === "assistant" && r.toolCalls) {
        const meta = parseAssistantMessageMeta(r.toolCalls);
        const media = r.media ? this.parseOwnedProcessMedia(r.media) : [];
        return {
          id: r.id,
          role: r.role,
          content: {
            text: r.content,
            thinking: meta.thinking ?? [],
            toolCalls: meta.toolCalls ?? [],
            ...(media.length > 0 ? { media } : {}),
          },
          timestamp: r.createdAt,
          ...run,
          ...(origin ? { origin } : {}),
          ...metadataPart,
        };
      }

      if (r.media) {
        const media = this.parseOwnedProcessMedia(r.media);
        return {
          id: r.id,
          role: r.role,
          content: {
            text: r.content,
            media,
          },
          timestamp: r.createdAt,
          ...run,
          ...(origin ? { origin } : {}),
          ...metadataPart,
        };
      }

      return {
        id: r.id,
        role: r.role,
        content: r.content,
        timestamp: r.createdAt,
        ...run,
        ...(origin ? { origin } : {}),
        ...metadataPart,
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
      activeRunId: activeRun?.runId ?? null,
      activeConversationId: activeRun?.conversationId ?? null,
      pendingHil: this.toProcHilRequest(this.store.getPendingHil()),
      context: this.getContextStateForHistory(conversationId),
    };
  }

  private async handleProcMediaRead(
    args: ProcMediaReadArgs,
  ): Promise<{ data: ProcMediaReadResult; body?: FrameBody }> {
    const key = typeof args.key === "string" ? args.key.trim() : "";
    if (!key) {
      return { data: { ok: false, error: "proc.media.read requires key" } };
    }

    const path = this.ownedMediaPath(key);
    if (!path) {
      return { data: { ok: false, error: "media key is outside this process" } };
    }

    const object = await this.env.STORAGE.get(key);
    if (!object) {
      return { data: { ok: false, error: "media not found" } };
    }
    if (!this.isValidOwnedArchiveObject(key, object)) {
      await object.body.cancel("Invalid archived media ownership").catch(() => {});
      return { data: { ok: false, error: "media key is outside this process" } };
    }

    const mimeType = object.httpMetadata?.contentType || "application/octet-stream";
    return {
      data: {
        ok: true,
        key,
        path,
        mimeType,
        size: object.size,
      },
      body: {
        stream: object.body,
        length: object.size,
      },
    };
  }

  private async handleProcRunAttach(
    args: ProcessRunAttachArgs,
  ): Promise<ProcessRunAttachResult> {
    if (!this.isInitialized()) {
      return { ok: false, error: "Process no longer exists" };
    }
    const runId = typeof args.runId === "string" ? args.runId.trim() : "";
    if (!runId) {
      return { ok: false, error: "proc.run.attach requires runId" };
    }
    if (!Array.isArray(args.media) || args.media.length === 0) {
      return { ok: false, error: "proc.run.attach requires media" };
    }
    if (args.media.length > MAX_MESSAGE_MEDIA_ITEMS) {
      return {
        ok: false,
        error: `proc.run.attach accepts at most ${MAX_MESSAGE_MEDIA_ITEMS} media items`,
      };
    }
    if (args.stagedKeys !== undefined && !Array.isArray(args.stagedKeys)) {
      return { ok: false, error: "proc.run.attach stagedKeys must be an array" };
    }

    const prefix = processMediaPrefix(this.identity.uid, this.pid);
    const normalized: RunOutputMedia[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const item of args.media) {
      if (!item || typeof item !== "object") {
        return { ok: false, error: "proc.run.attach media entries must be objects" };
      }
      const key = typeof item.key === "string" ? item.key.trim() : "";
      const path = key ? processMediaPath(key) : null;
      if (!key || !key.startsWith(prefix) || !path || item.path !== path) {
        return { ok: false, error: "media key is outside this process" };
      }
      if (seen.has(key)) {
        continue;
      }
      if (!(["image", "audio", "video", "document"] as unknown[]).includes(item.type)) {
        return { ok: false, error: "proc.run.attach media has an invalid type" };
      }
      const mimeType = typeof item.mimeType === "string" ? item.mimeType.trim() : "";
      if (!mimeType) {
        return { ok: false, error: "proc.run.attach media requires mimeType" };
      }
      if (!Number.isSafeInteger(item.size) || item.size < 0) {
        return { ok: false, error: "proc.run.attach media requires an exact size" };
      }
      if (item.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
        return {
          ok: false,
          error: `proc.run.attach media exceeds per-item limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes)`,
        };
      }
      totalBytes += item.size;
      if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
        return {
          ok: false,
          error: `proc.run.attach media exceeds total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
        };
      }
      seen.add(key);
      normalized.push({
        type: item.type,
        mimeType,
        key,
        path,
        size: item.size,
        ...(typeof item.filename === "string" && item.filename.trim()
          ? { filename: item.filename }
          : {}),
        ...(typeof item.duration === "number" && Number.isFinite(item.duration) && item.duration >= 0
          ? { duration: item.duration }
          : {}),
        ...(typeof item.transcription === "string" && item.transcription.trim()
          ? { transcription: item.transcription }
          : {}),
      });
    }

    const stagedKeys = [...new Set((args.stagedKeys ?? []).map((key) =>
      typeof key === "string" ? key.trim() : ""
    ))];
    if (stagedKeys.some((key) => !key || !seen.has(key))) {
      return { ok: false, error: "proc.run.attach stagedKeys must reference attached media" };
    }

    const keys = normalized.map((item) => item.key).sort();
    const releaseMedia = await this.acquireMediaKeyAdmissions(keys);
    try {
      const releaseLifecycle = await this.acquireLifecycleTransition();
      try {
        const run = this.currentRun;
        if (!run || run.runId !== runId) {
          return { ok: false, error: "the process run is no longer active" };
        }
        for (const item of normalized) {
          const object = await this.env.STORAGE.head(item.key);
          if (!object) {
            return { ok: false, error: `media not found: ${item.key}` };
          }
          const storedMimeType = object.httpMetadata?.contentType || "application/octet-stream";
          if (object.size !== item.size || storedMimeType !== item.mimeType) {
            return { ok: false, error: `media descriptor does not match stored data: ${item.key}` };
          }
        }

        const merged = new Map((run.outputMedia ?? []).map((item) => [item.key, item]));
        for (const item of normalized) {
          merged.set(item.key, item);
        }
        const media = [...merged.values()];
        const combinedBytes = media.reduce((sum, item) => sum + item.size, 0);
        if (media.length > MAX_MESSAGE_MEDIA_ITEMS) {
          return {
            ok: false,
            error: `proc.run.attach accepts at most ${MAX_MESSAGE_MEDIA_ITEMS} media items`,
          };
        }
        if (combinedBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
          return {
            ok: false,
            error: `proc.run.attach media exceeds total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
          };
        }

        run.outputMedia = media;
        run.stagedOutputMediaKeys = [...new Set([
          ...(run.stagedOutputMediaKeys ?? []),
          ...stagedKeys,
        ])];
        delete run.outputMediaPersisted;
        this.currentRun = run;
        return { ok: true, runId, media };
      } finally {
        releaseLifecycle();
      }
    } finally {
      releaseMedia();
    }
  }

  private async handleProcMediaWrite(
    args: ProcMediaWriteArgs,
    body?: FrameBody,
  ): Promise<ProcMediaWriteResult> {
    if (!this.isInitialized()) {
      await body?.stream.cancel("Process no longer exists").catch(() => {});
      return { ok: false, error: "Process no longer exists" };
    }
    if (!body) {
      return { ok: false, error: "proc.media.write requires a body" };
    }
    const length = body.length;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      await body.stream.cancel("Missing media body length").catch(() => {});
      return { ok: false, error: "proc.media.write requires an exact body length" };
    }
    if (!["image", "audio", "video", "document"].includes(args.type)) {
      await body.stream.cancel("Invalid media type").catch(() => {});
      return { ok: false, error: "proc.media.write requires a valid media type" };
    }
    const mimeType = typeof args.mimeType === "string" ? args.mimeType.trim() : "";
    if (!mimeType) {
      await body.stream.cancel("Missing media MIME type").catch(() => {});
      return { ok: false, error: "proc.media.write requires mimeType" };
    }
    const pid = this.pid;
    const uid = this.identity.uid;
    const lifecycleEpoch = this.lifecycleEpoch;
    const requestedMediaId = args.mediaId?.trim();
    if (
      requestedMediaId !== undefined
      && (
        requestedMediaId.length === 0
        || requestedMediaId.length > 160
        || requestedMediaId === ".dir"
        || !/^[a-zA-Z0-9._:-]+$/.test(requestedMediaId)
      )
    ) {
      await body.stream.cancel("Invalid media id").catch(() => {});
      return { ok: false, error: "proc.media.write mediaId is invalid" };
    }
    const key = `${processMediaPrefix(uid, pid)}${requestedMediaId ?? crypto.randomUUID()}`;
    const path = processMediaPath(key);
    if (!path) {
      await body.stream.cancel("Invalid process media path").catch(() => {});
      return { ok: false, error: "Process identity cannot own filesystem media" };
    }
    const descriptorId = await stableOpaqueId("process-media-descriptor", [
      args.type,
      mimeType,
      args.filename || null,
      args.duration ?? null,
      args.transcription || null,
    ]);
    const releaseMediaWrite = requestedMediaId
      ? await this.acquireMediaKeyAdmission(key)
      : null;
    let uploadController: AbortController | null = null;
    try {
      const releaseFinalLifecycle = await this.acquireLifecycleTransition();
      try {
        if (
          !this.isInitialized()
          || this.pid !== pid
          || this.identity.uid !== uid
          || this.lifecycleEpoch !== lifecycleEpoch
        ) {
          await body.stream.cancel("Process reset during media upload").catch(() => {});
          return { ok: false, error: "Process reset during media upload" };
        }
        uploadController = new AbortController();
        this.mediaUploadAbortControllers.set(key, uploadController);
      } finally {
        releaseFinalLifecycle();
      }

      if (requestedMediaId) {
        const existing = await this.env.STORAGE.head(key);
        if (existing) {
          const existingMimeType = existing.httpMetadata?.contentType || "application/octet-stream";
          if (
            existing.size !== length
            || existingMimeType !== mimeType
            || existing.customMetadata?.descriptorId !== descriptorId
          ) {
            await body.stream.cancel("Process media id conflicts with existing media").catch(() => {});
            return { ok: false, error: "proc.media.write mediaId conflicts with existing media" };
          }
          try {
            await body.stream.pipeTo(new WritableStream<Uint8Array>(), {
              signal: uploadController.signal,
            });
          } catch (error) {
            if (uploadController.signal.aborted) {
              return { ok: false, error: "Process reset during media upload" };
            }
            throw new Error(
              `proc.media.write failed to consume repeated media: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          const releaseLifecycle = await this.acquireLifecycleTransition();
          try {
            if (
              !this.isInitialized()
              || this.pid !== pid
              || this.identity.uid !== uid
              || this.lifecycleEpoch !== lifecycleEpoch
            ) {
              return { ok: false, error: "Process reset during media upload" };
            }
          } finally {
            releaseLifecycle();
          }
          return {
            ok: true,
            media: {
              type: args.type,
              mimeType,
              key,
              path,
              size: existing.size,
              ...(args.filename ? { filename: args.filename } : {}),
              ...(args.duration !== undefined ? { duration: args.duration } : {}),
              ...(args.transcription ? { transcription: args.transcription } : {}),
            },
          };
        }
      }
      const fixed = new FixedLengthStream(length);
      const [stored, piped] = await Promise.allSettled([
        this.env.STORAGE.put(key, fixed.readable, {
          httpMetadata: { contentType: mimeType },
          customMetadata: {
            uid: String(uid),
            gid: String(this.identity.gid),
            mode: "400",
            processId: pid,
            descriptorId,
          },
        }),
        body.stream.pipeTo(fixed.writable, { signal: uploadController.signal }),
      ]);
      if (stored.status === "rejected") {
        await this.env.STORAGE.delete(key);
        if (uploadController.signal.aborted) {
          return { ok: false, error: "Process reset during media upload" };
        }
        return {
          ok: false,
          error: `proc.media.write failed: ${stored.reason instanceof Error ? stored.reason.message : String(stored.reason)}`,
        };
      }
      if (piped.status === "rejected") {
        await this.env.STORAGE.delete(key);
        if (uploadController.signal.aborted) {
          return { ok: false, error: "Process reset during media upload" };
        }
        return {
          ok: false,
          error: `proc.media.write failed: ${piped.reason instanceof Error ? piped.reason.message : String(piped.reason)}`,
        };
      }
      const object = stored.value;
      if (object.size !== length) {
        await this.env.STORAGE.delete(key);
        return { ok: false, error: `proc.media.write received ${object.size} bytes, expected ${length}` };
      }

      const releaseLifecycle = await this.acquireLifecycleTransition();
      try {
        if (
          !this.isInitialized()
          || this.pid !== pid
          || this.identity.uid !== uid
          || this.lifecycleEpoch !== lifecycleEpoch
        ) {
          await this.env.STORAGE.delete(key);
          return { ok: false, error: "Process reset during media upload" };
        }
      } finally {
        releaseLifecycle();
      }

      return {
        ok: true,
        media: {
          type: args.type,
          mimeType,
          key,
          path,
          size: object.size,
          ...(args.filename ? { filename: args.filename } : {}),
          ...(args.duration !== undefined ? { duration: args.duration } : {}),
          ...(args.transcription ? { transcription: args.transcription } : {}),
        },
      };
    } finally {
      if (uploadController && this.mediaUploadAbortControllers.get(key) === uploadController) {
        this.mediaUploadAbortControllers.delete(key);
      }
      releaseMediaWrite?.();
    }
  }

  private async handleProcMediaDelete(
    args: ProcMediaDeleteArgs,
    body?: FrameBody,
  ): Promise<ProcMediaDeleteResult> {
    if (body) {
      await body.stream.cancel("proc.media.delete does not accept a body").catch(() => {});
      return { ok: false, error: "proc.media.delete does not accept a body" };
    }
    if (!this.isInitialized()) {
      return { ok: false, error: "Process no longer exists" };
    }
    const key = typeof args.key === "string" ? args.key.trim() : "";
    if (!key) {
      return { ok: false, error: "proc.media.delete requires key" };
    }
    if (
      !key.startsWith(processMediaPrefix(this.identity.uid, this.pid))
      || !processMediaPath(key)
    ) {
      return { ok: false, error: "media key is outside this process" };
    }
    const releaseMedia = await this.acquireMediaKeyAdmission(key);
    try {
      const releaseLifecycle = await this.acquireLifecycleTransition();
      try {
        if (!this.isInitialized()) {
          return { ok: false, error: "Process no longer exists" };
        }
        if (
          !key.startsWith(processMediaPrefix(this.identity.uid, this.pid))
          || !processMediaPath(key)
        ) {
          return { ok: false, error: "media key is outside this process" };
        }
        if (
          this.store.referencesMediaKey(key)
          || this.currentRun?.outputMedia?.some((item) => item.key === key)
        ) {
          return { ok: false, error: "media is referenced by process history" };
        }
        await this.env.STORAGE.delete(key);
        return { ok: true, key };
      } finally {
        releaseLifecycle();
      }
    } finally {
      releaseMedia();
    }
  }

  private getContextStateForHistory(conversationId: string): ProcContextState | null {
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
    let result!: ProcConversationResetResult;
    let releasedMediaKeys: string[] = [];
    const releaseLifecycle = await this.acquireLifecycleTransition();
    try {
      const pid = this.pid;
      const conversationId = normalizeConversationId(args.conversationId);
      const existingConversation = this.store.ensureConversation(conversationId);
      await this.resetConversationExecutionState(conversationId);
      const messages = this.store.getMessages({ conversationId, limit: null });
      releasedMediaKeys = this.activeProcessMediaKeys(messages);
      const archivedMessages = this.store.messageCount(conversationId);
      let archivedTo: string | undefined;

      if (args.archive !== false && archivedMessages > 0) {
        const archiveId = crypto.randomUUID();
        const key = await this.archiveConversationMessages(
          conversationId,
          archiveId,
        );
        archivedTo = key ? `/${key}` : undefined;
        if (archivedTo) {
          this.store.recordConversationArchive({
            id: archiveId,
            conversationId,
            generation: existingConversation.generation,
            kind: "reset",
            messages: archivedMessages,
            archivePath: archivedTo,
          });
        }
      }

      const conversation = this.store.resetConversation(conversationId);

      result = {
        ok: true,
        pid,
        conversationId,
        generation: conversation.generation,
        archivedMessages,
        archivedTo,
      };
    } finally {
      releaseLifecycle();
    }

    await this.deleteUnreferencedActiveMedia(releasedMediaKeys).catch((error) => {
      console.warn(
        `[Process] Failed to clean conversation media for ${result.conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return result;
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
      return { ok: false, error: "proc.conversation.policy.set overflow must be auto-compact or fail" };
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
    options: {
      allowActive?: boolean;
      reason?: string;
      activeRunId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<ProcConversationCompactResult> {
    const pid = this.pid;
    const conversationId = normalizeConversationId(args.conversationId);
    const explicitSummary = normalizeOptionalString(args.summary);
    const generateSummary = args.generateSummary === true;
    const stopped = () =>
      options.signal?.aborted === true ||
      (options.activeRunId !== undefined && this.currentRun?.runId !== options.activeRunId);
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

    let conversation!: ProcessConversationRecord;
    let selected!: MessageRecord[];
    let selectedMediaKeys: string[] = [];
    let lifecycleEpoch = 0;
    const releaseSnapshot = await this.acquireLifecycleTransition();
    try {
      if (!options.allowActive && this.currentRun?.conversationId === conversationId) {
        return { ok: false, error: `Conversation is active: ${conversationId}` };
      }
      if (stopped()) {
        return { ok: false, error: "Compaction was cancelled" };
      }
      lifecycleEpoch = this.lifecycleEpoch;
      conversation = this.store.ensureConversation(conversationId);
      selected = this.store.getConversationPrefixMessages({
        conversationId,
        keepLast: hasKeepLast ? args.keepLast : undefined,
        throughMessageId: hasThroughMessageId ? args.throughMessageId : undefined,
      });
      if (selected.length === 0) {
        return { ok: false, error: "No conversation messages selected for compaction" };
      }
      selectedMediaKeys = this.activeProcessMediaKeys(selected);
    } finally {
      releaseSnapshot();
    }

    const signal = options.activeRunId
      ? options.signal
        ? AbortSignal.any([options.signal, this.runAbortSignal(options.activeRunId)])
        : this.runAbortSignal(options.activeRunId)
      : options.signal;
    let summary = explicitSummary;
    if (!summary) {
      try {
        summary = await this.generateConversationCompactionSummary(selected, signal);
      } catch (error) {
        if (stopped()) {
          return { ok: false, error: "Compaction was cancelled" };
        }
        const message = errorMessageFromUnknown(error);
        const formatted = formatProviderErrorMessage(message);
        if (
          formatted &&
          (formatted !== message ||
            formatted.startsWith("Provider account issue") ||
            formatted.startsWith("Provider rate limit"))
        ) {
          return { ok: false, error: formatted };
        }
        return {
          ok: false,
          error: `Failed to generate compaction summary: ${formatted || message}`,
        };
      }
    }
    if (stopped()) {
      return { ok: false, error: "Compaction was cancelled" };
    }

    const fromMessageId = selected[0].id;
    const toMessageId = selected[selected.length - 1].id;
    const segmentId = crypto.randomUUID();
    const archiveKey = `${this.conversationArchiveDir(conversationId)}/${segmentId}.jsonl.gz`;
    const archivedTo = `/${archiveKey}`;
    let installed = false;
    let summaryMessageId = 0;
    let segment!: ReturnType<ProcessStore["recordConversationSegment"]>;
    try {
      try {
        await this.archiveMessageRecords(archiveKey, selected, signal);
      } catch (error) {
        if (stopped()) {
          return { ok: false, error: "Compaction was cancelled" };
        }
        throw error;
      }
      const releaseInstall = await this.acquireLifecycleTransition();
      try {
        const currentConversation = this.store.getConversation(conversationId);
        const currentRecords = this.store.getConversationPrefixMessages({
          conversationId,
          throughMessageId: toMessageId,
        });
        const snapshotMatches =
          this.lifecycleEpoch === lifecycleEpoch &&
          currentConversation?.generation === conversation.generation &&
          currentRecords.length === selected.length &&
          currentRecords.every((message, index) => {
            const snapshot = selected[index];
            return snapshot !== undefined &&
              message.id === snapshot.id &&
              message.conversationId === snapshot.conversationId &&
              message.generation === snapshot.generation &&
              message.runId === snapshot.runId &&
              message.role === snapshot.role &&
              message.content === snapshot.content &&
              message.toolCalls === snapshot.toolCalls &&
              message.toolCallId === snapshot.toolCallId &&
              message.media === snapshot.media &&
              message.origin === snapshot.origin &&
              message.metadata === snapshot.metadata &&
              message.createdAt === snapshot.createdAt;
          });
        if (
          stopped() ||
          (!options.allowActive && this.currentRun?.conversationId === conversationId) ||
          !snapshotMatches
        ) {
          return { ok: false, error: stopped() ? "Compaction was cancelled" : "Conversation changed during compaction" };
        }

        this.ctx.storage.transactionSync(() => {
          summaryMessageId = this.store.compactConversationPrefix({
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
          segment = this.store.recordConversationSegment({
            id: segmentId,
            conversationId,
            generation: conversation.generation,
            kind: "compaction",
            fromMessageId,
            toMessageId,
            archivePath: archivedTo,
            summaryMessageId,
          });
        });
        installed = true;
      } finally {
        releaseInstall();
      }
    } finally {
      if (!installed) {
        await this.deleteFailedCompactionArchive(archiveKey);
      }
    }

    await this.deleteUnreferencedActiveMedia(selectedMediaKeys).catch((error) => {
      console.warn(
        `[Process] Failed to clean compacted conversation media for ${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    await this.emitProcessLifecycle({
      event: "conversation.compacted",
      pid,
      conversationId,
      generation: conversation.generation,
      segment,
      archivedMessages: selected.length,
      archivedTo,
      summaryMessageId,
      ...(options.reason ? { reason: options.reason } : {}),
    });

    return {
      ok: true,
      pid,
      conversationId,
      segment,
      archivedMessages: selected.length,
      archivedTo,
      summaryMessageId,
    };
  }

  private async generateConversationCompactionSummary(
    messages: MessageRecord[],
    signal?: AbortSignal,
  ): Promise<string> {
    const primary = await this.resolveCheckpointConfig(signal);
    if (!primary) {
      throw new Error("AI config unavailable");
    }

    const context = buildCompactionSummaryContext(messages);
    const generationOptions: AiTextGenerateOptions = {
      maxTokens: 768,
      reasoning: "off",
      timeoutMs: COMPACTION_GENERATION_TIMEOUT_MS,
    };
    let config = primary;
    let fallbackIndex = 0;
    let retriedEmptyResponse = false;
    while (true) {
      try {
        const generated = await this.generateCompactionText({
          config,
          context,
          options: generationOptions,
          sessionAffinityKey: `${this.pid}:compaction`,
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
        const formatted = formatProviderErrorMessage(message, {
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
      ...(segment ? { segment } : {}),
      ...(throughMessageId !== undefined ? { throughMessageId } : {}),
      restoredMessages,
      includedLiveSuffix: includeLiveSuffix,
    });

    return {
      ok: true,
      pid,
      sourceConversationId,
      targetConversation: this.toProcConversation(this.store.getConversation(targetConversationId) ?? conversation),
      ...(segment ? { segment } : {}),
      ...(throughMessageId !== undefined ? { throughMessageId } : {}),
      restoredMessages,
      includedLiveSuffix: includeLiveSuffix,
    };
  }

  private async emitProcessLifecycle(payload: Record<string, unknown>): Promise<void> {
    await this.emitProcChanged(["lifecycle", "conversations", "messages"], payload).catch((error) => {
      console.warn(
        `[Process] Failed to emit proc.changed lifecycle for ${this.pid}: ${
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
      : message.role === "toolResult"
        ? JSON.stringify({
            toolName: message.toolName ?? "unknown",
            isError: message.isError ?? false,
            ...(message.outcome ? { outcome: message.outcome } : {}),
          })
        : message.toolCalls
          ? JSON.stringify(message.toolCalls)
          : undefined;
    const restoredMedia = message.media === undefined
      ? null
      : stringifyStoredProcessMedia(this.parseOwnedProcessMedia(JSON.stringify(message.media)));
    return this.store.appendMessage(message.role, message.content, {
      conversationId,
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
      origin: message.origin ?? undefined,
      metadata: message.metadata,
      runId: message.runId ?? undefined,
      createdAt: message.createdAt,
    });
  }

  private async handleConversationSegmentRead(
    args: ProcConversationSegmentReadArgs,
  ): Promise<ProcConversationSegmentReadResult> {
    const conversationId = normalizeConversationId(args.conversationId);
    const segmentId = normalizeOptionalString(args.segmentId);
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
      segment,
      messages,
      messageCount: archivedMessages.length,
      truncated: offset + messages.length < archivedMessages.length,
    };
  }

  private toProcHistoryMessageFromArchive(message: ArchivedMessageRecord): ProcHistoryMessage {
    const run = message.runId ? { runId: message.runId } : {};
    const metadataPart = message.metadata ? { metadata: message.metadata } : {};
    if (message.role === "toolResult") {
      const isError = message.isError ?? false;
      return {
        id: message.id,
        role: message.role,
        content: {
          toolName: message.toolName ?? "unknown",
          isError,
          outcome: normalizeToolResultOutcome(message.outcome, isError, message.content),
          toolCallId: message.toolCallId ?? null,
          output: message.content,
        },
        timestamp: message.createdAt,
        ...run,
        ...(message.origin ? { origin: message.origin } : {}),
        ...metadataPart,
      };
    }

    if (message.role === "assistant") {
      const media = message.media === undefined
        ? []
        : this.parseOwnedProcessMedia(JSON.stringify(message.media));
      return {
        id: message.id,
        role: message.role,
        content: {
          text: message.content,
          thinking: message.thinking ?? [],
          toolCalls: message.toolCalls ?? [],
          ...(media.length > 0 ? { media } : {}),
        },
        timestamp: message.createdAt,
        ...run,
        ...(message.origin ? { origin: message.origin } : {}),
        ...metadataPart,
      };
    }

    if (message.role === "user" && message.media !== undefined) {
      const media = this.parseOwnedProcessMedia(JSON.stringify(message.media));
      return {
        id: message.id,
        role: message.role,
        content: {
          text: message.content,
          media,
        },
        timestamp: message.createdAt,
        ...run,
        ...(message.origin ? { origin: message.origin } : {}),
        ...metadataPart,
      };
    }

    return {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
      ...run,
      ...(message.origin ? { origin: message.origin } : {}),
      ...metadataPart,
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
      segments: this.store.listConversationSegments(conversationId),
    };
  }

  private handleConversationTimeline(
    args: ProcConversationTimelineArgs,
  ): ProcConversationTimelineResult {
    const conversationId = normalizeConversationId(args.conversationId);
    const conversation = this.store.ensureConversation(conversationId);
    const archives = this.store
      .listConversationArchives(conversationId)
      .map((archive): ProcConversationTimelineEntry => ({
        type: "archive",
        id: archive.id,
        conversationId: archive.conversationId,
        generation: archive.generation,
        archiveKind: archive.kind,
        messages: archive.messages,
        archivePath: archive.archivePath,
        createdAt: archive.createdAt,
      }));
    const segments = this.store
      .listConversationSegments(conversationId)
      .map((segment): ProcConversationTimelineEntry => ({
        type: "segment",
        id: segment.id,
        conversationId: segment.conversationId,
        generation: segment.generation,
        segmentKind: segment.kind,
        fromMessageId: segment.fromMessageId,
        toMessageId: segment.toMessageId,
        archivePath: segment.archivePath,
        summaryMessageId: segment.summaryMessageId,
        createdAt: segment.createdAt,
      }));

    const live: ProcConversationTimelineEntry = {
      type: "live",
      ...this.toProcConversationLiveGeneration(conversation),
    };
    const timeline: ProcConversationTimelineEntry[] = [
      ...archives,
      ...segments,
      live,
    ].sort(compareConversationTimelineEntries);

    return {
      ok: true,
      pid: this.pid,
      conversationId,
      timeline,
    };
  }

  private handleConversationGenerations(
    args: ProcConversationGenerationsArgs,
  ): ProcConversationGenerationsResult {
    const conversationId = normalizeConversationId(args.conversationId);
    this.store.ensureConversation(conversationId);
    return {
      ok: true,
      pid: this.pid,
      conversationId,
      generations: this.store.listConversationGenerations(conversationId),
    };
  }

  private handleConversationGenerationManifest(
    args: ProcConversationGenerationManifestArgs,
  ): ProcConversationGenerationManifestResult {
    const conversationId = normalizeConversationId(args.conversationId);
    if (!isPositiveInteger(args.generation)) {
      return { ok: false, error: "proc.conversation.generation.manifest generation must be a positive integer" };
    }

    const manifest = this.buildConversationGenerationManifest(conversationId, args.generation);
    return {
      ok: true,
      pid: this.pid,
      conversationId,
      manifest,
    };
  }

  private buildConversationGenerationManifest(
    conversationId: string,
    generation: number,
  ): ProcConversationGenerationManifest | null {
    const conversation = this.store.ensureConversation(conversationId);
    const archives = this.store
      .listConversationArchives(conversationId)
      .filter((archive) => archive.generation === generation);
    const segments = this.store
      .listConversationSegments(conversationId)
      .filter((segment) => segment.generation === generation);
    const current = conversation.generation === generation;

    if (!current && archives.length === 0 && segments.length === 0) {
      return null;
    }

    return {
      conversationId,
      generation,
      current,
      status: conversation.status,
      title: conversation.title,
      archives,
      segments,
      live: current ? this.toProcConversationLiveGeneration(conversation) : null,
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

  private toProcConversationLiveGeneration(
    record: ProcessConversationRecord,
  ): ProcConversationLiveGeneration {
    const stats = this.store.messageStats(record.id);
    return {
      conversationId: record.id,
      generation: record.generation,
      messageCount: stats.count,
      firstMessageId: stats.firstMessageId,
      lastMessageId: stats.lastMessageId,
      updatedAt: record.updatedAt,
    };
  }

  private async resetConversationExecutionState(conversationId: string): Promise<void> {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === DEFAULT_CONVERSATION_ID) {
      this.store.setValue(PROCESS_RESET_AT_KEY, String(Date.now()));
    }
    const activeRun = this.currentRun;
    const stoppedActiveRun = activeRun?.conversationId === normalizedConversationId;

    if (stoppedActiveRun) {
      this.cancelPendingRequests(
        activeRun.runId,
        `Conversation was reset: ${normalizedConversationId}`,
      );
      this.rememberAbortedRun(activeRun.runId);
      this.ingestToolResults(activeRun.runId, this.store.getResults(activeRun.runId), {
        interruptPending: `Conversation was reset: ${normalizedConversationId}`,
      });
      this.rejectCodeModeWaiters(
        activeRun.runId,
        `Conversation was reset: ${normalizedConversationId}`,
      );
      this.emitRunFinished(activeRun, {
        status: "aborted",
        reason: "conversation.reset",
        text: null,
      });
      this.currentRun = null;
    }

    this.store.clearPendingToolCalls(normalizedConversationId);
    this.store.clearPendingHil(normalizedConversationId);
    this.store.clearQueue(normalizedConversationId);

    if (stoppedActiveRun) {
      this.promoteNextQueuedRun();
    }
  }

  private async handleProcReset(): Promise<ProcResetResult> {
    const releaseLifecycle = await this.acquireLifecycleTransition();
    try {
      const pid = this.pid;
      await this.resetExecutionState("process.reset");
      const totalMessages = this.store.totalMessageCount();

      const archive = totalMessages > 0
        ? await this.archiveAllConversationMessages(crypto.randomUUID(), "process-reset")
        : emptyProcessArchive();

      this.store.resetAllConversations();

      await deleteProcessMedia(this.env.STORAGE, this.identity.uid, pid);

      return {
        ok: true,
        pid,
        archivedMessages: archive.archivedMessages,
        archivedTo: archive.archivedTo,
        archives: archive.archives,
      };
    } finally {
      releaseLifecycle();
    }
  }

  private async handleProcKill(args: {
    pid?: string;
    archive?: boolean;
  }): Promise<ProcKillResult> {
    const releaseLifecycle = await this.acquireLifecycleTransition();
    try {
      const initialized = this.isInitialized();
      const pid = initialized ? this.pid : args.pid;
      if (!pid) {
        throw new Error("Process not initialized — pid missing");
      }
      const shouldArchive = args.archive !== false;
      if (initialized && this.currentRun) {
        await this.sendSignal("proc.run.finished", this.runFinishedPayload(
          this.currentRun,
          {
            status: "aborted",
            reason: "process.kill",
            text: null,
          },
          0,
        ));
      }
      if (initialized) {
        await this.resetExecutionState("process.kill", false);
      }
      const totalMessages = initialized ? this.store.totalMessageCount() : 0;

      const archive = shouldArchive && totalMessages > 0
        ? await this.archiveAllConversationMessages(crypto.randomUUID(), "kill")
        : emptyProcessArchive();

      if (initialized) {
        await deleteProcessMedia(this.env.STORAGE, this.identity.uid, pid);
      }

      // The executor is fungible: a killed process is gone. The durable
      // transcript already lives in the agent home (archived above), so we wipe
      // all live DO storage rather than keeping a reset stub around. A future
      // executor gets a fresh DO (and hydrates from the home archive on resume).
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.killed = true;

      return {
        ok: true,
        pid,
        archivedMessages: archive.archivedMessages,
        archivedTo: archive.archivedTo,
        archives: archive.archives,
      };
    } finally {
      releaseLifecycle();
    }
  }

  private async resetExecutionState(reason: string, emitFinish = true): Promise<void> {
    this.lifecycleEpoch += 1;
    this.abortMediaUploads(new Error(`Process execution was reset: ${reason}`));
    this.store.setValue(PROCESS_RESET_AT_KEY, String(Date.now()));
    const activeRun = this.currentRun;
    this.cancelPendingRequests(null, `Process execution was reset: ${reason}`);
    this.rejectCodeModeWaiters(null, "Process execution state was reset");
    if (activeRun) {
      this.rememberAbortedRun(activeRun.runId);
      this.ingestToolResults(activeRun.runId, this.store.getResults(activeRun.runId), {
        interruptPending: `Process execution was reset: ${reason}`,
      });
      if (emitFinish) {
        this.emitRunFinished(activeRun, {
          status: "aborted",
          reason,
          text: null,
        });
      }
    }
    this.currentRun = null;
    this.store.clearPendingToolCalls();
    this.store.clearPendingHil();
    this.store.clearQueue();
  }

  private async handleSig(frame: SignalFrame): Promise<void> {
    if (isWatchedSignalPayload(frame.payload)) {
      await this.handleWatchedSignalTriggered(frame.signal, frame.payload);
      return;
    }

    switch (frame.signal) {
      case REQUEST_CANCEL_SIGNAL:
        this.cancelRequest(frame.payload);
        break;
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
      case "proc.delivery.notice": {
        const payload = frame.payload && typeof frame.payload === "object"
          ? frame.payload as Record<string, unknown>
          : {};
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        const noticeId = typeof payload.noticeId === "string" ? payload.noticeId.trim() : "";
        if (message && noticeId && /^[a-zA-Z0-9._:-]{1,200}$/.test(noticeId)) {
          const noticeKey = `deliveryNotice:${noticeId}`;
          let messageId: number | null = null;
          this.ctx.storage.transactionSync(() => {
            if (this.store.getValue(noticeKey)) return;
            const conversationId = normalizeConversationId(
              typeof payload.conversationId === "string" ? payload.conversationId : undefined,
            );
            messageId = this.store.appendMessage("system", message, {
              conversationId,
              runId: typeof payload.runId === "string" ? payload.runId : undefined,
            });
            this.store.setValue(noticeKey, String(messageId));
            const noticeIds = JSON.parse(
              this.store.getValue(DELIVERY_NOTICE_IDS_KEY) ?? "[]",
            ) as string[];
            noticeIds.push(noticeId);
            const expired = noticeIds.splice(
              0,
              Math.max(0, noticeIds.length - DELIVERY_NOTICE_TOMBSTONE_LIMIT),
            );
            for (const expiredId of expired) {
              this.store.deleteValue(`deliveryNotice:${expiredId}`);
            }
            this.store.setValue(DELIVERY_NOTICE_IDS_KEY, JSON.stringify(noticeIds));
          });
          if (messageId !== null) {
            await this.emitProcChanged(["messages"], {
              conversationId: normalizeConversationId(
                typeof payload.conversationId === "string" ? payload.conversationId : undefined,
              ),
              runId: typeof payload.runId === "string" ? payload.runId : undefined,
              messageId,
            });
          }
        }
        break;
      }
      default:
        console.log(`[Process] Unknown signal: ${frame.signal}`);
        break;
    }
  }
  /**
   * Schedule the next agent loop tick using the DO scheduler.
   * Each tick resets the subrequest counter.
   */
  private async scheduleTick(runId: string): Promise<void> {
    const run = this.currentRun;
    if (!run || run.runId !== runId) {
      return;
    }
    const next = new Date(Date.now() + 10);
    await this.schedule(next, "tick", {
      runId,
      generation: run.tickGeneration ?? 0,
    }, { idempotent: true });
  }

  async onMediaPreparationTimeout(runId: string): Promise<void> {
    const run = this.currentRun;
    if (run?.runId !== runId || run.pendingMediaMessageId === undefined) {
      return;
    }
    await this.failPendingMedia(
      runId,
      run.pendingMediaMessageId,
      `Message media preparation timed out after ${MEDIA_PREPARATION_TIMEOUT_MS}ms`,
      "media.timeout",
    );
  }

  async onToolDispatchTimeout(input: { runId: string; dispatchId: string }): Promise<void> {
    const { runId, dispatchId } = input;
    if (this.currentRun?.runId !== runId) {
      return;
    }
    const tool = this.store.getResults(runId).find((result) => result.dispatchId === dispatchId);
    if (tool?.status === "pending") {
      this.ctx.waitUntil(
        cancelProcessRequests(this.pid, [dispatchId], "Tool execution timed out").catch(() => 0),
      );
      this.store.fail(dispatchId, `Tool execution timed out after ${TOOL_DISPATCH_TIMEOUT_MS}ms`);
      await this.resumeResolvedToolRun(runId);
    } else if (tool?.status === "registered") {
      await this.scheduleTick(runId);
    }
  }

  private async appendRuntimeMessage(
    content: string,
    opts?: { conversationId?: string; runId?: string },
  ): Promise<void> {
    const conversationId = normalizeConversationId(opts?.conversationId);
    const timestamp = Date.now();
    const messageId = this.store.appendMessage("system", content, {
      conversationId,
      runId: opts?.runId,
      createdAt: timestamp,
    });
    await this.emitProcChanged(["messages"], {
      conversationId,
      messageId,
      role: "system",
      content,
      timestamp,
      ...(opts?.runId ? { runId: opts.runId } : {}),
    });
  }

  private async handleWatchedSignalTriggered(signal: string, payload: unknown): Promise<void> {
    await this.handleRuntimeEvent(
      formatWatchedSignalMessage(signal, payload),
      DEFAULT_CONVERSATION_ID,
      "signal.watch",
    );
  }

  private async handleIpcSignal(signal: string, payload: unknown): Promise<void> {
    const content = formatIpcReplyMessage(signal, payload);
    const record = asPlainRecord(payload);
    const callId = normalizeOptionalString(record?.callId);
    const sourceRunId = normalizeOptionalString(record?.sourceRunId);
    const createdAt = typeof record?.createdAt === "number" ? record.createdAt : null;
    let messageId = -1;
    let nextRunId: string | null = null;
    let wakeRunId: string | null = null;
    const releaseLifecycle = await this.acquireLifecycleTransition();
    const timestamp = Date.now();
    try {
      if (!this.store.getValue("pid") || !this.store.getValue("identity")) {
        return;
      }
      const resetAt = Number(this.store.getValue(PROCESS_RESET_AT_KEY) ?? 0);
      const handled = JSON.parse(
        this.store.getValue(HANDLED_IPC_CALLS_KEY) ?? "[]",
      ) as string[];
      if (
        (callId && handled.includes(callId))
        || (sourceRunId && this.isAbortedRun(sourceRunId))
        || (createdAt !== null && createdAt <= resetAt)
      ) {
        return;
      }

      const currentRun = this.currentRun;
      nextRunId = currentRun ? null : crypto.randomUUID();
      this.ctx.storage.transactionSync(() => {
        if (callId) {
          handled.push(callId);
          this.store.setValue(
            HANDLED_IPC_CALLS_KEY,
            JSON.stringify(handled.slice(-IPC_TOMBSTONE_LIMIT)),
          );
        }
        messageId = this.store.appendMessage("system", content, {
          conversationId: DEFAULT_CONVERSATION_ID,
          createdAt: timestamp,
          ...(nextRunId ? { runId: nextRunId } : {}),
        });

        if (!currentRun) {
          this.currentRun = {
            runId: nextRunId!,
            conversationId: DEFAULT_CONVERSATION_ID,
          };
        } else if (
          (sourceRunId && sourceRunId !== currentRun.runId)
          || currentRun.conversationId !== DEFAULT_CONVERSATION_ID
        ) {
          wakeRunId = crypto.randomUUID();
          this.store.enqueue(
            wakeRunId,
            RUNTIME_EVENT_WAKE_MESSAGE,
            undefined,
            DEFAULT_CONVERSATION_ID,
          );
        } else {
          currentRun.pendingRuntimeEvents = (currentRun.pendingRuntimeEvents ?? 0) + 1;
          this.currentRun = currentRun;
        }
      });
    } finally {
      releaseLifecycle();
    }

    this.ctx.waitUntil(this.emitProcChanged(["messages"], {
      conversationId: DEFAULT_CONVERSATION_ID,
      messageId,
      role: "system",
      content,
      timestamp,
    }).catch((error) => {
      console.warn(`[Process] Failed to emit IPC message change for ${this.pid}:`, error);
    }));
    if (wakeRunId) {
      this.ctx.waitUntil(this.emitProcChanged(["queue"], {
        conversationId: DEFAULT_CONVERSATION_ID,
        enqueuedRunId: wakeRunId,
      }).catch((error) => {
        console.warn(`[Process] Failed to emit IPC queue change for ${this.pid}:`, error);
      }));
    } else if (nextRunId) {
      const runId = nextRunId;
      this.ctx.waitUntil(this.scheduleTick(runId).catch(async (error) => {
        if (this.currentRun?.runId !== runId) {
          return;
        }
        const message = `Failed to schedule delegated task: ${error instanceof Error ? error.message : String(error)}`;
        await this.appendRuntimeMessage(message, {
          conversationId: DEFAULT_CONVERSATION_ID,
          runId,
        });
        await this.finishRun(runId, {
          reason: "schedule.error",
          status: "error",
          text: null,
          error: message,
        });
      }));
      this.ctx.waitUntil(this.announceRun(
        runId,
        DEFAULT_CONVERSATION_ID,
        "delegated-task",
      ));
    }
  }

  private async handleProcScheduleDeliver(
    args: ProcessScheduleDeliverArgs,
  ): Promise<{ runId: string; queued: boolean }> {
    const conversationId = normalizeConversationId(args.conversationId);
    const origin: InteractionOrigin = {
      kind: "scheduler",
      scheduleId: args.scheduleId,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    };
    const admission = await this.handleRuntimeEvent(
      formatScheduleEventMessage(args),
      conversationId,
      "schedule.event",
      {
        origin,
        distinctRun: args.replyTo !== undefined,
        runId: args.runId,
      },
    );
    if (!admission.ok) {
      throw new Error(admission.error);
    }
    return { runId: admission.runId, queued: admission.queued };
  }

  private async handleRuntimeEvent(
    content: string,
    conversationId: string,
    reason: string,
    options: {
      origin?: InteractionOrigin;
      distinctRun?: boolean;
      runId?: string;
    } = {},
  ): Promise<RuntimeEventAdmission> {
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
    let messageId = -1;
    let nextRunId: string | null = null;
    let wakeRunId: string | null = null;
    let admissionError: string | null = null;
    let replayedAdmission: Extract<RuntimeEventAdmission, { ok: true }> | null = null;
    const releaseLifecycle = await this.acquireLifecycleTransition();
    const timestamp = Date.now();
    try {
      if (!this.isInitialized()) {
        admissionError = "Process no longer exists";
      } else if (options.runId) {
        const existing = this.existingRunAdmission(options.runId);
        if (existing) {
          replayedAdmission = {
            ok: true,
            runId: options.runId,
            queued: existing.queued === true,
          };
        }
      }
      if (!admissionError && !replayedAdmission) {
        const conversation = this.store.ensureConversation(conversationId);
        if (conversation.status === "closed") {
          admissionError = `Conversation is closed: ${conversationId}`;
        } else {
          const currentRun = this.currentRun;
          nextRunId = currentRun ? null : options.runId ?? crypto.randomUUID();
          this.ctx.storage.transactionSync(() => {
            if (currentRun && options.distinctRun) {
              wakeRunId = options.runId ?? crypto.randomUUID();
              this.store.enqueue(
                wakeRunId,
                content,
                undefined,
                conversationId,
                serializeInteractionOrigin(options.origin) ?? undefined,
              );
              return;
            }
            messageId = this.store.appendMessage("system", content, {
              conversationId,
              createdAt: timestamp,
              ...(nextRunId ? { runId: nextRunId } : {}),
              ...(options.origin
                ? { origin: serializeInteractionOrigin(options.origin) ?? undefined }
                : {}),
            });
            if (!currentRun) {
              this.currentRun = {
                runId: nextRunId!,
                conversationId,
                ...(options.origin ? { origin: options.origin } : {}),
              };
            } else if (currentRun.conversationId === conversationId) {
              currentRun.pendingRuntimeEvents = (currentRun.pendingRuntimeEvents ?? 0) + 1;
              this.currentRun = currentRun;
            } else {
              wakeRunId = crypto.randomUUID();
              this.store.enqueue(
                wakeRunId,
                RUNTIME_EVENT_WAKE_MESSAGE,
                undefined,
                conversationId,
              );
            }
          });
        }
      }
    } finally {
      releaseLifecycle();
    }

    if (replayedAdmission) {
      return replayedAdmission;
    }
    if (admissionError) {
      return { ok: false, error: admissionError };
    }

    if (messageId >= 0) {
      this.ctx.waitUntil(this.emitProcChanged(["messages"], {
        conversationId,
        messageId,
        role: "system",
        content,
        timestamp,
      }));
    }
    if (wakeRunId) {
      this.ctx.waitUntil(this.emitProcChanged(["queue"], {
        conversationId,
        enqueuedRunId: wakeRunId,
      }));
    } else if (nextRunId) {
      const runId = nextRunId;
      this.ctx.waitUntil(this.scheduleTick(runId).catch(async (error) => {
        if (this.currentRun?.runId !== runId) {
          return;
        }
        const message = `Failed to schedule runtime event: ${errorMessageFromUnknown(error)}`;
        await this.appendRuntimeMessage(message, { conversationId, runId });
        await this.finishRun(runId, {
          reason: "schedule.error",
          status: "error",
          text: null,
          error: message,
        });
      }));
      this.ctx.waitUntil(this.announceRun(runId, conversationId, reason));
    }
    const admittedRunId = nextRunId ?? wakeRunId ?? this.currentRun?.runId;
    if (!admittedRunId) {
      return { ok: false, error: "runtime event was not assigned to a run" };
    }
    return {
      ok: true,
      runId: admittedRunId,
      queued: wakeRunId !== null,
    };
  }

  async tick(input: { runId: string; generation: number }): Promise<void> {
    const { runId, generation } = input;
    const run = this.currentRun;
    if (
      !run
      || run.runId !== runId
      || (run.tickGeneration ?? 0) !== generation
    ) {
      return;
    }

    run.tickGeneration = generation + 1;
    this.currentRun = run;
    if (this.activeTickRunIds.has(runId)) {
      this.deferredTickRunIds.add(runId);
      return;
    }

    this.activeTickRunIds.add(runId);
    this.ctx.waitUntil(this.runTick(runId)
      .catch((error) => {
        if (this.currentRun?.runId !== runId) {
          return;
        }
        return this.finishRun(runId, {
          reason: "tick.error",
          status: "error",
          text: null,
          error: `Process run failed: ${errorMessageFromUnknown(error)}`,
        });
      })
      .finally(() => {
        this.activeTickRunIds.delete(runId);
        if (
          this.deferredTickRunIds.delete(runId)
          && this.currentRun?.runId === runId
        ) {
          return this.scheduleTick(runId).catch((error) => this.finishRun(runId, {
            reason: "schedule.error",
            status: "error",
            text: null,
            error: `Failed to schedule deferred process run: ${errorMessageFromUnknown(error)}`,
          }));
        }
      }));
  }

  private async runTick(runId: string): Promise<void> {
    await this.lifecycleTransition;
    let run = this.currentRun;
    if (!run || run.runId !== runId) {
      return;
    }

    const conversationId = normalizeConversationId(run.conversationId);
    if (run.pendingMediaMessageId) {
      return;
    }

    // Step 1: Collect resolved tool results
    let toolResults = this.store.getResults(runId);
    if (
      toolResults.some((result) => result.status === "registered")
      && !this.store.getPendingHilForRun(runId)
    ) {
      await this.processToolCalls(runId);
      if (this.handleRunStopped(runId)) {
        return;
      }
      toolResults = this.store.getResults(runId);
    }
    if (toolResults.some(
      (result) => result.status === "registered" || result.status === "pending",
    )) {
      return;
    }

    if (toolResults.length > 0) {
      const ingested = this.ingestToolResults(runId, toolResults);
      if (ingested.appended > 0) {
        await this.emitProcChanged(["messages"], { conversationId, runId });
      }
      if (this.handleRunStopped(runId)) {
        return;
      }
    }

    // Step 2: Load config + tools (first tick only, cached on run state)
    if (!run.config) {
      run.aiTextGenerateConfig = this.buildAiTextGenerateConfig();
      run.config = await this.resolveAiConfig(this.runAbortSignal(runId));
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
      run.mcpServers = toolsResult.mcpServers;

      this.currentRun = run;
    }

    // Step 3: Assemble prompt (first tick only)
    if (!run.systemPrompt) {
      run.systemPrompt = await assembleSystemPrompt({
        config: run.config!,
        identity: this.identity,
        ownerIdentity: run.config?.owner ?? undefined,
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

    // Step 4: Build pi-ai Context
    const tools: Tool[] = (run.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Tool["parameters"],
    }));
    const generationSystemPrompt = appendRunReplyContext(run.systemPrompt, run.origin);

    const buildGenerationContext = async (): Promise<Context> => {
      const pendingRuntimeEventsInContext = this.currentRun?.runId === runId
        ? this.currentRun.pendingRuntimeEvents ?? 0
        : 0;
      const messages = await this.buildContextMessages(conversationId);
      this.consumeRuntimeEventsInContext(runId, pendingRuntimeEventsInContext);
      return {
        systemPrompt: generationSystemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      };
    };

    let context: Context = {
      systemPrompt: generationSystemPrompt,
      messages: [],
      tools: tools.length > 0 ? tools : undefined,
    };
    let autoCompactionPressure: number | null = null;
    const prepareGenerationContext = async (
      config: AiConfigResult,
    ): Promise<"ready" | "stopped"> => {
      context = await buildGenerationContext();
      const contextState = await this.updateContextState(runId, conversationId, config, context);
      if (this.handleRunStopped(runId)) {
        return "stopped";
      }

      const policy = this.getConversationContextPolicy(conversationId);
      if (autoCompactionPressure !== null) {
        if (contextState.pressure !== null && contextState.pressure >= 1) {
          await this.finishInsufficientCompactionRun(
            runId,
            conversationId,
            policy,
            autoCompactionPressure,
            contextState.pressure,
          );
          return "stopped";
        }
        return "ready";
      }

      const contextPreflight = await this.applyConversationContextPolicy(
        runId,
        conversationId,
        config,
        contextState,
      );
      if (contextPreflight === "stopped") {
        return "stopped";
      }
      if (contextPreflight === "compacted") {
        autoCompactionPressure = contextState.pressure ?? policy.compactAtPressure;
        if (this.handleRunStopped(runId)) {
          return "stopped";
        }
        context = await buildGenerationContext();
        const compactedState = await this.updateContextState(runId, conversationId, config, context);
        if (this.handleRunStopped(runId)) {
          return "stopped";
        }
        if (
          compactedState.pressure !== null &&
          compactedState.pressure >= 1
        ) {
          await this.finishInsufficientCompactionRun(
            runId,
            conversationId,
            policy,
            autoCompactionPressure,
            compactedState.pressure,
          );
          return "stopped";
        }
      }
      return "ready";
    };

    const contextPreflight = await prepareGenerationContext(run.config!);
    if (contextPreflight === "stopped") {
      return;
    }

    // Step 5: Call LLM
    let response: AssistantMessage | null = null;
    const streamSeq: StreamSeqCounter = { value: 0 };
    const primaryConfig = run.config!;
    const fallbackConfigs = primaryConfig.fallbacks ?? [];
    let fallbackIndex = 0;
    let activeFallbackMetadata: MessageMetadata["fallback"] | undefined;
    const switchToFallback = async (
      reason: string,
      failedResponse?: AssistantMessage,
    ): Promise<"switched" | "stopped" | "none"> => {
      const fallback = nextAiConfigFallback(primaryConfig, run.config!, fallbackConfigs, fallbackIndex);
      if (!fallback) {
        return "none";
      }
      fallbackIndex = fallback.nextIndex;
      if (failedResponse) {
        this.recordUnpersistedAssistantUsage(conversationId, failedResponse, run.config!);
      }
      const fallbackState = await this.beginGenerationFallback({
        runId,
        conversationId,
        reason,
        from: run.config!,
        to: fallback.config,
        fallbackIndex,
        fallbackCount: fallbackConfigs.length,
      });
      if (fallbackState === "stopped") {
        return "stopped";
      }
      activeFallbackMetadata = {
        used: true,
        from: modelMetadataFromAiConfig(run.config!),
        to: modelMetadataFromAiConfig(fallback.config),
        reason,
      };
      run.config = fallback.config;
      this.currentRun = run;
      const fallbackContextPreflight = await prepareGenerationContext(run.config);
      if (fallbackContextPreflight === "stopped") {
        return "stopped";
      }
      return this.handleRunStopped(runId) ? "stopped" : "switched";
    };
    let attempt = 1;
    while (attempt <= MAX_RETRYABLE_GENERATION_ATTEMPTS) {
      try {
        response = await this.generateAssistantResponse({
          runId,
          conversationId,
          config: run.config!,
          aiTextGenerateConfig: run.aiTextGenerateConfig,
          context,
          sessionAffinityKey: this.pid,
          streamSeq,
        });
        if (this.handleRunStopped(runId)) {
          return;
        }
      } catch (e) {
        if (this.handleRunStopped(runId)) {
          return;
        }
        const errorMsg = errorMessageFromUnknown(e);
        if (isProviderContextOverflowErrorMessage(errorMsg, {
          provider: run.config!.provider,
          model: run.config!.model,
          contextWindowTokens: run.config!.contextWindowTokens,
        })) {
          const fallbackState = await switchToFallback(errorMsg);
          if (fallbackState === "stopped") {
            return;
          }
          if (fallbackState === "switched") {
            attempt = 1;
            response = null;
            continue;
          }
          console.error(`[Process] LLM context overflow:`, e);
          await this.finishProviderContextOverflowRun(
            runId,
            conversationId,
            run.config!,
            errorMsg,
          );
          return;
        }
        if (
          isRetryableGenerationErrorMessage(errorMsg) &&
          attempt < MAX_RETRYABLE_GENERATION_ATTEMPTS
        ) {
          const retryState = await this.beginGenerationRetry({
            runId,
            conversationId,
            attempt,
            maxAttempts: MAX_RETRYABLE_GENERATION_ATTEMPTS,
            reason: errorMsg,
            cause: "retryable provider error",
          });
          if (retryState === "stopped") {
            return;
          }
          attempt += 1;
          continue;
        }
        const fallbackState = await switchToFallback(errorMsg);
        if (fallbackState === "stopped") {
          return;
        }
        if (fallbackState === "switched") {
          attempt = 1;
          response = null;
          continue;
        }
        const displayError = formatGenerationFailure(errorMsg, {
          provider: run.config?.provider,
          model: run.config?.model,
        });
        console.error(`[Process] LLM call failed:`, e);
        this.store.appendMessage("system", displayError, { conversationId, runId });
        await this.emitProcChanged(["messages"], {
          conversationId,
          runId,
          role: "system",
          content: displayError,
        });
        if (this.handleRunStopped(runId)) {
          return;
        }
        await this.finishRun(runId, {
          reason: "generation.error",
          status: "error",
          text: null,
          error: displayError,
        });
        return;
      }

      if (!response) {
        break;
      }

      if (isProviderContextOverflow(response, run.config!.contextWindowTokens)) {
        const errorMsg = response.errorMessage ?? describeAssistantResponseFailure(response) ?? "Provider context overflow";
        const fallbackState = await switchToFallback(errorMsg, response);
        if (fallbackState === "stopped") {
          return;
        }
        if (fallbackState === "switched") {
          attempt = 1;
          response = null;
          continue;
        }
        break;
      }

      const responseFailure = describeAssistantResponseFailure(response);
      if (!responseFailure) {
        break;
      }

      if (
        !isRetryableAssistantResponseFailure(response, responseFailure) ||
        attempt >= MAX_RETRYABLE_GENERATION_ATTEMPTS
      ) {
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          const errorMsg = response.errorMessage ?? responseFailure;
          const fallbackState = await switchToFallback(errorMsg, response);
          if (fallbackState === "stopped") {
            return;
          }
          if (fallbackState === "switched") {
            attempt = 1;
            response = null;
            continue;
          }
        }
        break;
      }

      this.recordUnpersistedAssistantUsage(conversationId, response, run.config!);
      const retryState = await this.beginGenerationRetry({
        runId,
        conversationId,
        attempt,
        maxAttempts: MAX_RETRYABLE_GENERATION_ATTEMPTS,
        reason: responseFailure,
        cause: hasRawToolCallMarkupOutput(response)
          ? "malformed assistant response"
          : "empty assistant response",
      });
      if (retryState === "stopped") {
        return;
      }
      attempt += 1;
      continue;
    }

    if (!response) {
      return;
    }

    if (isProviderContextOverflow(response, run.config!.contextWindowTokens)) {
      const overflowUsage = this.recordUnpersistedAssistantUsage(conversationId, response, run.config!);
      await this.updateContextState(runId, conversationId, run.config!, context, response.usage, overflowUsage);
      if (this.handleRunStopped(runId)) {
        return;
      }
      const errorMsg = response.errorMessage ?? describeAssistantResponseFailure(response) ?? undefined;
      await this.finishProviderContextOverflowRun(
        runId,
        conversationId,
        run.config!,
        errorMsg,
      );
      return;
    }

    const responseFailure = describeAssistantResponseFailure(response);
    if (responseFailure) {
      this.recordUnpersistedAssistantUsage(conversationId, response, run.config!);
      const errorMsg = response.errorMessage ?? responseFailure;
      const displayError = formatGenerationFailure(errorMsg, {
        provider: run.config?.provider,
        model: run.config?.model,
      });
      console.error(`[Process] ${errorMsg}`);
      this.store.appendMessage("system", displayError, { conversationId, runId });
      await this.emitProcChanged(["messages"], {
        conversationId,
        runId,
        role: "system",
        content: displayError,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
      await this.finishRun(runId, {
        reason: "generation.empty",
        status: "error",
        text: null,
        error: displayError,
      });
      return;
    }

    // Step 6: Process response
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

    let outputMedia = toolCalls.length === 0 && this.currentRun?.runId === runId
      ? this.currentRun.outputMedia ?? []
      : [];

    if (outputMedia.length > 0) {
      outputMedia = await this.promoteRunOutputMedia(runId);
      if (this.handleRunStopped(runId)) {
        return;
      }
    }

    if (text.trim() || thinkingBlocks.length > 0 || outputMedia.length > 0) {
      await this.sendSignal("proc.run.output", {
        text,
        thinking: thinkingBlocks,
        ...(outputMedia.length > 0 ? { media: outputMedia } : {}),
        ...(activeFallbackMetadata ? { fallback: activeFallbackMetadata } : {}),
        pid: this.pid,
        runId,
        conversationId,
      });
      if (this.handleRunStopped(runId)) {
        return;
      }
    }

    const assistantMetadata = buildAssistantMessageMetadata(response, run.config!, activeFallbackMetadata);
    this.ctx.storage.transactionSync(() => {
      this.store.appendMessage("assistant", text, {
        conversationId,
        runId,
        toolCalls: stringifyAssistantMessageMeta({
          thinking: thinkingBlocks,
          toolCalls,
        }),
        metadata: assistantMetadata,
        ...(outputMedia.length > 0
          ? { media: stringifyStoredProcessMedia(outputMedia) ?? undefined }
          : {}),
      });
      if (outputMedia.length > 0) {
        const activeRun = this.currentRun;
        if (activeRun?.runId === runId) {
          activeRun.outputMediaPersisted = true;
          this.currentRun = activeRun;
        }
      }
      for (const toolCall of toolCalls) {
        const syscall = TOOL_TO_SYSCALL[toolCall.name] as SyscallName | undefined;
        const prepared = syscall
          ? this.prepareToolArgs(syscall, toolCall.arguments)
          : { args: toolCall.arguments, missingShellSessionTarget: false };
        const dispatchId = crypto.randomUUID();
        this.store.register(
          dispatchId,
          toolCall.id,
          runId,
          syscall ?? toolCall.name,
          prepared.args,
          conversationId,
        );
        if (prepared.missingShellSessionTarget) {
          this.store.fail(dispatchId, UNKNOWN_SHELL_SESSION_TARGET_MESSAGE);
        }
      }
    });
    if (outputMedia.length > 0) {
      const stagedKeys = this.currentRun?.runId === runId
        ? [...(this.currentRun.stagedOutputMediaKeys ?? [])]
        : [];
      if (stagedKeys.length > 0) {
        this.ctx.waitUntil(this.deleteUnreferencedActiveMedia(stagedKeys).catch((error) => {
          console.warn(
            `[Process] Failed to clean promoted reply media for ${runId}: ${errorMessageFromUnknown(error)}`,
          );
        }));
      }
    }

    context = await buildGenerationContext();
    await this.updateContextState(runId, conversationId, run.config!, context, response.usage, assistantMetadata?.usage);
    if (this.handleRunStopped(runId)) {
      return;
    }

    if (toolCalls.length > 0) {
      const pendingHil = await this.processToolCalls(runId);
      if (this.handleRunStopped(runId)) {
        return;
      }
      if (
        !pendingHil
        && this.store.getResults(runId).length > 0
        && this.store.isRunResolved(runId)
      ) {
        await this.scheduleTick(runId);
      }
    } else {
      await this.finishRun(runId, {
        reason: "turn.complete",
        status: "ok",
        text,
        usage: response.usage,
      });
    }
  }

  private async generateAssistantResponse(options: {
    runId: string;
    conversationId: string;
    config: AiConfigResult;
    aiTextGenerateConfig?: AiTextGenerateConfig;
    context: Context;
    sessionAffinityKey?: string;
    streamSeq?: StreamSeqCounter;
  }): Promise<AssistantMessage | null> {
    const executor = options.config.executor;
    if (executor.kind === "process" && executor.pid === this.pid) {
      return await this.generateAssistantResponseLocally(options);
    }
    const result = await this.kernelRpc(
      "ai.text.generate",
      this.buildAiTextGenerateArgs({
        config: options.aiTextGenerateConfig,
        context: options.context,
        sessionAffinityKey: options.sessionAffinityKey,
        target: executor.kind === "device" ? executor.target : undefined,
      }),
      this.runAbortSignal(options.runId),
    );
    return result.message as unknown as AssistantMessage;
  }

  private async generateAssistantResponseLocally(options: {
    runId: string;
    conversationId: string;
    config: AiConfigResult;
    aiTextGenerateConfig?: AiTextGenerateConfig;
    context: Context;
    sessionAffinityKey?: string;
    streamSeq?: StreamSeqCounter;
  }): Promise<AssistantMessage | null> {
    const routedFetch = this.createGenerationFetch(options.config, options.runId);
    const signal = this.runAbortSignal(options.runId);
    const stream = options.config.generationStreaming !== "off" &&
      typeof this.generation.stream === "function"
      // TODO: add ai.text.stream
      ? this.generation.stream({
        config: options.config,
        context: options.context,
        ...(routedFetch ? { fetch: routedFetch } : {}),
        sessionAffinityKey: options.sessionAffinityKey,
        signal,
      })
      : null;

    if (!stream) {
      return await this.generation.generate({
        config: options.config,
        context: options.context,
        ...(routedFetch ? { fetch: routedFetch } : {}),
        sessionAffinityKey: options.sessionAffinityKey,
        signal,
      });
    }

    let seq = options.streamSeq?.value ?? 0;
    let response: AssistantMessage | null = null;
    for await (const event of stream) {
      seq += 1;
      if (options.streamSeq) {
        options.streamSeq.value = seq;
      }
      await this.emitRunStreamEvent(options.runId, options.conversationId, seq, event);
      if (event.type === "done") {
        response = event.message;
      } else if (event.type === "error") {
        response = event.error;
      }
      if (this.handleRunStopped(options.runId)) {
        return null;
      }
    }

    return response ?? await stream.result();
  }

  private async generateCompactionText(options: {
    config: AiConfigResult;
    context: Context;
    options: AiTextGenerateOptions;
    sessionAffinityKey: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const executor = options.config.executor;
    if (executor.kind !== "process" || executor.pid !== this.pid) {
      const result = await this.kernelRpc(
        "ai.text.generate",
        this.buildAiTextGenerateArgs({
          context: options.context,
          options: options.options,
          sessionAffinityKey: options.sessionAffinityKey,
          target: executor.kind === "device" ? executor.target : undefined,
        }),
        options.signal,
      );
      return result.text ?? "";
    }
    const routedFetch = this.createGenerationFetch(options.config, this.currentRun?.runId);
    return await this.generation.generateText({
      config: options.config,
      context: options.context,
      options: options.options,
      ...(routedFetch ? { fetch: routedFetch } : {}),
      sessionAffinityKey: options.sessionAffinityKey,
      signal: options.signal,
    });
  }

  private buildAiTextGenerateArgs(options: {
    config?: AiTextGenerateConfig;
    context: Context;
    options?: AiTextGenerateOptions;
    sessionAffinityKey?: string;
    target?: string;
  }): ArgsOf<"ai.text.generate"> {
    const config = options.config ?? this.buildAiTextGenerateConfig();
    return {
      ...(options.target ? { target: options.target } : {}),
      systemPrompt: options.context.systemPrompt,
      messages: options.context.messages as ArgsOf<"ai.text.generate">["messages"],
      ...(options.context.tools && options.context.tools.length > 0
        ? { tools: options.context.tools as ArgsOf<"ai.text.generate">["tools"] }
        : {}),
      ...(config ? { config } : {}),
      ...(options.options ? { options: options.options } : {}),
      ...(options.sessionAffinityKey ? { sessionAffinityKey: options.sessionAffinityKey } : {}),
    };
  }

  private buildAiTextGenerateConfig(): AiTextGenerateConfig | undefined {
    const snapshot = this.store.getAiConfigSnapshot();
    if (!snapshot) {
      return undefined;
    }
    const config: AiTextGenerateConfig = {};
    if (Object.keys(snapshot.values).length > 0) {
      config.processOverrides = { ...snapshot.values };
    }
    if (snapshot.profile) {
      config.processProfile = snapshot.profile;
    }
    return config.processOverrides || config.processProfile ? config : undefined;
  }

  private recordUnpersistedAssistantUsage(
    conversationId: string,
    response: AssistantMessage,
    config: AiConfigResult,
  ): ProcUsageState | undefined {
    const usage = buildAssistantMessageMetadata(response, config)?.usage;
    if (usage) {
      this.store.addConversationUsage(conversationId, usage);
    }
    return usage;
  }

  private async finishRun(runId: string, options: RunFinishOptions): Promise<void> {
    const releaseLifecycle = await this.acquireLifecycleTransition();
    try {
      const run = this.currentRun;
      if (!run || run.runId !== runId) {
        return;
      }

      const shouldQueueRuntimeWake =
        (run.pendingRuntimeEvents ?? 0) > 0
        && this.store.queueSize(run.conversationId) === 0;
      this.emitRunFinished(run, options);
      this.currentRun = null;
      this.runAbortControllers.delete(runId);
      this.store.clearPendingHil();
      console.log(`[Process] Finished run ${runId}`);

      const wakeRunId = shouldQueueRuntimeWake ? crypto.randomUUID() : undefined;
      if (wakeRunId) {
        this.store.enqueue(
          wakeRunId,
          RUNTIME_EVENT_WAKE_MESSAGE,
          undefined,
          run.conversationId,
        );
      }
      const next = this.claimNextQueuedRun();

      if (wakeRunId && next?.runId !== wakeRunId) {
        this.ctx.waitUntil(this.emitProcChanged(["queue"], {
          conversationId: run.conversationId,
          enqueuedRunId: wakeRunId,
        }));
      }
      this.promoteNextQueuedRun(next);
    } finally {
      releaseLifecycle();
    }
  }

  private consumeRuntimeEventsInContext(runId: string, count: number): void {
    if (count <= 0) {
      return;
    }
    const run = this.currentRun;
    if (!run || run.runId !== runId) {
      return;
    }
    const remaining = Math.max(0, (run.pendingRuntimeEvents ?? 0) - count);
    if (remaining > 0) {
      run.pendingRuntimeEvents = remaining;
    } else {
      delete run.pendingRuntimeEvents;
    }
    this.currentRun = run;
  }

  private async finishProviderContextOverflowRun(
    runId: string,
    conversationId: string,
    config: AiConfigResult,
    providerMessage?: string,
  ): Promise<void> {
    const message = formatProviderContextOverflowMessage(providerMessage, {
      provider: config.provider,
      model: config.model,
    });
    this.store.appendMessage("system", message, { conversationId, runId });
    await this.emitProcChanged(["messages"], {
      conversationId,
      runId,
      role: "system",
      content: message,
    });
    if (this.handleRunStopped(runId)) {
      return;
    }
    await this.finishRun(runId, {
      reason: CONTEXT_PROVIDER_OVERFLOW_REASON,
      status: "error",
      text: null,
      error: message,
    });
  }

  private async finishInsufficientCompactionRun(
    runId: string,
    conversationId: string,
    policy: ProcConversationContextPolicy,
    beforePressure: number,
    afterPressure: number,
  ): Promise<void> {
    const message = [
      "Auto-compaction could not reduce this conversation below its context limit.",
      `Pressure: ${Math.round(beforePressure * 100)}% before, ${Math.round(afterPressure * 100)}% after.`,
      `Policy: compact at ${Math.round(policy.compactAtPressure * 100)}% and keep ${policy.keepLast} recent messages.`,
      "Lower keepLast, compact more history manually, or reset the conversation.",
    ].join("\n");
    this.store.appendMessage("system", message, { conversationId, runId });
    await this.emitProcChanged(["messages"], {
      conversationId,
      runId,
      role: "system",
      content: message,
    });
    if (!this.handleRunStopped(runId)) {
      await this.finishRun(runId, {
        reason: "context.auto_compact.insufficient",
        status: "error",
        text: null,
        error: message,
      });
    }
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

    if (policy.overflow === "fail") {
      const message = [
        "Context limit policy stopped this run.",
        `Policy: fail at ${Math.round(policy.compactAtPressure * 100)}% context pressure.`,
        `Current estimate: ${Math.round(pressure * 100)}%.`,
        "Compact or reset the conversation before sending more work.",
      ].join("\n");
      this.store.appendMessage("system", message, { conversationId, runId });
      await this.emitProcChanged(["messages"], {
        conversationId,
        runId,
        role: "system",
        content: message,
      });
      await this.finishRun(runId, {
        reason: "context.policy.fail",
        status: "error",
        text: null,
        error: message,
      });
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
      this.store.appendMessage("system", message, { conversationId, runId });
      await this.emitProcChanged(["messages"], {
        conversationId,
        runId,
        role: "system",
        content: message,
      });
      await this.finishRun(runId, {
        reason: "context.auto_compact.empty",
        status: "error",
        text: null,
        error: message,
      });
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
        activeRunId: runId,
      },
    );
    if (this.handleRunStopped(runId)) {
      return "stopped";
    }
    if (!result.ok) {
      const message = `Auto-compaction failed before model call: ${result.error}`;
      this.store.appendMessage("system", message, { conversationId, runId });
      await this.emitProcChanged(["messages"], {
        conversationId,
        runId,
        role: "system",
        content: message,
      });
      await this.finishRun(runId, {
        reason: "context.auto_compact.failed",
        status: "error",
        text: null,
        error: message,
      });
      return "stopped";
    }

    if (this.handleRunStopped(runId)) {
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
    usageState?: ProcUsageState,
  ): Promise<ProcContextState> {
    const { count: messageCount, lastMessageId } = this.store.messageStats(conversationId);
    const state = buildProcContextState({
      conversationId,
      runId,
      messageCount,
      lastMessageId,
      provider: config.provider,
      model: config.model,
      reasoning: config.reasoning,
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxTokens,
      estimatedInputTokens: estimateContextInputTokens(context),
      usage,
      usageState,
      conversationUsage: this.store.getConversationUsage(conversationId),
    });
    this.store.setContextState(state);
    await this.emitProcChanged(["context"], {
      context: state,
    }).catch((error) => {
      console.warn(
        `[Process] Failed to emit proc.changed context for ${this.pid}: ${
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
    signal?: AbortSignal,
  ): Promise<ResultOf<T>> {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const frame = { type: "req", id, call, args } as RequestFrame;
    const pending = sendFrameToKernel(this.pid, frame);
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = signal && new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => {
      const reason = signal?.reason instanceof Error
        ? signal.reason.message
        : "Request cancelled";
      this.ctx.waitUntil(
        cancelProcessRequests(
          this.pid,
          [id],
          reason,
        ).catch(() => 0),
      );
      void pending.then((response) =>
        response?.type === "res"
          ? cancelResponseBody(response, reason)
          : undefined
      ).catch(() => {});
      rejectAbort?.(signal?.reason);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let response: Frame | null;
    try {
      response = await (aborted ? Promise.race([pending, aborted]) : pending);
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", cancel);
    }

    if (!response || response.type !== "res") {
      throw new Error(`No synchronous response for ${call}`);
    }
    if (!response.ok) {
      throw new Error((response as ResponseErrFrame).error.message);
    }
    return response.data as ResultOf<T>;
  }

  private createGenerationFetch(
    config: AiConfigResult,
    runId?: string,
  ): typeof fetch | undefined {
    const target = normalizeTarget(config.transportTarget);
    if (target === "gsv") {
      return undefined;
    }
    return async (input, init) => {
      const requestedRedirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
      const redirect = requestedRedirect === "follow"
        || requestedRedirect === "error"
        || requestedRedirect === "manual"
        ? requestedRedirect
        : undefined;
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const runSignal = runId ? this.runAbortSignal(runId) : undefined;
      const signal = runSignal && callerSignal
        ? AbortSignal.any([runSignal, callerSignal])
        : runSignal ?? callerSignal;
      const request = new Request(input, {
        ...init,
        ...(redirect === "error" ? { redirect: "manual" } : {}),
        ...(signal ? { signal } : {}),
      });
      const outbound = requestToNetFetchArgs(request, redirect);
      const timeoutMs = normalizeNetFetchTimeoutMs((init as RoutedFetchInit | undefined)?.timeoutMs);
      const requestId = crypto.randomUUID();
      const response = await requestNetFetchWithSignal(
        () => this.requestKernelNetFetch(
          target,
          {
            ...outbound.args,
            timeoutMs,
          },
          timeoutMs,
          outbound.body,
          requestId,
        ),
        request.signal,
        outbound.body,
        (reason) => {
          this.ctx.waitUntil(cancelProcessRequests(
            this.pid,
            [requestId],
            reason instanceof Error ? reason.message : undefined,
          ).catch(() => 0));
        },
      );
      return responseFromNetFetchResult(response.data, response.body, request.signal);
    };
  }

  private runAbortSignal(runId: string): AbortSignal {
    let controller = this.runAbortControllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.runAbortControllers.set(runId, controller);
    }
    return controller.signal;
  }

  private async requestKernelNetFetch(
    target: string,
    args: NetFetchArgs,
    ttlMs?: number,
    body?: FrameBody,
    requestId?: string,
  ): Promise<ResponseOkFrame<"net.fetch">> {
    return await requestProcessNetFetch(
      this.pid,
      target,
      args,
      {
        ttlMs,
        internalPurpose: "model-transport",
        ...(body ? { body } : {}),
        ...(requestId ? { requestId } : {}),
      },
    );
  }

  private async resolveAiConfig(signal?: AbortSignal): Promise<AiConfigResult> {
    const snapshot = this.store.getAiConfigSnapshot();
    return await this.kernelRpc("ai.config", snapshot
      ? {
          processOverrides: snapshot.values,
          processProfile: snapshot.profile ?? null,
        }
      : {}, signal);
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

  private async announceRun(
    runId: string,
    conversationId: string,
    reason: string,
  ): Promise<void> {
    if (this.currentRun?.runId !== runId) {
      return;
    }
    try {
      await this.sendSignal("proc.run.started", {
        pid: this.pid,
        runId,
        conversationId: normalizeConversationId(conversationId),
        reason,
        queuedCount: this.store.queueSize(),
        timestamp: Date.now(),
      });
    } catch (error) {
      console.warn(`[Process] Failed to emit start for ${runId}:`, error);
    }
  }

  private async emitToolStarted(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.sendSignal("proc.run.tool.started", payload);
    } catch (error) {
      console.warn(`[Process] Failed to emit tool start for ${this.pid}:`, error);
    }
  }

  private async emitRunStreamEvent(
    runId: string,
    conversationId: string,
    seq: number,
    event: AssistantMessageEvent,
  ): Promise<void> {
    await this.sendSignal("proc.run.stream", {
      pid: this.pid,
      runId,
      conversationId: normalizeConversationId(conversationId),
      seq,
      event: snapshotAssistantMessageEvent(event),
      timestamp: Date.now(),
    });
  }

  private async emitRunRetrying(
    runId: string,
    conversationId: string,
    attempt: number,
    maxAttempts: number,
    reason: string,
  ): Promise<void> {
    await this.sendSignal("proc.run.retrying", {
      pid: this.pid,
      runId,
      conversationId: normalizeConversationId(conversationId),
      attempt,
      nextAttempt: attempt + 1,
      maxAttempts,
      reason,
      timestamp: Date.now(),
    });
  }

  private async beginGenerationRetry(options: {
    runId: string;
    conversationId: string;
    attempt: number;
    maxAttempts: number;
    reason: string;
    cause: string;
  }): Promise<"retry" | "stopped"> {
    console.warn(
      `[Process] Retrying LLM generation after ${options.cause} ` +
      `(${options.attempt}/${options.maxAttempts}): ${options.reason}`,
    );
    if (this.handleRunStopped(options.runId)) {
      return "stopped";
    }
    await this.emitRunRetrying(
      options.runId,
      options.conversationId,
      options.attempt,
      options.maxAttempts,
      options.reason,
    );
    return this.handleRunStopped(options.runId) ? "stopped" : "retry";
  }

  private async beginGenerationFallback(options: {
    runId: string;
    conversationId: string;
    reason: string;
    from: AiConfigResult;
    to: AiConfigResult;
    fallbackIndex: number;
    fallbackCount: number;
  }): Promise<"fallback" | "stopped"> {
    console.warn(
      `[Process] Switching LLM generation from ${formatAiModelStackLabel(options.from)} ` +
      `to fallback ${formatAiModelStackLabel(options.to)}: ${options.reason}`,
    );
    if (this.handleRunStopped(options.runId)) {
      return "stopped";
    }
    await this.sendSignal("proc.run.retrying", {
      pid: this.pid,
      runId: options.runId,
      conversationId: normalizeConversationId(options.conversationId),
      attempt: options.fallbackIndex,
      nextAttempt: options.fallbackIndex + 1,
      maxAttempts: options.fallbackCount + 1,
      reason: options.reason,
      fallback: {
        from: {
          provider: options.from.provider,
          model: options.from.model,
        },
        to: {
          provider: options.to.provider,
          model: options.to.model,
        },
      },
      timestamp: Date.now(),
    });
    return this.handleRunStopped(options.runId) ? "stopped" : "fallback";
  }

  private emitRunFinished(run: RunState, options: RunFinishOptions): void {
    if (!run.outputMediaPersisted && run.stagedOutputMediaKeys?.length) {
      const keys = [...run.stagedOutputMediaKeys];
      this.ctx.waitUntil(this.deleteUnreferencedActiveMedia(keys).catch((error) => {
        console.warn(
          `[Process] Failed to clean unfinished reply media for ${run.runId}: ${errorMessageFromUnknown(error)}`,
        );
      }));
    }
    const payload = this.runFinishedPayload(run, options);
    const pending = JSON.parse(
      this.store.getValue(PENDING_RUN_FINISHES_KEY) ?? "[]",
    ) as Array<typeof payload>;
    if (!pending.some((finish) => finish.runId === run.runId)) {
      pending.push(payload);
      this.store.setValue(PENDING_RUN_FINISHES_KEY, JSON.stringify(pending));
    }
    this.ctx.waitUntil(this.onRunFinishDelivery(run.runId));
  }

  private runFinishedPayload(
    run: RunState,
    options: RunFinishOptions,
    queuedCount = this.store.queueSize(),
  ) {
    return {
      pid: this.pid,
      runId: run.runId,
      conversationId: normalizeConversationId(run.conversationId),
      status: options.status ?? "ok",
      reason: options.reason,
      text: options.text ?? null,
      ...(options.error ? { error: options.error } : {}),
      ...(options.usage !== undefined ? { usage: options.usage } : {}),
      ...(run.outputMediaPersisted && run.outputMedia?.length
        ? { media: run.outputMedia }
        : {}),
      ...(options.status === "aborted" ? { aborted: true } : {}),
      queuedCount,
      timestamp: Date.now(),
    };
  }

  async onRunFinishDelivery(runId: string): Promise<void> {
    const pending = JSON.parse(
      this.store.getValue(PENDING_RUN_FINISHES_KEY) ?? "[]",
    ) as Array<Record<string, unknown> & { runId: string }>;
    const payload = pending.find((finish) => finish.runId === runId);
    if (!payload) {
      return;
    }
    try {
      const { deliveryAttempts: _deliveryAttempts, ...signalPayload } = payload;
      await this.sendSignal("proc.run.finished", signalPayload);
    } catch (error) {
      console.warn(`[Process] Failed to emit finish for ${runId}:`, error);
      const attempts = typeof payload.deliveryAttempts === "number"
        && Number.isSafeInteger(payload.deliveryAttempts)
        && payload.deliveryAttempts >= 0
        ? payload.deliveryAttempts + 1
        : 1;
      if (attempts >= MAX_RUN_FINISH_DELIVERY_ATTEMPTS) {
        this.removePendingRunFinish(runId);
        const conversationId = normalizeConversationId(
          typeof payload.conversationId === "string" ? payload.conversationId : undefined,
        );
        const messageId = this.store.appendMessage(
          "system",
          "Automatic reply delivery stopped after repeated transport failures. The completed answer remains in this conversation history.",
          { conversationId, runId },
        );
        this.ctx.waitUntil(this.emitProcChanged(["messages"], {
          conversationId,
          runId,
          messageId,
        }));
        return;
      }
      payload.deliveryAttempts = attempts;
      this.store.setValue(PENDING_RUN_FINISHES_KEY, JSON.stringify(pending));
      await this.schedule(5, "onRunFinishDelivery", runId, {
        idempotent: false,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      });
      return;
    }

    this.removePendingRunFinish(runId);
  }

  private removePendingRunFinish(runId: string): void {
    const remaining = (JSON.parse(
      this.store.getValue(PENDING_RUN_FINISHES_KEY) ?? "[]",
    ) as Array<{ runId: string }>).filter((finish) => finish.runId !== runId);
    if (remaining.length > 0) {
      this.store.setValue(PENDING_RUN_FINISHES_KEY, JSON.stringify(remaining));
    } else {
      this.store.deleteValue(PENDING_RUN_FINISHES_KEY);
    }
  }

  private async emitProcChanged(
    changes: string[],
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.sendSignal("proc.changed", {
        pid: this.pid,
        changes,
        queuedCount: this.store.queueSize(),
        timestamp: Date.now(),
        ...payload,
      });
    } catch (error) {
      console.warn(`[Process] Failed to emit state change for ${this.pid}:`, error);
    }
  }

  private async resolveCheckpointConfig(signal?: AbortSignal): Promise<AiConfigResult | null> {
    if (this.currentRun?.config) {
      return this.currentRun.config;
    }
    try {
      return await this.resolveAiConfig(signal);
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn("[Process] Failed to resolve AI config for compaction:", error);
      return null;
    }
  }

  /**
   * R2-key prefix where a conversation's transcript archives live, under the
   * run-as agent's home: `home/<agent>/conversations/<id>`. Keyed by the agent
   * identity + conversation, NOT the (fungible) executor pid, so transcripts
   * survive across executors and can be hydrated on resume.
   */
  private conversationArchiveDir(conversationId: string): string {
    const homeKey = this.identity.home.replace(/^\/+/, "").replace(/\/+$/, "");
    const normalized = normalizeConversationId(conversationId);
    // The primary ("default") thread is addressed by the durable kernel
    // conversation id (e.g. default:<owner>:<agent>) when one is assigned, so
    // transcripts live at a stable, executor-independent path. Ad-hoc threads
    // (forks opened via proc.conversation.open) keep their local id.
    const pathId = normalized === DEFAULT_CONVERSATION_ID && this.primaryConversationId
      ? this.primaryConversationId
      : normalized;
    return `${homeKey}/conversations/${encodeURIComponent(pathId)}`;
  }

  /**
   * Hydrate the primary ("default") thread from a previously-archived transcript
   * when a fresh executor resumes a conversation. Lossless: the archive holds
   * the working window as it was at kill (already incorporating any prior
   * size-compaction summaries), so we restore exactly that window.
   */
  private async hydratePrimaryConversation(archivePath: string): Promise<void> {
    if (this.store.messageCount(DEFAULT_CONVERSATION_ID) > 0) {
      return; // Already has live messages; never double-hydrate.
    }
    let archived: ArchivedMessageRecord[];
    try {
      archived = await this.readArchivedMessageRecords(archivePath);
    } catch (error) {
      console.warn(
        `[Process] Failed to hydrate conversation from ${archivePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const conversation = this.store.ensureConversation(DEFAULT_CONVERSATION_ID);
    for (const record of archived) {
      this.appendRestoredArchivedMessage(record, DEFAULT_CONVERSATION_ID, conversation.generation);
    }
  }

  private async archiveConversationMessages(
    conversationId: string,
    archiveId: string,
  ): Promise<string | null> {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const messages = this.store.getMessages({
      conversationId: normalizedConversationId,
      limit: null,
    });
    if (messages.length === 0) return null;

    const key = `${this.conversationArchiveDir(normalizedConversationId)}/${archiveId}.jsonl.gz`;

    await this.archiveMessageRecords(key, messages);
    return key;
  }

  private async archiveAllConversationMessages(
    archiveId: string,
    kind: ProcConversationArchiveKind,
  ): Promise<ProcessArchiveResult> {
    const archives: ProcArchiveEntry[] = [];
    let archivedMessages = 0;

    const conversations = this.store
      .listConversations({ includeClosed: true })
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const conversation of conversations) {
      const messages = this.store.getMessages({
        conversationId: conversation.id,
        limit: null,
      });
      if (messages.length === 0) {
        continue;
      }

      const key = `${this.conversationArchiveDir(conversation.id)}/${archiveId}.${conversationArchiveFilename(
        conversation.id,
        conversation.generation,
      )}`;

      await this.archiveMessageRecords(key, messages);
      const archivePath = `/${key}`;
      this.store.recordConversationArchive({
        id: `${archiveId}:${encodeURIComponent(conversation.id)}:gen-${conversation.generation}`,
        conversationId: conversation.id,
        generation: conversation.generation,
        kind,
        messages: messages.length,
        archivePath,
      });
      archivedMessages += messages.length;
      archives.push({
        conversationId: conversation.id,
        generation: conversation.generation,
        messages: messages.length,
        path: archivePath,
      });
    }

    const homeKey = this.identity.home.replace(/^\/+/, "").replace(/\/+$/, "");
    return {
      archivedMessages,
      archivedTo: archivedMessages > 0 ? `/${homeKey}/conversations/` : undefined,
      archives,
    };
  }

  private async archiveMessageRecords(
    key: string,
    messages: MessageRecord[],
    signal?: AbortSignal,
  ): Promise<void> {
    const mediaRewrites = await this.persistArchivedMedia(messages, signal);
    const compressed = await raceWithAbort(
      new Response(gzipMessageRecords(messages, signal, mediaRewrites)).arrayBuffer(),
      signal,
    );
    const upload = this.env.STORAGE.put(key, compressed, {
      httpMetadata: { contentType: "application/gzip" },
    });
    await raceWithAbort(upload, signal, {
      onAbort: () => {
        this.ctx.waitUntil(upload.then(
          () => this.deleteFailedCompactionArchive(key),
          () => undefined,
        ));
      },
    });
  }

  private async deleteFailedCompactionArchive(key: string): Promise<void> {
    try {
      await this.env.STORAGE.delete(key);
    } catch (error) {
      console.warn(`[Process] Failed to delete unreferenced archive ${key}:`, error);
    }
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
    dispatchId: string,
    call: SyscallName,
    args: unknown,
  ): Promise<void> {
    if (this.handleRunStopped(runId) || !this.store.getPending(dispatchId)) {
      return;
    }

    const reqFrame: RequestFrame = {
      type: "req",
      id: dispatchId,
      call,
      args,
      runId,
    } as RequestFrame;

    const response = await sendFrameToKernel(this.pid, reqFrame);

    if (response && response.type === "res") {
      if (!this.store.getPending(dispatchId)) {
        await cancelResponseBody(response, "Tool call is no longer pending");
        return;
      }
      const res = response;
      if (res.ok) {
        try {
          const result = await materializeToolResponse(
            call,
            res.data ?? null,
            res.body,
            this.runAbortSignal(runId),
          );
          this.rememberShellSessionTargetFromResult(call, args, result);
          this.store.resolve(dispatchId, formatAgentToolResponse(call, args, result));
        } catch (error) {
          this.store.fail(
            dispatchId,
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        this.store.fail(
          dispatchId,
          (res as { error: { message: string } }).error.message,
        );
      }
    }
  }

  private async buildContextMessages(conversationId: string): Promise<Context["messages"]> {
    const records = this.store.getMessages({ conversationId, limit: null });
    const messages = this.store.toMessages({ conversationId, limit: null });
    const mediaBudget = { remainingBytes: MAX_PROCESS_MEDIA_READ_BYTES };

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.role !== "user" || !record.media) {
        continue;
      }

      const content = await this.hydrateUserContent(record.content, record.media, mediaBudget);
      messages[index] = {
        role: "user",
        content,
        timestamp: record.createdAt,
      } satisfies UserMessage;
    }

    let previousSource: string | null | undefined;
    for (let index = 0; index < records.length; index += 1) {
      if (records[index].role !== "user") {
        continue;
      }

      const source = formatInteractionOriginForContext(parseInteractionOrigin(records[index].origin));
      const shouldRenderSource = source !== null && source !== previousSource;
      previousSource = source;
      if (!shouldRenderSource) {
        continue;
      }

      const message = messages[index];
      if (message?.role !== "user") {
        continue;
      }

      messages[index] = prefixUserMessageContent(message, `[From: ${source}]`);
    }

    return orderMessagesForProvider(messages);
  }

  private async hydrateUserContent(
    text: string,
    rawMedia: string,
    budget: { remainingBytes: number },
  ): Promise<Array<TextContent | ImageContent>> {
    const media = this.parseOwnedProcessMedia(rawMedia);
    const content: Array<TextContent | ImageContent> = [];

    if (text.trim().length > 0) {
      content.push({ type: "text", text });
    }

    for (const item of media) {
      content.push({
        type: "text",
        text: describeStoredProcessMedia(item),
      });

      if (item.type === "image" && item.key && !isVectorImageMimeType(item.mimeType)) {
        const data = await this.loadProcessMedia(item.key, item.mimeType, budget);
        if (data) {
          content.push(buildImageBlock(data, item.mimeType));
        }
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    return content;
  }

  private async loadProcessMedia(
    key: string,
    expectedContentType: string,
    budget: { remainingBytes: number },
  ): Promise<string | null> {
    if (!this.ownedMediaPath(key)) {
      return null;
    }
    const object = await this.env.STORAGE.get(key);
    if (!object) {
      return null;
    }
    if (
      !this.isValidOwnedArchiveObject(key, object, { expectedContentType })
      || object.size > MAX_PROCESS_MEDIA_READ_BYTES
      || object.size > budget.remainingBytes
    ) {
      await object.body.cancel("Process media cannot be hydrated").catch(() => {});
      return null;
    }

    budget.remainingBytes -= object.size;
    return encodeBase64Bytes(await object.arrayBuffer());
  }

  private archiveMediaPrefix(): string {
    return agentArchiveMediaPrefix(this.identity.home);
  }

  private ownedMediaPath(key: string): string | null {
    const activePath = processMediaPath(key);
    if (activePath && key.startsWith(processMediaPrefix(this.identity.uid, this.pid))) {
      return activePath;
    }
    return agentArchiveMediaPath(this.identity.home, key);
  }

  private isValidOwnedArchiveObject(
    key: string,
    object: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
    },
    expected: { sourceEtag?: string; expectedContentType?: string } = {},
  ): boolean {
    if (!key.startsWith(this.archiveMediaPrefix())) return true;
    return isValidAgentArchiveMediaObject({
      home: this.identity.home,
      key,
      uid: this.identity.uid,
      gid: this.identity.gid,
      object,
      expectedSourceEtag: expected.sourceEtag,
      expectedContentType: expected.expectedContentType,
    });
  }

  private parseOwnedProcessMedia(raw: string | null): StoredProcessMedia[] {
    return parseStoredProcessMedia(raw).map((item) => {
      const { path: _persistedPath, ...metadata } = item;
      const path = item.key ? this.ownedMediaPath(item.key) : null;
      return path ? { ...metadata, path } : metadata;
    });
  }

  private activeProcessMediaKeys(messages: MessageRecord[]): string[] {
    const sourcePrefix = processMediaPrefix(this.identity.uid, this.pid);
    return [...new Set(messages.flatMap((message) =>
      parseStoredProcessMedia(message.media).flatMap((media) =>
        media.key?.startsWith(sourcePrefix) && processMediaPath(media.key) ? [media.key] : []
      )
    ))].sort();
  }

  private async deleteUnreferencedActiveMedia(keys: string[]): Promise<void> {
    const candidates = [...new Set(keys)].sort();
    if (candidates.length === 0) return;

    const releaseMedia = await this.acquireMediaKeyAdmissions(candidates);
    try {
      const releaseLifecycle = await this.acquireLifecycleTransition();
      try {
        const prefix = processMediaPrefix(this.identity.uid, this.pid);
        const unreferenced = candidates.filter((key) =>
          key.startsWith(prefix)
          && processMediaPath(key) !== null
          && !this.store.referencesMediaKey(key)
          && !this.currentRun?.outputMedia?.some((item) => item.key === key)
        );
        if (unreferenced.length > 0) {
          await this.env.STORAGE.delete(unreferenced);
        }
      } finally {
        releaseLifecycle();
      }
    } finally {
      releaseMedia();
    }
  }

  /**
   * Move final reply attachments out of the executor-scoped live-media area
   * before they enter assistant history or a durable finish notification.
   * The resulting content-addressed files live in the run-as agent's reserved,
   * read-only archive namespace, so retries and later compaction cannot race
   * executor media cleanup.
   */
  private async promoteRunOutputMedia(runId: string): Promise<RunOutputMedia[]> {
    for (;;) {
      const run = this.currentRun;
      if (!run || run.runId !== runId) return [];
      const snapshot = [...(run.outputMedia ?? [])];
      const sourcePrefix = processMediaPrefix(this.identity.uid, this.pid);
      const sourceKeys = snapshot.flatMap((item) =>
        item.key.startsWith(sourcePrefix) && processMediaPath(item.key) ? [item.key] : []
      );
      if (sourceKeys.length === 0) return snapshot;

      const releaseMedia = await this.acquireMediaKeyAdmissions(sourceKeys);
      let retry = false;
      try {
        const rewrites = await this.persistArchivedMediaKeys(sourceKeys);
        const promoted = snapshot.map((item): RunOutputMedia => {
          const rewrite = rewrites.get(item.key);
          if (!rewrite) return item;
          if ("missing" in rewrite) {
            throw new Error(`reply media not found while finalizing: ${item.key}`);
          }
          return { ...item, ...rewrite };
        });

        const releaseLifecycle = await this.acquireLifecycleTransition();
        try {
          const activeRun = this.currentRun;
          if (!activeRun || activeRun.runId !== runId) return [];
          if (JSON.stringify(activeRun.outputMedia ?? []) !== JSON.stringify(snapshot)) {
            retry = true;
          } else {
            activeRun.outputMedia = promoted;
            this.currentRun = activeRun;
            return promoted;
          }
        } finally {
          releaseLifecycle();
        }
      } finally {
        releaseMedia();
      }
      if (!retry) return [];
    }
  }

  private async persistArchivedMedia(
    messages: MessageRecord[],
    signal?: AbortSignal,
  ): Promise<Map<string, ArchivedMediaRewrite>> {
    const sourceKeys = this.activeProcessMediaKeys(messages);
    return this.persistArchivedMediaKeys(sourceKeys, signal);
  }

  private async persistArchivedMediaKeys(
    sourceKeys: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ArchivedMediaRewrite>> {
    const rewrites = new Map<string, ArchivedMediaRewrite>();

    for (const sourceKey of [...new Set(sourceKeys)].sort()) {
      signal?.throwIfAborted();
      const sourceHead = await this.env.STORAGE.head(sourceKey);
      if (!sourceHead) {
        rewrites.set(sourceKey, { missing: true });
        continue;
      }
      const archiveId = await stableOpaqueId("archived-media", [sourceKey, sourceHead.etag]);
      const archivedKey = `${this.archiveMediaPrefix()}${archiveId}`;
      const sourceContentType = sourceHead.httpMetadata?.contentType?.trim()
        || "application/octet-stream";
      const existing = await this.env.STORAGE.head(archivedKey);
      const reusable = existing
        && existing.size === sourceHead.size
        && this.isValidOwnedArchiveObject(archivedKey, existing, {
          sourceEtag: sourceHead.etag,
          expectedContentType: sourceContentType,
        });
      if (existing && !reusable) {
        throw new Error(`archived media content-address collision: ${archivedKey}`);
      }
      if (!existing) {
        signal?.throwIfAborted();
        const source = await this.env.STORAGE.get(sourceKey);
        if (!source) {
          rewrites.set(sourceKey, { missing: true });
          continue;
        }
        if (
          source.etag !== sourceHead.etag
          || source.size !== sourceHead.size
          || (source.httpMetadata?.contentType?.trim() || "application/octet-stream")
            !== sourceContentType
        ) {
          await source.body.cancel("Process media changed while archiving").catch(() => {});
          throw new Error(`media changed while archiving: ${sourceKey}`);
        }
        if (signal?.aborted) {
          await source.body.cancel(signal.reason).catch(() => {});
          signal.throwIfAborted();
        }
        let fixed: FixedLengthStream;
        try {
          fixed = new FixedLengthStream(sourceHead.size);
        } catch (error) {
          await source.body.cancel(error).catch(() => {});
          throw error;
        }
        let stored: Promise<R2Object>;
        let piped: Promise<void>;
        try {
          stored = this.env.STORAGE.put(archivedKey, fixed.readable, {
            httpMetadata: {
              ...sourceHead.httpMetadata,
              contentType: sourceContentType,
            },
            customMetadata: {
              uid: String(this.identity.uid),
              gid: String(this.identity.gid),
              mode: "400",
              purpose: "conversation-media",
              sourceEtag: sourceHead.etag,
              sourceContentType,
            },
          });
          piped = source.body.pipeTo(fixed.writable, { signal });
        } catch (error) {
          await source.body.cancel(error).catch(() => {});
          throw error;
        }
        const [storedResult, pipedResult] = await Promise.allSettled([stored, piped]);
        if (storedResult.status === "rejected" || pipedResult.status === "rejected") {
          const reason = storedResult.status === "rejected"
            ? storedResult.reason
            : pipedResult.status === "rejected"
              ? pipedResult.reason
              : "unknown archive media error";
          throw reason instanceof Error ? reason : new Error(String(reason));
        }
        const copied = await this.env.STORAGE.head(archivedKey);
        if (
          !copied
          || copied.size !== sourceHead.size
          || !this.isValidOwnedArchiveObject(archivedKey, copied, {
            sourceEtag: sourceHead.etag,
            expectedContentType: sourceContentType,
          })
        ) {
          throw new Error(`failed to verify archived media: ${archivedKey}`);
        }
      }
      rewrites.set(sourceKey, { key: archivedKey, path: `/${archivedKey}` });
    }

    return rewrites;
  }

  private ingestToolResults(
    runId: string,
    toolResults: ReturnType<ProcessStore["getResults"]>,
    options?: { interruptPending?: string },
  ): { interrupted: number; appended: number } {
    const run = this.currentRun;
    const conversationId = normalizeConversationId(
      run?.runId === runId
        ? run.conversationId
        : toolResults[0]?.conversationId,
    );
    let interrupted = 0;
    let appended = 0;

    this.ctx.storage.transactionSync(() => {
      for (const result of toolResults) {
        let content: string;
        let isError: boolean;
        let outcome: ProcToolResultOutcome;

        if (result.status === "completed") {
          content =
            typeof result.result === "string"
              ? result.result
              : JSON.stringify(result.result ?? null);
          outcome = result.outcome ?? "completed";
          isError = outcome !== "completed";
        } else if (result.status === "error") {
          content = `Error: ${result.error}`;
          isError = true;
          outcome = result.outcome ?? "failed";
        } else if (options?.interruptPending) {
          content = `Error: ${options.interruptPending}`;
          isError = true;
          outcome = "cancelled";
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
          runId,
          outcome,
        );
        appended += 1;
      }
      this.store.clearRun(runId);
    });
    return { interrupted, appended };
  }

  private async processToolCalls(runId: string): Promise<PendingHilRecord | null> {
    const toolCalls = this.store.getResults(runId).filter(
      (result) => result.status === "registered",
    );
    if (toolCalls.length === 0) {
      return null;
    }

    const run = this.currentRun;
    if (!run || run.runId !== runId) {
      return null;
    }

    const approvalPolicy = this.resolveToolApprovalPolicy(run);
    if (this.handleRunStopped(runId)) {
      return null;
    }

    for (const tc of toolCalls) {
      if (this.handleRunStopped(runId)) {
        return null;
      }
      const syscall = SYSCALL_TOOL_NAMES[tc.call] ? tc.call as SyscallName : undefined;
      const toolName = SYSCALL_TOOL_NAMES[tc.call] ?? tc.call;

      if (!syscall) {
        this.store.fail(tc.dispatchId, `Unknown tool "${toolName}"`);
        continue;
      }

      const toolArgs = tc.args;
      const approval = resolveToolApproval(approvalPolicy, syscall, toolArgs);

      if (approval.action === "deny") {
        this.store.fail(tc.dispatchId, "Tool execution denied by policy");
        continue;
      }

      if (approval.action === "ask") {
        if (!this.interactive) {
          this.store.fail(
            tc.dispatchId,
            "Tool execution requires interactive approval, which is unavailable for this process",
          );
          continue;
        }
        const pendingHil: PendingHilRecord = {
          requestId: crypto.randomUUID(),
          runId,
          conversationId: run.conversationId,
          toolCallId: tc.id,
          toolName,
          syscall,
          args: asPlainRecord(toolArgs) ?? {},
          createdAt: Date.now(),
        };
        this.store.setPendingHil(pendingHil);
        await this.sendSignal("proc.run.hil.requested", this.toProcHilRequest(pendingHil));
        return pendingHil;
      }

      if (!await this.beginToolDispatch(runId, tc.dispatchId)) {
        if (this.handleRunStopped(runId)) {
          return null;
        }
        continue;
      }
      await this.emitToolStarted({
        name: toolName,
        syscall,
        args: toolArgs,
        callId: tc.id,
        pid: this.pid,
        runId,
        conversationId: run.conversationId,
      });
      if (this.handleRunStopped(runId)) {
        return null;
      }
      this.launchToolDispatch(
        runId,
        tc.dispatchId,
        syscall,
        toolArgs,
        approvalPolicy,
      );
    }

    return null;
  }

  private launchToolDispatch(
    runId: string,
    dispatchId: string,
    syscall: SyscallName,
    args: unknown,
    approvalPolicy: ToolApprovalPolicy,
  ): void {
    const execution = syscall === CODEMODE_EXEC
      ? this.executeCodeModeTool(runId, dispatchId, args, approvalPolicy)
      : this.dispatchSyscall(runId, dispatchId, syscall, args);
    this.ctx.waitUntil(execution
      .catch((error) => {
        if (this.store.getPending(dispatchId)) {
          this.store.fail(dispatchId, errorMessageFromUnknown(error));
        }
      })
      .then(() => this.resumeResolvedToolRun(runId)));
  }

  private async resumeResolvedToolRun(runId: string): Promise<void> {
    if (
      this.currentRun?.runId !== runId
      || this.store.getPendingHilForRun(runId)
      || !this.store.isRunResolved(runId)
    ) {
      return;
    }
    try {
      await this.scheduleTick(runId);
    } catch (error) {
      await this.finishRun(runId, {
        reason: "schedule.error",
        status: "error",
        text: null,
        error: `Failed to resume after tool execution: ${errorMessageFromUnknown(error)}`,
      });
    }
  }

  private async beginToolDispatch(runId: string, dispatchId: string): Promise<boolean> {
    const deadlineAt = Date.now() + TOOL_DISPATCH_TIMEOUT_MS;
    try {
      await this.schedule(
        new Date(deadlineAt),
        "onToolDispatchTimeout",
        { runId, dispatchId },
      );
    } catch (error) {
      this.store.fail(
        dispatchId,
        `Failed to schedule tool timeout: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (this.handleRunStopped(runId)) {
      return false;
    }
    return this.store.markDispatched(dispatchId);
  }

  private async handleCancellableRequest<T>(
    requestId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const cancelled = this.cancelledRequests.get(requestId);
    this.cancelledRequests.delete(requestId);
    if (cancelled) {
      controller.abort(new Error(cancelled));
    }
    this.requestControllers.set(requestId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.requestControllers.get(requestId) === controller) {
        this.requestControllers.delete(requestId);
      }
    }
  }

  private cancelRequest(payload: unknown): void {
    const value = asPlainRecord(payload);
    const requestId = typeof value?.id === "string" ? value.id : "";
    if (!requestId) {
      return;
    }
    const reason = typeof value?.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : "Request cancelled";
    const controller = this.requestControllers.get(requestId);
    if (controller) {
      controller.abort(new Error(reason));
      return;
    }
    if (this.cancelledRequests.size >= MAX_CANCELLED_REQUESTS) {
      const oldest = this.cancelledRequests.keys().next().value;
      if (oldest) {
        this.cancelledRequests.delete(oldest);
      }
    }
    this.cancelledRequests.set(requestId, reason);
  }

  private async handleCodeModeRun(
    rawArgs: CodeModeRunArgs,
    signal?: AbortSignal,
  ): Promise<CodeModeRunResult> {
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
        (call, toolArgs) => this.executeCodeModeSyscall(null, call, toolArgs, signal),
        {
          defaultTarget: normalizeOptionalString(args.target),
          defaultCwd: normalizeOptionalString(args.cwd),
          argv: Array.isArray(args.argv) ? args.argv.map((item) => String(item)) : [],
          args: args.args ?? null,
          mcpToolBindings: await this.getCodeModeMcpToolBindings(signal),
          signal,
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
    dispatchId: string,
    rawArgs: unknown,
    approvalPolicy: ToolApprovalPolicy,
  ): Promise<void> {
    const args = rawArgs && typeof rawArgs === "object"
      ? rawArgs as Partial<CodeModeExecArgs>
      : {};
    if (this.handleRunStopped(runId) || !this.store.getPending(dispatchId)) {
      return;
    }

    if (typeof args.code !== "string" || args.code.trim().length === 0) {
      this.store.resolve(dispatchId, {
        status: "failed",
        error: "CodeMode requires a non-empty code string",
      }, "failed");
      return;
    }

    try {
      const signal = this.runAbortSignal(runId);
      const result = await executeCodeMode(
        this.env,
        args.code,
        (call, toolArgs) => this.executeCodeModeSyscall(
          {
            runId,
            dispatchId,
            approvalPolicy,
            capabilities: this.currentRun?.config?.capabilities ?? [],
          },
          call,
          toolArgs,
          signal,
        ),
        {
          mcpToolBindings: await this.getCodeModeMcpToolBindings(signal),
          signal,
        },
      );
      this.store.resolve(
        dispatchId,
        result,
        result.status === "failed" ? "failed" : "completed",
      );
    } catch (error) {
      this.store.resolve(dispatchId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }, "failed");
    }
  }

  private async getCodeModeMcpToolBindings(signal?: AbortSignal) {
    try {
      const result = await this.kernelRpc("sys.mcp.list", {}, signal);
      return buildCodeModeMcpToolBindings(result.servers);
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }

  private async executeCodeModeSyscall(
    context: {
      runId: string;
      dispatchId: string;
      approvalPolicy: ToolApprovalPolicy;
      capabilities: string[];
    } | null,
    call: SyscallName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (context && this.handleRunStopped(context.runId)) {
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    const toolCallId = `codemode-${crypto.randomUUID()}`;
    const prepared = this.prepareToolArgs(call, args);
    if (prepared.missingShellSessionTarget) {
      throw new Error(UNKNOWN_SHELL_SESSION_TARGET_MESSAGE);
    }
    const toolArgs = asPlainRecord(prepared.args) ?? args;

    if (context) {
      const approval = resolveToolApproval(context.approvalPolicy, call, toolArgs);
      if (approval.action === "deny") {
        throw new Error(`Tool execution denied by policy: ${call}`);
      }
      if (approval.action === "ask") {
        if (!hasCapability(context.capabilities, call)) {
          throw new Error(`Permission denied: ${call}`);
        }
        if (!this.interactive) {
          throw new Error(
            `Tool execution requires interactive approval, which is unavailable for this process: ${call}`,
          );
        }
        const approved = await this.waitForCodeModeApproval(
          context.runId,
          context.dispatchId,
          toolCallId,
          SYSCALL_TOOL_NAMES[call] ?? call,
          call,
          toolArgs,
        );
        if (!approved) {
          throw new Error(`Tool execution was not approved: ${call}`);
        }
      }
    }

    if (context && this.handleRunStopped(context.runId)) {
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    const response = await this.dispatchCodeModeSyscall(
      context?.runId ?? null,
      toolCallId,
      call,
      toolArgs,
      signal,
    );

    if (context && this.handleRunStopped(context.runId)) {
      await cancelResponseBody(response, "Run stopped before CodeMode tool execution completed");
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    if (response.ok) {
      return await materializeToolResponse(
        call,
        response.data ?? null,
        response.body,
        signal ?? (context ? this.runAbortSignal(context.runId) : undefined),
      );
    }

    throw new Error(response.error.message);
  }

  private async waitForCodeModeApproval(
    runId: string,
    dispatchId: string,
    toolCallId: string,
    toolName: string,
    call: string,
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
      this.codeModeApprovals.set(requestId, { runId, dispatchId, resolve, timeoutId });
    });

    const pendingHil: PendingHilRecord = {
      requestId,
      runId,
      conversationId,
      ownerDispatchId: dispatchId,
      toolCallId,
      toolName,
      syscall: call,
      args,
      createdAt: Date.now(),
    };
    this.store.setPendingHil(pendingHil);
    await this.sendSignal("proc.run.hil.requested", this.toProcHilRequest(pendingHil));
    return approved;
  }

  private async dispatchCodeModeSyscall(
    runId: string | null,
    id: string,
    call: SyscallName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ResponseFrame> {
    signal?.throwIfAborted();
    const request = createCodeModeRequest(call, args);
    const reqFrame: RequestFrame = {
      type: "req",
      id,
      call,
      args: request.args,
      ...(runId ? { runId } : {}),
      ...(request.body ? { body: request.body } : {}),
    } as RequestFrame;

    const pending = new Promise<ResponseFrame>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.codeModeResponses.delete(id);
        this.ctx.waitUntil(
          cancelProcessRequests(this.pid, [id], `${call} timed out`).catch(() => 0),
        );
        reject(new Error(`Timed out waiting for ${call}`));
      }, CODE_MODE_NESTED_SYSCALL_TIMEOUT_MS);
      this.codeModeResponses.set(id, { runId, call, args, resolve, reject, timeoutId });
    });
    void pending.catch(() => {});

    const operation = (async () => {
      const response = await sendFrameToKernel(this.pid, reqFrame);
      if (response && response.type === "res") {
        const waiter = this.codeModeResponses.get(id);
        if (!waiter || (runId !== null && this.handleRunStopped(runId))) {
          await cancelResponseBody(response, `Run stopped before ${call} completed`);
          throw new Error(`Run stopped before ${call} completed`);
        }
        this.codeModeResponses.delete(id);
        clearTimeout(waiter.timeoutId);
        if (response.ok) {
          this.rememberShellSessionTargetFromResult(call, args, response.data ?? null);
        }
        return response;
      }
      if (response) {
        throw new Error(`Unexpected response frame for ${call}: ${response.type}`);
      }
      return await pending;
    })();

    try {
      return await raceWithAbort(operation, signal, {
        abortReason: () => signal?.reason ?? new Error("CodeMode request cancelled"),
        onAbort: () => {
          const reason = signal?.reason instanceof Error
            ? signal.reason.message
            : "CodeMode request cancelled";
          const waiter = this.codeModeResponses.get(id);
          if (waiter) {
            this.codeModeResponses.delete(id);
            clearTimeout(waiter.timeoutId);
            waiter.reject(new Error(reason));
          }
          this.ctx.waitUntil(
            cancelProcessRequests(this.pid, [id], reason).catch(() => 0),
          );
        },
        onLateResolve: (response) => {
          void cancelResponseBody(response, "CodeMode request was cancelled");
        },
      });
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

  private cancelPendingRequests(runId: string | null, reason: string): void {
    const requestIds = new Set<string>();
    const toolRunId = runId ?? this.currentRun?.runId;
    if (toolRunId) {
      for (const result of this.store.getResults(toolRunId)) {
        if (result.status === "registered" || result.status === "pending") {
          requestIds.add(result.dispatchId);
        }
      }
    }
    for (const [id, waiter] of this.codeModeResponses) {
      if (runId === null || waiter.runId === runId) {
        requestIds.add(id);
      }
    }

    if (runId === null) {
      for (const controller of this.requestControllers.values()) {
        controller.abort(new Error(reason));
      }
      this.requestControllers.clear();
      for (const controller of this.runAbortControllers.values()) {
        controller.abort(new Error(reason));
      }
      this.runAbortControllers.clear();
    } else {
      this.runAbortControllers.get(runId)?.abort(new Error(reason));
      this.runAbortControllers.delete(runId);
    }

    if (requestIds.size > 0) {
      this.ctx.waitUntil(
        cancelProcessRequests(this.pid, [...requestIds], reason).catch(() => 0),
      );
    }
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

  private resolveToolApprovalPolicy(run: RunState): ToolApprovalPolicy {
    if (run.approvalPolicy) {
      return run.approvalPolicy;
    }

    const accountPolicy = parseToolApprovalPolicy(run.config?.accountApprovalPolicy ?? null);
    const overrides = this.loadToolApprovalOverrides();
    run.approvalPolicy = {
      default: accountPolicy.default,
      rules: [
        ...overrides,
        ...accountPolicy.rules,
      ],
    };
    this.currentRun = run;
    return run.approvalPolicy;
  }

  private prepareToolArgs(syscall: SyscallName, args: unknown): PreparedToolArgs {
    if (syscall !== "shell.exec") {
      return { args, missingShellSessionTarget: false };
    }

    const record = asPlainRecord(args);
    if (!record) {
      return { args, missingShellSessionTarget: false };
    }

    if (normalizeOptionalString(record.target)) {
      return { args, missingShellSessionTarget: false };
    }

    const sessionId = normalizeOptionalString(record.sessionId);
    if (!sessionId) {
      return { args, missingShellSessionTarget: false };
    }

    const target = this.loadShellSessionTarget(sessionId);
    if (!target) {
      return { args, missingShellSessionTarget: true };
    }

    return {
      args: { ...record, target },
      missingShellSessionTarget: false,
    };
  }

  private rememberShellSessionTargetFromResult(
    syscall: string,
    args: unknown,
    result: unknown,
  ): void {
    if (syscall !== "shell.exec") {
      return;
    }

    const resultRecord = asPlainRecord(result);
    const sessionId = normalizeOptionalString(resultRecord?.sessionId);
    if (!sessionId) {
      return;
    }

    const target = resolveToolApprovalTarget(syscall, args);
    if (target === "targets/*") {
      return;
    }

    this.store.setValue(this.shellSessionTargetKey(sessionId), target);
  }

  private loadShellSessionTarget(sessionId: string): string | null {
    const target = this.store.getValue(this.shellSessionTargetKey(sessionId));
    return normalizeOptionalString(target) ?? null;
  }

  private shellSessionTargetKey(sessionId: string): string {
    return `${SHELL_SESSION_TARGET_KEY_PREFIX}${sessionId}`;
  }

  private rememberToolApproval(pendingHil: PendingHilRecord, run: RunState): boolean {
    const rule = this.buildToolApprovalOverride(pendingHil.syscall, pendingHil.args);
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

  private buildToolApprovalOverride(syscall: string, args: unknown): ToolApprovalRule {
    const prepared = this.prepareToolArgs(syscall as SyscallName, args);
    const target = resolveToolApprovalTarget(syscall, prepared.args);
    return {
      match: syscall,
      target,
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

  private toProcHilRequest(record: PendingHilRecord | null): ProcHilRequest | null {
    if (!record) {
      return null;
    }

    return {
      pid: this.pid,
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

  private async acquireLifecycleTransition(): Promise<() => void> {
    const previous = this.lifecycleTransition;
    let release!: () => void;
    this.lifecycleTransition = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private async acquireQueuedSendAdmission(): Promise<() => void> {
    const previous = this.queuedSendAdmission;
    let release!: () => void;
    this.queuedSendAdmission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private async acquireMediaKeyAdmission(key: string): Promise<() => void> {
    const previous = this.mediaWriteAdmissions.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mediaWriteAdmissions.set(key, current);
    await previous;
    return () => {
      if (this.mediaWriteAdmissions.get(key) === current) {
        this.mediaWriteAdmissions.delete(key);
      }
      release();
    };
  }

  private async acquireMediaKeyAdmissions(keys: string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    try {
      for (const key of [...new Set(keys)].sort()) {
        releases.push(await this.acquireMediaKeyAdmission(key));
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  private async firstMissingMediaKey(keys: string[]): Promise<string | null> {
    for (const key of keys) {
      if (!await this.env.STORAGE.head(key)) return key;
    }
    return null;
  }

  private abortMediaUploads(reason: Error): void {
    for (const controller of this.mediaUploadAbortControllers.values()) {
      controller.abort(reason);
    }
    this.mediaUploadAbortControllers.clear();
  }

  private handleRunStopped(runId: string): boolean {
    return this.currentRun?.runId !== runId;
  }

  private rememberAbortedRun(runId: string): void {
    const runIds = JSON.parse(this.store.getValue(ABORTED_RUN_IDS_KEY) ?? "[]") as string[];
    if (!runIds.includes(runId)) {
      runIds.push(runId);
      this.store.setValue(
        ABORTED_RUN_IDS_KEY,
        JSON.stringify(runIds.slice(-IPC_TOMBSTONE_LIMIT)),
      );
    }
  }

  private isAbortedRun(runId: string): boolean {
    const runIds = JSON.parse(this.store.getValue(ABORTED_RUN_IDS_KEY) ?? "[]") as string[];
    return runIds.includes(runId);
  }

  private claimNextQueuedRun(): QueuedMessage | null {
    if (this.currentRun) {
      return null;
    }
    const next = this.store.dequeue();
    if (!next) {
      return null;
    }
    this.store.appendMessage("user", next.message, {
      conversationId: next.conversationId,
      generation: next.generation,
      runId: next.runId,
      media: next.media ?? undefined,
      origin: next.origin ?? undefined,
    });
    const origin = parseInteractionOrigin(next.origin);
    this.currentRun = {
      runId: next.runId,
      conversationId: next.conversationId,
      ...(origin ? { origin } : {}),
    };
    return next;
  }

  private promoteNextQueuedRun(
    claimed: QueuedMessage | null = this.claimNextQueuedRun(),
  ): string | null {
    if (!claimed || this.currentRun?.runId !== claimed.runId) {
      return null;
    }
    const next = claimed;
    this.ctx.waitUntil(this.scheduleTick(next.runId)
      .then(() => this.announceRun(next.runId, next.conversationId, "queue.promote"))
      .catch((error) => this.finishRun(next.runId, {
        reason: "schedule.error",
        status: "error",
        text: null,
        error: error instanceof Error ? error.message : String(error),
      })));
    return next.runId;
  }
}

function snapshotAssistantMessageEvent<T extends AssistantMessageEvent>(event: T): T {
  return JSON.parse(JSON.stringify(event)) as T;
}

function orderMessagesForProvider(messages: Message[]): Message[] {
  const ordered: Message[] = [];
  type PendingToolBlock = {
    expected: Set<string>;
    deferred: Message[];
  };
  const state: { pendingToolBlock: PendingToolBlock | null } = {
    pendingToolBlock: null,
  };

  const append = (message: Message): void => {
    const pendingToolBlock = state.pendingToolBlock;
    if (pendingToolBlock) {
      // Providers require tool results to immediately follow the assistant tool-call message.
      if (message.role === "toolResult" && pendingToolBlock.expected.has(message.toolCallId)) {
        pendingToolBlock.expected.delete(message.toolCallId);
        ordered.push(message);

        if (pendingToolBlock.expected.size === 0) {
          const deferred = pendingToolBlock.deferred;
          state.pendingToolBlock = null;
          for (const deferredMessage of deferred) {
            append(deferredMessage);
          }
        }
        return;
      }

      pendingToolBlock.deferred.push(message);
      return;
    }

    ordered.push(message);
    const toolCallIds = message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : [];
    if (toolCallIds.length > 0) {
      state.pendingToolBlock = {
        expected: new Set(toolCallIds),
        deferred: [],
      };
    }
  };

  for (const message of messages) {
    append(message);
  }

  if (state.pendingToolBlock) {
    ordered.push(...state.pendingToolBlock.deferred);
  }

  return ordered;
}

function serializeArchivedMessage(
  message: MessageRecord,
  mediaRewrites: ReadonlyMap<string, ArchivedMediaRewrite> = new Map(),
): Record<string, unknown> {
  const origin = parseInteractionOrigin(message.origin);
  const metadata = parseMessageMetadata(message.metadata) ?? undefined;
  const media = message.media
    ? parseStoredProcessMedia(message.media).map((item) => {
        const rewrite = item.key ? mediaRewrites.get(item.key) : undefined;
        if (rewrite && "missing" in rewrite) {
          const { key: _key, path: _path, ...metadataOnly } = item;
          return metadataOnly;
        }
        return rewrite ? { ...item, ...rewrite } : item;
      })
    : undefined;
  if (message.role === "assistant") {
    const meta = parseAssistantMessageMeta(message.toolCalls);
    return {
      id: message.id,
      conversation_id: message.conversationId,
      generation: message.generation,
      run_id: message.runId ?? undefined,
      role: message.role,
      content: message.content,
      tool_calls: meta.toolCalls,
      thinking: meta.thinking,
      tool_call_id: message.toolCallId ?? undefined,
      media,
      origin,
      metadata,
      ts: message.createdAt,
    };
  }

  return {
    id: message.id,
    conversation_id: message.conversationId,
    generation: message.generation,
    run_id: message.runId ?? undefined,
    role: message.role,
    content: message.content,
    media,
    tool_calls: message.toolCalls ? JSON.parse(message.toolCalls) : undefined,
    tool_call_id: message.toolCallId ?? undefined,
    origin,
    metadata,
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
  const runId = typeof record.run_id === "string" && record.run_id.trim().length > 0
    ? record.run_id
    : undefined;
  const origin = parseInteractionOriginRecord(record.origin);
  const metadata = normalizeMessageMetadata(record.metadata) ?? undefined;
  const toolResultMeta = role === "toolResult"
    && record.tool_calls
    && typeof record.tool_calls === "object"
    && !Array.isArray(record.tool_calls)
    ? record.tool_calls as Record<string, unknown>
    : null;
  const toolName = normalizeOptionalString(toolResultMeta?.toolName);
  const isError = typeof toolResultMeta?.isError === "boolean"
    ? toolResultMeta.isError
    : undefined;
  const outcome = role === "toolResult"
    ? normalizeToolResultOutcome(toolResultMeta?.outcome, isError ?? false, content)
    : undefined;

  return {
    id,
    runId,
    role,
    content,
    toolCalls: Array.isArray(record.tool_calls)
      ? record.tool_calls as ToolCall[]
      : undefined,
    thinking: Array.isArray(record.thinking)
      ? record.thinking as ThinkingContent[]
      : undefined,
    toolCallId,
    ...(toolName ? { toolName } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...(outcome ? { outcome } : {}),
    media: record.media,
    origin,
    metadata,
    createdAt,
  };
}

function serializeInteractionOrigin(origin: InteractionOrigin | undefined): string | null {
  if (!origin) return null;
  try {
    return JSON.stringify(origin);
  } catch {
    return null;
  }
}

function parseInteractionOrigin(value: string | null | undefined): InteractionOrigin | undefined {
  if (!value) return undefined;
  try {
    return parseInteractionOriginRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseInteractionOriginRecord(value: unknown): InteractionOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;

  if (kind === "client") {
    const connectionId = normalizeOptionalString(record.connectionId);
    if (!connectionId) return undefined;
    const clientId = normalizeOptionalString(record.clientId);
    const platform = normalizeOptionalString(record.platform);
    return {
      kind,
      connectionId,
      ...(clientId ? { clientId } : {}),
      ...(platform ? { platform } : {}),
    };
  }

  if (kind === "app") {
    const packageId = normalizeOptionalString(record.packageId);
    const packageName = normalizeOptionalString(record.packageName);
    const entrypointName = normalizeOptionalString(record.entrypointName);
    const routeBase = normalizeOptionalString(record.routeBase);
    if (!packageId || !packageName || !entrypointName || !routeBase) return undefined;
    return { kind, packageId, packageName, entrypointName, routeBase };
  }

  if (kind === "adapter") {
    const adapter = normalizeOptionalString(record.adapter);
    const accountId = normalizeOptionalString(record.accountId);
    const actorId = normalizeOptionalString(record.actorId);
    const surface = parseAdapterSurface(record.surface);
    if (!adapter || !accountId || !actorId || !surface) return undefined;
    const actorLabel = normalizeOptionalString(record.actorLabel);
    const messageId = normalizeOptionalString(record.messageId);
    return {
      kind,
      adapter,
      accountId,
      surface,
      actorId,
      ...(actorLabel ? { actorLabel } : {}),
      ...(messageId ? { messageId } : {}),
    };
  }

  if (kind === "device") {
    const deviceId = normalizeOptionalString(record.deviceId);
    if (!deviceId) return undefined;
    const cwd = normalizeOptionalString(record.cwd);
    return {
      kind,
      deviceId,
      ...(cwd ? { cwd } : {}),
    };
  }

  if (kind === "process") {
    const sourcePid = normalizeOptionalString(record.sourcePid);
    if (!sourcePid) return undefined;
    return {
      kind,
      sourcePid,
      ...(typeof record.uid === "number" && Number.isFinite(record.uid) ? { uid: record.uid } : {}),
    };
  }

  if (kind === "scheduler") {
    const scheduleId = normalizeOptionalString(record.scheduleId);
    if (!scheduleId) return undefined;
    const replyTo = parseAdapterMessageDestination(record.replyTo);
    return {
      kind,
      scheduleId,
      ...(replyTo ? { replyTo } : {}),
    };
  }

  return undefined;
}

function parseAdapterMessageDestination(value: unknown): AdapterMessageDestination | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "adapter") return undefined;
  const adapter = normalizeOptionalString(record.adapter);
  const accountId = normalizeOptionalString(record.accountId);
  const actorId = normalizeOptionalString(record.actorId);
  const surfaceRecord = record.surface && typeof record.surface === "object"
    ? record.surface as Record<string, unknown>
    : null;
  const surface = parseAdapterSurface(surfaceRecord);
  if (!adapter || !accountId || !actorId || !surface || !surfaceRecord) return undefined;
  return {
    kind: "adapter",
    adapter,
    accountId,
    actorId,
    surface: {
      kind: surface.kind,
      id: surface.id,
      ...(surface.threadId ? { threadId: surface.threadId } : {}),
    },
  };
}

function appendRunReplyContext(
  systemPrompt: string | undefined,
  origin: InteractionOrigin | undefined,
): string | undefined {
  const replyContext = formatRunReplyContext(origin);
  if (!replyContext) return systemPrompt;
  return [systemPrompt?.trimEnd(), "[run.reply]", replyContext]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function formatRunReplyContext(origin: InteractionOrigin | undefined): string | null {
  if (!origin) return null;

  if (origin.kind === "adapter") {
    return automaticAdapterReplyInstructions(origin.adapter, origin.surface.kind, false);
  }
  if (origin.kind === "scheduler") {
    if (origin.replyTo) {
      return automaticAdapterReplyInstructions(
        origin.replyTo.adapter,
        origin.replyTo.surface.kind,
        true,
      );
    }
    return "This scheduled run records its final response in the GSV process conversation; it has no external chat delivery destination.";
  }
  if (origin.kind === "client") {
    return "This run's final response is returned automatically to the GSV client that started it. Return the answer normally.";
  }
  if (origin.kind === "app") {
    return "This run's final response is returned automatically to the GSV app that started it. Return the answer normally.";
  }
  if (origin.kind === "process") {
    return "This run's final response is returned automatically to the calling GSV process. Return the answer normally.";
  }
  if (origin.kind === "device") {
    return "This run's final response is returned automatically to the initiating GSV device client. Return the answer normally.";
  }
  return null;
}

function automaticAdapterReplyInstructions(
  adapter: string,
  surface: AdapterSurface["kind"],
  scheduled: boolean,
): string {
  const destination = `${titleCase(adapter)} ${surface === "dm" ? "direct message" : surface}`;
  return [
    `This ${scheduled ? "scheduled " : ""}run's final response is delivered automatically to the current ${destination}.`,
    "Return the answer normally for that reply.",
    "`message send` creates an additional outbound message; use it only when an extra or cross-channel message was requested. An intentional extra message to this same destination requires `--also`.",
  ].join(" ");
}

function prefixUserMessageContent(message: UserMessage, prefix: string): UserMessage {
  if (typeof message.content === "string") {
    return {
      ...message,
      content: `${prefix}\n${message.content}`,
    };
  }

  const content = Array.isArray(message.content) ? [...message.content] : [];
  const first = content[0];
  if (first?.type === "text") {
    content[0] = {
      ...first,
      text: `${prefix}\n${first.text}`,
    };
  } else {
    content.unshift({ type: "text", text: prefix });
  }

  return {
    ...message,
    content,
  };
}

function formatInteractionOriginForContext(origin: InteractionOrigin | undefined): string | null {
  if (!origin) return null;

  if (origin.kind === "app") {
    if (origin.packageId === "chat" || origin.routeBase === "/apps/chat") {
      return null;
    }
    return `${origin.packageName} app (${origin.entrypointName})`;
  }

  if (origin.kind === "adapter") {
    const adapter = titleCase(origin.adapter);
    const surface = formatAdapterSurfaceForContext(origin.surface);
    const actor = origin.surface.kind === "dm" ? null : origin.actorLabel || origin.actorId;
    return [
      adapter,
      surface ? ` ${surface}` : "",
      actor ? ` from ${actor}` : "",
    ].join("");
  }

  if (origin.kind === "client") {
    return formatClientOriginForContext(origin.platform, origin.clientId);
  }

  if (origin.kind === "device") {
    return `device ${origin.deviceId}${origin.cwd ? ` cwd ${origin.cwd}` : ""}`;
  }

  if (origin.kind === "process") {
    return `process ${origin.sourcePid}${origin.uid !== undefined ? ` uid ${origin.uid}` : ""}`;
  }

  if (origin.kind === "scheduler") {
    return `schedule ${origin.scheduleId}`;
  }

  return null;
}

function formatClientOriginForContext(platform: string | undefined, clientId: string | undefined): string {
  if (clientId === "gsv-ui" || platform === "browser" || platform === "web") {
    return "GSV Web Desktop";
  }
  const label = platform || "client";
  return clientId ? `${label} ${clientId}` : label;
}

function formatAdapterSurfaceForContext(surface: AdapterSurface): string {
  const label = surface.name || surface.handle || surface.id;
  if (surface.kind === "dm") {
    return "direct message";
  }
  if (surface.kind === "thread") {
    const thread = surface.threadId ? ` thread ${surface.threadId}` : "";
    return `${surface.kind} ${label}${thread}`;
  }
  return `${surface.kind} ${label}`;
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const known = new Map([
    ["whatsapp", "WhatsApp"],
    ["discord", "Discord"],
    ["gsv", "GSV"],
  ]);
  const mapped = known.get(trimmed.toLowerCase());
  if (mapped) return mapped;
  return `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)}`;
}

function parseAdapterSurface(value: unknown): AdapterSurface | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const id = normalizeOptionalString(record.id);
  if (
    !id ||
    (kind !== "dm" && kind !== "group" && kind !== "channel" && kind !== "thread")
  ) {
    return undefined;
  }
  const name = normalizeOptionalString(record.name);
  const handle = normalizeOptionalString(record.handle);
  const threadId = normalizeOptionalString(record.threadId);
  return {
    kind,
    id,
    ...(name ? { name } : {}),
    ...(handle ? { handle } : {}),
    ...(threadId ? { threadId } : {}),
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

function nextAiConfigFallback(
  primary: AiConfigResult,
  current: AiConfigResult,
  fallbacks: NonNullable<AiConfigResult["fallbacks"]>,
  startIndex: number,
): { config: AiConfigResult; nextIndex: number } | null {
  for (let index = startIndex; index < fallbacks.length; index += 1) {
    const config = aiConfigWithFallback(primary, fallbacks[index]);
    if (!isSameAiRuntimeModelStack(current, config)) {
      return { config, nextIndex: index + 1 };
    }
  }
  return null;
}

function aiConfigWithFallback(
  primary: AiConfigResult,
  fallback: NonNullable<AiConfigResult["fallbacks"]>[number],
): AiConfigResult {
  const {
    fallbacks: _fallbacks,
    provider: _provider,
    model: _model,
    apiKey: _apiKey,
    baseUrl: _baseUrl,
    providerStyle: _providerStyle,
    transportTarget: _transportTarget,
    openAiCodex: _openAiCodex,
    reasoning: _reasoning,
    maxTokens: _maxTokens,
    contextWindowTokens: _contextWindowTokens,
    contextWindowSource: _contextWindowSource,
    generationTimeoutMs: _generationTimeoutMs,
    generationStreaming: _generationStreaming,
    ...base
  } = primary;
  return {
    ...base,
    provider: fallback.provider,
    model: fallback.model,
    apiKey: fallback.apiKey,
    ...(fallback.baseUrl ? { baseUrl: fallback.baseUrl } : {}),
    providerStyle: fallback.providerStyle,
    transportTarget: fallback.transportTarget,
    ...(fallback.openAiCodex ? { openAiCodex: fallback.openAiCodex } : {}),
    reasoning: fallback.reasoning,
    maxTokens: fallback.maxTokens,
    contextWindowTokens: fallback.contextWindowTokens,
    contextWindowSource: fallback.contextWindowSource,
    generationTimeoutMs: fallback.generationTimeoutMs,
    generationStreaming: fallback.generationStreaming,
  };
}

function isSameAiRuntimeModelStack(left: AiConfigResult, right: AiConfigResult): boolean {
  return left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase() &&
    left.model.trim().toLowerCase() === right.model.trim().toLowerCase() &&
    left.apiKey === right.apiKey &&
    (left.baseUrl ?? "").trim() === (right.baseUrl ?? "").trim() &&
    (left.providerStyle ?? "auto").trim().toLowerCase() === (right.providerStyle ?? "auto").trim().toLowerCase() &&
    (left.transportTarget ?? "gsv").trim() === (right.transportTarget ?? "gsv").trim() &&
    (left.openAiCodex?.accountId ?? "") === (right.openAiCodex?.accountId ?? "");
}

function formatAiModelStackLabel(config: Pick<AiConfigResult, "provider" | "model">): string {
  return `${config.provider}/${config.model}`;
}

function formatGenerationFailure(
  message: string,
  context?: { provider?: string; model?: string },
): string {
  const normalized = formatProviderErrorMessage(message, context);
  if (!normalized) {
    return "Generation failed.";
  }
  return `Generation failed: ${normalized}`;
}

function approvalRuleKey(rule: ToolApprovalRule): string {
  return JSON.stringify({
    match: rule.match,
    target: rule.target ?? null,
    action: rule.action,
  });
}

function gzipMessageRecords(
  messages: MessageRecord[],
  signal?: AbortSignal,
  mediaRewrites: ReadonlyMap<string, ArchivedMediaRewrite> = new Map(),
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(signal.reason ?? new Error("Compaction cancelled"));
        return;
      }
      const message = messages[index];
      if (!message) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(
        `${index > 0 ? "\n" : ""}${JSON.stringify(serializeArchivedMessage(message, mediaRewrites))}`,
      ));
      index += 1;
    },
  }).pipeThrough(new CompressionStream("gzip"));
}

async function gunzip(input: ArrayBuffer): Promise<string> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
