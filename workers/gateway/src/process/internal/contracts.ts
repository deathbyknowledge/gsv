/** Internal Process contracts primitives. */

import type {
  AiConfigResult, JsonObject, ProcArchiveEntry, ProcContextState, ProcMediaInput, ProcToolResultOutcome,
} from "@humansandmachines/gsv/protocol";
import type { AssistantMessage, Context, ThinkingContent, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { AssistantTurnClassification } from "../run-tick-policy";
import type { FrameBody, ResponseFrame } from "../../protocol/frames";
import type { MessageMetadata, QueuedMessage } from "../store";
import type { RunDelivery, RunFinishOptions, RunFinishPayload } from "../run/finish";
import type { RunOutputMedia, RunState } from "../run/state";
import type { SyscallName } from "../../syscalls";
import type { TelemetryEvent } from "@humansandmachines/gsv/telemetry";

export type HistoryCompactionOptions = {
  allowActive?: boolean;
  reason?: string;
  activeRunId?: string;
  signal?: AbortSignal;
  telemetryTrigger?: "manual" | "auto-preflight" | "auto-provider-overflow";
  contextPressure?: number;
};

export type CompactionTelemetryProperties = Extract<
  TelemetryEvent,
  { name: "process.compaction.completed"; }
>["properties"];

export type RunFinishedTelemetryProperties = Extract<
  TelemetryEvent,
  { name: "process.run.finished"; }
>["properties"];

export type RunTickContinuation =
  | {
    kind: "finish";
    options: RunFinishOptions;
    responsibilityAdmissionKey?: string;
  }
  | { kind: "schedule"; }
  | { kind: "dispatch-or-wait"; }
  | {
    kind: "yield-correction";
    usage: AssistantMessage["usage"];
    text: string;
  };

export type RunTickInputs = {
  run: RunState;
  activeConfig: AiConfigResult;
  workTools: Tool[];
  tools: Tool[];
};

export type RunTickContextState = RunTickInputs & {
  context: Context;
  contextState: ProcContextState | null;
  autoCompactionPressure: number | null;
};

export type PreparedRunTickContext = RunTickContextState & {
  contextState: ProcContextState;
};

export type GeneratedRunTick = {
  prepared: PreparedRunTickContext;
  response: AssistantMessage;
  fallbackMetadata?: MessageMetadata["fallback"];
  inferenceSpanId: string | null;
};

export type RunTickGenerationControl = {
  prepared: PreparedRunTickContext;
  primaryConfig: AiConfigResult;
  fallbackConfigs: NonNullable<AiConfigResult["fallbacks"]>;
  fallbackIndex: number;
  fallbackMetadata?: MessageMetadata["fallback"];
};

export type RunTickGenerationAttemptOutcome =
  | { kind: "complete"; result: GeneratedRunTick | RunTickContinuation | null; }
  | { kind: "retry"; advanceAttempt: boolean; }
  | { kind: "fallback"; };

export type PersistedRunTick = GeneratedRunTick & {
  turn: AssistantTurnClassification;
  outputMedia: RunOutputMedia[];
  runControlResult: RunControlResult | null;
  assistantMetadata: MessageMetadata | undefined;
};

export type PersistedAssistantHistory = {
  messageId: number;
  runControlDispatchId: string | null;
};

export type RunControlResult =
  | {
    ok: true;
    action: "message" | "yield";
    finish: boolean;
    text: string;
    delivery: RunDelivery;
    responsibilityAdmissionKey?: string;
  }
  | {
    ok: false;
    action: "message" | "yield";
    text: string;
    delivery: { kind: "none"; };
    failureKind: "command" | "delivery";
    error: string;
  };

export type TerminalResponsibilityCheck =
  | { ok: true; admissionKey: string; }
  | { ok: false; error: string; };

export type TerminalResponsibilitySnapshot = {
  admissionKey: string;
  responsibilityIds: string[];
};

export type CommittedRunControlMessage = {
  conversationId: string;
  id: string;
};

export type StagedResourceWriteArgs = Omit<ProcMediaInput, "key" | "path" | "url" | "size"> & {
  mediaId?: string;
};

export type StagedResourceWriteResult =
  | { ok: true; media: RunOutputMedia; }
  | { ok: false; error: string; };

export type AssistantHistoryContent = {
  text: string;
  thinking: ThinkingContent[];
  toolCalls: ToolCall[];
  media?: ProcMediaInput[];
};

export type RestoredToolResultMetadata = {
  toolName: string;
  isError: boolean;
  outcome?: ProcToolResultOutcome;
};

export type StreamSeqCounter = {
  value: number;
};

export type RunFinishEffects = {
  run: RunState;
  payload: RunFinishPayload;
  startedAt: number | null;
  newlyFinished: boolean;
  cleanupKeys: string[];
};

export type CompletedRunTransition = {
  effects: RunFinishEffects;
  next: QueuedMessage | null;
  wakeRunId?: string;
};

export type CodeModeResponseWaiter = {
  runId: string | null;
  call: SyscallName;
  args: JsonObject;
  resolve: (frame: ResponseFrame) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type CodeModeApprovalWaiter = {
  runId: string;
  dispatchId: string;
  resolve: (approved: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type ProcessArchiveResult = {
  archivedMessages: number;
  archivedTo?: string;
  archives: ProcArchiveEntry[];
};

export type AsyncCleanupTask = {
  label: string;
  run: () => Promise<void>;
};

export type PreparedJsonToolArgs = {
  args: JsonObject;
  missingShellSessionTarget: boolean;
};

export type DynamicRequestFrameData = {
  type: "req";
  id: string;
  call: SyscallName;
  args: JsonObject;
  runId?: string;
  body?: FrameBody;
};
