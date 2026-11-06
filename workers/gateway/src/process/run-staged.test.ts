import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyFromBytes, type ResourceBlock } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import type { ProcessRunAttachArgs, ProcessRunStagedArgs } from "../protocol/process-frames";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import * as utils from "../shared/utils";

function staged(runId: string, requestId?: string): ProcessRunStagedArgs {
  return { runId, destination: "contact:friend", ...(requestId ? { requestId } : undefined) };
}

function attach(runId: string, requestId: string, media: ResourceBlock[]): ProcessRunAttachArgs {
  return { runId, media, requestId };
}

async function photo(stub: Awaited<ReturnType<typeof initProcess>>): Promise<ResourceBlock> {
  const uploaded = await stub.writeResource(
    { resourceId: "photo", mediaType: "image", contentType: "image/jpeg", filename: "photo.jpg" },
    bodyFromBytes(new Uint8Array([1, 2, 3])),
  );
  if ("unavailable" in uploaded) throw new Error(uploaded.message);
  return uploaded.resource;
}

/** Registers one model turn's parallel tool calls as running. */
function running(process: Process, runId: string, ...dispatchIds: string[]): void {
  for (const dispatchId of dispatchIds) {
    process.store.tools.register(dispatchId, `call:${dispatchId}`, runId, "shell.exec", {});
    process.store.tools.markDispatched(dispatchId);
  }
}

/** Registers shell calls a running CodeMode program has in flight under its owning tool call. */
function nested(process: Process, runId: string, ownerDispatchId: string, ...requestIds: string[]): void {
  for (const id of requestIds) {
    process.codeModeResponses.set(id, {
      runId, ownerDispatchId, call: "shell.exec", args: {},
      resolve: () => {}, reject: () => {}, deadline: { clear() {} },
    });
  }
}

describe("staged reply files", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("counts the files waiting for the active run's next reply", async () => {
    const stub = await initProcess("run-staged-count", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      expect(await process.attachRunMedia(attach("run-photo", "call-attach", [resource]))).toMatchObject({ ok: true });
      expect(await process.countStagedRunMedia(staged("run-photo", "call-send"))).toEqual({ ok: true, count: 1 });
      // A stale run never sees another run's files.
      expect(await process.countStagedRunMedia(staged("run-other"))).toEqual({ ok: true, count: 0 });
      process.run.consumeRunOutputMedia("run-photo", process.runs.active.outputMedia ?? []);
      expect(await process.countStagedRunMedia(staged("run-photo"))).toEqual({ ok: true, count: 0 });
    });
  });

  it("refuses an attach that ran alongside a send elsewhere without files", async () => {
    const stub = await initProcess("run-staged-parallel", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-attach", "call-send");
      expect(await process.countStagedRunMedia(staged("run-photo", "call-send"))).toEqual({ ok: true, count: 0 });
      const refused = await process.attachRunMedia(attach("run-photo", "call-attach", [resource]));
      expect(refused).toMatchObject({ ok: false });
      expect("error" in refused && refused.error).toContain(
        "a message went to contact:friend without files while this attach was running",
      );
      expect(process.runs.active?.outputMedia).toBeUndefined();
    });
  });

  it("refuses an attach that ran alongside a send elsewhere in the same CodeMode program", async () => {
    const stub = await initProcess("run-staged-codemode", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-codemode");
      nested(process, "run-photo", "call-codemode", "codemode-attach", "codemode-send");
      expect(await process.countStagedRunMedia(staged("run-photo", "codemode-send"))).toEqual({ ok: true, count: 0 });
      const refused = await process.attachRunMedia(attach("run-photo", "codemode-attach", [resource]));
      expect(refused).toMatchObject({ ok: false });
      expect(process.runs.active?.outputMedia).toBeUndefined();
    });
  });

  it("refuses an attach from one CodeMode program while another sends elsewhere", async () => {
    const stub = await initProcess("run-staged-codemode-pair", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-codemode-a", "call-codemode-b");
      nested(process, "run-photo", "call-codemode-a", "codemode-attach");
      nested(process, "run-photo", "call-codemode-b", "codemode-send");
      await process.countStagedRunMedia(staged("run-photo", "codemode-send"));
      expect(await process.attachRunMedia(attach("run-photo", "codemode-attach", [resource]))).toMatchObject({ ok: false });
    });
  });

  it("reports a CodeMode attach that staged first to the send that follows", async () => {
    const stub = await initProcess("run-staged-codemode-first", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-codemode");
      nested(process, "run-photo", "call-codemode", "codemode-attach", "codemode-send");
      expect(await process.attachRunMedia(attach("run-photo", "codemode-attach", [resource]))).toMatchObject({ ok: true });
      expect(await process.countStagedRunMedia(staged("run-photo", "codemode-send"))).toEqual({ ok: true, count: 1 });
    });
  });

  it("removes the archived copy of a file whose attach the fence refused", async () => {
    const bytes = new TextEncoder().encode("holiday photo");
    const source: ResourceBlock = {
      type: "resource",
      ref: { type: "file", target: "gsv", path: "/root/photo.jpg", revision: "rev-photo", contentType: "image/jpeg", size: bytes.length },
      mediaType: "image",
      filename: "photo.jpg",
    };
    vi.spyOn(utils, "sendFrameToKernel").mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.call !== "fs.transfer.send") throw new Error(`unexpected ${frame.call}`);
      return {
        type: "res", id: frame.id, ok: true,
        data: { ok: true, path: source.ref.path, size: bytes.length, revision: source.ref.revision, contentType: source.ref.contentType },
        body: { length: bytes.length, stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) },
      };
    });
    const stub = await initProcess("run-staged-cleanup", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-attach", "call-send");
      await process.countStagedRunMedia(staged("run-photo", "call-send"));
      const key = await process.resources.resourceRetentionKey(source);
      expect(key).toBeTruthy();
      const refused = await process.attachRunMedia(attach("run-photo", "call-attach", [source]));
      expect(refused).toMatchObject({ ok: false });
      expect(await process.storage.head(key!)).toBeNull();
    });
  });

  it("lets a later tool call stage files for the owner after a send elsewhere", async () => {
    const stub = await initProcess("run-staged-later", ROOT_IDENTITY);
    const resource = await photo(stub);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "run-photo" };
      running(process, "run-photo", "call-send");
      await process.countStagedRunMedia(staged("run-photo", "call-send"));
      process.store.tools.resolve("call-send", "sent");
      running(process, "run-photo", "call-attach-later");
      expect(await process.attachRunMedia(attach("run-photo", "call-attach-later", [resource]))).toMatchObject({ ok: true });
      expect(process.runs.active?.outputMedia).toHaveLength(1);
    });
  });
});
