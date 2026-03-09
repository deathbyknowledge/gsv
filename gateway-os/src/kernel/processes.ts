/**
 * ProcessRegistry — kernel-side tracking of alive processes.
 *
 * Maps processId to ProcessIdentity + metadata. Used by recvFrame to
 * build KernelContext for process-originated syscalls, and for listing
 * processes per user.
 *
 * Process kind is derived from the processId convention:
 *   "init:{uid}" — the user's persistent root agent process
 *   "task:{uuid}" — an ephemeral task spawned by the user or their init
 *   "cron:{jobId}" — an ephemeral process spawned by a cron trigger
 */

import type { ProcessIdentity } from "../syscalls/system";

export type ProcessState = "running" | "paused" | "killed";

export type ProcessRecord = {
  processId: string;
  parentPid: string | null;
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
  state: ProcessState;
  label: string | null;
  createdAt: number;
};

export class ProcessRegistry {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS processes (
        process_id TEXT PRIMARY KEY,
        parent_pid TEXT,
        uid INTEGER NOT NULL,
        gid INTEGER NOT NULL,
        gids TEXT NOT NULL,
        username TEXT NOT NULL,
        home TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'running',
        label TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  spawn(processId: string, identity: ProcessIdentity, opts?: { parentPid?: string; label?: string }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO processes (process_id, parent_pid, uid, gid, gids, username, home, state, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      processId,
      opts?.parentPid ?? null,
      identity.uid,
      identity.gid,
      JSON.stringify(identity.gids),
      identity.username,
      identity.home,
      opts?.label ?? null,
      Date.now(),
    );
  }

  /**
   * Get the init process for a user. Returns null if not yet spawned.
   */
  getInit(uid: number): ProcessRecord | null {
    const initId = `init:${uid}`;
    return this.get(initId);
  }

  /**
   * Ensure the user's init process exists. Spawns it if missing.
   */
  ensureInit(identity: ProcessIdentity): string {
    const initId = `init:${identity.uid}`;
    const existing = this.get(initId);
    if (existing) return initId;

    this.spawn(initId, identity, { label: `init (${identity.username})` });
    return initId;
  }

  getIdentity(processId: string): ProcessIdentity | null {
    const rows = [...this.sql.exec<{
      uid: number;
      gid: number;
      gids: string;
      username: string;
      home: string;
    }>(
      "SELECT uid, gid, gids, username, home FROM processes WHERE process_id = ?",
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

  setState(processId: string, state: ProcessState): boolean {
    this.sql.exec(
      "UPDATE processes SET state = ? WHERE process_id = ?",
      state,
      processId,
    );
    return this.get(processId) !== null;
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

  list(uid?: number): ProcessRecord[] {
    if (uid !== undefined) {
      return [...this.sql.exec<RowShape>(
        "SELECT * FROM processes WHERE uid = ? ORDER BY created_at DESC",
        uid,
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
  gid: number;
  gids: string;
  username: string;
  home: string;
  state: string;
  label: string | null;
  created_at: number;
};

function toRecord(row: RowShape): ProcessRecord {
  return {
    processId: row.process_id,
    parentPid: row.parent_pid,
    uid: row.uid,
    gid: row.gid,
    gids: JSON.parse(row.gids),
    username: row.username,
    home: row.home,
    state: row.state as ProcessState,
    label: row.label,
    createdAt: row.created_at,
  };
}
