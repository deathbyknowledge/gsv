/**
 * ProcessRegistry — kernel-side tracking of alive processes.
 *
 * Maps processId to ProcessIdentity + metadata. Used by recvFrame to
 * build KernelContext for process-originated syscalls, and for listing
 * processes per user.
 *
 * Process ids still follow the `<type>:<id>` convention, but prompt/runtime
 * profile is now explicit metadata stored alongside the process record.
 */

import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { ProcContextFile } from "../syscalls/proc";
import type { PackageInstallScope } from "./packages";

export type ProcessState = "idle" | "queued" | "running" | "waiting_tool" | "waiting_hil";

export type ProcessRuntimePatch = {
  state?: ProcessState;
  activeRunId?: string | null;
  activeConversationId?: string | null;
  queuedCount?: number;
  lastActiveAt?: number | null;
};

export type ProcessMount = {
  kind: "ripgit-source";
  mountPath: string;
  packageId: string | null;
  scope?: PackageInstallScope;
  repo: string;
  ref: string;
  resolvedCommit: string | null;
  subdir: string;
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
  mounts: ProcessMount[];
  contextFiles: ProcContextFile[];
};

export class ProcessRegistry {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS processes (
        process_id TEXT PRIMARY KEY,
        parent_pid TEXT,
        uid INTEGER NOT NULL,
        owner_uid INTEGER,
        interactive INTEGER NOT NULL DEFAULT 1,
        gid INTEGER NOT NULL,
        gids TEXT NOT NULL,
        username TEXT NOT NULL,
        home TEXT NOT NULL,
        cwd TEXT NOT NULL,
        mounts TEXT NOT NULL DEFAULT '[]',
        context_files_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'idle',
        active_run_id TEXT,
        active_conversation_id TEXT,
        queued_count INTEGER NOT NULL DEFAULT 0,
        last_active_at INTEGER,
        label TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN owner_uid INTEGER");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN interactive INTEGER NOT NULL DEFAULT 1");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN cwd TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN mounts TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN context_files_json TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN active_run_id TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN active_conversation_id TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN last_active_at INTEGER");
    } catch {}

    this.sql.exec("UPDATE processes SET owner_uid = uid WHERE owner_uid IS NULL");
    this.sql.exec("UPDATE processes SET cwd = home WHERE cwd IS NULL OR cwd = ''");
    this.sql.exec("UPDATE processes SET mounts = '[]' WHERE mounts IS NULL OR mounts = ''");
    this.sql.exec("UPDATE processes SET context_files_json = '[]' WHERE context_files_json IS NULL OR context_files_json = ''");
    this.sql.exec("UPDATE processes SET queued_count = 0 WHERE queued_count IS NULL OR queued_count < 0");
    this.sql.exec("UPDATE processes SET state = 'idle' WHERE state IS NULL OR state = '' OR state IN ('paused', 'killed')");
  }

  spawn(
    processId: string,
    identity: ProcessIdentity,
    opts: {
      parentPid?: string;
      ownerUid?: number;
      interactive?: boolean;
      label?: string;
      cwd?: string;
      mounts?: ProcessMount[];
      contextFiles?: ProcContextFile[];
    },
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO processes
        (process_id, parent_pid, uid, owner_uid, interactive, gid, gids, username, home, cwd, mounts, context_files_json, state, active_run_id, active_conversation_id, queued_count, last_active_at, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, 0, NULL, ?, ?)`,
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
      JSON.stringify(opts.mounts ?? []),
      JSON.stringify(opts.contextFiles ?? []),
      opts.label ?? null,
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
   * Returns { pid, created } so the caller knows whether to initialize the DO.
   */
  ensureInit(
    ownerUid: number,
    identity: ProcessIdentity,
  ): { pid: string; created: boolean } {
    const initId = `init:${ownerUid}`;
    const existing = this.get(initId);
    if (existing) return { pid: initId, created: false };

    this.spawn(initId, identity, {
      label: `init (${identity.username})`,
      ownerUid,
    });
    return { pid: initId, created: true };
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

  getMounts(processId: string): ProcessMount[] {
    const rows = [...this.sql.exec<{ mounts: string | null }>(
      "SELECT mounts FROM processes WHERE process_id = ?",
      processId,
    )];
    return parseMounts(rows[0]?.mounts ?? null);
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
  mounts: string | null;
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
    mounts: parseMounts(row.mounts),
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

function parseMounts(value: string | null): ProcessMount[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
