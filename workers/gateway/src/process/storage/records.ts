/** Durable Process record types shared by the SQLite repositories. */

import type {
  JsonObject, JsonValue, ProcMessageMetadata, ProcMessageProviderMetadata, ProcToolResultOutcome, ProcTraceSpan,
  ProcTraceSpanKind, ProcTraceSpanStatus, ResponsibilityRecord,
} from "@humansandmachines/gsv/protocol";
import type { SyscallName } from "../../syscalls";
import type { ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export const DEFAULT_MESSAGE_READ_LIMIT = 200;

export const MAX_TRACE_RUNS = 32;

export const MAX_TRACE_SPANS_PER_RUN = 512;

type ToolCallStatus = "registered" | "pending" | "completed" | "error";

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

export type MessageRow = {
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

export type MessageStats = {
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

export type ContextEpochRow = {
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

export type ProcessTraceSpanRow = {
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

export type ToolResultMetadata = {
  toolName: string;
  isError: boolean;
  outcome?: ProcToolResultOutcome;
};
