import { describe, expect, it } from "vitest";
import type { Process } from "./do";
import type { InternalRequestFrame } from "../protocol/process-frames";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";

function staged(runId: string): InternalRequestFrame<"proc.run.staged"> {
  return { type: "req", id: crypto.randomUUID(), call: "proc.run.staged", args: { runId } };
}

describe("staged reply files", () => {
  it("counts the files waiting for the active run's next reply", async () => {
    const stub = await initProcess("run-staged-count", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = {
        runId: "run-photo",
        outputMedia: [{
          type: "image", mimeType: "image/jpeg", filename: "photo.jpg", size: 3,
          key: "root/.gsv/media/archived-media:photo", path: "/root/.gsv/media/archived-media:photo",
        }],
      };
      expect(await process.recvFrame(staged("run-photo"))).toMatchObject({ ok: true, data: { ok: true, count: 1 } });
      // A stale run never sees another run's files.
      expect(await process.recvFrame(staged("run-other"))).toMatchObject({ ok: true, data: { ok: true, count: 0 } });
      process.run.consumeRunOutputMedia("run-photo", process.runs.active.outputMedia ?? []);
      expect(await process.recvFrame(staged("run-photo"))).toMatchObject({ ok: true, data: { ok: true, count: 0 } });
    });
  });
});
