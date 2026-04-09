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

import type { ProcessIdentity } from "../syscalls/system";
import type { AiContextProfile } from "../syscalls/ai";

export type ProcessState = "running" | "paused" | "killed";

export type ProcessMount = {
  kind: "ripgit-source";
  mountPath: string;
  packageId: string | null;
  repo: string;
  ref: string;
  resolvedCommit: string | null;
  subdir: string;
};

export type ProcessRecord = {
  processId: string;
  parentPid: string | null;
  uid: number;
  profile: AiContextProfile;
  gid: number;
  gids: number[];
  username: string;
  home: string;
  cwd: string;
  workspaceId: string | null;
  state: ProcessState;
  label: string | null;
  createdAt: number;
  mounts: ProcessMount[];
};

export class ProcessRegistry {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS processes (
        process_id TEXT PRIMARY KEY,
        parent_pid TEXT,
        uid INTEGER NOT NULL,
        profile TEXT NOT NULL,
        gid INTEGER NOT NULL,
        gids TEXT NOT NULL,
        username TEXT NOT NULL,
        home TEXT NOT NULL,
        cwd TEXT NOT NULL,
        workspace_id TEXT,
        mounts TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'running',
        label TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN cwd TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN workspace_id TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN profile TEXT");
    } catch {}

    try {
      this.sql.exec("ALTER TABLE processes ADD COLUMN mounts TEXT");
    } catch {}

    this.sql.exec("UPDATE processes SET cwd = home WHERE cwd IS NULL OR cwd = ''");
    this.sql.exec("UPDATE processes SET mounts = '[]' WHERE mounts IS NULL OR mounts = ''");
    this.sql.exec("UPDATE processes SET profile = 'init' WHERE (profile IS NULL OR profile = '') AND process_id LIKE 'init:%'");
    this.sql.exec("UPDATE processes SET profile = 'task' WHERE (profile IS NULL OR profile = '') AND process_id LIKE 'task:%'");
    this.sql.exec("UPDATE processes SET profile = 'cron' WHERE (profile IS NULL OR profile = '') AND process_id LIKE 'cron:%'");
    this.sql.exec("UPDATE processes SET profile = 'mcp' WHERE (profile IS NULL OR profile = '') AND process_id LIKE 'mcp:%'");
    this.sql.exec("UPDATE processes SET profile = 'app' WHERE (profile IS NULL OR profile = '') AND process_id LIKE 'app:%'");
    this.sql.exec("UPDATE processes SET profile = 'task' WHERE profile IS NULL OR profile = ''");
  }

  spawn(
    processId: string,
    identity: ProcessIdentity,
    opts: {
      parentPid?: string;
      profile: AiContextProfile;
      label?: string;
      cwd?: string;
      workspaceId?: string | null;
      mounts?: ProcessMount[];
    },
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO processes
        (process_id, parent_pid, uid, profile, gid, gids, username, home, cwd, workspace_id, mounts, state, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      processId,
      opts.parentPid ?? null,
      identity.uid,
      opts.profile,
      identity.gid,
      JSON.stringify(identity.gids),
      identity.username,
      identity.home,
      opts.cwd ?? identity.cwd,
      opts.workspaceId ?? identity.workspaceId,
      JSON.stringify(opts.mounts ?? []),
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
  ensureInit(identity: ProcessIdentity): { pid: string; created: boolean } {
    const initId = `init:${identity.uid}`;
    const existing = this.get(initId);
    if (existing) return { pid: initId, created: false };

    this.spawn(initId, identity, { label: `init (${identity.username})`, profile: "init" });
    return { pid: initId, created: true };
  }

  getIdentity(processId: string): ProcessIdentity | null {
    const rows = [...this.sql.exec<{
      uid: number;
      gid: number;
      gids: string;
      username: string;
      home: string;
      cwd: string | null;
      workspace_id: string | null;
    }>(
      "SELECT uid, gid, gids, username, home, cwd, workspace_id FROM processes WHERE process_id = ?",
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
      workspaceId: row.workspace_id ?? null,
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

  updateIdentity(processId: string, identity: ProcessIdentity): void {
    const existing = this.get(processId);
    const nextCwd = existing
      ? remapCwd(existing.home, identity.home, existing.cwd, existing.workspaceId)
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
  profile: AiContextProfile;
  gid: number;
  gids: string;
  username: string;
  home: string;
  cwd: string | null;
  workspace_id: string | null;
  mounts: string | null;
  state: string;
  label: string | null;
  created_at: number;
};

function toRecord(row: RowShape): ProcessRecord {
  return {
    processId: row.process_id,
    parentPid: row.parent_pid,
    uid: row.uid,
    profile: row.profile,
    gid: row.gid,
    gids: JSON.parse(row.gids),
    username: row.username,
    home: row.home,
    cwd: row.cwd ?? row.home,
    workspaceId: row.workspace_id ?? null,
    state: row.state as ProcessState,
    label: row.label,
    createdAt: row.created_at,
    mounts: parseMounts(row.mounts),
  };
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

function remapCwd(
  previousHome: string,
  nextHome: string,
  cwd: string,
  workspaceId: string | null,
): string {
  if (workspaceId) return cwd;
  if (cwd === previousHome) return nextHome;
  const prefix = previousHome.endsWith("/") ? previousHome : `${previousHome}/`;
  if (!cwd.startsWith(prefix)) return cwd;
  const suffix = cwd.slice(prefix.length);
  const nextPrefix = nextHome.endsWith("/") ? nextHome : `${nextHome}/`;
  return `${nextPrefix}${suffix}`.replace(/\/+$/, "");
}
