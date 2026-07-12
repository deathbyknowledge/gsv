/**
 * Process management syscall types.
 *
 * These govern OS-level processes (agent loops), not shell commands on devices.
 * Every user has a persistent "init" process (their root AI agent).
 * Sub-processes can be spawned for tasks, cron jobs, etc.
 */

import type { ProcessIdentity } from "./system";
import type { InteractionOrigin } from "./interaction-origin";

export type ProcMediaInput = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  key?: string;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
};

export type ProcContextFile = {
  name: string;
  text: string;
};

export type ProcSpawnAssignment = {
  contextFiles: ProcContextFile[];
  autoStart?: boolean;
};

export type ProcSpawnArgs = {
  /**
   * Account to run the process as: a username, a uid string, or a `pkg#agent`
   * reference. Defaults to the caller's personal agent. The caller must own the
   * account or hold membership in its private group (root may run as anyone).
   */
  runAs?: string;
  /** Whether the process can request human-in-the-loop approval. Background spawns set false. */
  interactive?: boolean;
  /** Force allocation of a new top-level process instead of reusing the default conversation executor. */
  fresh?: boolean;
  label?: string;
  prompt?: string;
  assignment?: ProcSpawnAssignment;
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
  conversationId: string;
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
    }
  | { ok: false; error: string };

export type ProcSendArgs = {
  pid?: string;
  conversationId?: string;
  message: string;
  media?: ProcMediaInput[];
  origin?: InteractionOrigin;
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
  requestId: string;
  runId: string;
  conversationId?: string;
  callId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
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
  | { ok: true; status: "started"; runId: string; queued?: boolean }
  | { ok: false; error: string };

export type ProcIpcMetadata = Record<string, unknown>;

export type ProcIpcSendArgs = {
  pid: string;
  conversationId?: string;
  message: string;
  metadata?: ProcIpcMetadata;
};

export type ProcIpcDeliverArgs = {
  runId: string;
  sourcePid: string;
  source: ProcessIdentity;
  conversationId?: string;
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
      conversationId: string;
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
      conversationId: string;
      runId: string;
      deadlineAt: number;
      queued?: boolean;
    }
  | { ok: false; error: string };

export type ProcHistoryArgs = {
  pid?: string;
  conversationId?: string;
  limit?: number;
  offset?: number;
  beforeMessageId?: number;
  afterMessageId?: number;
  tail?: boolean;
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
  conversationId: string;
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
  conversationUsage?: ProcUsageState;
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
      clear: true;
    }
  | {
      profileId: string;
      profileName?: string;
    }
  | {
      profileName: string;
      profileId?: string;
    }
  | {
      values: Record<string, string>;
      profile?: {
        id?: string;
        name?: string;
      };
    }
  | {
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
      conversationId?: string;
      messages: ProcHistoryMessage[];
      messageCount: number;
      truncated?: boolean;
      hasMoreBefore?: boolean;
      hasMoreAfter?: boolean;
      activeRunId?: string | null;
      activeConversationId?: string | null;
      pendingHil?: ProcHilRequest | null;
      context?: ProcContextState | null;
    }
  | { ok: false; error: string };

export type ProcMediaReadArgs = {
  pid?: string;
  key: string;
};

export type ProcMediaReadResult =
  | {
      ok: true;
      key: string;
      mimeType: string;
      size: number;
    }
  | { ok: false; error: string };

export type ProcMediaWriteArgs = Omit<ProcMediaInput, "key" | "url" | "size"> & {
  pid?: string;
};

export type ProcMediaWriteResult =
  | {
      ok: true;
      media: ProcMediaInput & { key: string; size: number };
    }
  | { ok: false; error: string };

export type ProcMediaDeleteArgs = {
  pid?: string;
  key: string;
};

export type ProcMediaDeleteResult =
  | { ok: true; key: string }
  | { ok: false; error: string };

export type ProcConversationStatus = "open" | "closed";

export type ProcConversation = {
  id: string;
  generation: number;
  status: ProcConversationStatus;
  title: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ProcConversationOpenArgs = {
  pid?: string;
  conversationId?: string;
  title?: string;
};

export type ProcConversationOpenResult =
  | {
      ok: true;
      pid: string;
      conversation: ProcConversation;
      created: boolean;
    }
  | { ok: false; error: string };

export type ProcConversationListArgs = {
  pid?: string;
  includeClosed?: boolean;
};

export type ProcConversationListResult =
  | {
      ok: true;
      pid: string;
      conversations: ProcConversation[];
    }
  | { ok: false; error: string };

export type ProcConversationGetArgs = {
  pid?: string;
  conversationId?: string;
};

export type ProcConversationGetResult =
  | {
      ok: true;
      pid: string;
      conversation: ProcConversation | null;
    }
  | { ok: false; error: string };

export type ProcConversationCloseArgs = {
  pid?: string;
  conversationId: string;
};

export type ProcConversationCloseResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      closed: boolean;
    }
  | { ok: false; error: string };

export type ProcConversationResetArgs = {
  pid?: string;
  conversationId?: string;
  archive?: boolean;
};

export type ProcConversationResetResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      generation: number;
      archivedMessages: number;
      archivedTo?: string;
    }
  | { ok: false; error: string };

