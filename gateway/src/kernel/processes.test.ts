import { describe, expect, it } from "vitest";
import { ProcessRegistry } from "./processes";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";

type Row = Record<string, unknown>;

function createMockSql() {
  const table = new Map<string, Row>();

  function rows<T>(items: T[]) {
    return Object.assign(items, {
      toArray: () => items,
    });
  }

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (
      q.startsWith("CREATE TABLE IF NOT EXISTS") ||
      q.startsWith("ALTER TABLE processes ADD COLUMN")
    ) {
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET owner_uid = uid")) {
      for (const row of table.values()) {
        if (row.owner_uid === null || row.owner_uid === undefined) row.owner_uid = row.uid;
      }
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET interactive = 0")) {
      for (const row of table.values()) {
        if (row.profile === "cron") row.interactive = 0;
      }
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET cwd = home")) {
      for (const row of table.values()) {
        if (!row.cwd) row.cwd = row.home;
      }
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET mounts = '[]'")) {
      for (const row of table.values()) {
        if (!row.mounts) row.mounts = "[]";
      }
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET context_files_json = '[]'")) {
      for (const row of table.values()) {
        if (!row.context_files_json) row.context_files_json = "[]";
      }
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET queued_count = 0")) {
      for (const row of table.values()) {
        if (typeof row.queued_count !== "number" || row.queued_count < 0) row.queued_count = 0;
      }
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET state = 'idle'")) {
      for (const row of table.values()) {
        if (!row.state || row.state === "paused" || row.state === "killed") row.state = "idle";
      }
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET profile = '")) {
      const match = q.match(/SET profile = '([^']+)'/);
      const profile = match?.[1];
      if (!profile) {
        return rows([] as T[]);
      }

      if (q.includes("process_id LIKE 'init:%'")) {
        for (const row of table.values()) {
          if (!row.profile && typeof row.process_id === "string" && row.process_id.startsWith("init:")) {
            row.profile = profile;
          }
        }
      } else if (q.includes("process_id LIKE 'task:%'")) {
        for (const row of table.values()) {
          if (!row.profile && typeof row.process_id === "string" && row.process_id.startsWith("task:")) {
            row.profile = profile;
          }
        }
      } else if (q.includes("process_id LIKE 'cron:%'")) {
        for (const row of table.values()) {
          if (!row.profile && typeof row.process_id === "string" && row.process_id.startsWith("cron:")) {
            row.profile = profile;
          }
        }
      } else if (q.includes("process_id LIKE 'mcp:%'")) {
        for (const row of table.values()) {
          if (!row.profile && typeof row.process_id === "string" && row.process_id.startsWith("mcp:")) {
            row.profile = profile;
          }
        }
      } else if (q.includes("process_id LIKE 'app:%'")) {
        for (const row of table.values()) {
          if (!row.profile && typeof row.process_id === "string" && row.process_id.startsWith("app:")) {
            row.profile = profile;
          }
        }
      } else {
        for (const row of table.values()) {
          if (!row.profile) row.profile = profile;
        }
      }
      return rows([] as T[]);
    }

    if (q.startsWith("INSERT OR REPLACE INTO processes")) {
      const [
        process_id,
        parent_pid,
        uid,
        owner_uid,
        profile,
        interactive,
        gid,
        gids,
        username,
        home,
        cwd,
        mounts,
        context_files_json,
        label,
        created_at,
      ] = bindings as [
        string,
        string | null,
        number,
        number,
        string,
        number,
        number,
        string,
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
        profile,
        interactive,
        gid,
        gids,
        username,
        home,
        cwd,
        mounts,
        context_files_json,
        state: "idle",
        active_run_id: null,
        active_conversation_id: null,
        queued_count: 0,
        last_active_at: null,
        label,
        created_at,
      });
      return rows([] as T[]);
    }

    if (q.startsWith("SELECT uid, gid, gids, username, home, cwd FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return rows((row ? [row] : []) as T[]);
    }

    if (q.startsWith("SELECT owner_uid, uid FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return rows((row ? [{ owner_uid: row.owner_uid ?? null, uid: row.uid }] : []) as T[]);
    }

    if (q.startsWith("SELECT mounts FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return rows((row ? [{ mounts: row.mounts ?? "[]" }] : []) as T[]);
    }

    if (q.startsWith("SELECT * FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return rows((row ? [row] : []) as T[]);
    }

    if (q.startsWith("SELECT * FROM processes WHERE owner_uid = ?")) {
      const [ownerUid] = bindings as [number];
      const matches = [...table.values()].filter((row) => (row.owner_uid ?? row.uid) === ownerUid);
      return rows(matches as T[]);
    }

    if (q.startsWith("SELECT * FROM processes ORDER BY")) {
      return rows([...table.values()] as T[]);
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
      return rows([] as T[]);
    }

    if (q.startsWith("UPDATE processes SET state = ?")) {
      const [state, lastActiveAt, processId] = bindings as [string, number, string];
      const row = table.get(processId);
      if (row) {
        row.state = state;
        row.last_active_at = lastActiveAt;
      }
      return rows([] as T[]);
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
      return rows([] as T[]);
    }

    if (q.startsWith("SELECT process_id FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return rows((row ? [{ process_id: processId }] : []) as T[]);
    }

    if (q.startsWith("DELETE FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      table.delete(processId);
      return rows([] as T[]);
    }

    if (q.startsWith("SELECT COUNT(*) as cnt FROM processes")) {
      return rows([{ cnt: table.size }] as T[]);
    }

    return rows([] as T[]);
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
    registry.init();

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
    registry.init();

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
    registry.init();

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
    expect(record?.profile).toBe("task");
    expect(record?.cwd).toBe("/srv/work/demo");
  });

  it("tracks runtime activity fields separately from identity metadata", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);
    registry.init();

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

  it("stores and returns process mounts on spawn", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);
    registry.init();

    registry.spawn("task:4", makeIdentity("/home/sam"), {
      profile: "review",
      cwd: "/src/packages/pkg-test",
      mounts: [
        {
          kind: "ripgit-source",
          mountPath: "/src/packages/pkg-test",
          packageId: "import:root/pkg-test:.",
          repo: "root/pkg-test",
          ref: "main",
          resolvedCommit: "abc123",
          subdir: ".",
        },
      ],
    });

    expect(registry.get("task:4")?.cwd).toBe("/src/packages/pkg-test");
    expect(registry.getMounts("task:4")).toEqual([
      {
        kind: "ripgit-source",
        mountPath: "/src/packages/pkg-test",
        packageId: "import:root/pkg-test:.",
        repo: "root/pkg-test",
        ref: "main",
        resolvedCommit: "abc123",
        subdir: ".",
      },
    ]);
  });
});
