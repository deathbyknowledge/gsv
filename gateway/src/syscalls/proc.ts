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

export type ProcKillResult =
  | { ok: true; pid: string; archivedTo?: string }
  | { ok: false; error: string };

export type ProcSendArgs = {
  pid?: string;
  message: string;
  media?: ProcMediaInput[];
};

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
};

export type ProcHilResult =
  | {
      ok: true;
      pid: string;
      requestId: string;
      decision: ProcHilDecision;
      resumed: boolean;
      pendingHil?: ProcHilRequest | null;
    }
  | { ok: false; error: string };

export type ProcSendResult =
  | { ok: true; status: "started"; runId: string; queued?: boolean }
  | { ok: false; error: string };

export type ProcHistoryArgs = {
  pid?: string;
  limit?: number;
  offset?: number;
};

export type ProcHistoryMessage = {
  role: "user" | "assistant" | "system" | "toolResult";
  content: unknown;
  timestamp?: number;
};

export type ProcHistoryResult =
  | {
      ok: true;
      pid: string;
      messages: ProcHistoryMessage[];
      messageCount: number;
      truncated?: boolean;
      pendingHil?: ProcHilRequest | null;
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
