import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const NOTICE_ID = "contact.message:contact:remote:5:0";
const R12Y = "r12y:00000000-0000-4000-8000-000000000001";
const PRINCIPAL = JSON.stringify({ kind: "user", uid: 1000, username: "sam" });
const REPLY = { kind: "adapter", adapter: "telegram", accountId: "bot", actorId: "telegram:user:42", surface: { kind: "dm", id: "chat-42" } };
const KERNEL = { kind: "kernel" };

function pending(consumer: string, lane: string | null, at: number) {
  return { consumer, lane, state: "pending", attempt_count: 0, next_attempt_at: at, last_error: null, updated_at: at, legacy_id: null };
}

const UNDELIVERED = {
  consumer: null, lane: null, state: null, attempt_count: null, next_attempt_at: null, last_error: null, updated_at: null, legacy_id: null,
};

describe("event log cutover", () => {
  it("moves what an older Kernel had on its way onto the log, and drops the state the log replaces", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 92));
      sql.exec(`INSERT INTO processes (process_id, uid, owner_uid, gid, gids, username, home, cwd, is_personal_controller, created_at) VALUES
        ('ship', 1000, 1000, 1000, '[1000]', 'sam', '/home/sam', '/home/sam', 1, 1),
        ('worker', 1001, 1000, 1001, '[1001]', 'crew', '/home/crew', '/home/crew', 0, 1)`);

      const notice = { type: "owner.notified", payload: { noticeId: NOTICE_ID, topic: "contact.message" }, link: { kind: "contact", contactId: "contact:remote" } };
      const message = { type: "contact.message", contactId: "contact:remote", messageId: "msg:one", text: "hello" };
      const shipEvent = `INSERT INTO ship_events (event_id, owner_uid, event_json, attempt_count, last_error, next_attempt_at, created_at, updated_at)
        VALUES (?, 1000, ?, ?, ?, ?, 5, ?)`;
      // Queued in the same millisecond: the notice first.
      sql.exec(shipEvent, `owner.notified:${NOTICE_ID}`, JSON.stringify(notice), 0, null, 5, 5);
      sql.exec(shipEvent, "contact.message:msg:one", JSON.stringify(message), 2, "Process is restarting", 90, 30);
      sql.exec(`INSERT INTO responsibility_wake_batches (
          batch_id, owner_uid, through_revision, responsibility_ids_json, event_id, attempt_count, last_error, created_at, updated_at
        ) VALUES ('batch:one', 1000, 7, ?, 'r12y.ready:batch:one', 2, 'Process is restarting', 10, 40)`, JSON.stringify([R12Y]));

      sql.exec(`INSERT INTO event_sources (source_id, owner_uid, name, label, notify, ship, webhook, bucket_tokens, bucket_at, created_by, created_at, updated_at)
        VALUES ('src_a', 1000, 'feed', 'Feed', 'messenger', 'none', 'none', 120, 1, 'person', 1, 1)`);
      const arrived = `INSERT INTO event_log (source_id, event_id, owner_uid, title, preview, body, emitted_by, received_at)
        VALUES ('src_a', ?, 1000, ?, ?, ?, ?, ?)`;
      sql.exec(arrived, "full", "Full", "seen", "private", "webhook", 30);
      sql.exec(arrived, "bare", "Bare", null, null, "process", 10);
      // The old limit counted characters, so a stored body can be past 64 KiB.
      sql.exec(arrived, "huge", "Huge", null, "x".repeat(65_536), "client", 20);

      for (const [callId, status, runStatus, response, error, updatedAt] of [
        // Answered by the target's run, and in flight to the caller when the Kernel stopped.
        ["replied", "completed", "ok", { text: "The oven is off.", usage: null }, null, 30],
        // Ended by the Kernel when the target was reset.
        ["reset", "completed", null, null, "Target process was reset", 20],
        ["late", "timed_out", null, null, "IPC call timed out", 10],
        ["pending", "pending", null, null, null, 5],
      ] as const) {
        sql.exec(
          `INSERT INTO ipc_calls (call_id, uid, source_pid, source_run_id, target_pid, target_run_id, status, run_status,
             supervised, deadline_at, created_at, updated_at, response_json, error, delivery_started_at)
           VALUES (?, 1000, 'ship', 'run:ship', 'worker', ?, ?, ?, 0, 100, 1, ?, ?, ?, 25)`,
          callId, `run:${callId}`, status, runStatus, updatedAt, JSON.stringify(response), error,
        );
      }

      const task = "INSERT INTO cf_agents_schedules (id, callback, payload, type, time, created_at) VALUES (?, ?, ?, 'scheduled', ?, ?)";
      const failure = { runId: "run-1", processId: "worker", deliveryKind: "message", state: "permanent" };
      sql.exec(task, "task:reply", "onProcessDeliveryNotice", JSON.stringify({ ...failure, noticeId: "notice-reply", message: "chat closed" }), 2, 20);
      sql.exec(task, "task:approval", "onProcessDeliveryNotice", JSON.stringify({
        ...failure, noticeId: "notice-approval", deliveryKind: "hil", requestId: "approval-1", message: "timeout",
      }), 1, 10);
      // Its process was killed, so there is no one left to tell.
      sql.exec(task, "task:killed", "onProcessDeliveryNotice", JSON.stringify({ ...failure, processId: "killed", noticeId: "notice-killed", message: "gone" }), 3, 30);
      for (const [id, callback] of [
        ["task:ship", "onShipEvents"], ["task:answer", "onIpcCallDelivery"], ["task:review", "onMemoryReview"], ["task:approval-notice", "onProcessApprovalNotice"],
        ["task:timeout", "onIpcCallTimeout"], ["task:wake", "onResponsibilityWake"], ["task:route", "onAdapterRouteDelivery"],
      ]) sql.exec(task, id, callback, "{}", 1, 1);

      const schedule = `INSERT INTO schedules (schedule_id, owner_uid, creator_json, run_as_json, name, enabled, expression_json,
          target_json, overlap_policy, run_count, created_at, updated_at)
        VALUES (?, 1000, ?, ?, ?, 1, '{"kind":"every","everyMs":60000}', ?, 'skip', 0, 1, 1)`;
      const targets = {
        ship: { kind: "process.event", pid: "ship", message: "Review the day.", data: { mailbox: "primary" }, replyTo: REPLY },
        bare: { kind: "process.event", pid: "ship", message: "Stretch." },
        worker: { kind: "process.event", pid: "worker", message: "Check the oven.", replyTo: REPLY },
      };
      for (const [id, target] of Object.entries(targets)) sql.exec(schedule, id, PRINCIPAL, PRINCIPAL, id, JSON.stringify(target));

      const receipt = `INSERT INTO adapter_ingress_receipts
        (receipt_id, adapter, account_id, actor_id, surface_kind, surface_id, provider_message_id, state, progress_json, claim_token, claimed_at, created_at)
        VALUES (?, 'whatsapp', 'primary', 'wa:+123', 'dm', 'dm-1', ?, ?, ?, 'claim', 1, 1)`;
      const workReturn = JSON.stringify({ kind: "work_return", uid: 1000, workPid: "proc:work" });
      const replyPreference = JSON.stringify({ kind: "reply_preference", uid: 1000, order: 1 });
      sql.exec(receipt, "receipt:ship", "wamid-ship", "in_progress", workReturn);
      sql.exec(receipt, "receipt:message", "wamid-message", "in_progress", replyPreference);
      sql.exec(receipt, "receipt:done", "wamid-done", "completed", workReturn);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const log = sql.exec<{ actor_json: string; body_json: string }>(`
        SELECT e.type, e.subject, e.actor_json, e.idempotency_key, e.body_json, e.created_at,
          d.consumer, d.lane, d.state, d.attempt_count, d.next_attempt_at, d.last_error, d.updated_at, d.legacy_id
        FROM events e LEFT JOIN deliveries d USING (seq) ORDER BY e.seq
      `).toArray().map(({ actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }));
      const source = { type: "source.event", subject: "source:src_a", actor: { kind: "source", sourceId: "src_a" }, ...UNDELIVERED };
      const answer = (type: string, callId: string, at: number, actor: { kind: string; pid?: string }, ended: { response?: { text: string; usage: null }; error?: string }) => ({
        type, subject: `ipc:${callId}`, actor, idempotency_key: callId,
        body: { sourcePid: "ship", callId, targetPid: "worker", sourceRunId: "run:ship", createdAt: 1, deadlineAt: 100, ...ended },
        created_at: at, ...pending("proc:ship", "background", at),
      });
      // A Ship event or wake batch goes under the id its Process deduped it by, in case it already has it.
      // TODO(event-log): drop legacy_id from this check once a migration drops the column.
      expect(log).toEqual([
        {
          type: "owner.notified", subject: `notice:${NOTICE_ID}`, actor: KERNEL, idempotency_key: NOTICE_ID,
          body: { payload: notice.payload, link: notice.link }, created_at: 5, ...pending("personal:1000", "background", 5),
          legacy_id: `owner.notified:${NOTICE_ID}`,
        },
        {
          type: "contact.message", subject: "contact:remote", actor: { kind: "contact", contactId: "contact:remote" }, idempotency_key: "msg:one",
          body: { contactId: "contact:remote", messageId: "msg:one", text: "hello" }, created_at: 5,
          ...pending("personal:1000", "background", 5), attempt_count: 2, next_attempt_at: 90, last_error: "Process is restarting", updated_at: 30,
          legacy_id: "contact.message:msg:one",
        },
        // A failed batch retries at once, as the wake timer would have, and no lane holds it.
        {
          type: "responsibility.ready", subject: "owner:1000", actor: KERNEL, idempotency_key: "batch:one",
          body: { responsibilityIds: [R12Y], ledgerRevision: 7 }, created_at: 10,
          ...pending("personal:1000", null, 40), attempt_count: 2, last_error: "Process is restarting",
          legacy_id: "r12y.ready:batch:one",
        },
        { ...source, idempotency_key: "src_a:bare", body: { eventId: "bare", title: "Bare", emittedBy: "process" }, created_at: 10 },
        { ...source, idempotency_key: "src_a:huge", body: { eventId: "huge", title: "Huge", emittedBy: "client" }, created_at: 20 },
        {
          ...source, idempotency_key: "src_a:full",
          body: { eventId: "full", title: "Full", preview: "seen", body: "private", emittedBy: "webhook" }, created_at: 30,
        },
        // Each answer moves into its event, which carries it from now on.
        answer("ipc.timeout", "late", 10, KERNEL, { error: "IPC call timed out" }),
        answer("ipc.reply", "reset", 20, KERNEL, { error: "Target process was reset" }),
        answer("ipc.reply", "replied", 30, { kind: "process", pid: "worker" }, { response: { text: "The oven is off.", usage: null } }),
        {
          type: "delivery.failed", subject: "proc:worker", actor: KERNEL, idempotency_key: "notice-approval",
          body: { pid: "worker", runId: "run-1", requestId: "approval-1", message: "timeout" }, created_at: 10_000,
          ...pending("proc:worker", "background", 10_000),
        },
        {
          type: "delivery.failed", subject: "proc:worker", actor: KERNEL, idempotency_key: "notice-reply",
          body: { pid: "worker", runId: "run-1", message: "chat closed" }, created_at: 20_000,
          ...pending("proc:worker", "background", 20_000),
        },
      ]);
      // A crew worker's notice belongs to its owner.
      expect(sql.exec("SELECT DISTINCT owner_uid FROM events").toArray()).toEqual([{ owner_uid: 1000 }]);

      expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('ship_events', 'responsibility_wake_batches', 'event_log')").toArray()).toEqual([]);
      // Only the call still with its target keeps a row, and the row no longer holds an answer.
      expect(sql.exec("SELECT call_id FROM ipc_calls").toArray()).toEqual([{ call_id: "pending" }]);
      expect(sql.exec("SELECT name FROM pragma_table_info('ipc_calls') ORDER BY cid").toArray().map(({ name }) => name)).toEqual([
        "call_id", "uid", "source_pid", "target_pid", "target_run_id", "deadline_at", "created_at", "updated_at",
        "source_run_id", "responsibility_id", "supervised",
      ]);
      expect(sql.exec("SELECT name FROM pragma_index_list('ipc_calls') WHERE origin = 'c' ORDER BY name").toArray()).toEqual([
        { name: "idx_ipc_calls_source_run" }, { name: "idx_ipc_calls_target_run" },
      ]);
      expect(sql.exec("SELECT id FROM cf_agents_schedules ORDER BY id").toArray()).toEqual([
        { id: "task:route" }, { id: "task:timeout" }, { id: "task:wake" },
      ]);

      // A schedule aimed at a Ship's pid becomes a Ship responsibility, as new ones are stored.
      const stored = Object.fromEntries(sql.exec<{ schedule_id: string; target_json: string }>(
        "SELECT schedule_id, target_json FROM schedules",
      ).toArray().map(({ schedule_id, target_json }) => [schedule_id, JSON.parse(target_json)]));
      expect(stored).toEqual({
        ship: { kind: "responsibility", message: "Review the day.", data: { mailbox: "primary" } },
        bare: { kind: "responsibility", message: "Stretch." },
        worker: targets.worker,
      });

      // A /ship an older Kernel checkpointed starts afresh; every other receipt stays.
      expect(sql.exec("SELECT receipt_id, progress_json FROM adapter_ingress_receipts ORDER BY receipt_id").toArray()).toEqual([
        { receipt_id: "receipt:done", progress_json: workReturn },
        { receipt_id: "receipt:message", progress_json: replyPreference },
        { receipt_id: "receipt:ship", progress_json: null },
      ]);
    });
  });
});
