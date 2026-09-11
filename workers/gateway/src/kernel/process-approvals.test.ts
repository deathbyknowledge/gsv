import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ROOT_IDENTITY } from "../process/do-test-harness";
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
  const send = vi.spyOn(utils, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => ({
    type: "res", id: frame.id, ok: true,
    data: frame.type === "req" && frame.call === "proc.history"
      ? { ok: true, pid: "child", messages: [], messageCount: 0, pendingHil: approval }
      : { eventId: "notice", runId: "notice-run", queued: false },
  }));
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
