/**
 * Process management syscall types.
 *
 * These govern OS-level processes (agent loops), not shell commands on devices.
 * Every user has a persistent "init" process (their root AI agent).
 * Sub-processes can be spawned for tasks, cron jobs, etc.
 */

import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { AiContextProfile } from "./ai";
import type { ProcMediaInput } from "@gsv/protocol/syscalls/proc";

export type ProcWorkspaceKind = "thread" | "app" | "shared";

export type ProcWorkspaceSpec =
  | { mode: "none" }
  | { mode: "new"; label?: string; kind?: ProcWorkspaceKind }
  | { mode: "inherit" }
  | { mode: "attach"; workspaceId: string };

export type ProcSpawnMountSpec =
  | { kind: "package-source"; packageId: string; mountPath?: string }
  | { kind: "package-repo"; packageId: string; mountPath?: string };

export type ProcContextFile = {
  name: string;
  text: string;
};

export type ProcSpawnAssignment = {
  contextFiles: ProcContextFile[];
  autoStart?: boolean;
};

export type ProcSpawnArgs = {
  profile: AiContextProfile;
  label?: string;
  prompt?: string;
  assignment?: ProcSpawnAssignment;
  parentPid?: string;
  workspace?: ProcWorkspaceSpec;
  mounts?: ProcSpawnMountSpec[];
  // NOTE: consider allowing explicit identity override (root only or subset of current identity)
};

export type ProcSpawnResult =
  | { ok: true; pid: string; label?: string; profile: AiContextProfile; workspaceId: string | null; cwd: string }
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
};

export type ProcMindDeliverArgs = {
  pid?: string;
  conversationId?: string;
  message: string;
};

export type ProcMindDeliverResult =
  | {
      ok: true;
      status: "started";
      pid: string;
      conversationId: string;
      runId: string;
      queued?: boolean;
    }
  | { ok: false; error: string };

export type ProcAbortArgs = {
  pid?: string;
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
  sourcePid: string;
  source: ProcessIdentity;
  conversationId?: string;
  message: string;
  metadata?: ProcIpcMetadata;
  sentAt: number;
  call?: {
    callId: string;
    replyToPid: string;
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
  role: "user" | "assistant" | "system" | "mind" | "toolResult";
  content: unknown;
  timestamp?: number;
};

export type ProcContextPressureLevel =
  | "unknown"
  | "ok"
  | "warn"
  | "critical"
  | "full";

export type ProcContextUsageSource = "estimate" | "provider";

export type ProcContextState = {
  conversationId: string;
  runId?: string;
  messageCount?: number;
  lastMessageId?: number | null;
  provider: string;
  model: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  inputTokens: number;
  outputTokens?: number;
  totalTokens?: number;
  availableInputTokens: number | null;
  pressure: number | null;
  level: ProcContextPressureLevel;
  source: ProcContextUsageSource;
  updatedAt: number;
};

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
      pendingHil?: ProcHilRequest | null;
      context?: ProcContextState | null;
    }
  | { ok: false; error: string };

export type ProcMediaReadArgs = {
  pid?: string;
  key: string;
  mimeType?: string;
};

export type ProcMediaReadResult =
  | {
      ok: true;
      key: string;
      mimeType: string;
      size: number;
      dataUrl: string;
    }
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

export type ProcConversationOverflowPolicy = "manual" | "auto-compact" | "fail";

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
  profile: AiContextProfile;
  parentPid: string | null;
  state: string;
  label: string | null;
  createdAt: number;
  workspaceId: string | null;
  cwd: string;
};

export type ProcListResult = {
  processes: ProcListEntry[];
};

export type ProcProfileListArgs = Record<string, never>;

export type ProcProfileListEntry = {
  id: AiContextProfile;
  alias?: string;
  kind: "system" | "package";
  displayName: string;
  description?: string;
  icon?: string;
  interactive: boolean;
  startable: boolean;
  background: boolean;
  spawnMode: "singleton" | "new";
  packageId?: string;
  packageName?: string;
};

export type ProcProfileListResult = {
  profiles: ProcProfileListEntry[];
};

// Kernel-only: sets process identity. Sent by the kernel to Process DOs
// at spawn time and never routed from user/device connections.
export type ProcSetIdentityArgs = {
  pid: string;
  identity: ProcessIdentity;
  profile: AiContextProfile;
  assignment?: ProcSpawnAssignment;
};

export type ProcSetIdentityResult = {
  ok: true;
  startedRunId?: string;
};
