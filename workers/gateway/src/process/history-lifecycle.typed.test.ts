import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { procHistoryRecordSchema, type ProcHistoryRecordData } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { procMediaInputSchema } from "../kernel/do-shared";

describe("typed history lifecycle", () => {
  it("preserves accepted legacy media numbers and timestamps across reset and archive restore", async () => {
    const stub = await initProcess("typed-history-negative-media", ROOT_IDENTITY);
    const media = procMediaInputSchema.parse({
      type: "audio",
      mimeType: "audio/ogg",
      url: "https://example.test/negative-media.ogg",
      filename: "recording.ogg",
      size: -1.5,
      duration: -0.25,
      transcription: "A recording",
    });
    const content = "  Keep the original attachment metadata.  ";
    const createdAt = -100.25;
    const before = await runInProcess(stub, async (process: Process) => {
      const resolved = await process.resources.resolveIncomingMedia([media]);
      expect(resolved).toEqual([media]);
      for (const legacy of [true, false]) {
        process.store.messages.appendMessage("user", content, {
          legacy,
          media: JSON.stringify(resolved),
          createdAt,
        });
      }
      const records = process.store.messages.getRecords();
      expect(records.map((record) => record.payload)).toEqual([
        { direction: "in", text: content, media: [media], origin: {} },
        { direction: "in", text: content, media: [media], origin: {} },
      ]);
      for (const record of records) expect(procHistoryRecordSchema.parse(record)).toEqual(record);
      return records.map(({ kind, payload, source, createdAt }) => ({ kind, payload, source, createdAt }));
    });

    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      expect(process.store.messages.getRecords().map(({ kind, payload, source, createdAt }) => ({ kind, payload, source, createdAt })))
        .toEqual(before);
      const reset = await process.controller.handleProcReset();
      if (!reset.ok || !reset.archivedTo) throw new Error("Reset did not archive media history");
      const archived = await process.history.readArchivedMessageRecords(reset.archivedTo);
      expect(archived.map((message) => ({ content: message.content, media: message.media, createdAt: message.createdAt })))
        .toEqual([{ content, media: [media], createdAt }, { content, media: [media], createdAt }]);
      for (const message of archived) {
        process.history.appendRestoredArchivedMessage(message, process.store.state.getHistoryGeneration());
      }
      const restored = process.store.messages.getRecords();
      for (const record of restored) expect(procHistoryRecordSchema.parse(record)).toEqual(record);
      expect(restored.map(({ kind, payload, source, createdAt }) => ({ kind, payload, source, createdAt })))
        .toEqual(before);
      expect(process.store.messages.getMessages().map((message) => ({
        content: message.content,
        media: JSON.parse(message.media!),
      }))).toEqual([{ content, media: [media] }, { content, media: [media] }]);
    });
  });

  it("retains typed-only media and event data across eviction, fork archives, and reset", async () => {
    const pid = "typed-history-lifecycle-source";
    const source = await initProcess(pid, ROOT_IDENTITY);
    const sourceKey = `var/media/0/${pid}/typed-only.png`;
    const bytes = new Uint8Array([7, 8, 9]);
    await env.STORAGE.put(sourceKey, bytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { uid: "0", gid: "0", mode: "400", processId: pid },
    });

    const lastMessageId = await runInProcess(source, async (process: Process) => {
      vi.spyOn(process.run, "scheduleTick").mockResolvedValue(undefined);
      vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      vi.spyOn(process, "maybeStartTaskTitleGeneration").mockImplementation(() => {});
      await process.controller.handleProcScheduleDeliver({
        runId: "schedule-run",
        scheduleId: "schedule-1",
        message: "Keep the image from this scheduled inspection",
        data: { machine: "laptop" },
        firedAtMs: 1_000,
      });
      await process.controller.handleProcAbort();

      const messageId = process.store.messages.appendMessage("assistant", "Image ready", {
        runId: "schedule-run",
        records: [
          { kind: "note", payload: { text: "Image ready", thinking: [] } },
          {
            kind: "message",
            payload: {
              direction: "out",
              text: "Here is the image",
              origin: { kind: "run-control" },
              media: [{
                type: "image",
                mimeType: "image/png",
                filename: "typed-only.png",
                size: bytes.byteLength,
                key: sourceKey,
                path: `/${sourceKey}`,
              }],
            },
          },
        ],
      });
      expect(process.store.messages.getMessages().at(-1)?.media).toBeNull();
      expect(process.store.messages.referencesMediaKey(sourceKey)).toBe(true);
      await process.resources.deleteUnreferencedActiveMedia([sourceKey]);
      return messageId;
    });
    expect(await env.STORAGE.head(sourceKey)).not.toBeNull();
    await evictDurableObject(source);

    const exported = await runInProcess(source, async (process: Process) => {
      expect(process.store.messages.getRecords()).toMatchObject([
        {
          kind: "event",
          payload: {
            kind: "schedule.fired",
            payload: { scheduleId: "schedule-1", data: { machine: "laptop" } },
          },
        },
        { kind: "note" },
        { kind: "message", payload: { media: [{ key: sourceKey }] } },
      ]);
      return process.history.handleHistoryExport({ throughMessageId: lastMessageId });
    });
    if (!exported.ok) throw new Error(exported.error);

    const target = await initProcess("typed-history-lifecycle-fork", ROOT_IDENTITY);
    const imported = await runInProcess(target, (process: Process) => (
      process.history.handleHistoryImport({ archivePaths: exported.archivePaths })
    ));
    expect(imported).toMatchObject({ ok: true, restoredMessages: 2 });

    const beforeEviction = await runInProcess(target, (process: Process) => (
      process.store.messages.getRecords()
    ));
    const outgoing = beforeEviction.find((record) => record.kind === "message");
    if (outgoing?.kind !== "message") throw new Error("Fork lost the typed outgoing message");
    const media = outgoing.payload.media[0];
    if (!media || media.type === "resource" || !media.key) {
      throw new Error("Fork lost the typed media descriptor");
    }
    const retainedKey = media.key;
    expect(retainedKey).toMatch(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/);
    expect(media.path).toBe(`/${retainedKey}`);
    expect(retainedKey).not.toBe(sourceKey);

    await evictDurableObject(target);
    const afterEviction = await runInProcess(target, (process: Process) => (
      process.store.messages.getRecords()
    ));
    expect(afterEviction).toEqual(beforeEviction);

    const reset = await runInProcess(source, (process: Process) => (
      process.controller.handleProcReset()
    ));
    if (!reset.ok || !reset.archivedTo) throw new Error("Reset did not archive typed history");
    expect(await env.STORAGE.head(sourceKey)).toBeNull();
    const retained = await env.STORAGE.get(retainedKey);
    expect(retained && [...new Uint8Array(await retained.arrayBuffer())]).toEqual([...bytes]);

    const archived = await runInProcess(source, (process: Process) => (
      process.history.readArchivedMessageRecords(reset.archivedTo!)
    ));
    const archiveRecords: ProcHistoryRecordData[] = archived.flatMap((message) => message.records ?? []);
    expect(archiveRecords).toMatchObject([
      {
        kind: "event",
        payload: { kind: "schedule.fired", payload: { scheduleId: "schedule-1" } },
      },
      { kind: "note" },
      { kind: "message", payload: { media: [{ key: retainedKey, path: `/${retainedKey}` }] } },
    ]);
    await runInProcess(source, (process: Process) => {
      expect(process.store.messages.getRecords()).toEqual([]);
    });
    expect(await runInProcess(target, (process: Process) => process.store.messages.getRecords()))
      .toEqual(beforeEviction);
  });
});
