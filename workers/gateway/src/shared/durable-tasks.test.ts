import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { DurableTaskScheduler } from "./durable-tasks";

describe("durable task successors", () => {
  it("commits a task atomically with its owner's state and arms it after reconstruction", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const create = () => new DurableTaskScheduler(storage, (callback, payloadJson) => ({ callback, payload: z.string().parse(JSON.parse(payloadJson)) }), async () => {});
      const tasks = create();
      const insert = () => sql.exec("INSERT INTO browser_handoff_links (owner_uid, instance_id, request_id, responsibility_id) VALUES (1000, 'browser', 'login', 'work')");
      const enqueue = () => tasks.enqueue(new Date(Date.now() + 10000), { callback: "atomic-fixture", payload: "login" });
      expect(() => storage.transactionSync(() => { insert(); enqueue(); throw new Error("Interrupted commit"); })).toThrow("Interrupted commit");
      expect(sql.exec("SELECT * FROM browser_handoff_links").toArray()).toHaveLength(0);
      expect(sql.exec("SELECT * FROM cf_agents_schedules WHERE callback = 'atomic-fixture'").toArray()).toHaveLength(0);
      const pending = storage.transactionSync(() => { insert(); return enqueue(); });
      try {
        await create().arm();
        expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
        expect(sql.exec("SELECT * FROM browser_handoff_links").toArray()).toHaveLength(1);
        expect(sql.exec("SELECT * FROM cf_agents_schedules WHERE callback = 'atomic-fixture'").toArray()).toHaveLength(1);
      } finally {
        sql.exec("DELETE FROM browser_handoff_links");
        await tasks.cancel(pending.id);
      }
    });
  });

  it("persists the successor before touching the running row and deduplicates an interrupted replay", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const create = () => new DurableTaskScheduler(storage, (callback, payloadJson) => ({ callback, payload: z.string().parse(JSON.parse(payloadJson)) }), async () => {});
      const tasks = create();
      const spec = { callback: "outbound-successor-fixture", payload: "immutable-outbound-id" };
      const current = await tasks.schedule(new Date(Date.now() + 3_600_000), spec);
      const currentAlarm = await storage.getAlarm();
      const alarm = vi.spyOn(storage, "setAlarm").mockRejectedValueOnce(new Error("Alarm update interrupted"));
      try {
        await expect(tasks.schedule(new Date(Date.now() + 7_200_000), spec, { idempotent: true, excludeTaskId: current.id })).rejects.toThrow("Alarm update interrupted");
        const saved = sql.exec<{ id: string }>("SELECT id FROM cf_agents_schedules WHERE callback = ?", spec.callback).toArray();
        expect(saved).toHaveLength(2);
        expect(saved).toContainEqual({ id: current.id });
        expect(await storage.getAlarm()).toBe(currentAlarm);
        const replayed = await create().schedule(new Date(Date.now() + 10_800_000), spec, { idempotent: true, excludeTaskId: current.id });
        expect(saved).toContainEqual({ id: replayed.id });
        expect(replayed.id).not.toBe(current.id);
        expect(sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = ?", spec.callback).toArray()).toHaveLength(2);
        await tasks.cancel(current.id);
        expect(sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = ?", spec.callback).toArray()).toEqual([{ id: replayed.id }]);
      } finally { alarm.mockRestore(); }
    });
  });
});
