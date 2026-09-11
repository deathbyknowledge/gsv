import { afterEach, describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { deferred, ROOT_IDENTITY } from "../process/do-test-harness";
import * as utils from "../shared/utils";
import { ProcessRegistry } from "./processes";
import { IpcCallStore } from "./ipc-calls";
import { deliverProcessApprovalNotice } from "./process-approvals";
import type { Kernel } from "./do";

afterEach(() => vi.restoreAllMocks());

const notice = { pid: "child", runId: "child-run", requestId: "request" };
const approval: ProcHilRequest = {
  ...notice, callId: "nested-fetch", toolName: "net.fetch", syscall: "net.fetch",
  target: "gsv", args: { url: "https://example.com/private" }, createdAt: 20,
};

async function fixture(test: (context: Awaited<ReturnType<typeof build>>) => Promise<void>) {
  await runWithRealKernelSql(async (sql) => test(await build(sql)));
}

async function scheduledFixture(test: (context: Awaited<ReturnType<typeof build>>, kernel: Kernel, sql: SqlStorage) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel, state) => {
    vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: true });
    await test(await build(state.storage.sql), kernel, state.storage.sql);
  });
}

async function build(sql: SqlStorage) {
  const procs = new ProcessRegistry(sql);
  const ipcCalls = new IpcCallStore(sql);
  for (const [pid, parentPid] of [["ship", undefined], ["parent", "ship"], ["child", "parent"]] as const) {
    procs.spawn(pid, ROOT_IDENTITY, { ownerUid: 1000, parentPid, isPersonalController: pid === "ship" });
  }
  procs.updateRuntimeState("child", { state: "waiting_hil", activeRunId: "child-run" });
  for (const [sourcePid, targetPid] of [["ship", "parent"], ["parent", "child"]]) {
    ipcCalls.create({ callId: `${sourcePid}-call`, uid: 1000, sourcePid,
      sourceRunId: `${sourcePid}-run`, targetPid, targetRunId: `${targetPid}-run`, deadlineAt: Date.now() + 60000 });
  }
  const host = {
    installationId: "singleton", procs, ipcCalls,
    onboarding: { managedWorkGate: vi.fn(async () => ({ allowed: true as const })) },
    schedule: vi.fn(async () => ({ id: "retry", time: 1, callback: "onProcessApprovalNotice" as const, payload: notice })),
  };
  const send = vi.spyOn(utils, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => {
    if (frame.type !== "req") throw new Error("Expected a process request");
    return {
      type: "res", id: frame.id, ok: true,
      data: frame.call === "proc.event.deliver"
        ? { eventId: frame.args.eventId, runId: "notice-run", queued: false }
        : { ok: true, pid: "child", messages: [], messageCount: 0, pendingHil: approval },
    };
  });
  return { host, send, procs, ipcCalls };
}

