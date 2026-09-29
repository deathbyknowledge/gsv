import { describe, expect, it } from "vitest";
import {
  okProcessResponse, runInProcess, ROOT_IDENTITY, drainProcessQueue, initProcess, makeReq,
} from "./do-test-harness";

describe("proc.ipc.*", () => {
  it("queues delivered IPC when the target process is already running", async () => {
    const pid = "mech-ipc-queued";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      process.run.scheduleTick = async () => {};
      process.runs.active = {
        runId: "active-run",
      };
    });

    const response = await okProcessResponse(
      stub,
      makeReq("proc.ipc.deliver", {
        runId: "queued-ipc-run",
        sourcePid: "source-process",
        source: ROOT_IDENTITY,
        message: "Queued IPC work.",
        metadata: { priority: "normal" },
        sentAt: 1_700_000_000_000,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      ok: true,
      status: "started",
      pid,
      sourcePid: "source-process",
      runId: "queued-ipc-run",
      queued: true,
    });

    await runInProcess(stub, (process) => {
      const store = process.store;
      expect(store.messages.messageCount()).toBe(0);
      expect(store.queue.queueSize()).toBe(1);
      const queued = drainProcessQueue(store);
      expect(queued[0].message).toContain("Queued IPC work.");
      expect(queued[0].message).toContain('"priority": "normal"');
      process.runs.active = null;
    });
  });
});
