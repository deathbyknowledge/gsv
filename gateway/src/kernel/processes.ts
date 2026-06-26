/**
 * ProcessRegistry — kernel-side tracking of alive processes.
 *
 * Maps processId to ProcessIdentity + metadata. Used by recvFrame to
 * build KernelContext for process-originated syscalls, and for listing
 * processes per user.
 *
 * Process ids are opaque, fungible handles (`proc:<uuid>`): an executor is
 * allocated per running process and discarded on kill. Durable state lives in
 * the run-as agent's home (conversation transcripts), not in the executor.
 */

import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { ProcContextFile } from "../syscalls/proc";

export type ProcessState = "idle" | "queued" | "running" | "waiting_tool" | "waiting_hil";

export type ProcessRuntimePatch = {
  state?: ProcessState;
  activeRunId?: string | null;
  activeConversationId?: string | null;
  queuedCount?: number;
  lastActiveAt?: number | null;
};

export type ProcessRecord = {
  processId: string;
  parentPid: string | null;
  uid: number;
  ownerUid: number;
  interactive: boolean;
  gid: number;
  gids: number[];
  username: string;
  home: string;
  cwd: string;
  state: ProcessState;
  activeRunId: string | null;
  activeConversationId: string | null;
  queuedCount: number;
  lastActiveAt: number | null;
  label: string | null;
  createdAt: number;
  contextFiles: ProcContextFile[];
};

export class ProcessRegistry {
  constructor(private readonly sql: SqlStorage) {}

