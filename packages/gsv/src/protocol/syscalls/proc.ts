/**
 * Process management syscall types.
 *
 * These govern OS-level processes (agent loops), not shell commands on devices.
 * Every user has a persistent "init" process (their root AI agent).
 * Sub-processes can be spawned for tasks, cron jobs, etc.
 */

import type { ProcessIdentity } from "./system";
import type { InteractionOrigin } from "./interaction-origin";
import type { JsonObject } from "../json";
import type { ResourceBlock } from "../resource";

export type ProcMediaInput = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  key?: string;
  /** Set for immutable media owned by a canonical conversation message. */
  conversationId?: string;
  /** Server-derived read-only filesystem path for a process-scoped media key. */
  path?: string;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
};

/** Legacy stored media descriptors remain readable while new messages use resources. */
export type MessageAttachment = ResourceBlock | ProcMediaInput;

export type ProcSpawnArgs = {
  /**
   * Account to run the process as a username or uid string. Defaults to the
   * caller's personal agent for a top-level process and the parent account for
   * a child. The caller must own the account or hold membership in its
   * private group (root may run as anyone).
   */
  runAs?: string;
  /** Whether the process owns a direct human conversation. */
  interactive?: boolean;
  label?: string;
  prompt?: string;
  parentPid?: string;
  cwd?: string;
  // NOTE: consider allowing explicit identity override (root only or subset of current identity)
};

export type ProcSpawnResult =
  | { ok: true; pid: string; label?: string; cwd: string }
  | { ok: false; error: string };

export type ProcKillArgs = {
  pid: string;
  archive?: boolean;
};

export type ProcArchiveEntry = {
  generation: number;
  messages: number;
  path: string;
};

export type ProcKillResult =
  | {
      ok: true;
      pid: string;
      archivedMessages: number;
      archivedTo?: string;
      archives: ProcArchiveEntry[];
      contextEpochArchives?: string[];
    }
  | { ok: false; error: string };

export type ProcSendArgs = {
  pid?: string;
  message: string;
  media?: ResourceBlock[];
  origin?: InteractionOrigin;
  interaction?: {
    conversationId: string;
    messageId: string;
  };
};

export type ProcAbortArgs = {
  pid?: string;
  runId?: string;
};

export type ProcAbortResult =
  | {
      ok: true;
      pid: string;
      aborted: boolean;
      runId?: string;
      interruptedToolCalls?: number;
      continuedQueuedRunId?: string;
    }
  | { ok: false; error: string };

export type ProcHilDecision = "approve" | "deny";

export type ProcHilRequest = {
  pid: string;
  requestId: string;
  runId: string;
  conversationId?: string;
  callId: string;
  toolName: string;
  syscall: string;
  /** Authoritative normalized execution target resolved by the Process approval policy. */
  target: string;
  args: JsonObject;
  createdAt: number;
};

export type ProcHilArgs = {
  pid?: string;
  requestId: string;
  decision: ProcHilDecision;
  remember?: boolean;
};

export type ProcHilResult =
  | {
      ok: true;
      pid: string;
      requestId: string;
      decision: ProcHilDecision;
      resumed: boolean;
      remembered?: boolean;
      pendingHil?: ProcHilRequest | null;
    }
  | { ok: false; error: string };

export type ProcSendResult =
  | {
      ok: true;
      status: "started";
      runId: string;
      queued?: boolean;
      /** Existing admission reconciled for the caller-provided run id. */
      replayed?: "active" | "queued" | "recorded";
    }
  | { ok: false; error: string };

export type ProcIpcMetadata = JsonObject;

export type ProcIpcSendArgs = {
  pid: string;
  message: string;
  metadata?: ProcIpcMetadata;
};

export type ProcIpcDeliverArgs = {
  runId: string;
  sourcePid: string;
  source: ProcessIdentity;
  message: string;
  metadata?: ProcIpcMetadata;
  origin?: InteractionOrigin;
  sentAt: number;
  call?: {
    callId: string;
    deadlineAt: number;
  };
};

export type ProcIpcSendResult =
  | {
      ok: true;
      status: "started";
      pid: string;
      sourcePid: string;
      runId: string;
      queued?: boolean;
    }
  | { ok: false; error: string };

export type ProcIpcDeliverResult = ProcIpcSendResult;

export type ProcIpcCallArgs = ProcIpcSendArgs & {
  timeoutMs?: number;
};

export type ProcIpcCallResult =
  | {
      ok: true;
      status: "started";
      callId: string;
      pid: string;
      sourcePid: string;
      runId: string;
      deadlineAt: number;
      queued?: boolean;
    }
  | { ok: false; error: string };

export type ProcHistoryArgs = {
  pid?: string;
  includeMessages?: boolean;
  limit?: number;
  offset?: number;
  beforeMessageId?: number;
  afterMessageId?: number;
  tail?: boolean;
};