describe("delegated approval notices", () => {
  it("reconstructs nested same-owner delegation from durable rows without routing child arguments", async () => {
    await fixture(async ({ host, send }) => {
      await deliverProcessApprovalNotice(host, notice);
      expect(send.mock.calls.map(([, pid]) => pid)).toEqual(["child", "parent", "ship"]);
      expect(send.mock.calls[0][2]).toMatchObject({ call: "proc.history", args: { includeMessages: false } });
      expect(send.mock.calls[1][2]).toMatchObject({ call: "proc.event.deliver", args: {
        eventId: "approval:request:parent-call",
        event: { kind: "process.approval", severity: "warn", audience: "model", payload: {
          ...notice, sourceRunId: "parent-run", syscall: "net.fetch", target: "gsv",
        } },
      } });
      expect(JSON.stringify(send.mock.calls.slice(1))).not.toContain("https://example.com/private");
      expect(send.mock.calls.every(([installation]) => installation === "singleton")).toBe(true);
    });
  });

  it.each(["cancelled", "foreign", "removed"])("stops ancestry at a %s delegation", async (change) => {
    await fixture(async ({ host, send, procs, ipcCalls }) => {
      if (change === "cancelled") ipcCalls.cancelBySourcePid({ uid: 1000, sourcePid: "parent" });
      else {
        procs.kill("parent");
        if (change === "foreign") procs.spawn("parent", ROOT_IDENTITY, { ownerUid: 2000 });
      }
      await deliverProcessApprovalNotice(host, notice);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("stops ancestry when an intermediate caller ignores the notice", async () => {
    await fixture(async ({ host, send, ipcCalls }) => {
      const implementation = send.getMockImplementation()!;
      send.mockImplementation(async (...args) => {
        const frame = args[2];
        if (args[1] === "parent" && frame.type === "req" && frame.call === "proc.event.deliver") {
          return { type: "res", id: frame.id, ok: true,
            data: { eventId: frame.args.eventId, runId: null, queued: false, ignored: true } };
        }
        return implementation(...args);
      });
      await deliverProcessApprovalNotice(host, notice);
      expect(ipcCalls.get("parent-call")?.status).toBe("pending");
      expect(send.mock.calls.map(([, pid]) => pid)).toEqual(["child", "parent"]);
    });
  });

  it.each([
    { name: "malformed", data: { eventId: "approval:request:parent-call", ignored: true } },
    { name: "mismatched", data: { eventId: "another-notice", runId: null, queued: false } },
  ])("rejects a $name acknowledgment before notifying the next ancestor", async ({ data }) => {
    await fixture(async ({ host, send }) => {
      const implementation = send.getMockImplementation()!;
      send.mockImplementation(async (...args) => args[1] === "parent"
        ? { type: "res", id: args[2].id, ok: true, data }
        : implementation(...args));
      await expect(deliverProcessApprovalNotice(host, notice)).rejects.toThrow("acknowledgment did not match");
      expect(send.mock.calls.map(([, pid]) => pid)).toEqual(["child", "parent"]);
    });
  });

  it.each(["cancelled", "completed", "replaced"])("stops ancestry when the delivered delegation is %s while awaiting acceptance", async (change) => {
    await fixture(async ({ host, send, ipcCalls }) => {
      const implementation = send.getMockImplementation()!;
      const started = deferred();
      const accepted = deferred();
      send.mockImplementation(async (...args) => {
        if (args[1] === "parent") {
          started.resolve();
          await accepted.promise;
        }
        return implementation(...args);
      });
      const delivery = deliverProcessApprovalNotice(host, notice);
      await started.promise;
      try {
        if (change === "completed") {
          ipcCalls.completeByRun({ uid: 1000, targetPid: "child", runId: "child-run", response: "finished" });
        } else {
          ipcCalls.cancelBySourceRun({ uid: 1000, sourcePid: "parent", sourceRunId: "parent-run" });
          if (change === "replaced") {
            ipcCalls.create({ callId: "replacement-call", uid: 1000, sourcePid: "parent",
              sourceRunId: "parent-run", targetPid: "child", targetRunId: "child-run", deadlineAt: Date.now() + 60000 });
          }
        }
      } finally {
        accepted.resolve();
      }
      await delivery;
      expect(ipcCalls.get("ship-call")?.status).toBe("pending");
      expect(send.mock.calls.map(([, pid]) => pid)).toEqual(["child", "parent"]);
    });
  });

  it("ignores a finished run before querying and a replaced request after querying", async () => {
    await fixture(async ({ host, send, procs }) => {
      procs.updateRuntimeState("child", { state: "idle", activeRunId: null });
      await deliverProcessApprovalNotice(host, notice);
      expect(send).not.toHaveBeenCalled();
      procs.updateRuntimeState("child", { state: "waiting_hil", activeRunId: "child-run" });
      await deliverProcessApprovalNotice(host, { ...notice, requestId: "previous-request" });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("retries failed delivery with the same deduplication identity", async () => {
    await fixture(async ({ host, send }) => {
      const implementation = send.getMockImplementation()!;
      let fail = true;
      send.mockImplementation(async (...args) => {
        if (args[1] === "ship" && fail) { fail = false; throw new Error("Temporarily unavailable"); }
        return implementation(...args);
      });
      await expect(deliverProcessApprovalNotice(host, notice)).rejects.toThrow("Temporarily unavailable");
      await deliverProcessApprovalNotice(host, notice);
      expect(send.mock.calls.filter(([, pid]) => pid === "parent").map(([, , frame]) => frame))
        .toEqual([expect.objectContaining({ args: expect.objectContaining({ eventId: "approval:request:parent-call" }) }),
          expect.objectContaining({ args: expect.objectContaining({ eventId: "approval:request:parent-call" }) })]);
    });
  });

  it.each(["child", "ship"])("retains a durable notice across repeated %s failures and removes it after acceptance", async (unavailablePid) => {
    await scheduledFixture(async ({ send }, kernel, sql) => {
      const implementation = send.getMockImplementation()!;
      send.mockImplementation(async (...args) => {
        if (args[1] === unavailablePid) throw new Error("Temporarily unavailable");
        return implementation(...args);
      });
      let task = await kernel.schedule(0, "onProcessApprovalNotice", notice, { idempotent: true });
      for (let attempt = 0; attempt < 4; attempt++) {
        sql.exec("UPDATE cf_agents_schedules SET time = ? WHERE id = ?", Math.floor(Date.now() / 1000), task.id);
        await kernel.alarm();
        const successors = sql.exec<{ id: string; time: number; payload: string }>(
          "SELECT id, time, payload FROM cf_agents_schedules WHERE callback = 'onProcessApprovalNotice'",
        ).toArray();
        expect(successors).toHaveLength(1);
        expect(successors[0].id).not.toBe(task.id);
        expect(successors[0].time).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(JSON.parse(successors[0].payload)).toEqual(notice);
        task = { ...task, id: successors[0].id };
      }
      send.mockImplementation(implementation);
      sql.exec("UPDATE cf_agents_schedules SET time = ? WHERE id = ?", Math.floor(Date.now() / 1000), task.id);
      await kernel.alarm();
      expect(sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onProcessApprovalNotice'").toArray()).toEqual([]);
      const eventIds = send.mock.calls.flatMap(([, pid, frame]) => pid === "parent" && frame.type === "req"
        && frame.call === "proc.event.deliver" ? [frame.args.eventId] : []);
      expect(new Set(eventIds)).toEqual(new Set(["approval:request:parent-call"]));
      expect(send.mock.calls.at(-1)?.[1]).toBe("ship");
    });
  });

  it.each(["completed", "cancelled", "ignored"])("retires a delayed notice when the request or delegation is %s", async (terminal) => {
    await scheduledFixture(async ({ send, procs, ipcCalls }, kernel, sql) => {
      const implementation = send.getMockImplementation()!;
      send.mockRejectedValue(new Error("Temporarily unavailable"));
      await kernel.schedule(0, "onProcessApprovalNotice", notice, { idempotent: true });
      await kernel.alarm();
      expect(sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onProcessApprovalNotice'").toArray()).toHaveLength(1);
      send.mockClear();
      send.mockImplementation(async (...args) => {
        const frame = args[2];
        if (terminal === "ignored" && args[1] === "parent" && frame.type === "req" && frame.call === "proc.event.deliver") {
          return { type: "res", id: frame.id, ok: true,
            data: { eventId: frame.args.eventId, runId: null, queued: false, ignored: true } };
        }
        return implementation(...args);
      });
      if (terminal === "completed") procs.updateRuntimeState("child", { state: "idle", activeRunId: null });
      if (terminal === "cancelled") ipcCalls.cancelBySourcePid({ uid: 1000, sourcePid: "parent" });
      sql.exec("UPDATE cf_agents_schedules SET time = ? WHERE callback = 'onProcessApprovalNotice'", Math.floor(Date.now() / 1000));
      await kernel.alarm();
      expect(sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onProcessApprovalNotice'").toArray()).toEqual([]);
      expect(send.mock.calls.map(([, pid]) => pid)).toEqual(terminal === "completed" ? [] : terminal === "cancelled" ? ["child"] : ["child", "parent"]);
    });
  });
});