  spawn(
    processId: string,
    identity: ProcessIdentity,
    opts: {
      parentPid?: string;
      ownerUid?: number;
      interactive?: boolean;
      label?: string;
      cwd?: string;
      contextFiles?: ProcContextFile[];
    },
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO processes
        (process_id, parent_pid, uid, owner_uid, interactive, gid, gids, username, home, cwd, context_files_json, state, active_run_id, active_conversation_id, queued_count, last_active_at, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, 0, NULL, ?, ?)`,
      processId,
      opts.parentPid ?? null,
      identity.uid,
      opts.ownerUid ?? identity.uid,
      (opts.interactive ?? true) ? 1 : 0,
      identity.gid,
      JSON.stringify(identity.gids),
      identity.username,
      identity.home,
      opts.cwd ?? identity.cwd,
      JSON.stringify(opts.contextFiles ?? []),
      opts.label ?? null,
      Date.now(),
    );
  }

  /** Owner uid for routing/visibility (the human who owns the process). */
  getOwnerUid(processId: string): number | null {
    const rows = [...this.sql.exec<{ owner_uid: number | null; uid: number }>(
      "SELECT owner_uid, uid FROM processes WHERE process_id = ?",
      processId,
    )];
    if (rows.length === 0) return null;
    return rows[0].owner_uid ?? rows[0].uid;
  }

  getIdentity(processId: string): ProcessIdentity | null {
    const rows = [...this.sql.exec<{
      uid: number;
      gid: number;
      gids: string;
      username: string;
      home: string;
      cwd: string | null;
    }>(
      "SELECT uid, gid, gids, username, home, cwd FROM processes WHERE process_id = ?",
      processId,
    )];

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      uid: row.uid,
      gid: row.gid,
      gids: JSON.parse(row.gids),
      username: row.username,
      home: row.home,
      cwd: row.cwd ?? row.home,
    };
  }

  get(processId: string): ProcessRecord | null {
    const rows = [...this.sql.exec<RowShape>(
      "SELECT * FROM processes WHERE process_id = ?",
      processId,
    )];

    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  getContextFiles(processId: string): ProcContextFile[] {
    const rows = [...this.sql.exec<{ context_files_json: string | null }>(
      "SELECT context_files_json FROM processes WHERE process_id = ?",
      processId,
    )];
    return parseContextFiles(rows[0]?.context_files_json ?? null);
  }

  updateIdentity(processId: string, identity: ProcessIdentity): void {
    const existing = this.get(processId);
    const nextCwd = existing
      ? remapCwd(existing.home, identity.home, existing.cwd)
      : identity.cwd;

    this.sql.exec(
      `UPDATE processes
         SET uid = ?, gid = ?, gids = ?, username = ?, home = ?, cwd = ?
       WHERE process_id = ?`,
      identity.uid,
      identity.gid,
      JSON.stringify(identity.gids),
      identity.username,
      identity.home,
      nextCwd,
      processId,
    );
  }

  setState(processId: string, state: ProcessState): boolean {
    this.sql.exec(
      "UPDATE processes SET state = ?, last_active_at = ? WHERE process_id = ?",
      state,
      Date.now(),
      processId,
    );
    return this.get(processId) !== null;
  }

  updateRuntimeState(processId: string, patch: ProcessRuntimePatch): boolean {
    const existing = this.get(processId);
    if (!existing) {
      return false;
    }

    this.sql.exec(
      `UPDATE processes
          SET state = ?,
              active_run_id = ?,
              active_conversation_id = ?,
              queued_count = ?,
              last_active_at = ?
        WHERE process_id = ?`,
      patch.state ?? existing.state,
      patch.activeRunId !== undefined ? patch.activeRunId : existing.activeRunId,
      patch.activeConversationId !== undefined ? patch.activeConversationId : existing.activeConversationId,
      patch.queuedCount !== undefined ? Math.max(0, Math.floor(patch.queuedCount)) : existing.queuedCount,
      patch.lastActiveAt !== undefined ? patch.lastActiveAt : existing.lastActiveAt,
      processId,
    );
    return true;
  }

  kill(processId: string): boolean {
    const rows = [...this.sql.exec<{ process_id: string }>(
      "SELECT process_id FROM processes WHERE process_id = ?",
      processId,
    )];

    if (rows.length === 0) return false;

    this.sql.exec("DELETE FROM processes WHERE process_id = ?", processId);
    return true;
  }

  /**
   * List children of a given process.
   */
  children(parentPid: string): ProcessRecord[] {
    return [...this.sql.exec<RowShape>(
      "SELECT * FROM processes WHERE parent_pid = ? ORDER BY created_at DESC",
      parentPid,
    )].map(toRecord);
  }

  /** List processes owned by a uid (owner_uid), or all processes when omitted. */
  list(ownerUid?: number): ProcessRecord[] {
    if (ownerUid !== undefined) {
      return [...this.sql.exec<RowShape>(
        "SELECT * FROM processes WHERE owner_uid = ? ORDER BY created_at DESC",
        ownerUid,
      )].map(toRecord);
    }

    return [...this.sql.exec<RowShape>(
      "SELECT * FROM processes ORDER BY created_at DESC",
    )].map(toRecord);
  }

  count(): number {
    const rows = [...this.sql.exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM processes")];
    return rows[0]?.cnt ?? 0;
  }
}

type RowShape = {
  process_id: string;
  parent_pid: string | null;
  uid: number;
  owner_uid: number | null;
  interactive: number | null;
  gid: number;
  gids: string;
  username: string;
  home: string;
  cwd: string | null;
  context_files_json: string | null;
  state: string;
  active_run_id: string | null;
  active_conversation_id: string | null;
  queued_count: number | null;
  last_active_at: number | null;
  label: string | null;
  created_at: number;
};

function toRecord(row: RowShape): ProcessRecord {
  return {
    processId: row.process_id,
    parentPid: row.parent_pid,
    uid: row.uid,
    ownerUid: row.owner_uid ?? row.uid,
    interactive: row.interactive === null ? true : row.interactive !== 0,
    gid: row.gid,
    gids: JSON.parse(row.gids),
    username: row.username,
    home: row.home,
    cwd: row.cwd ?? row.home,
    state: normalizeProcessState(row.state),
    activeRunId: row.active_run_id,
    activeConversationId: row.active_conversation_id,
    queuedCount: Math.max(0, Math.floor(row.queued_count ?? 0)),
    lastActiveAt: row.last_active_at,
    label: row.label,
    createdAt: row.created_at,
    contextFiles: parseContextFiles(row.context_files_json),
  };
}

function normalizeProcessState(value: string): ProcessState {
  switch (value) {
    case "idle":
    case "queued":
    case "running":
    case "waiting_tool":
    case "waiting_hil":
      return value;
    default:
      return "idle";
  }
}

function parseContextFiles(value: string | null): ProcContextFile[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const file = entry as { name?: unknown; text?: unknown };
      if (typeof file.name !== "string" || typeof file.text !== "string") {
        return [];
      }
      return [{ name: file.name, text: file.text }];
    });
  } catch {
    return [];
  }
}

function remapCwd(
  previousHome: string,
  nextHome: string,
  cwd: string,
): string {
  if (cwd === previousHome) return nextHome;
  const prefix = previousHome.endsWith("/") ? previousHome : `${previousHome}/`;
  if (!cwd.startsWith(prefix)) return cwd;
  const suffix = cwd.slice(prefix.length);
  const nextPrefix = nextHome.endsWith("/") ? nextHome : `${nextHome}/`;
  return `${nextPrefix}${suffix}`.replace(/\/+$/, "");
}
