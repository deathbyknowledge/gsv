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
import { KERNEL_V016_ADD_USER_KERNELS } from "./v016_add_user_kernels";
import {
  KERNEL_V017_BIND_ADAPTER_RUN_ROUTES,
} from "./v017_bind_adapter_run_routes";
import {
  KERNEL_V018_FENCE_AUTH_TOKEN_SESSIONS,
} from "./v018_fence_auth_token_sessions";
import {
  KERNEL_V019_BIND_PROCESS_KERNEL_GENERATION,
} from "./v019_bind_process_kernel_generation";

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
  it("leaves legacy process rows unbound and rejects invalid generations", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE processes");
      sql.exec("CREATE TABLE processes (process_id TEXT PRIMARY KEY)");
      sql.exec("INSERT INTO processes (process_id) VALUES ('legacy-process')");

      applyMigration(sql, KERNEL_V019_BIND_PROCESS_KERNEL_GENERATION);

      expect(sql.exec<{ kernel_generation: number | null }>(
        "SELECT kernel_generation FROM processes WHERE process_id = 'legacy-process'",
      ).toArray()).toEqual([{ kernel_generation: null }]);
      expect(() => sql.exec(
        "UPDATE processes SET kernel_generation = 0 WHERE process_id = 'legacy-process'",
      )).toThrow();
      sql.exec(
        "UPDATE processes SET kernel_generation = 4 WHERE process_id = 'legacy-process'",
      );
      expect(sql.exec<{ kernel_generation: number | null }>(
        "SELECT kernel_generation FROM processes WHERE process_id = 'legacy-process'",
      ).toArray()).toEqual([{ kernel_generation: 4 }]);
    });
  });

  it("atomically queues new token revocations without copying credential material", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TRIGGER auth_tokens_enqueue_revocation");
      sql.exec("DROP TABLE auth_token_revocation_tombstones");
      sql.exec("DROP TABLE auth_token_revocation_outbox");
      applyMigration(sql, KERNEL_V018_FENCE_AUTH_TOKEN_SESSIONS);
      sql.exec(`
        INSERT INTO auth_tokens (
          token_id, uid, kind, label, token_hash, token_prefix, allowed_role,
          allowed_device_id, created_at, last_used_at, expires_at, revoked_at, revoked_reason
        ) VALUES (
          'revocation-test', 1000, 'user', NULL, 'secret-hash', 'secret-prefix',
          'user', NULL, 1, NULL, NULL, NULL, NULL
        )
      `);

      sql.exec(`
        UPDATE auth_tokens
        SET revoked_at = 1234, revoked_reason = 'test'
        WHERE token_id = 'revocation-test'
      `);

      expect(sql.exec<{
        token_id: string;
        uid: number;
        revoked_at: number;
        attempt_count: number;
        next_attempt_at: number;
      }>(`
        SELECT token_id, uid, revoked_at, attempt_count, next_attempt_at
        FROM auth_token_revocation_outbox
      `).toArray()).toEqual([{
        token_id: "revocation-test",
        uid: 1000,
        revoked_at: 1234,
        attempt_count: 0,
        next_attempt_at: 1234,
      }]);
      const columns = sql.exec<{ name: string }>(
        "PRAGMA table_info(auth_token_revocation_outbox)",
      ).toArray().map((column) => column.name);
      expect(columns).not.toEqual(expect.arrayContaining([
        "token_hash",
        "token_prefix",
        "password",
        "credential",
      ]));
    });
  });

  it("backfills permanent identities without promoting locked token-bearing agents", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE user_kernels");
      sql.exec("DROP TABLE account_identities");
      sql.exec(`
        INSERT INTO passwd (username, uid, gid, gecos, home, shell) VALUES
          ('root', 0, 0, 'root', '/root', '/bin/init'),
          ('alice', 1000, 1000, 'Alice', '/home/alice', '/bin/init'),
          ('alice-agent', 1001, 1001, 'Agent', '/home/alice-agent', '/bin/init'),
          ('bob', 1002, 1002, 'Bob', '/home/bob', '/bin/init'),
          ('token-agent', 1003, 1003, 'Token Agent', '/home/token-agent', '/bin/init'),
          ('locked-agent', 1004, 1004, 'Locked Agent', '/home/locked-agent', '/bin/init')
      `);
      sql.exec(`
        INSERT INTO shadow (username, hash, lastchanged, min, max, warn, inactive, expire, reserved)
        VALUES
          ('root', '!', '', '', '', '', '', '', ''),
          ('alice', '$hash$', '', '', '', '', '', '', ''),
          ('alice-agent', '!', '', '', '', '', '', '', ''),
          ('bob', '$hash$', '', '', '', '', '', '', ''),
          ('token-agent', '!', '', '', '', '', '', '', ''),
          ('locked-agent', '!', '', '', '', '', '', '', '')
      `);
      sql.exec("INSERT INTO personal_agents (owner_uid, agent_uid) VALUES (1000, 1001)");
      sql.exec(`
        INSERT INTO auth_tokens (
          token_id, uid, kind, label, token_hash, token_prefix, allowed_role,
          allowed_device_id, created_at, last_used_at, expires_at, revoked_at, revoked_reason
        ) VALUES (
          'agent-user-token', 1003, 'user', 'agent user token', 'hash-agent-user-token',
          'gsv_user_token', 'user', NULL, 1, NULL, NULL, NULL, NULL
        )
      `);

      applyMigration(sql, KERNEL_V016_ADD_USER_KERNELS);

      expect(sql.exec<{ username: string; uid: number; kind: string; state: string }>(`
        SELECT username, uid, kind, state
        FROM account_identities
        ORDER BY uid
      `).toArray()).toEqual([
        { username: "root", uid: 0, kind: "system", state: "active" },
        { username: "alice", uid: 1000, kind: "human", state: "active" },
        { username: "alice-agent", uid: 1001, kind: "agent", state: "active" },
        { username: "bob", uid: 1002, kind: "human", state: "active" },
        { username: "token-agent", uid: 1003, kind: "agent", state: "active" },
        { username: "locked-agent", uid: 1004, kind: "agent", state: "active" },
      ]);
      expect(sql.exec<{ username: string; uid: number; lifecycle: string }>(`
        SELECT username, uid, lifecycle
        FROM user_kernels
        ORDER BY uid
      `).toArray()).toEqual([
        { username: "root", uid: 0, lifecycle: "legacy" },
        { username: "alice", uid: 1000, lifecycle: "legacy" },
        { username: "bob", uid: 1002, lifecycle: "legacy" },
      ]);
    });
  });

  it("rejects non-canonical legacy account names instead of normalizing or dropping them", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE user_kernels");
      sql.exec("DROP TABLE account_identities");

      const invalidAccounts = [
        { username: "Alice", uid: 2000 },
        { username: " alice", uid: 2001 },
        { username: "9alice", uid: 2002 },
        { username: "alice.dev", uid: 2003 },
        { username: "álice", uid: 2004 },
        { username: `a${"b".repeat(32)}`, uid: 2005 },
        { username: "", uid: 2006 },
      ];

      for (const account of invalidAccounts) {
        sql.exec(
          `INSERT INTO passwd (username, uid, gid, gecos, home, shell)
           VALUES (?, ?, ?, '', ?, '/bin/init')`,
          account.username,
          account.uid,
          account.uid,
          `/home/${account.username}`,
        );

        expect(() => state.storage.transactionSync(() => {
          applyMigration(sql, KERNEL_V016_ADD_USER_KERNELS);
        })).toThrow(/check constraint failed/i);
        expect(sql.exec<{ name: string }>(`
          SELECT name
          FROM sqlite_master
          WHERE name IN ('account_identities', 'user_kernels')
        `).toArray()).toEqual([]);
        expect(sql.exec<{ username: string; uid: number }>(
          "SELECT username, uid FROM passwd WHERE uid = ?",
          account.uid,
        ).toArray()).toEqual([account]);

        sql.exec("DELETE FROM passwd WHERE uid = ?", account.uid);
      }
    });
  });

  it("rejects canonicalization collisions and preserves the original passwd rows", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE user_kernels");
      sql.exec("DROP TABLE account_identities");
      sql.exec(`
        INSERT INTO passwd (username, uid, gid, gecos, home, shell) VALUES
          ('alice', 2000, 2000, 'Alice', '/home/alice', '/bin/init'),
          ('Alice', 2001, 2001, 'Also Alice', '/home/Alice', '/bin/init')
      `);

      expect(() => state.storage.transactionSync(() => {
        applyMigration(sql, KERNEL_V016_ADD_USER_KERNELS);
      })).toThrow(/check constraint failed/i);
      expect(sql.exec<{ username: string; uid: number }>(`
        SELECT username, uid
        FROM passwd
        WHERE uid IN (2000, 2001)
        ORDER BY uid
      `).toArray()).toEqual([
        { username: "alice", uid: 2000 },
        { username: "Alice", uid: 2001 },
      ]);
      expect(sql.exec<{ name: string }>(`
        SELECT name
        FROM sqlite_master
        WHERE name IN ('account_identities', 'user_kernels')
      `).toArray()).toEqual([]);
    });
  });

  it("rejects legacy rows that violate permanent root and uid bindings", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE user_kernels");
      sql.exec("DROP TABLE account_identities");
      sql.exec("DELETE FROM shadow WHERE username = 'root'");
      sql.exec("DELETE FROM passwd WHERE username = 'root'");

      const invalidBindings = [
        { username: "admin", uid: 0 },
        { username: "root", uid: 42 },
        { username: "negative", uid: -1 },
        { username: "unsafe", uid: 9_007_199_254_740_992 },
      ];

      for (const binding of invalidBindings) {
        sql.exec(
          `INSERT INTO passwd (username, uid, gid, gecos, home, shell)
           VALUES (?, ?, 0, '', '/root', '/bin/init')`,
          binding.username,
          binding.uid,
        );

        expect(() => state.storage.transactionSync(() => {
          applyMigration(sql, KERNEL_V016_ADD_USER_KERNELS);
        })).toThrow(/check constraint failed/i);
        expect(sql.exec<{ name: string }>(`
          SELECT name
          FROM sqlite_master
          WHERE name IN ('account_identities', 'user_kernels')
        `).toArray()).toEqual([]);

        sql.exec("DELETE FROM passwd WHERE username = ?", binding.username);
      }
    });
  });

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

  it("backfills adapter identity generations and binds existing run route rows", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE identity_link_generations");
      sql.exec("DROP TABLE identity_links");
      sql.exec("DROP TABLE run_routes");
      sql.exec(`
        CREATE TABLE identity_links (
          adapter       TEXT NOT NULL,
          account_id    TEXT NOT NULL,
          actor_id      TEXT NOT NULL,
          uid           INTEGER NOT NULL,
          created_at    INTEGER NOT NULL,
          linked_by_uid INTEGER NOT NULL,
          metadata_json TEXT,
          PRIMARY KEY (adapter, account_id, actor_id)
        )
      `);
      sql.exec(`
        CREATE TABLE run_routes (
          run_id        TEXT PRIMARY KEY,
          route_kind    TEXT NOT NULL,
          uid           INTEGER NOT NULL,
          connection_id TEXT,
          adapter       TEXT,
          account_id    TEXT,
          surface_kind  TEXT,
          surface_id    TEXT,
          thread_id     TEXT,
          created_at    INTEGER NOT NULL,
          expires_at    INTEGER NOT NULL
        )
      `);
      sql.exec(`
        INSERT INTO identity_links (
          adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
        ) VALUES ('discord', 'primary', 'actor-1', 1000, 1, 0, NULL)
      `);
      sql.exec(`
        INSERT INTO run_routes (
          run_id, route_kind, uid, connection_id, adapter, account_id,
          surface_kind, surface_id, thread_id, created_at, expires_at
        ) VALUES (
          'run-legacy', 'adapter', 1000, NULL, 'discord', 'primary',
          'dm', 'surface-1', NULL, 1, 1000
        )
      `);

      applyMigration(sql, KERNEL_V017_BIND_ADAPTER_RUN_ROUTES);

      expect(sql.exec<{ actor_id: string | null; link_generation: number | null }>(`
        SELECT actor_id, link_generation FROM run_routes WHERE run_id = 'run-legacy'
      `).toArray()).toEqual([{ actor_id: null, link_generation: null }]);
      expect(sql.exec<{ generation: number }>(`
        SELECT generation FROM identity_links
        WHERE adapter = 'discord' AND account_id = 'primary' AND actor_id = 'actor-1'
      `).toArray()).toEqual([{ generation: 1 }]);
      expect(sql.exec<{
        adapter: string;
        account_id: string;
        actor_id: string;
        generation: number;
      }>(`
        SELECT adapter, account_id, actor_id, generation
        FROM identity_link_generations
      `).toArray()).toEqual([{
        adapter: "discord",
        account_id: "primary",
        actor_id: "actor-1",
        generation: 1,
      }]);
    });
  });
});