export type ProcConversationOverflowPolicy = "auto-compact" | "fail";

export type ProcConversationContextPolicy = {
  conversationId: string;
  overflow: ProcConversationOverflowPolicy;
  compactAtPressure: number;
  keepLast: number;
  updatedAt: number;
};

export type ProcConversationPolicyGetArgs = {
  pid?: string;
  conversationId?: string;
};

export type ProcConversationPolicyGetResult =
  | {
      ok: true;
      pid: string;
      policy: ProcConversationContextPolicy;
    }
  | { ok: false; error: string };

export type ProcConversationPolicySetArgs = {
  pid?: string;
  conversationId?: string;
  overflow?: ProcConversationOverflowPolicy;
  compactAtPressure?: number;
  keepLast?: number;
};

export type ProcConversationPolicySetResult =
  | {
      ok: true;
      pid: string;
      policy: ProcConversationContextPolicy;
    }
  | { ok: false; error: string };

export type ProcConversationSegmentKind = "compaction";

export type ProcConversationSegment = {
  id: string;
  conversationId: string;
  generation: number;
  kind: ProcConversationSegmentKind;
  fromMessageId: number;
  toMessageId: number;
  archivePath: string;
  summaryMessageId: number | null;
  createdAt: number;
};

export type ProcConversationCompactArgs = {
  pid?: string;
  conversationId?: string;
  summary?: string;
  generateSummary?: boolean;
  keepLast?: number;
  throughMessageId?: number;
};

export type ProcConversationCompactResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      segment: ProcConversationSegment;
      archivedMessages: number;
      archivedTo: string;
      summaryMessageId: number;
    }
  | { ok: false; error: string };

export type ProcConversationForkArgs = {
  pid?: string;
  conversationId?: string;
  segmentId?: string;
  throughMessageId?: number;
  targetConversationId?: string;
  title?: string;
  includeLiveSuffix?: boolean;
};

export type ProcConversationForkResult =
  | {
      ok: true;
      pid: string;
      sourceConversationId: string;
      targetConversation: ProcConversation;
      segment?: ProcConversationSegment;
      throughMessageId?: number;
      restoredMessages: number;
      includedLiveSuffix: boolean;
    }
  | { ok: false; error: string };

export type ProcConversationSegmentReadArgs = {
  pid?: string;
  conversationId?: string;
  segmentId: string;
  limit?: number;
  offset?: number;
};

export type ProcConversationSegmentReadResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      segment: ProcConversationSegment;
      messages: ProcHistoryMessage[];
      messageCount: number;
      truncated?: boolean;
    }
  | { ok: false; error: string };

