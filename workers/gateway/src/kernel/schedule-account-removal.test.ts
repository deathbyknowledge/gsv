import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ScheduleRecord, ScheduleTarget } from "@humansandmachines/gsv/protocol";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { testPeer } from "../test-support/peers";
import { principalOf, type KernelContext } from "./context";
import type { Kernel } from "./do";

async function fixture(work: (kernel: Kernel, root: KernelContext) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    const password = await hashPassword("schedule-fixture-password");
    kernel.auth.setShadow(makeShadowEntry("root", password));
    for (const [uid, username] of [[1000, "removed"], [1001, "survivor"], [2000, "agent"]] as const) {
      kernel.auth.addUser({ username, uid, gid: uid, gecos: username, home: `/home/${username}`, shell: "/bin/init" });
      kernel.auth.addGroup({ name: username, gid: uid, members: [] });
      if (uid < 2000) kernel.auth.setShadow(makeShadowEntry(username, password));
      kernel.caps.grant(uid, "shell.exec");
      kernel.caps.grant(uid, "proc.spawn");
    }
    const root = kernel.buildKernelContext({
      peer: testPeer({ account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" }, calls: ["*"] }),
    });
    await work(kernel, root);
  });
}

function dueSchedule(kernel: Kernel, ownerUid: number, runAsUid: number, target: ScheduleTarget = { kind: "command.exec", command: "printf scheduled" }): ScheduleRecord {
  const account = kernel.auth.getPasswdByUid(runAsUid)!;
  const principal = { kind: "user" as const, uid: account.uid, username: account.username };
  const record = kernel.schedules.create({
    ownerUid, creator: principal, runAs: principal, name: "removal admission",
    enabled: true, expression: { kind: "every", everyMs: 60_000 }, target, now: Date.now(),
  });
  kernel.ctx.storage.sql.exec("UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?", Date.now() - 1, record.id);
  return kernel.schedules.get(record.id)!;
}

function expectStopped(kernel: Kernel, id: string, runs = 0) {
  expect(kernel.schedules.getStored(id)).toMatchObject({
    enabled: false, wakeScheduleId: null,
    state: { runCount: runs, runningAtMs: null, nextRunAtMs: null },
  });
  expect(kernel.schedules.history(id)).toHaveLength(runs);
}

describe("scheduled admission after account removal", () => {
  it.each(["owner", "run-as"] as const)("blocks command and spawn schedules with a removed %s, including root force", async (removed) => {
    await fixture(async (kernel, root) => {
      const ownerUid = removed === "owner" ? 1000 : 1001;
      const runAsUid = removed === "owner" ? 2000 : 1000;
      const command = dueSchedule(kernel, ownerUid, runAsUid);
      const spawn = dueSchedule(kernel, ownerUid, runAsUid, { kind: "process.spawn", prompt: "Must not be admitted" });
      const control = dueSchedule(kernel, 1001, 1001);
      const dispatch = vi.spyOn(kernel.scheduleRuntime, "dispatchScheduleTarget");
      await kernel.people.remove(1000, root);

      for (const record of [command, spawn]) {
        await kernel.scheduleRuntime.onScheduleDue(record.id);
        expect(await kernel.scheduleRuntime.runSchedules({ id: record.id, mode: "force" }, principalOf(root)!)).toMatchObject({
          ran: 0, results: [{ status: "skipped", error: "schedule account is disabled" }],
        });
        expectStopped(kernel, record.id);
      }
      expect(dispatch).not.toHaveBeenCalled();
      await kernel.scheduleRuntime.onScheduleDue(control.id);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(kernel.schedules.history(control.id)[0]).toMatchObject({ status: "ok", result: { stdout: "scheduled", exitCode: 0 } });
      expect(kernel.schedules.get(control.id)).toMatchObject({ enabled: true, state: { runCount: 1 } });
      dispatch.mockRestore();
    });
  });

  it.each(["allowed wake", "restricted wake", "root force"] as const)("rechecks removal while awaiting %s admission", async (mode) => {
    await fixture(async (kernel, root) => {
      const record = dueSchedule(kernel, 1000, 2000);
      const gate = Promise.withResolvers<Awaited<ReturnType<typeof kernel.onboarding.managedWorkGate>>>();
      const admission = vi.spyOn(kernel.onboarding, "managedWorkGate").mockImplementationOnce(() => gate.promise);
      const dispatch = vi.spyOn(kernel.scheduleRuntime, "dispatchScheduleTarget");
      const pending = mode === "root force"
        ? kernel.scheduleRuntime.runSchedules({ id: record.id, mode: "force" }, principalOf(root)!)
        : kernel.scheduleRuntime.onScheduleDue(record.id);
      expect(admission).toHaveBeenCalledTimes(1);
      await kernel.people.remove(1000, root);
      gate.resolve(mode === "restricted wake"
        ? { allowed: false, code: 423, message: "Installation is restricted" }
        : { allowed: true });
      await pending;

      expect(dispatch).not.toHaveBeenCalled();
      expectStopped(kernel, record.id);
      expect(kernel.ctx.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onScheduleDue'").toArray()).toEqual([]);
      admission.mockRestore();
      dispatch.mockRestore();
    });
  });

  it("finishes an admitted command while blocking its recurrence and later records from the removed owner", async () => {
    await fixture(async (kernel, root) => {
      const first = dueSchedule(kernel, 1000, 1000);
      const blocked = dueSchedule(kernel, 1000, 2000);
      const control = dueSchedule(kernel, 1001, 1001);
      // Preserve an explicit due order across the awaited first dispatch.
      for (const [offset, record] of [first, blocked, control].entries()) {
        kernel.ctx.storage.sql.exec("UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?", Date.now() - 100 + offset, record.id);
      }
      const completed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = kernel.scheduleRuntime.dispatchScheduleTarget.bind(kernel.scheduleRuntime);
      const dispatch = vi.spyOn(kernel.scheduleRuntime, "dispatchScheduleTarget").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[0].id === first.id) {
          completed.resolve();
          await release.promise;
        }
        return result;
      });
      const pending = kernel.scheduleRuntime.runSchedules({ mode: "due" }, principalOf(root)!);
      await completed.promise;
      await kernel.people.remove(1000, root);
      release.resolve();
      const result = await pending;

      expect(result).toMatchObject({ ran: 2, results: [
        { scheduleId: first.id, status: "ok", nextRunAtMs: null },
        { scheduleId: blocked.id, status: "skipped" },
        { scheduleId: control.id, status: "ok" },
      ] });
      expectStopped(kernel, first.id, 1);
      expectStopped(kernel, blocked.id);
      expect(kernel.schedules.history(first.id)[0]).toMatchObject({ status: "ok", result: { stdout: "scheduled" } });
      expect(kernel.schedules.get(control.id)).toMatchObject({ enabled: true, state: { runCount: 1 } });
      expect(dispatch).toHaveBeenCalledTimes(2);
      dispatch.mockRestore();
    });
  });
});
