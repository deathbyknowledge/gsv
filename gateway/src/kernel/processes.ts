/**
 * ProcessRegistry — kernel-side tracking of alive processes.
 *
 * Maps processId to ProcessIdentity + metadata. Used by recvFrame to
 * build KernelContext for process-originated syscalls, and for listing
 * processes per user.
 *
 * Process ids are opaque durable handles (`proc:<id>`). A Process Durable
 * Object owns the execution state and history for that pid until it is killed.
 */

import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

export type ProcessState = "idle" | "queued" | "running" | "waiting_tool" | "waiting_hil";

export type ProcessRuntimePatch = {
  state?: ProcessState;
  activeRunId?: string | null;
  queuedCount?: number;
  lastActiveAt?: number | null;
};

export type ProcessRecord = {
  processId: string;
  parentPid: string | null;
  uid: number;
  ownerUid: number;
  interactive: boolean;
  isPersonalController: boolean;
  gid: number;
  gids: number[];
  username: string;
  home: string;
  cwd: string;
  state: ProcessState;
  activeRunId: string | null;
  queuedCount: number;
  lastActiveAt: number | null;
  label: string | null;
  createdAt: number;
};

export type ProcessSelectorResult =
  | { kind: "found"; record: ProcessRecord }
  | { kind: "ambiguous"; records: ProcessRecord[] }
  | { kind: "missing" };

export function findInteractiveProcess(
  selector: string,
  processes: readonly ProcessRecord[],
): ProcessSelectorResult {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return { kind: "missing" };

  const interactive = processes.filter((record) => record.interactive);
  const exact = interactive.find((record) => record.processId.toLowerCase() === normalized);
  if (exact) return { kind: "found", record: exact };

  const matches = interactive.filter((record) => {
    const pid = record.processId.toLowerCase();
    const shortPid = pid.slice(0, 13);
    const label = record.label?.trim().toLowerCase();
    return pid.startsWith(normalized)
      || shortPid === normalized
      || shortPid.startsWith(normalized)
      || label === normalized;
  });
  if (matches.length === 1) return { kind: "found", record: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", records: matches };
  return { kind: "missing" };
}

export class ProcessRegistry {
  constructor(private readonly sql: SqlStorage) {}

  spawn(
    processId: string,
    identity: ProcessIdentity,
    opts: {
      parentPid?: string;
      ownerUid?: number;
      interactive?: boolean;
      isPersonalController?: boolean;
      label?: string;
      cwd?: string;
    },
  ): void {
    this.sql.exec(
      `INSERT INTO processes
        (process_id, parent_pid, uid, owner_uid, interactive, is_personal_controller, gid, gids, username, home, cwd, state, active_run_id, queued_count, last_active_at, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, 0, NULL, ?, ?)`,
      processId,
      opts.parentPid ?? null,
      identity.uid,
      opts.ownerUid ?? identity.uid,
      (opts.interactive ?? true) ? 1 : 0,
      opts.isPersonalController ? 1 : 0,
      identity.gid,
      JSON.stringify(identity.gids),
      identity.username,
      identity.home,
      opts.cwd ?? identity.cwd,
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
    const rows = [...this.sql.exec<ProcessRow>(
      "SELECT * FROM processes WHERE process_id = ?",
      processId,
    )];

    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  getPersonalController(ownerUid: number): ProcessRecord | null {
    const rows = [...this.sql.exec<ProcessRow>(
      `SELECT * FROM processes
       WHERE owner_uid = ? AND is_personal_controller = 1
       LIMIT 1`,
      ownerUid,
    )];

    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  clearPersonalController(processId: string): boolean {
    const existing = this.get(processId);
    if (!existing?.isPersonalController) {
      return false;
    }
    this.sql.exec(
      "UPDATE processes SET is_personal_controller = 0 WHERE process_id = ?",
      processId,
    );
    return true;
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

  setLabel(processId: string, label: string): boolean {
    const normalized = label.trim();
    if (!normalized || !this.get(processId)) {
      return false;
    }
    this.sql.exec(
      "UPDATE processes SET label = ? WHERE process_id = ?",
      normalized,
      processId,
    );
    return true;
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
              queued_count = ?,
              last_active_at = ?
        WHERE process_id = ?`,
      patch.state ?? existing.state,
      patch.activeRunId !== undefined ? patch.activeRunId : existing.activeRunId,
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
    return [...this.sql.exec<ProcessRow>(
      "SELECT * FROM processes WHERE parent_pid = ? ORDER BY created_at DESC",
      parentPid,
    )].map(toRecord);
  }

  /** List processes owned by a uid (owner_uid), or all processes when omitted. */
  list(ownerUid?: number): ProcessRecord[] {
    if (ownerUid !== undefined) {
      return [...this.sql.exec<ProcessRow>(
        "SELECT * FROM processes WHERE owner_uid = ? ORDER BY created_at DESC",
        ownerUid,
      )].map(toRecord);
    }

      return [...this.sql.exec<ProcessRow>(
      "SELECT * FROM processes ORDER BY created_at DESC",
    )].map(toRecord);
  }

  count(): number {
    const rows = [...this.sql.exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM processes")];
    return rows[0]?.cnt ?? 0;
  }
}

type ProcessRow = {
  process_id: string;
  parent_pid: string | null;
  uid: number;
  owner_uid: number | null;
  interactive: number | null;
  is_personal_controller: number | null;
  gid: number;
  gids: string;
  username: string;
  home: string;
  cwd: string | null;
  state: string;
  active_run_id: string | null;
  queued_count: number | null;
  last_active_at: number | null;
  label: string | null;
  created_at: number;
};

function toRecord(row: ProcessRow): ProcessRecord {
  return {
    processId: row.process_id,
    parentPid: row.parent_pid,
    uid: row.uid,
    ownerUid: row.owner_uid ?? row.uid,
    interactive: row.interactive === null ? true : row.interactive !== 0,
    isPersonalController: row.is_personal_controller !== null
      && row.is_personal_controller !== 0,
    gid: row.gid,
    gids: JSON.parse(row.gids),
    username: row.username,
    home: row.home,
    cwd: row.cwd ?? row.home,
    state: normalizeProcessState(row.state),
    activeRunId: row.active_run_id,
    queuedCount: Math.max(0, Math.floor(row.queued_count ?? 0)),
    lastActiveAt: row.last_active_at,
    label: row.label,
    createdAt: row.created_at,
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
