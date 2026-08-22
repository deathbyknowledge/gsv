import type { GSVClient } from "@humansandmachines/gsv/client";
import { describe, expect, it, vi } from "vitest";
import { frameBodyFromBlob } from "../../../services/gateway/frameBody";
import { readChatProcessMedia, readChatResource, sendChatMessage } from "./chatService";

type UploadRequestArgs = { pid?: string; type?: string; filename?: string };
type ClientFixture = { request: unknown; proc?: unknown; conversation?: unknown };

function clientFixture(value: ClientFixture): Pick<GSVClient, "proc" | "conversation" | "request"> {
  // SAFETY: each fixture supplies exactly the client methods exercised by its focused test.
  return value as Pick<GSVClient, "proc" | "conversation" | "request">;
}

describe("chat process media", () => {
  it("uploads attachment bodies before sending their references", async () => {
    const request = vi.fn(async (
      _call: string,
      args: UploadRequestArgs,
      options?: { body?: { stream: ReadableStream<Uint8Array> } },
    ) => {
      expect(args).toMatchObject({ pid: "proc:test", type: "image" });
      expect(args).not.toHaveProperty("size");
      expect(await new Response(options?.body?.stream).text()).toBe("abc");
      return {
        data: {
          // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
          ok: true as const,
          media: {
            // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
            type: "image" as const,
            mimeType: "image/png",
            key: "var/media/1000/proc/test.png",
            size: 3,
          },
        },
      };
    });
    const send = vi.fn(async () => ({
      // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
      message: {} as never,
      handlerPid: "proc:test",
      runId: "run:1",
    }));
    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    const client = clientFixture({
      request,
      proc: {},
      conversation: {
        forProcess: vi.fn(async () => ({ conversation: { id: "conv:test" } })),
        send,
      },
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    });

    await sendChatMessage(client, {
      pid: "proc:test",
      message: "look",
      media: [{
        type: "image",
        mimeType: "image/png",
        filename: "test.png",
        body: new Blob(["abc"]),
      }],
    });

    expect(request).toHaveBeenCalledWith(
      "proc.media.write",
      expect.objectContaining({ pid: "proc:test", filename: "test.png" }),
      expect.objectContaining({ body: expect.any(Object) }),
    );
    expect(send).toHaveBeenCalledWith({
      conversationId: "conv:test",
      text: "look",
      idempotencyKey: expect.any(String),
      media: [{
        type: "image",
        mimeType: "image/png",
        key: "var/media/1000/proc/test.png",
        size: 3,
      }],
    });
  });

  it("rejects oversized attachments before starting an upload", async () => {
    const request = vi.fn();
    const send = vi.fn();
    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    const client = clientFixture({
      request,
      proc: { media: { delete: vi.fn() } },
      conversation: { forProcess: vi.fn(), send },
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    });

    await expect(sendChatMessage(client, {
      message: "too large",
      media: [{
        type: "video",
        mimeType: "video/mp4",
        // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
        body: { size: 25 * 1024 * 1024 + 1 } as Blob,
      }],
    })).rejects.toThrow("Chat attachments cannot exceed 25 MiB");
    expect(request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rolls back successful parallel uploads when another upload fails", async () => {
    const request = vi.fn(async (_call: string, args: { filename?: string }) => ({
      data: args.filename === "bad.png"
        // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
        ? { ok: false as const, error: "upload failed" }
        : {
            // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
            ok: true as const,
            media: {
              // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
              type: "image" as const,
              mimeType: "image/png",
              key: "var/media/1000/proc/good.png",
              size: 1,
            },
          },
    }));
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const remove = vi.fn(async () => ({ ok: true as const, key: "var/media/1000/proc/good.png" }));
    const send = vi.fn();
    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    const client = clientFixture({
      request,
      proc: { media: { delete: remove } },
      conversation: {
        forProcess: vi.fn(async () => ({ conversation: { id: "conv:test" } })),
        send,
      },
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    });

    await expect(sendChatMessage(client, {
      pid: "proc:test",
      message: "look",
      media: [
        { type: "image", mimeType: "image/png", filename: "good.png", body: new Blob(["a"]) },
        { type: "image", mimeType: "image/png", filename: "bad.png", body: new Blob(["b"]) },
      ],
    })).rejects.toThrow("upload failed");

    expect(send).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({
      pid: "proc:test",
      key: "var/media/1000/proc/good.png",
    });
  });

  it("rolls back staged media when proc.send rejects it", async () => {
    const request = vi.fn(async () => ({
      data: {
        // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
        ok: true as const,
        media: {
          // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
          type: "image" as const,
          mimeType: "image/png",
          key: "var/media/1000/proc/staged.png",
          size: 1,
        },
      },
    }));
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const remove = vi.fn(async () => ({ ok: true as const, key: "var/media/1000/proc/staged.png" }));
    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    const client = clientFixture({
      request,
      proc: {
        media: { delete: remove },
      },
      conversation: {
        forProcess: vi.fn(async () => ({ conversation: { id: "conv:test" } })),
        send: vi.fn(async () => { throw new Error("conversation closed"); }),
      },
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    });

    await expect(sendChatMessage(client, {
      pid: "proc:test",
      message: "look",
      media: [{ type: "image", mimeType: "image/png", body: new Blob(["a"]) }],
    })).rejects.toThrow("conversation closed");
    expect(remove).toHaveBeenCalledWith({
      pid: "proc:test",
      key: "var/media/1000/proc/staged.png",
    });
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("caches the response body as a Blob instead of a data URL", async () => {
    const request = vi.fn(async () => ({
      data: {
        // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
        ok: true as const,
        key: "var/media/1000/proc/example.png",
        mimeType: "image/png",
        size: 3,
      },
      body: frameBodyFromBlob(new Blob([new Uint8Array([1, 2, 3])])),
    }));
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const client = clientFixture({ request });

    const result = await readChatProcessMedia(client, {
      pid: "proc:test",
      key: "var/media/1000/proc/example.png",
    });

    expect(request).toHaveBeenCalledWith("proc.media.read", {
      pid: "proc:test",
      key: "var/media/1000/proc/example.png",
    });
    expect(result).not.toHaveProperty("dataUrl");
    expect(result.blob.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("rejects successful metadata without a response body", async () => {
    const request = vi.fn(async () => ({
      data: {
        // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
        ok: true as const,
        key: "var/media/1000/proc/example.png",
        mimeType: "image/png",
        size: 3,
      },
    }));
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const client = clientFixture({ request });

    await expect(readChatProcessMedia(client, {
      key: "var/media/1000/proc/example.png",
    })).rejects.toThrow("Process media response did not include a body");
  });

  it("resolves the exact resource revision over the binary body channel", async () => {
    const ref = {
      type: "file" as const,
      target: "gsv",
      path: "/root/.gsv/media/archived-media:one",
      revision: '"revision-one"',
      contentType: "image/png",
      size: 3,
    };
    const request = vi.fn(async () => ({
      data: {
        ok: true as const,
        path: ref.path,
        revision: ref.revision,
        contentType: ref.contentType,
        size: ref.size,
      },
      body: frameBodyFromBlob(new Blob([new Uint8Array([4, 5, 6])])),
    }));
    const client = clientFixture({ request });

    const result = await readChatResource(client, ref);

    expect(request).toHaveBeenCalledWith("fs.transfer.send", {
      target: "gsv",
      path: ref.path,
      revision: ref.revision,
    });
    expect(result.ref).toEqual(ref);
    expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([4, 5, 6]);
  });

  it("cancels a resource body whose revision does not match", async () => {
    let cancelled = false;
    const ref = {
      type: "file" as const,
      target: "gsv",
      path: "/root/image.png",
      revision: '"expected"',
      contentType: "image/png",
      size: 3,
    };
    const request = vi.fn(async () => ({
      data: {
        ok: true as const,
        path: ref.path,
        revision: '"newer"',
        contentType: ref.contentType,
        size: ref.size,
      },
      body: {
        stream: new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } }),
        length: ref.size,
      },
    }));
    const client = clientFixture({ request });

    await expect(readChatResource(client, ref)).rejects.toThrow(
      "Resource response does not match its reference",
    );
    expect(cancelled).toBe(true);
  });

  it("cancels process media above the eager display limit", async () => {
    let cancelReason: unknown;
    const body = {
      stream: new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelReason = reason;
        },
      }),
      length: 25 * 1024 * 1024 + 1,
    };
    const request = vi.fn(async () => ({
      data: {
        // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
        ok: true as const,
        key: "var/media/1000/proc/large.mp4",
        mimeType: "video/mp4",
        size: 25 * 1024 * 1024 + 1,
      },
      body,
    }));
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const client = clientFixture({ request });

    await expect(readChatProcessMedia(client, {
      key: "var/media/1000/proc/large.mp4",
    })).rejects.toThrow("Process media exceeds the 25 MiB display limit");
    expect(cancelReason).toBeInstanceOf(Error);
  });
});
