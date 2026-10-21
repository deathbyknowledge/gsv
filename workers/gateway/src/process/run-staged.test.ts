import { describe, expect, it } from "vitest";
import { bodyFromBytes, type ResourceBlock } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import type { InternalRequestFrame } from "../protocol/process-frames";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";

function staged(runId: string, requestId?: string): InternalRequestFrame<"proc.run.staged"> {
  return {
    type: "req", id: crypto.randomUUID(), call: "proc.run.staged",
    args: { runId, destination: "contact:friend", ...(requestId ? { requestId } : undefined) },
  };
}

function attach(runId: string, requestId: string, media: ResourceBlock[]): InternalRequestFrame<"proc.run.attach"> {
  return { type: "req", id: crypto.randomUUID(), call: "proc.run.attach", args: { runId, media, requestId } };
}

async function photo(stub: Awaited<ReturnType<typeof initProcess>>): Promise<ResourceBlock> {
  const uploaded = await stub.recvFrame({
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.resource.write",
    args: { resourceId: "photo", mediaType: "image", contentType: "image/jpeg", filename: "photo.jpg" },
    body: bodyFromBytes(new Uint8Array([1, 2, 3])),
  } satisfies InternalRequestFrame<"proc.resource.write">);
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  return uploaded.data.resource;
}

/** Registers one model turn's parallel tool calls as running. */
function running(process: Process, runId: string, ...dispatchIds: string[]): void {
  for (const dispatchId of dispatchIds) {
    process.store.tools.register(dispatchId, `call:${dispatchId}`, runId, "shell.exec", {});
    process.store.tools.markDispatched(dispatchId);
  }
}

describe("staged reply files", () => {
  it("counts the files waiting for the active run's next reply", async () => {
    const stub = await initProcess("run-staged-count", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      expect(await process.recvFrame(attach("run-photo", "call-attach", [resource]))).toMatchObject({ ok: true, data: { ok: true } });
      expect(await process.recvFrame(staged("run-photo", "call-send"))).toMatchObject({ ok: true, data: { ok: true, count: 1 } });
      // A stale run never sees another run's files.
      expect(await process.recvFrame(staged("run-other"))).toMatchObject({ ok: true, data: { ok: true, count: 0 } });
      process.run.consumeRunOutputMedia("run-photo", process.runs.active.outputMedia ?? []);
      expect(await process.recvFrame(staged("run-photo"))).toMatchObject({ ok: true, data: { ok: true, count: 0 } });
    });
  });

  it("refuses an attach that ran alongside a send elsewhere without files", async () => {
    const stub = await initProcess("run-staged-parallel", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-attach", "call-send");
      expect(await process.recvFrame(staged("run-photo", "call-send"))).toMatchObject({ ok: true, data: { ok: true, count: 0 } });
      const refused = await process.recvFrame(attach("run-photo", "call-attach", [resource]));
      expect(refused).toMatchObject({ ok: true, data: { ok: false } });
      expect(refused.ok && !refused.data.ok && refused.data.error).toContain(
        "a message went to contact:friend without files while this attach was running",
      );
      expect(process.runs.active?.outputMedia).toBeUndefined();
    });
  });

  it("lets a later tool call stage files for the owner after a send elsewhere", async () => {
    const stub = await initProcess("run-staged-later", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-send");
      await process.recvFrame(staged("run-photo", "call-send"));
      process.store.tools.resolve("call-send", "sent");
      running(process, "run-photo", "call-attach-later");
      expect(await process.recvFrame(attach("run-photo", "call-attach-later", [resource]))).toMatchObject({
        ok: true, data: { ok: true },
      });
      expect(process.runs.active?.outputMedia).toHaveLength(1);
    });
  });
});
