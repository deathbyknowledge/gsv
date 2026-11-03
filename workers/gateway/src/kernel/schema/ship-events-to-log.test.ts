import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const NOTICE_ID = "contact.message:contact:remote:5:0";
const MESSAGE_ID = "msg:one";

describe("Ship events migration", () => {
  it("moves events still waiting for a Ship into the log, in their order and with their retry state", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 93));
      const notice = {
        type: "owner.notified",
        payload: { noticeId: NOTICE_ID, topic: "contact.message", adapter: "whatsapp", from: "Remote", preview: "hello", messages: 1, sentAtMs: 5 },
        link: { kind: "contact", contactId: "contact:remote" },
      };
      const message = {
        type: "contact.message", contactId: "contact:remote", contactGeneration: "1", conversationId: "conv:remote",
        messageId: MESSAGE_ID, from: "Remote", text: "hello", responsibilityId: "r12y:00000000-0000-4000-8000-000000000001", ledgerRevision: 4,
      };
      const insert = `INSERT INTO ship_events (event_id, owner_uid, event_json, attempt_count, last_error, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      // Created in the same millisecond: the notice was queued first.
      sql.exec(insert, `owner.notified:${NOTICE_ID}`, 1000, JSON.stringify(notice), 0, null, 5, 5, 5);
      sql.exec(insert, `contact.message:${MESSAGE_ID}`, 1000, JSON.stringify(message), 2, "Process is restarting", 90, 5, 30);
      sql.exec(`INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES ('task:ship', 'onShipEvents', '1000', 'scheduled', 1)`);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'ship_events'").toArray()).toEqual([]);
      expect(sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onShipEvents'").toArray()).toEqual([]);
      const events = sql.exec<{ seq: number; type: string; owner_uid: number; subject: string; actor_json: string; idempotency_key: string; body_json: string; created_at: number }>(
        "SELECT * FROM events ORDER BY seq",
      ).toArray();
      expect(events.map(({ seq: _seq, actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }))).toEqual([
        {
          type: "owner.notified", owner_uid: 1000, subject: `notice:${NOTICE_ID}`, idempotency_key: NOTICE_ID, created_at: 5,
          actor: { kind: "kernel" }, body: { payload: notice.payload, link: notice.link },
        },
        {
          type: "contact.message", owner_uid: 1000, subject: "contact:remote", idempotency_key: MESSAGE_ID, created_at: 5,
          actor: { kind: "contact", contactId: "contact:remote" },
          body: { contactId: "contact:remote", contactGeneration: "1", conversationId: "conv:remote", messageId: MESSAGE_ID,
            from: "Remote", text: "hello", responsibilityId: message.responsibilityId, ledgerRevision: 4 },
        },
      ]);
      expect(sql.exec("SELECT seq, consumer, lane, state, attempt_count, next_attempt_at, last_error, updated_at FROM deliveries ORDER BY seq").toArray()).toEqual([
        { seq: events[0]!.seq, consumer: "personal:1000", lane: "background", state: "pending", attempt_count: 0, next_attempt_at: 5, last_error: null, updated_at: 5 },
        { seq: events[1]!.seq, consumer: "personal:1000", lane: "background", state: "pending", attempt_count: 2, next_attempt_at: 90, last_error: "Process is restarting", updated_at: 30 },
      ]);
    });
  });
});
