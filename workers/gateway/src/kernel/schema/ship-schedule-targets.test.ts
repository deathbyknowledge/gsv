import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const PRINCIPAL = JSON.stringify({ kind: "user", uid: 1000, username: "sam" });
const REPLY = { kind: "adapter", adapter: "telegram", accountId: "bot", actorId: "telegram:user:42", surface: { kind: "dm", id: "chat-42" } };

describe("Ship schedule targets migration", () => {
  it("turns schedules aimed at a Ship's pid into Ship responsibilities, as new ones are stored", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 96));
      const process = `INSERT INTO processes (process_id, uid, owner_uid, gid, gids, username, home, cwd, is_personal_controller, created_at)
        VALUES (?, 1000, 1000, 1000, '[1000]', 'sam', '/home/sam', '/home/sam', ?, 1)`;
      sql.exec(process, "proc:ship", 1);
      sql.exec(process, "proc:worker", 0);
      const schedule = `INSERT INTO schedules (schedule_id, owner_uid, creator_json, run_as_json, name, enabled, expression_json,
          target_json, overlap_policy, run_count, created_at, updated_at)
        VALUES (?, 1000, ?, ?, ?, 1, '{"kind":"every","everyMs":60000}', ?, 'skip', 0, 1, 1)`;
      const targets = {
        ship: { kind: "process.event", pid: "proc:ship", message: "Review the day.", data: { mailbox: "primary", tags: ["a"] }, replyTo: REPLY },
        bare: { kind: "process.event", pid: "proc:ship", message: "Stretch." },
        worker: { kind: "process.event", pid: "proc:worker", message: "Check the oven.", replyTo: REPLY },
        spawn: { kind: "process.spawn", prompt: "Run the report." },
      };
      for (const [id, target] of Object.entries(targets)) sql.exec(schedule, id, PRINCIPAL, PRINCIPAL, id, JSON.stringify(target));

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const stored = Object.fromEntries(sql.exec<{ schedule_id: string; target_json: string; updated_at: number }>(
        "SELECT schedule_id, target_json, updated_at FROM schedules ORDER BY schedule_id",
      ).toArray().map(({ schedule_id, target_json, updated_at }) => [schedule_id, { target: JSON.parse(target_json), updated_at }]));
      expect(stored).toEqual({
        ship: { target: { kind: "responsibility", message: "Review the day.", data: { mailbox: "primary", tags: ["a"] } }, updated_at: 1 },
        bare: { target: { kind: "responsibility", message: "Stretch." }, updated_at: 1 },
        worker: { target: targets.worker, updated_at: 1 },
        spawn: { target: targets.spawn, updated_at: 1 },
      });
    });
  });
});
