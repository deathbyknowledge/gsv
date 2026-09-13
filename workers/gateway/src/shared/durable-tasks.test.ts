import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { DurableTaskScheduler } from "./durable-tasks";

describe("durable task successors", () => {
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
