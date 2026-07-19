import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { SqlMigration } from "../../schema/runner";
import type { Kernel } from "../do";
import { KERNEL_V009_RESTRICT_SYSTEM_BOOTSTRAP } from "./v009_restrict_system_bootstrap";
import { KERNEL_V010_RESTRICT_WILDCARD_CAPABILITY } from "./v010_restrict_wildcard_capability";
import { KERNEL_V011_PRIVATIZE_DEVICE_OWNER_ACCESS } from "./v011_privatize_device_owner_access";
import { KERNEL_V013_ADD_UNIX_ID_ALLOCATOR } from "./v013_add_unix_id_allocator";
import {
  KERNEL_V014_INTERNALIZE_CONVERSATION_ARCHIVES,
} from "./v014_internalize_conversation_archives";

type CapabilityRow = {
  gid: number;
  capability: string;
};

type DeviceAccessRow = {
  device_id: string;
  gid: number;
};

function applyMigration(sql: SqlStorage, migration: SqlMigration): void {
  for (const statement of migration.statements) {
    const trimmed = statement.trim();
    if (trimmed) {
      sql.exec(trimmed);
    }
  }
}

describe("kernel security migration data", () => {
  it("removes sys.bootstrap only from the shared users group", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM group_capabilities WHERE gid IN (0, 100, 1001)");
      sql.exec(`
        INSERT INTO group_capabilities (gid, capability) VALUES
          (0, 'sys.bootstrap'),
          (0, '*'),
          (100, 'sys.bootstrap'),
          (100, 'fs.read'),
          (1001, 'sys.bootstrap')
      `);

      applyMigration(sql, KERNEL_V009_RESTRICT_SYSTEM_BOOTSTRAP);

      expect(sql.exec<CapabilityRow>(`
        SELECT gid, capability
        FROM group_capabilities
        WHERE gid IN (0, 100, 1001)
        ORDER BY gid, capability
      `).toArray()).toEqual([
        { gid: 0, capability: "*" },
        { gid: 0, capability: "sys.bootstrap" },
        { gid: 100, capability: "fs.read" },
        { gid: 1001, capability: "sys.bootstrap" },
      ]);
    });
  });

  it("removes wildcard authority only from non-root groups", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM group_capabilities WHERE gid IN (0, 100, 1001)");
      sql.exec(`
        INSERT INTO group_capabilities (gid, capability) VALUES
          (0, '*'),
          (0, 'sys.bootstrap'),
          (100, '*'),
          (100, 'fs.read'),
          (1001, '*'),
          (1001, 'net.fetch')
      `);

      applyMigration(sql, KERNEL_V010_RESTRICT_WILDCARD_CAPABILITY);

      expect(sql.exec<CapabilityRow>(`
        SELECT gid, capability
        FROM group_capabilities
        WHERE gid IN (0, 100, 1001)
        ORDER BY gid, capability
      `).toArray()).toEqual([
        { gid: 0, capability: "*" },
        { gid: 0, capability: "sys.bootstrap" },
        { gid: 100, capability: "fs.read" },
        { gid: 1001, capability: "net.fetch" },
      ]);
    });
  });

  it("moves legacy human device access to the owner's private group", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec(`
        INSERT INTO devices (
          device_id, owner_uid, label, description, implements, platform,
          version, online, first_seen_at, last_seen_at
        ) VALUES
          ('human-device', 1000, 'Human', '', '[]', '', '', 0, 1, 1),
          ('already-private', 1001, 'Private', '', '[]', '', '', 0, 1, 1),
          ('root-device', 0, 'Root', '', '[]', '', '', 0, 1, 1),
          ('service-device', 500, 'Service', '', '[]', '', '', 0, 1, 1)
      `);
      sql.exec(`
        INSERT INTO device_access (device_id, gid) VALUES
          ('human-device', 100),
          ('human-device', 200),
          ('already-private', 100),
          ('already-private', 1001),
          ('root-device', 100),
          ('root-device', 200),
          ('service-device', 100)
      `);

      applyMigration(sql, KERNEL_V011_PRIVATIZE_DEVICE_OWNER_ACCESS);

      expect(sql.exec<DeviceAccessRow>(`
        SELECT device_id, gid
        FROM device_access
        WHERE device_id IN (
          'human-device', 'already-private', 'root-device', 'service-device'
        )
        ORDER BY device_id, gid
      `).toArray()).toEqual([
        { device_id: "already-private", gid: 1001 },
        { device_id: "human-device", gid: 200 },
        { device_id: "human-device", gid: 1000 },
        { device_id: "root-device", gid: 100 },
        { device_id: "root-device", gid: 200 },
        { device_id: "service-device", gid: 100 },
      ]);
    });
  });

  it("initializes the Unix id allocator above every legacy uid and gid", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE unix_id_allocator");
      sql.exec(`
        INSERT INTO passwd (username, uid, gid, gecos, home, shell) VALUES
          ('legacy-user', 4100, 6200, '', '/home/legacy-user', '/bin/init')
      `);
      sql.exec(`
        INSERT INTO groups (name, gid, members) VALUES
          ('legacy-group', 5300, '')
      `);

      applyMigration(sql, KERNEL_V013_ADD_UNIX_ID_ALLOCATOR);

      expect(sql.exec<{ singleton: number; high_water: number }>(
        "SELECT singleton, high_water FROM unix_id_allocator",
      ).toArray()).toEqual([{ singleton: 1, high_water: 6200 }]);
    });
  });

  it("invalidates legacy agent-home conversation archive pointers", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("ALTER TABLE conversations ADD COLUMN archive_base TEXT");
      sql.exec(`
        INSERT INTO conversations (
          conversation_id, owner_uid, agent_uid, title, is_default, active_pid,
          latest_archive, created_at, last_active_at, archive_base
        ) VALUES (
          'legacy-conversation', 1000, 2000, NULL, 1, NULL,
          '/home/shared-agent/conversations/legacy/archive.jsonl.gz', 1, NULL,
          '/home/shared-agent/conversations/legacy'
        )
      `);

      applyMigration(sql, KERNEL_V014_INTERNALIZE_CONVERSATION_ARCHIVES);

      expect(sql.exec<{ latest_archive: string | null }>(
        "SELECT latest_archive FROM conversations WHERE conversation_id = 'legacy-conversation'",
      ).toArray()).toEqual([{ latest_archive: null }]);
      expect(sql.exec<{ name: string }>("PRAGMA table_info(conversations)").toArray()
        .map((column) => column.name)).not.toContain("archive_base");
    });
  });
});