export type ProcConversationSegmentsArgs = {
  pid?: string;
  conversationId?: string;
};

export type ProcConversationSegmentsResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      segments: ProcConversationSegment[];
    }
  | { ok: false; error: string };

export type ProcConversationArchiveKind = "reset" | "process-reset" | "kill";

export type ProcConversationArchive = {
  id: string;
  conversationId: string;
  generation: number;
  kind: ProcConversationArchiveKind;
  messages: number;
  archivePath: string;
  createdAt: number;
};

export type ProcConversationLiveGeneration = {
  conversationId: string;
  generation: number;
  messageCount: number;
  firstMessageId: number | null;
  lastMessageId: number | null;
  updatedAt: number;
};

export type ProcConversationTimelineEntry =
  | {
      type: "archive";
      id: string;
      conversationId: string;
      generation: number;
      archiveKind: ProcConversationArchiveKind;
      messages: number;
      archivePath: string;
      createdAt: number;
    }
  | {
      type: "segment";
      id: string;
      conversationId: string;
      generation: number;
      segmentKind: ProcConversationSegmentKind;
      fromMessageId: number;
      toMessageId: number;
      archivePath: string;
      summaryMessageId: number | null;
      createdAt: number;
    }
  | ({
      type: "live";
    } & ProcConversationLiveGeneration);

export type ProcConversationTimelineArgs = {
  pid?: string;
  conversationId?: string;
};

export type ProcConversationTimelineResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      timeline: ProcConversationTimelineEntry[];
    }
  | { ok: false; error: string };

export type ProcConversationGenerationsArgs = {
  pid?: string;
  conversationId?: string;
};

export type ProcConversationGenerationsResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      generations: number[];
    }
  | { ok: false; error: string };

export type ProcConversationGenerationManifest = {
  conversationId: string;
  generation: number;
  current: boolean;
  status: ProcConversationStatus;
  title: string | null;
  archives: ProcConversationArchive[];
  segments: ProcConversationSegment[];
  live: ProcConversationLiveGeneration | null;
};

export type ProcConversationGenerationManifestArgs = {
  pid?: string;
  conversationId?: string;
  generation: number;
};

export type ProcConversationGenerationManifestResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      manifest: ProcConversationGenerationManifest | null;
    }
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
  /** Whether the process can hold an interactive (human-in-the-loop) conversation. */
  interactive: boolean;
  parentPid: string | null;
  state: string;
  activeRunId: string | null;
  activeConversationId: string | null;
  queuedCount: number;
  lastActiveAt: number | null;
  label: string | null;
  createdAt: number;
  cwd: string;
  /**
   * True when this process is the owner's default-conversation executor (the
   * stable "home" inbox running as their personal agent). Clients surface this
   * conversation as home rather than as a regular spawned thread.
   */
  isDefaultConversation?: boolean;
};

export type ProcListResult = {
  processes: ProcListEntry[];
};

// Kernel-only: sets process identity. Sent by the kernel to Process DOs
// at spawn time and never routed from user/device connections.
export type ProcSetIdentityArgs = {
  pid: string;
  identity: ProcessIdentity;
  interactive?: boolean;
  assignment?: ProcSpawnAssignment;
  /**
   * Kernel conversation id this executor's primary thread belongs to. The
   * executor archives/reads its primary thread under
   * `/home/<agent>/conversations/<conversationId>/...`, so transcripts are
   * addressed by the durable conversation rather than the fungible pid.
   */
  conversationId?: string;
  /**
   * Archive path to hydrate the primary thread from on resume (a fresh executor
   * picking up a conversation that was previously archived). Deterministic: the
   * kernel records this pointer when the prior executor archived on kill.
   */
  hydrateFrom?: string;
};

export type ProcSetIdentityResult = {
  ok: true;
  startedRunId?: string;
};
