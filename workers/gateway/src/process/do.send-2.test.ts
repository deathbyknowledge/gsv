import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import type { InternalRequestFrame } from "../protocol/protocol/process-frames";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deferred, runInProcess, ROOT_IDENTITY, initProcess } from "./do-test-harness";

describe("proc.send", () => {
  it("retains resources above the model hydration budget", async () => {
    const pid = "mech-resource-retain-large-reference";
    const retainedSize = 26 * 1024 * 1024;
    const sourceRevision = "revision:large-reference";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process, _state, instance) => {
      const realHead = process.storage.head.bind(process.storage);
      const head = vi.spyOn(process.storage, "head").mockImplementation(async (key: string) => {
        if (!key.startsWith("root/.gsv/media/archived-media:")) {
          return await realHead(key);
        }
        // SAFETY: the fixture supplies the complete R2Object metadata surface used by Process.
        return {
          key,
          version: "version:large-reference",
          size: retainedSize,
          etag: "etag:large-reference",
          httpEtag: "etag:large-reference",
          uploaded: new Date(0),
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: {
            uid: "0",
            gid: "0",
            mode: "400",
            purpose: "resource",
            sourceEtag: sourceRevision,
            sourceContentType: "application/octet-stream",
          },
          range: undefined,
          checksums: {},
          writeHttpMetadata() {},
        } as R2Object;
      });
      const request: InternalRequestFrame<"proc.resources.retain"> = {
        type: "req",
        id: "retain-large-reference",
        call: "proc.resources.retain",
        args: {
          batchId: "delivery:large-reference",
          resources: [
            {
              type: "resource",
              ref: {
                type: "file",
                target: "machine:camera",
                path: "/captures/large.raw",
                revision: sourceRevision,
                contentType: "application/octet-stream",
                size: retainedSize,
              },
            },
          ],
        },
      };

      try {
        await expect(instance.recvFrame(request)).resolves.toMatchObject({
          type: "res",
          id: request.id,
          ok: true,
          data: { resources: [{ ref: { size: retainedSize } }] },
        });
      } finally {
        head.mockRestore();
      }
    });
  });

  it("retains fs.read resources without storing transport base64", async () => {
    const pid = "mech-tool-result-resource";
    const runId = "run-tool-result-resource";
    const dispatchId = "dispatch-tool-result-resource";
    const sourcePath = "/root/tool-result-resource.png";
    const sourceKey = sourcePath.slice(1);
    const bytes = new Uint8Array([7, 8, 9]);
    await env.STORAGE.put(sourceKey, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    const source = await env.STORAGE.head(sourceKey);
    if (!source) throw new Error("fixture source was not stored");
    const stub = await initProcess(pid, ROOT_IDENTITY);
    let retainedKey = "";

    try {
      await runInProcess(stub, async (process) => {
        process.runs.active = { runId };
        process.sendSignal = vi.fn(async () => {});
        process.store.tools.register(dispatchId, "call-tool-result-resource", runId, "fs.read", {
          path: sourcePath,
        });
        process.store.tools.register(
          "dispatch-tool-result-resource-blocker",
          "call-tool-result-resource-blocker",
          runId,
          "fs.read",
          { path: "/tmp/blocker" },
        );

        const resource = {
          type: "file" as const,
          target: "gsv",
          path: sourcePath,
          revision: source.httpEtag,
          contentType: "image/png",
          size: bytes.byteLength,
        };
        await expect(
          process.tools.resolveStartedTool(runId, dispatchId, {
            ok: true,
            path: sourcePath,
            kind: "image",
            contentType: "image/png",
            size: bytes.byteLength,
            resource,
            content: [
              { type: "text", text: "Read image" },
              { type: "resource", ref: resource },
            ],
          }),
        ).resolves.toBe(true);

        const resolved = process.store.tools.getResults(runId)[0];
        expect(JSON.stringify(resolved.result)).not.toContain("BwgJ");
        expect(resolved.result).toMatchObject({
          __gsvStoredToolResult: 1,
          output: {
            resource: {
              type: "file",
              target: "gsv",
              path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
              revision: expect.any(String),
            },
            content: [
              { type: "text" },
              {
                type: "resource",
                ref: {
                  target: "gsv",
                  path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
                },
              },
            ],
          },
        });
        retainedKey = resolved.result.media[0].key;
        const retained = await env.STORAGE.get(retainedKey);
        expect(retained && [...new Uint8Array(await retained.arrayBuffer())]).toEqual([7, 8, 9]);
        expect(retained?.customMetadata).toMatchObject({
          uid: "0",
          gid: "0",
          mode: "400",
          purpose: "resource",
          sourceEtag: source.httpEtag,
          sourceContentType: "image/png",
        });

        await process.tools.ingestToolResults(runId, process.store.tools.getResults(runId), {
          interruptPending: "test completed",
        });
        const history = await process.controller.handleProcHistory({});
        expect(
          history.messages.find((message: any) => message.role === "toolResult"),
        ).toMatchObject({
          content: {
            resources: [
              {
                type: "resource",
                ref: {
                  type: "file",
                  target: "gsv",
                  path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
                  revision: expect.any(String),
                  contentType: "image/png",
                  size: bytes.byteLength,
                },
              },
            ],
          },
        });
        const messages = await process.history.buildContextMessages();
        const result = messages.find(
          (message: any) =>
            message.role === "toolResult" && message.toolCallId === "call-tool-result-resource",
        );
        expect(
          result.content.some((block: any) => block.type === "image" && block.data === "BwgJ"),
        ).toBe(true);
      });
    } finally {
      await env.STORAGE.delete(sourceKey);
      if (retainedKey) await env.STORAGE.delete(retainedKey);
    }
  });

  it("reconciles repeated process media writes and drains the repeated body", async () => {
    const pid = "mech-media-write-idempotent";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const args = {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      type: "image" as const,
      mimeType: "image/png",
      filename: "provider-image.png",
      mediaId: "provider-message-1:image-1",
    };

    const first = await runInProcess(stub, (process) =>
      process.resources.storeIncomingResource(args, bodyFromBytes(new Uint8Array([1, 2, 3]))),
    );
    expect(first).toMatchObject({
      ok: true,
      media: {
        type: "image",
        mimeType: "image/png",
        filename: "provider-image.png",
        size: 3,
        key: `var/media/0/${pid}/${args.mediaId}`,
        path: `/var/media/0/${pid}/${args.mediaId}`,
      },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const originalMedia = (first as any).media;

    let repeatedBodyPulled = false;
    const repeatedBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          repeatedBodyPulled = true;
          controller.enqueue(new Uint8Array([9, 9, 9]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const repeated = await runInProcess(stub, (process) =>
      process.resources.storeIncomingResource(args, {
        stream: repeatedBody,
        length: 3,
      }),
    );

    expect(repeatedBodyPulled).toBe(true);
    expect(repeated).toEqual({ ok: true, media: originalMedia });

    const mimeConflict = await runInProcess(stub, (process) =>
      process.resources.storeIncomingResource(
        { ...args, mimeType: "image/jpeg" },
        bodyFromBytes(new Uint8Array([4, 5, 6])),
      ),
    );
    expect(mimeConflict).toEqual({
      ok: false,
      error: "Resource id conflicts with existing media",
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    for (const conflictingArgs of [
      // SAFETY: test fixture is constructed with the asserted domain shape.
      { ...args, type: "document" as const },
      // SAFETY: test fixture is constructed with the asserted domain shape.
      { ...args, filename: "different-provider-image.png" },
      { ...args, duration: 12 },
      { ...args, transcription: "different transcript" },
    ]) {
      const conflict = await runInProcess(stub, (process) =>
        process.resources.storeIncomingResource(
          conflictingArgs,
          bodyFromBytes(new Uint8Array([4, 5, 6])),
        ),
      );
      expect(conflict).toEqual({
        ok: false,
        error: "Resource id conflicts with existing media",
      });
    }

    const stored = await env.STORAGE.get(originalMedia.key);
    expect(stored).not.toBeNull();
    expect([...new Uint8Array(await new Response(stored!.body).arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
  });

  it("serializes concurrent repeated media writes into one storage put", async () => {
    const pid = "mech-media-write-concurrent-idempotent";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const result = await runInProcess(stub, async (process) => {
      const originalStorage = process.storage;
      const objects = new Map<
        string,
        {
          bytes: Uint8Array;
          httpMetadata?: { contentType?: string };
          customMetadata?: Record<string, string>;
        }
      >();
      const { promise: putBlocked, resolve: releasePut } = deferred();
      const { promise: putStarted, resolve: markPutStarted } = deferred();
      const put = vi.fn(
        async (
          key: string,
          stream: ReadableStream<Uint8Array>,
          options?: {
            httpMetadata?: { contentType?: string };
            customMetadata?: Record<string, string>;
          },
        ) => {
          markPutStarted();
          await putBlocked;
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          objects.set(key, {
            bytes,
            httpMetadata: options?.httpMetadata,
            customMetadata: options?.customMetadata,
          });
          return { key, size: bytes.byteLength };
        },
      );
      process.storage = {
        head: vi.fn(async (key: string) => {
          const object = objects.get(key);
          return object
            ? {
                key,
                size: object.bytes.byteLength,
                httpMetadata: object.httpMetadata,
                customMetadata: object.customMetadata,
              }
            : null;
        }),
        put,
        delete: vi.fn(async (key: string) => {
          objects.delete(key);
        }),
      };

      // SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        const args = {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          type: "image" as const,
          mimeType: "image/png",
          filename: "concurrent.png",
          mediaId: "provider-message-2:image-1",
        };
        const first = process.resources.storeIncomingResource(
          args,
          bodyFromBytes(new Uint8Array([1, 2, 3])),
        );
        await putStarted;
        const repeated = process.resources.storeIncomingResource(
          args,
          bodyFromBytes(new Uint8Array([9, 9, 9])),
        );
        releasePut();
        const [firstResult, repeatedResult] = await Promise.all([first, repeated]);
        const stored = [...objects.values()][0];
        return {
          firstResult,
          repeatedResult,
          putCalls: put.mock.calls.length,
          storedBytes: stored ? [...stored.bytes] : [],
        };
      } finally {
        process.storage = originalStorage;
        releasePut();
      }
    });

    expect(result.putCalls).toBe(1);
    expect(result.repeatedResult).toEqual(result.firstResult);
    expect(result.storedBytes).toEqual([1, 2, 3]);
  });

  it("keeps SVG attachments out of raster model image blocks", async () => {
    const stub = await initProcess("mech-svg-context", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const originalStorage = process.storage;
      const get = vi.fn();
      process.store.messages.appendMessage("user", "Review this diagram.", {
        media: JSON.stringify([
          {
            type: "image",
            mimeType: "image/svg+xml",
            key: "var/media/0/mech-svg-context/diagram.svg",
            filename: "diagram.svg",
          },
        ]),
      });
      process.storage = { get };

      try {
        const messages = await process.history.buildContextMessages("default");
        expect(get).not.toHaveBeenCalled();
        expect(messages[0].content).toEqual([
          { type: "text", text: "Review this diagram." },
          {
            type: "text",
            text: 'Attached image "diagram.svg" [image/svg+xml]\nPath: /var/media/0/mech-svg-context/diagram.svg',
          },
        ]);
      } finally {
        process.storage = originalStorage;
      }
    });
  });

  it("only deletes process-scoped media after preparation fails", async () => {
    const pid = "mech-media-preparation-cleanup";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const ownKey = `var/media/0/${pid}/${crypto.randomUUID()}`;
    const foreignKey = `var/media/0/another-process/${crypto.randomUUID()}`;
    await env.STORAGE.put(ownKey, new Uint8Array([1]));
    await env.STORAGE.put(foreignKey, new Uint8Array([2]));

    try {
      await runInProcess(stub, async (process) => {
        const runId = "run-media-cleanup";
        const media = [
          { type: "document", mimeType: "application/octet-stream", key: ownKey },
          { type: "document", mimeType: "application/octet-stream", key: foreignKey },
        ];
        const messageId = process.store.messages.appendMessage("user", "attachments", {
          runId,
          media: JSON.stringify(media),
        });
        process.runs.active = {
          runId,
          pendingMediaMessageId: messageId,
        };
        process.sendSignal = vi.fn(async () => {});
        process.resources.resolveMediaProcessingOptions = vi.fn(async () => ({
          ai: process.env.AI,
        }));

        await process.resources.prepareRunMedia(runId, messageId, media);
      });

      expect(await env.STORAGE.head(ownKey)).toBeNull();
      expect(await env.STORAGE.head(foreignKey)).not.toBeNull();
    } finally {
      await env.STORAGE.delete([ownKey, foreignKey]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
    }
  });

  it("requires the media body descriptor length", async () => {
    const stub = await initProcess("mech-media-length", ROOT_IDENTITY);
    const response = await runInProcess(stub, (process) => {
      return process.resources.storeIncomingResource(
        {
          type: "image",
          mimeType: "image/png",
        },
        {
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
        },
      );
    });

    expect(response).toEqual({
      ok: false,
      error: "Resource write requires an exact body length",
    });
  });

  it("rejects the reserved R2 directory-marker media id", async () => {
    const stub = await initProcess("mech-media-reserved-marker", ROOT_IDENTITY);
    const response = await runInProcess(stub, (process) => {
      return process.resources.storeIncomingResource(
        {
          type: "document",
          mimeType: "application/octet-stream",
          mediaId: ".dir",
        },
        bodyFromBytes(new Uint8Array([1])),
      );
    });

    expect(response).toEqual({
      ok: false,
      error: "Resource id is invalid",
    });
  });

  it("deletes an upload that finishes after a process reset", async () => {
    const pid = "mech-media-reset-race";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const originalStorage = process.storage;
      const objects = new Map<string, Uint8Array>();
      const { promise: putBlocked, resolve: releasePut } = deferred();
      const { promise: putStarted, resolve: markPutStarted } = deferred();
      const deleteObject = vi.fn(async (key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key]) {
          objects.delete(item);
        }
      });
      process.storage = {
        put: vi.fn(async (key: string, stream: ReadableStream<Uint8Array>) => {
          markPutStarted();
          await putBlocked;
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          objects.set(key, bytes);
          return { key, size: bytes.byteLength };
        }),
        list: vi.fn(async ({ prefix }: { prefix: string }) => ({
          objects: [...objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, bytes]) => ({ key, size: bytes.byteLength })),
          truncated: false,
        })),
        delete: deleteObject,
      };

      try {
        const writing = process.resources.storeIncomingResource(
          { type: "image", mimeType: "image/png" },
          bodyFromBytes(new Uint8Array([1, 2, 3])),
        );
        await putStarted;
        await process.controller.handleProcReset();
        releasePut();

        await expect(writing).resolves.toEqual({
          ok: false,
          error: "Process reset during media upload",
        });
        expect(objects.size).toBe(0);
        expect(deleteObject).toHaveBeenCalledWith(expect.stringContaining(`/0/${pid}/`));
      } finally {
        process.storage = originalStorage;
        releasePut();
      }
    });
  });

  it("bounds media materialized while building model context", async () => {
    const pid = "mech-bounded-context-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const originalStorage = process.storage;
      const arrayBuffer = vi.fn(async () => new Uint8Array([1]).buffer);
      const prefix = `var/media/0/${pid}/`;
      process.store.messages.appendMessage("user", "Review these images.", {
        media: JSON.stringify([
          { type: "image", mimeType: "image/png", key: `${prefix}oversized` },
          { type: "image", mimeType: "image/png", key: `${prefix}first` },
          { type: "image", mimeType: "image/png", key: `${prefix}second` },
        ]),
      });
      process.storage = {
        get: vi.fn(async (key: string) => ({
          size: key.endsWith("oversized") ? 25 * 1024 * 1024 + 1 : 15 * 1024 * 1024,
          arrayBuffer,
          body: { cancel: vi.fn(async () => {}) },
        })),
      };

      try {
        const messages = await process.history.buildContextMessages("default");
        expect(arrayBuffer).toHaveBeenCalledTimes(1);
        expect(messages[0].content).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "image", data: "AQ==" })]),
        );
      } finally {
        process.storage = originalStorage;
      }
    });
  });

  it("does not hydrate out-of-scope media from persisted history", async () => {
    const stub = await initProcess("mech-foreign-context-media", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const originalStorage = process.storage;
      const get = vi.fn(async () => ({
        size: 3,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }));
      process.store.messages.appendMessage("user", "Legacy attachment", {
        media: JSON.stringify([
          {
            type: "image",
            mimeType: "image/png",
            key: "var/media/0/another-process/secret.png",
          },
        ]),
      });
      process.storage = { get };

      try {
        const messages = await process.history.buildContextMessages("default");
        expect(get).not.toHaveBeenCalled();
        expect(messages[0].content).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "image" })]),
        );
      } finally {
        process.storage = originalStorage;
      }
    });
  });
});
