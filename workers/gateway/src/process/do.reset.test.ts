import { describe, expect, it, vi } from "vitest";
import {
  mockGeneration, processTestConfig, generationRun, assistantResponse, deferred, okProcessResponse,
  runInProcess, ROOT_IDENTITY, initProcess, makeReq, testUsage,
} from "./do-test-harness";

describe("proc.reset", () => {
  it("clears active run state and queued messages", async () => {
    const pid = "mech-reset-runtime";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const runId = "run-reset-runtime";

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.state.setValue("currentRun", JSON.stringify({ runId }));
      store.tools.register("dispatch-reset-1", "call-reset-1", runId, "fs.read", {
        path: "/tmp/test.txt",
      });
      store.queue.enqueue(runId, "queued after reset");
      store.messages.appendMessage("user", "hello before reset");
    });

    const resetRes = await okProcessResponse(stub, makeReq("proc.reset", {}));
    expect(resetRes.ok).toBe(true);

    await runInProcess(stub, (process) => {
      const store = process.store;
      expect(store.state.getValue("currentRun")).toBeNull();
      expect(store.queue.queueSize()).toBe(0);
      expect(store.tools.getResults(runId)).toHaveLength(0);
    });

    const sendRes = await okProcessResponse(
      stub,
      makeReq("proc.send", { message: "first after reset" }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const sendData = sendRes.data as { queued?: boolean };
    expect(sendData.queued).toBeUndefined();
  });

  it("fences an in-flight generation before archiving reset history", async () => {
    const pid = "mech-reset-fences-generation";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: generationBlocked, resolve: releaseGeneration } = deferred();
      const { promise: generationStarted, resolve: markGenerationStarted } = deferred();
      const { promise: archiveBlocked, resolve: releaseArchive } = deferred();
      const { promise: archiveStarted, resolve: markArchiveStarted } = deferred();
      process.sendSignal = vi.fn();
      mockGeneration(process, async () => {
        markGenerationStarted();
        await generationBlocked;
        return assistantResponse([{ type: "text", text: "late reset response" }], {
          usage: testUsage()
        });
      }, async () => {
        return "";
      });
      process.history.archiveHistoryMessages = vi.fn(async () => {
        markArchiveStarted();
        await archiveBlocked;
        return { archivedMessages: 1, archivedTo: "/archive/", archives: [] };
      });
      process.store.messages.appendMessage("user", "reset while generating", {
        runId: "run-reset-fence",
      });
      process.runs.active = generationRun("run-reset-fence", processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        mcpServers: []
      });

      const ticking = process.run.runTick("run-reset-fence");
      await generationStarted;
      const resetting = process.controller.handleProcReset();
      await archiveStarted;
      expect(process.runs.active).toBeNull();

      releaseGeneration();
      await ticking;
      expect(
        process.store.messages
          .getMessages()
          .some((message: any) => message.content === "late reset response"),
      ).toBe(false);

      releaseArchive();
      await resetting;
      expect(process.store.messages.getMessages()).toEqual([]);
    });
  });
});