export type ProcToolResultOutcome = "completed" | "failed" | "cancelled" | "denied";

export type ProcRunToolStartedSignal = {
  pid: string;
  runId: string;
  executionId: string;
  callId: string;
  name: string;
  syscall: string;
  args: unknown;
};

export type ProcRunToolFinishedSignal = {
  pid: string;
  runId: string;
  executionId: string;
  callId: string;
  outcome: ProcToolResultOutcome;
  timestamp: number;
};

export type ProcHistoryToolResultContent = {
  toolName: string;
  isError: boolean;
  outcome: ProcToolResultOutcome;
  toolCallId: string | null;
  output: unknown;
  media?: ProcMediaInput[];
  resources?: ResourceBlock[];
};

export type ProcHistoryMessage = {
  id?: number;
  runId?: string;
  role: "user" | "assistant" | "system" | "toolResult";
  content: unknown;
  timestamp?: number;
  origin?: InteractionOrigin;
  metadata?: ProcMessageMetadata;
};

export type ProcContextPressureLevel =
  | "unknown"
  | "ok"
  | "warn"
  | "critical"
  | "full";

export type ProcContextUsageSource = "estimate" | "provider";

export type ProcUsageCostSource =
  | "provider"
  | "model-pricing"
  | "mixed";

export type ProcUsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  currency: "USD";
  source: ProcUsageCostSource;
};

export type ProcUsageState = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: ProcUsageCost | null;
  generations?: number;
  costIncomplete?: boolean;
  updatedAt?: number;
};

export type ProcMessageProviderMetadata = {
  api?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  stopReason?: string;
};

export type ProcMessageModelMetadata = {
  provider?: string;
  model?: string;
};

export type ProcMessageFallbackMetadata = {
  used: true;
  from?: ProcMessageModelMetadata;
  to?: ProcMessageModelMetadata;
  reason?: string;
};

export type ProcMessageMetadata = {
  provider?: ProcMessageProviderMetadata;
  fallback?: ProcMessageFallbackMetadata;
  usage?: ProcUsageState;
};

export type ProcContextState = {
  runId?: string;
  messageCount?: number;
  lastMessageId?: number | null;
  provider: string;
  model: string;
  reasoning?: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  inputTokens: number;
  outputTokens?: number;
  totalTokens?: number;
  usage?: ProcUsageState;
  historyUsage?: ProcUsageState;
  availableInputTokens: number | null;
  pressure: number | null;
  level: ProcContextPressureLevel;
  source: ProcContextUsageSource;
  updatedAt: number;
};

export type ProcAiConfigProfileRef = {
  id?: string;
  name?: string;
  appliedAt: number;
};

export type ProcAiConfigSnapshot = {
  version: 1;
  values: Record<string, string>;
  profile?: ProcAiConfigProfileRef;
  updatedAt: number;
};

export type ProcAiConfigGetArgs = {
  pid?: string;
  redacted?: boolean;
};

export type ProcAiConfigGetResult =
  | {
      ok: true;
      pid: string;
      config: ProcAiConfigSnapshot | null;
    }
  | { ok: false; error: string };

export type ProcAiConfigSetArgs =
  | {
      pid?: string;
      clear: true;
    }
  | {
      pid?: string;
      profileId: string;
      profileName?: string;
    }
  | {
      pid?: string;
      profileName: string;
      profileId?: string;
    }
  | {
      pid?: string;
      values: Record<string, string>;
      profile?: {
        id?: string;
        name?: string;
      };
    }
  | {
      pid?: string;
      key: string;
      value: string;
    };

export type ProcAiConfigSetResult =
  | {
      ok: true;
      pid: string;
      config: ProcAiConfigSnapshot | null;
    }
  | { ok: false; error: string };

export type ProcHistoryResult =
  | {
      ok: true;
      pid: string;
      messages: ProcHistoryMessage[];
      messageCount: number;
      truncated?: boolean;
      hasMoreBefore?: boolean;
      hasMoreAfter?: boolean;
      activeRunId?: string | null;
      pendingHil?: ProcHilRequest | null;
      context?: ProcContextState | null;
    }
  | { ok: false; error: string };

export type ProcHistoryOverflowPolicy = "auto-compact" | "fail";

export type ProcHistoryContextPolicy = {
  overflow: ProcHistoryOverflowPolicy;
  compactAtPressure: number;
  keepLast: number;
  updatedAt: number;
};

export type ProcHistoryPolicyGetArgs = {
  pid?: string;
};

export type ProcHistoryPolicyGetResult =
  | {
      ok: true;
      pid: string;
      policy: ProcHistoryContextPolicy;
    }
  | { ok: false; error: string };

