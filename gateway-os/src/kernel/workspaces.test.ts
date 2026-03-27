import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "./workspaces";

type Row = Record<string, unknown>;

function createMockSql() {
  const table = new Map<string, Row>();

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (
      q.startsWith("CREATE TABLE IF NOT EXISTS") ||
      q.startsWith("CREATE INDEX IF NOT EXISTS")
    ) {
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT INTO workspaces")) {
      const [
        workspace_id,
        owner_uid,
        label,
        kind,
        state,
        created_at,
        updated_at,
        default_branch,
        head_commit,
        meta_json,
      ] = bindings as [
        string,
        number,
        string | null,
        string,
        string,
        number,
        number,
        string,
        string | null,
        string | null,
      ];

      table.set(workspace_id, {
        workspace_id,
        owner_uid,
        label,
        kind,
        state,
        created_at,
        updated_at,
        default_branch,
        head_commit,
        meta_json,
      });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT * FROM workspaces WHERE workspace_id = ?")) {
      const [workspaceId] = bindings as [string];
      const row = table.get(workspaceId);
      return { toArray: () => (row ? [row] : []) as T[] };
    }

    if (q.startsWith("SELECT * FROM workspaces WHERE owner_uid = ?")) {
      const [ownerUid] = bindings as [number];
      const rows = [...table.values()]
        .filter((row) => row.owner_uid === ownerUid)
        .sort((a, b) => (b.updated_at as number) - (a.updated_at as number));
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("SELECT * FROM workspaces ORDER BY updated_at DESC")) {
      const rows = [...table.values()].sort((a, b) => (b.updated_at as number) - (a.updated_at as number));
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("UPDATE workspaces SET updated_at = ? WHERE workspace_id = ?")) {
      const [updatedAt, workspaceId] = bindings as [number, string];
      const row = table.get(workspaceId);
      if (row) {
        row.updated_at = updatedAt;
      }
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("DELETE FROM workspaces WHERE workspace_id = ?")) {
      const [workspaceId] = bindings as [string];
      table.delete(workspaceId);
      return { toArray: () => [] as T[] };
    }

    return { toArray: () => [] as T[] };
  }

  return { exec };
}

describe("WorkspaceStore", () => {
  it("creates thread workspaces with stable metadata", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const sql = createMockSql();
    const store = new WorkspaceStore(sql as unknown as SqlStorage);
    store.init();

    const record = store.create(1000, { label: "landing page" });

    expect(record.workspaceId).toMatch(/^ws_/);
    expect(record.ownerUid).toBe(1000);
    expect(record.label).toBe("landing page");
    expect(record.kind).toBe("thread");
    expect(record.state).toBe("active");
    expect(store.get(record.workspaceId)?.workspaceId).toBe(record.workspaceId);
  });

  it("updates updatedAt on touch and sorts by recent activity", () => {
    const sql = createMockSql();
    const store = new WorkspaceStore(sql as unknown as SqlStorage);
    store.init();

    vi.spyOn(Date, "now").mockReturnValue(10);
    const first = store.create(1000, { label: "first" });

    vi.spyOn(Date, "now").mockReturnValue(20);
    const second = store.create(1000, { label: "second" });

    vi.spyOn(Date, "now").mockReturnValue(30);
    expect(store.touch(first.workspaceId)).toBe(true);

    const listed = store.list(1000);
    expect(listed[0]?.workspaceId).toBe(first.workspaceId);
    expect(listed[1]?.workspaceId).toBe(second.workspaceId);
  });

  it("deletes workspaces", () => {
    const sql = createMockSql();
    const store = new WorkspaceStore(sql as unknown as SqlStorage);
    store.init();

    const record = store.create(1000, { label: "temp" });
    expect(store.delete(record.workspaceId)).toBe(true);
    expect(store.get(record.workspaceId)).toBeNull();
  });
});
