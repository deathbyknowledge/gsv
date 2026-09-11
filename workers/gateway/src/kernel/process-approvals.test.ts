import { expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as utils from "../shared/utils";
import { ROOT_IDENTITY } from "../process/do-test-harness";
import type { Kernel } from "./do";

it("retires persisted approval notices without reading a child or waking a parent", async () => {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel, state) => {
    kernel.procs.spawn("parent", ROOT_IDENTITY, { ownerUid: 1000 });
    kernel.procs.spawn("child", ROOT_IDENTITY, { ownerUid: 1000, parentPid: "parent" });
    kernel.procs.updateRuntimeState("child", { state: "waiting_hil", activeRunId: "child-run" });
    kernel.ipcCalls.create({ callId: "delegation", uid: 1000, sourcePid: "parent", sourceRunId: "parent-run",
      targetPid: "child", targetRunId: "child-run", deadlineAt: Date.now() + 60_000 });
    const gate = vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: true });
    const send = vi.spyOn(utils, "sendFrameToProcess").mockRejectedValue(new Error("No model notice should be sent"));
    try {
      const task = await kernel.schedule(0, "onProcessApprovalNotice", {
        pid: "child", runId: "child-run", requestId: "request",
      });
      await kernel.alarm();
      expect(send).not.toHaveBeenCalled();
      expect(state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE id = ?", task.id).toArray()).toEqual([]);
    } finally { send.mockRestore(); gate.mockRestore(); }
  });
});
