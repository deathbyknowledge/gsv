import { describe, expect, it } from "vitest";
import { ProcessRegistry } from "./processes";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import {
  handleMockSchemaStatement,
  mockSqlRows,
  type MockSqlRow,
} from "../test-support/mock-sql";

function createMockSql() {
  const table = new Map<string, MockSqlRow>();

  function exec<T = MockSqlRow>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    const schemaResult = handleMockSchemaStatement<T>(q);
    if (schemaResult) return schemaResult;

    if (q.startsWith("UPDATE processes SET owner_uid = uid")) {
      for (const row of table.values()) {
        if (row.owner_uid === null || row.owner_uid === undefined) row.owner_uid = row.uid;
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("UPDATE processes SET cwd = home")) {
      for (const row of table.values()) {
        if (!row.cwd) row.cwd = row.home;
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("UPDATE processes SET context_files_json = '[]'")) {
      for (const row of table.values()) {
        if (!row.context_files_json) row.context_files_json = "[]";
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("UPDATE processes SET queued_count = 0")) {
      for (const row of table.values()) {
        if (typeof row.queued_count !== "number" || row.queued_count < 0) row.queued_count = 0;
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("UPDATE processes SET state = 'idle'")) {
      for (const row of table.values()) {
        if (!row.state || row.state === "paused" || row.state === "killed") row.state = "idle";
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("INSERT OR REPLACE INTO processes")) {
      const [
        process_id,
        parent_pid,
        uid,
        owner_uid,
        interactive,
        gid,
        gids,
        username,
        home,
        cwd,
        context_files_json,
        label,
        created_at,
      ] = bindings as [
        string,
        string | null,
        number,
        number,
        number,
        number,
        string,
        string,
        string,
        string,
        string,
        string | null,
        number,
      ];

      table.set(process_id, {
        process_id,
        parent_pid,
        uid,
        owner_uid,
        interactive,
        gid,
        gids,
        username,
        home,
        cwd,
        context_files_json,
        state: "idle",
        active_run_id: null,
        active_conversation_id: null,
        queued_count: 0,
        last_active_at: null,
        label,
        created_at,
      });
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT uid, gid, gids, username, home, cwd FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return mockSqlRows((row ? [row] : []) as T[]);
    }

    if (q.startsWith("SELECT owner_uid, uid FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return mockSqlRows((row ? [{ owner_uid: row.owner_uid ?? null, uid: row.uid }] : []) as T[]);
    }

    if (q.startsWith("SELECT context_files_json FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return mockSqlRows((row ? [{ context_files_json: row.context_files_json ?? "[]" }] : []) as T[]);
    }

    if (q.startsWith("SELECT * FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return mockSqlRows((row ? [row] : []) as T[]);
    }

    if (q.startsWith("SELECT * FROM processes WHERE owner_uid = ?")) {
      const [ownerUid] = bindings as [number];
      const matches = [...table.values()].filter((row) => (row.owner_uid ?? row.uid) === ownerUid);
      return mockSqlRows(matches as T[]);
    }

    if (q.startsWith("SELECT * FROM processes ORDER BY")) {
      return mockSqlRows([...table.values()] as T[]);
    }

    if (q.startsWith("UPDATE processes\n          SET state = ?")) {
      const [
        state,
        active_run_id,
        active_conversation_id,
        queued_count,
        last_active_at,
        processId,
      ] = bindings as [string, string | null, string | null, number, number | null, string];
      const row = table.get(processId);
      if (row) {
        row.state = state;
        row.active_run_id = active_run_id;
        row.active_conversation_id = active_conversation_id;
        row.queued_count = queued_count;
        row.last_active_at = last_active_at;
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("UPDATE processes SET state = ?")) {
      const [state, lastActiveAt, processId] = bindings as [string, number, string];
      const row = table.get(processId);
      if (row) {
        row.state = state;
        row.last_active_at = lastActiveAt;
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("UPDATE processes")) {
      const [uid, gid, gids, username, home, cwd, processId] =
        bindings as [number, number, string, string, string, string, string];
      const row = table.get(processId);
      if (row) {
        row.uid = uid;
        row.gid = gid;
        row.gids = gids;
        row.username = username;
        row.home = home;
        row.cwd = cwd;
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT process_id FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return mockSqlRows((row ? [{ process_id: processId }] : []) as T[]);
    }

    if (q.startsWith("DELETE FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      table.delete(processId);
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT COUNT(*) as cnt FROM processes")) {
      return mockSqlRows([{ cnt: table.size }] as T[]);
    }

    return mockSqlRows<T>();
  }

  return { exec };
}

describe("ProcessRegistry", () => {
  function makeIdentity(home: string): ProcessIdentity {
    return {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home,
      cwd: home,
    };
  }

  it("stores cwd on spawn", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);

    registry.spawn("task:1", makeIdentity("/home/sam"), {
      profile: "task",
      cwd: "/srv/work/demo",
      label: "demo",
    });

    expect(registry.getIdentity("task:1")).toEqual({
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home: "/home/sam",
      cwd: "/srv/work/demo",
    });
  });

  it("remaps cwd inside home when identity home changes", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);

    registry.spawn("task:2", makeIdentity("/home/sam"), {
      profile: "task",
      cwd: "/home/sam/projects/demo",
    });

    registry.updateIdentity("task:2", {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home: "/srv/sam",
      cwd: "/srv/sam",
    });

    expect(registry.get("task:2")?.cwd).toBe("/srv/sam/projects/demo");
  });

  it("preserves non-home cwd when auth identity changes", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);

    registry.spawn("task:3", makeIdentity("/home/sam"), {
      profile: "task",
      cwd: "/srv/work/demo",
    });

    registry.updateIdentity("task:3", {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100, 200],
      username: "sam",
      home: "/srv/sam",
      cwd: "/srv/sam",
    });

    const record = registry.get("task:3");
    expect(record?.cwd).toBe("/srv/work/demo");
  });

  it("tracks runtime activity fields separately from identity metadata", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);

    registry.spawn("task:runtime", makeIdentity("/home/sam"), {
      profile: "task",
      cwd: "/home/sam",
    });

    expect(registry.get("task:runtime")).toMatchObject({
      state: "idle",
      activeRunId: null,
      activeConversationId: null,
      queuedCount: 0,
      lastActiveAt: null,
    });

    registry.updateRuntimeState("task:runtime", {
      state: "waiting_hil",
      activeRunId: "run-1",
      activeConversationId: "default",
      queuedCount: 2,
      lastActiveAt: 1234,
    });

    expect(registry.get("task:runtime")).toMatchObject({
      state: "waiting_hil",
      activeRunId: "run-1",
      activeConversationId: "default",
      queuedCount: 2,
      lastActiveAt: 1234,
    });
  });

  it("stores and returns process context files on spawn", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);

    registry.spawn("task:4", makeIdentity("/home/sam"), {
      cwd: "/src/repos/sam/pkg-test",
      contextFiles: [{ name: "brief.md", text: "Investigate the package." }],
    });

    expect(registry.get("task:4")?.cwd).toBe("/src/repos/sam/pkg-test");
    expect(registry.getContextFiles("task:4")).toEqual([
      { name: "brief.md", text: "Investigate the package." },
    ]);
  });
});
