import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { deferred, ROOT_IDENTITY } from "../process/do-test-harness";
import * as utils from "../shared/utils";
import { ProcessRegistry } from "./processes";
import { IpcCallStore } from "./ipc-calls";
import { deliverProcessApprovalNotice } from "./process-approvals";

afterEach(() => vi.restoreAllMocks());

const notice = { pid: "child", runId: "child-run", requestId: "request" };
const approval: ProcHilRequest = {
  ...notice, callId: "nested-fetch", toolName: "net.fetch", syscall: "net.fetch",
  target: "gsv", args: { url: "https://example.com/private" }, createdAt: 20,
};

async function fixture(test: (context: Awaited<ReturnType<typeof build>>) => Promise<void>) {
  await runWithRealKernelSql(async (sql) => test(await build(sql)));
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
});
