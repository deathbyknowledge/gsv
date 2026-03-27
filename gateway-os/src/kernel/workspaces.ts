import type { ProcWorkspaceKind } from "../syscalls/proc";

export type WorkspaceState = "active" | "archived";

export type WorkspaceRecord = {
  workspaceId: string;
  ownerUid: number;
  label: string | null;
  kind: ProcWorkspaceKind;
  state: WorkspaceState;
  createdAt: number;
  updatedAt: number;
  defaultBranch: string;
  headCommit: string | null;
  metaJson: string | null;
};

export class WorkspaceStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        label TEXT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        head_commit TEXT,
        meta_json TEXT
      )
    `);

    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_workspaces_owner_updated ON workspaces (owner_uid, updated_at DESC)",
    );
  }

  create(
    ownerUid: number,
    opts?: { label?: string; kind?: ProcWorkspaceKind; metaJson?: string | null },
  ): WorkspaceRecord {
    const workspaceId = `ws_${crypto.randomUUID()}`;
    const now = Date.now();
    const record: WorkspaceRecord = {
      workspaceId,
      ownerUid,
      label: opts?.label ?? null,
      kind: opts?.kind ?? "thread",
      state: "active",
      createdAt: now,
      updatedAt: now,
      defaultBranch: "main",
      headCommit: null,
      metaJson: opts?.metaJson ?? null,
    };

    this.sql.exec(
      `INSERT INTO workspaces
        (workspace_id, owner_uid, label, kind, state, created_at, updated_at, default_branch, head_commit, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.workspaceId,
      record.ownerUid,
      record.label,
      record.kind,
      record.state,
      record.createdAt,
      record.updatedAt,
      record.defaultBranch,
      record.headCommit,
      record.metaJson,
    );

    return record;
  }

  get(workspaceId: string): WorkspaceRecord | null {
    const rows = this.sql.exec<RowShape>(
      "SELECT * FROM workspaces WHERE workspace_id = ?",
      workspaceId,
    ).toArray();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  list(ownerUid?: number): WorkspaceRecord[] {
    const rows = typeof ownerUid === "number"
      ? this.sql.exec<RowShape>(
          "SELECT * FROM workspaces WHERE owner_uid = ? ORDER BY updated_at DESC",
          ownerUid,
        ).toArray()
      : this.sql.exec<RowShape>(
          "SELECT * FROM workspaces ORDER BY updated_at DESC",
        ).toArray();

    return rows.map(toRecord);
  }

  touch(workspaceId: string): boolean {
    const existing = this.get(workspaceId);
    if (!existing) return false;

    this.sql.exec(
      "UPDATE workspaces SET updated_at = ? WHERE workspace_id = ?",
      Date.now(),
      workspaceId,
    );
    return true;
  }

  delete(workspaceId: string): boolean {
    const existing = this.get(workspaceId);
    if (!existing) return false;

    this.sql.exec(
      "DELETE FROM workspaces WHERE workspace_id = ?",
      workspaceId,
    );
    return true;
  }
}

type RowShape = {
  workspace_id: string;
  owner_uid: number;
  label: string | null;
  kind: ProcWorkspaceKind;
  state: WorkspaceState;
  created_at: number;
  updated_at: number;
  default_branch: string;
  head_commit: string | null;
  meta_json: string | null;
};

function toRecord(row: RowShape): WorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    ownerUid: row.owner_uid,
    label: row.label,
    kind: row.kind,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    defaultBranch: row.default_branch,
    headCommit: row.head_commit,
    metaJson: row.meta_json,
  };
}