export type ProcHistoryPolicySetArgs = {
  pid?: string;
  overflow?: ProcHistoryOverflowPolicy;
  compactAtPressure?: number;
  keepLast?: number;
};

export type ProcHistoryPolicySetResult =
  | {
      ok: true;
      pid: string;
      policy: ProcHistoryContextPolicy;
    }
  | { ok: false; error: string };

export type ProcHistorySegmentKind = "compaction";

export type ProcHistorySegment = {
  id: string;
  generation: number;
  kind: ProcHistorySegmentKind;
  fromMessageId: number;
  toMessageId: number;
  archivePath: string;
  summaryMessageId: number | null;
  createdAt: number;
};

export type ProcHistoryCompactArgs = {
  pid?: string;
  summary?: string;
  generateSummary?: boolean;
  keepLast?: number;
  throughMessageId?: number;
};

export type ProcHistoryCompactResult =
  | {
      ok: true;
      pid: string;
      segment: ProcHistorySegment;
      archivedMessages: number;
      archivedTo: string;
      summaryMessageId: number;
    }
  | { ok: false; error: string };

export type ProcForkArgs = {
  pid?: string;
  segmentId?: string;
  throughMessageId?: number;
  throughRunId?: string;
  label?: string;
  includeLiveSuffix?: boolean;
};

export type ProcForkResult =
  | {
      ok: true;
      pid: string;
      label: string;
      sourcePid: string;
      segment?: ProcHistorySegment;
      throughMessageId?: number;
      restoredMessages: number;
      includedLiveSuffix: boolean;
    }
  | { ok: false; error: string };

export type ProcHistorySegmentReadArgs = {
  pid?: string;
  segmentId: string;
  limit?: number;
  offset?: number;
};

export type ProcHistorySegmentReadResult =
  | {
      ok: true;
      pid: string;
      segment: ProcHistorySegment;
      messages: ProcHistoryMessage[];
      messageCount: number;
      truncated?: boolean;
    }
  | { ok: false; error: string };

export type ProcHistorySegmentsArgs = {
  pid?: string;
};

export type ProcContextEpoch = {
  id: string;
  generation: number;
  state: "live" | "closed";
  r12yRevision: number;
  r12yCount: number;
  observedR12yRevision: number;
  createdAt: number;
  closedAt?: number;
  closeReason?: string;
  archivePath?: string;
};

export type ProcHistorySegmentsResult =
  | {
      ok: true;
      pid: string;
      segments: ProcHistorySegment[];
      epochs: ProcContextEpoch[];
    }
  | { ok: false; error: string };

// Kernel-only: materializes a committed history selection for proc.fork.
export type ProcHistoryExportArgs = {
  segmentId?: string;
  throughMessageId?: number;
  throughRunId?: string;
  includeLiveSuffix?: boolean;
};

export type ProcHistoryExportResult =
  | {
      ok: true;
      sourcePid: string;
      archivePaths: string[];
      temporaryArchivePaths: string[];
      segment?: ProcHistorySegment;
      throughMessageId?: number;
      includedLiveSuffix: boolean;
    }
  | { ok: false; error: string };

// Kernel-only: initializes an empty process from exported history archives.
export type ProcHistoryImportArgs = {
  archivePaths: string[];
};

export type ProcHistoryImportResult =
  | { ok: true; pid: string; restoredMessages: number }
  | { ok: false; error: string };

export type ProcResetArgs = {
  pid?: string;
};

export type ProcResetResult =
  | {
      ok: true;
      pid: string;
      archivedMessages: number;
      archivedTo?: string;
      archives: ProcArchiveEntry[];
      contextEpochArchives?: string[];
    }
  | { ok: false; error: string };

export type ProcListArgs = {
  uid?: number;
};

export type ProcListEntry = {
  pid: string;
  uid: number;
  /** Username of the account the process runs as (its run-as identity). */
  username: string;
  /** Whether the process owns a direct human conversation. */
  interactive: boolean;
  personal: boolean;
  parentPid: string | null;
  state: string;
  activeRunId: string | null;
  queuedCount: number;
  lastActiveAt: number | null;
  label: string | null;
  createdAt: number;
  cwd: string;
};

export type ProcListResult = {
  processes: ProcListEntry[];
};

export type ProcObserveArgs = { pid: string };
export type ProcObserveResult = { ok: true; pid: string; observing: boolean };

export type ProcUnobserveArgs = { pid: string };
export type ProcUnobserveResult = { ok: true; pid: string; observing: boolean };

// Kernel-only: sets process identity. Sent by the kernel to Process DOs
// at spawn time and never routed from user/device connections.
export type ProcSetIdentityArgs = {
  identity: ProcessIdentity;
  interactive?: boolean;
  /** Initial process label. */
  title?: string;
  /** Generate a label from the first admitted message. */
  autoTitle?: boolean;
};

export type ProcSetIdentityResult = { ok: true };
