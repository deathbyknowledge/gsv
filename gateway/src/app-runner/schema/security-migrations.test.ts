import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { SqlMigration } from "../../schema/runner";
import type { Kernel } from "../../kernel/do";
import { APP_RUNNER_V001_INITIAL_SCHEMA } from "./v001_initial";
import { APP_RUNNER_V002_BIND_SCHEDULE_AUTHORITY } from "./v002_bind_schedule_authority";

function applyMigration(sql: SqlStorage, migration: SqlMigration): void {
  for (const statement of migration.statements) {
    const trimmed = statement.trim();
    if (trimmed) {
      sql.exec(trimmed);
    }
  }
}

describe("app runner security migration data", () => {
  it("leaves legacy schedules unbound and impossible to fire", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      applyMigration(sql, APP_RUNNER_V001_INITIAL_SCHEMA);
      sql.exec(
        `INSERT INTO app_rpc_schedules (
          schedule_key, rpc_method, schedule_json, payload_json, enabled,
          version, created_at, updated_at, next_run_at, running_at,
          last_run_at, last_status, last_error, last_duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "legacy-refresh",
        "refresh",
        JSON.stringify({ kind: "every", everyMs: 60_000 }),
        null,
        1,
        1,
        1_000,
        1_000,
        2_000,
        null,
        null,
        null,
        null,
        null,
      );

      applyMigration(sql, APP_RUNNER_V002_BIND_SCHEDULE_AUTHORITY);

      expect(sql.exec<{
        logical_key: string | null;
        authority_key: string | null;
        kernel_generation: number | null;
        runtime_authority_json: string | null;
        enabled: number;
        next_run_at: number | null;
        last_status: string | null;
        last_error: string | null;
      }>(
        `SELECT logical_key, authority_key, kernel_generation,
                runtime_authority_json, enabled, next_run_at,
                last_status, last_error
         FROM app_rpc_schedules
         WHERE schedule_key = 'legacy-refresh'`,
      ).toArray()).toEqual([{
        logical_key: "legacy-refresh",
        authority_key: null,
        kernel_generation: null,
        runtime_authority_json: null,
        enabled: 0,
        next_run_at: null,
        last_status: "error",
        last_error: "Legacy schedule authority is unbound",
      }]);
      expect(sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM app_rpc_schedules
         WHERE authority_key IS NOT NULL
           AND runtime_authority_json IS NOT NULL
           AND enabled = 1
           AND next_run_at IS NOT NULL`,
      ).toArray()).toEqual([{ count: 0 }]);
      expect(() => sql.exec(
        "UPDATE app_rpc_schedules SET kernel_generation = 0 WHERE schedule_key = 'legacy-refresh'",
      )).toThrow();
    });
  });
});
