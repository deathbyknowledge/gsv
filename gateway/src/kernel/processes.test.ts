import { describe, expect, it } from "vitest";
import { ProcessRegistry } from "./processes";
import type { ProcessIdentity } from "../syscalls/system";

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
        profile,
        gid,
        gids,
        username,
        home,
        cwd,
        workspace_id,
        mounts,
        label,
        created_at,
      ] = bindings as [
        string,
        string | null,
        number,
        string,
        number,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        number,
      ];

      table.set(process_id, {
        process_id,
        parent_pid,
        uid,
        profile,
        gid,
        gids,
        username,
        home,
        cwd,
        workspace_id,
        mounts,
        state: "running",
        label,
        created_at,
      });
      return rows([] as T[]);
    }

    if (q.startsWith("SELECT uid, gid, gids, username, home, cwd, workspace_id FROM processes WHERE process_id = ?")) {
      const [processId] = bindings as [string];
      const row = table.get(processId);
      return rows((row ? [row] : []) as T[]);
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

    if (q.startsWith("SELECT * FROM processes WHERE uid = ?")) {
      const [uid] = bindings as [number];
      const matches = [...table.values()].filter((row) => row.uid === uid);
      return rows(matches as T[]);
    }

    if (q.startsWith("SELECT * FROM processes ORDER BY")) {
      return rows([...table.values()] as T[]);
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
      workspaceId: null,
    };
  }

  it("stores cwd and workspace metadata on spawn", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);
    registry.init();

    registry.spawn("task:1", makeIdentity("/home/sam"), {
      profile: "task",
      cwd: "/workspaces/ws_demo",
      workspaceId: "ws_demo",
      label: "demo",
    });

    expect(registry.getIdentity("task:1")).toEqual({
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home: "/home/sam",
      cwd: "/workspaces/ws_demo",
      workspaceId: "ws_demo",
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
      workspaceId: null,
    });

    expect(registry.get("task:2")?.cwd).toBe("/srv/sam/projects/demo");
  });

  it("preserves workspace cwd when auth identity changes", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);
    registry.init();

    registry.spawn("task:3", makeIdentity("/home/sam"), {
      profile: "task",
      cwd: "/workspaces/ws_shared",
      workspaceId: "ws_shared",
    });

    registry.updateIdentity("task:3", {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100, 200],
      username: "sam",
      home: "/srv/sam",
      cwd: "/srv/sam",
      workspaceId: null,
    });

    const record = registry.get("task:3");
    expect(record?.profile).toBe("task");
    expect(record?.workspaceId).toBe("ws_shared");
    expect(record?.cwd).toBe("/workspaces/ws_shared");
  });

  it("stores and returns process mounts on spawn", () => {
    const sql = createMockSql();
    const registry = new ProcessRegistry(sql as unknown as SqlStorage);
    registry.init();

    registry.spawn("task:4", makeIdentity("/home/sam"), {
      profile: "review",
      cwd: "/src/package",
      mounts: [
        {
          kind: "ripgit-source",
          mountPath: "/src/package",
          packageId: "import:root/pkg-test:.",
          repo: "root/pkg-test",
          ref: "main",
          resolvedCommit: "abc123",
          subdir: ".",
        },
        {
          kind: "ripgit-source",
          mountPath: "/src/repo",
          packageId: "import:root/pkg-test:.",
          repo: "root/pkg-test",
          ref: "main",
          resolvedCommit: "abc123",
          subdir: ".",
        },
      ],
    });

    expect(registry.get("task:4")?.cwd).toBe("/src/package");
    expect(registry.getMounts("task:4")).toEqual([
      {
        kind: "ripgit-source",
        mountPath: "/src/package",
        packageId: "import:root/pkg-test:.",
        repo: "root/pkg-test",
        ref: "main",
        resolvedCommit: "abc123",
        subdir: ".",
      },
      {
        kind: "ripgit-source",
        mountPath: "/src/repo",
        packageId: "import:root/pkg-test:.",
        repo: "root/pkg-test",
        ref: "main",
        resolvedCommit: "abc123",
        subdir: ".",
      },
    ]);
  });
});
