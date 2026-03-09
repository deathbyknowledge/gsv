/**
 * Process management syscall types.
 *
 * These govern OS-level processes (agent loops), not shell commands on devices.
 * Every user has a persistent "init" process (their root AI agent).
 * Sub-processes can be spawned for tasks, cron jobs, etc.
 */

export type ProcSpawnArgs = {
  label?: string;
  prompt?: string;
  parentPid?: string;
};

export type ProcSpawnResult =
  | { ok: true; pid: string; label?: string }
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
  role: "user" | "assistant" | "system";
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
  parentPid: string | null;
  state: string;
  label: string | null;
  createdAt: number;
};

export type ProcListResult = {
  processes: ProcListEntry[];
};
