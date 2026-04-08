/**
 * Process management syscall types.
 *
 * These govern OS-level processes (agent loops), not shell commands on devices.
 * Every user has a persistent "init" process (their root AI agent).
 * Sub-processes can be spawned for tasks, cron jobs, etc.
 */

import type { ProcessIdentity } from "./system";
import type { AiContextProfile } from "./ai";

export type ProcWorkspaceKind = "thread" | "app" | "shared";

export type ProcWorkspaceSpec =
  | { mode: "none" }
  | { mode: "new"; label?: string; kind?: ProcWorkspaceKind }
  | { mode: "inherit" }
  | { mode: "attach"; workspaceId: string };

export type ProcSpawnArgs = {
  profile: AiContextProfile;
  label?: string;
  prompt?: string;
  parentPid?: string;
  workspace?: ProcWorkspaceSpec;
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
};

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

// Kernel-only: sets process identity. Sent by the kernel to Process DOs
// at spawn time and never routed from user/device connections.
export type ProcSetIdentityArgs = {
  pid: string;
  identity: ProcessIdentity;
  profile: AiContextProfile;
};

export type ProcSetIdentityResult = { ok: true };
