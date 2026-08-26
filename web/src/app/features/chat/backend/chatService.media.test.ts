import type { GSVClient } from "@humansandmachines/gsv/client";
import { MAX_FEDERATION_RESOURCE_BYTES } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { frameBodyFromBlob } from "../../../services/gateway/frameBody";
import { readChatProcessMedia, readChatResource, sendChatMessage } from "./chatService";

type UploadRequestArgs = { path?: string; contentType?: string };
type ClientFixture = { request: unknown; proc?: unknown; conversation?: unknown };

function clientFixture(value: ClientFixture): Pick<GSVClient, "proc" | "conversation" | "request"> {
  // SAFETY: each fixture supplies exactly the client methods exercised by its focused test.
  return value as Pick<GSVClient, "proc" | "conversation" | "request">;
}

describe("chat process media", () => {
  it("uploads attachment bodies before sending their references", async () => {
    const request = vi.fn(async (
      call: string,
      args: UploadRequestArgs,
      options?: { body?: { stream: ReadableStream<Uint8Array> } },
    ) => {
      if (call === "fs.transfer.receive") {
        expect(args).toMatchObject({ contentType: "image/png" });
        expect(await new Response(options?.body?.stream).text()).toBe("abc");
        return { data: { ok: true as const, path: args.path!, bytesWritten: 3 } };
      }
      if (call === "fs.transfer.stat") {
        return {
          data: {
            ok: true as const,
            path: args.path!,
            size: 3,
            isFile: true,
            isDirectory: false,
            contentType: "image/png",
            revision: "revision-one",
          },
        };
      }
      return {
        data: { ok: true as const, path: args.path! },
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
      "fs.transfer.receive",
      expect.objectContaining({ path: expect.stringMatching(/^~\/\.gsv\/uploads\//) }),
      expect.objectContaining({ body: expect.any(Object) }),
    );
    expect(send).toHaveBeenCalledWith({
      conversationId: "conv:test",
      text: "look",
      idempotencyKey: expect.any(String),
      media: [{
        type: "resource",
        ref: {
          type: "file",
          target: "gsv",
          path: expect.stringMatching(/^~\/\.gsv\/uploads\//),
          revision: "revision-one",
          contentType: "image/png",
          size: 3,
        },
        mediaType: "image",
        filename: "test.png",
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

  it("deletes successful parallel uploads when another upload fails", async () => {
    const request = vi.fn(async (call: string, args: { path: string }) => {
      if (call === "fs.transfer.receive") {
        return {
          data: args.path.endsWith("bad.png")
            ? { ok: false as const, error: "upload failed" }
            : { ok: true as const, path: args.path, bytesWritten: 1 },
        };
      }
      if (call === "fs.transfer.stat") {
        return {
          data: {
            ok: true as const,
            path: args.path,
            size: 1,
            isFile: true,
            isDirectory: false,
            contentType: "image/png",
            revision: "revision-one",
          },
        };
      }
      return { data: { ok: true as const, path: args.path } };
    });
    const send = vi.fn();
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

    await expect(sendChatMessage(client, {
      pid: "proc:test",
      message: "look",
      media: [
        { type: "image", mimeType: "image/png", filename: "good.png", body: new Blob(["a"]) },
        { type: "image", mimeType: "image/png", filename: "bad.png", body: new Blob(["b"]) },
      ],
    })).rejects.toThrow("upload failed");

    expect(send).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "fs.delete",
      expect.objectContaining({ path: expect.stringContaining("good.png") }),
    );
  });

  it("deletes the staged resource when conversation.send rejects it", async () => {
    const request = vi.fn(async (call: string, args: { path: string }) => {
      if (call === "fs.transfer.receive") {
        return { data: { ok: true as const, path: args.path, bytesWritten: 1 } };
      }
      if (call === "fs.transfer.stat") {
        return {
          data: {
            ok: true as const,
            path: args.path,
            size: 1,
            isFile: true,
            isDirectory: false,
            contentType: "image/png",
            revision: "revision-one",
          },
        };
      }
      return { data: { ok: true as const, path: args.path } };
    });
    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    const client = clientFixture({
      request,
      proc: {},
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
    expect(request).toHaveBeenCalledWith(
      "fs.delete",
      expect.objectContaining({ path: expect.stringContaining("attachment") }),
    );
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("caches the response body as a Blob instead of a data URL", async () => {
    const request = vi.fn(async (call: string) => call === "fs.transfer.stat"
      ? {
          data: {
            ok: true as const,
            path: "/var/media/1000/proc/example.png",
            size: 3,
            isFile: true,
            isDirectory: false,
            contentType: "image/png",
            revision: "revision-one",
          },
        }
      : {
          data: {
            ok: true as const,
            path: "/var/media/1000/proc/example.png",
            contentType: "image/png",
            revision: "revision-one",
            size: 3,
          },
          body: frameBodyFromBlob(new Blob([new Uint8Array([1, 2, 3])])),
        });
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const client = clientFixture({ request });

    const result = await readChatProcessMedia(client, {
      pid: "proc:test",
      key: "var/media/1000/proc/example.png",
    });

    expect(request).toHaveBeenCalledWith("fs.transfer.stat", {
      path: "/var/media/1000/proc/example.png",
    });
    expect(request).toHaveBeenCalledWith("fs.transfer.send", {
      target: "gsv",
      path: "/var/media/1000/proc/example.png",
      revision: "revision-one",
    });
    expect(result).not.toHaveProperty("dataUrl");
    expect(result.blob.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("rejects successful metadata without a response body", async () => {
    const request = vi.fn(async (call: string) => call === "fs.transfer.stat"
      ? {
          data: {
            ok: true as const,
            path: "/var/media/1000/proc/example.png",
            size: 3,
            isFile: true,
            isDirectory: false,
            contentType: "image/png",
            revision: "revision-one",
          },
        }
      : {
          data: {
            ok: true as const,
            path: "/var/media/1000/proc/example.png",
            size: 3,
            contentType: "image/png",
            revision: "revision-one",
          },
        });
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const client = clientFixture({ request });

    await expect(readChatProcessMedia(client, {
      key: "var/media/1000/proc/example.png",
    })).rejects.toThrow("Resource response did not include a body");
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

  it("opens contact resources across the process-media display boundary", async () => {
    const ref = {
      type: "file" as const,
      target: "contact:remote",
      path: "/_gsv/federation/v1/resources/large",
      revision: "large-contact-resource",
      contentType: "video/mp4",
      size: 25 * 1024 * 1024 + 1,
    };
    const request = vi.fn(async () => ({
      data: { ok: false as const, error: "fixture stops before reading bytes" },
    }));
    const client = clientFixture({ request });

    await expect(readChatResource(client, ref)).rejects.toThrow(
      "fixture stops before reading bytes",
    );
    expect(request).toHaveBeenCalledWith("fs.transfer.send", {
      target: ref.target,
      path: ref.path,
      revision: ref.revision,
    });
  });

  it("rejects contact resources above the federation transfer limit", async () => {
    const request = vi.fn();
    const client = clientFixture({ request });

    await expect(readChatResource(client, {
      type: "file",
      target: "contact:remote",
      path: "/_gsv/federation/v1/resources/too-large",
      revision: "too-large",
      contentType: "application/octet-stream",
      size: MAX_FEDERATION_RESOURCE_BYTES + 1,
    })).rejects.toThrow("Resource exceeds the 48 MiB display limit");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects process media above the eager display limit before reading bytes", async () => {
    const request = vi.fn(async () => ({
      data: {
        ok: true as const,
        path: "/var/media/1000/proc/large.mp4",
        size: 25 * 1024 * 1024 + 1,
        isFile: true,
        isDirectory: false,
        contentType: "video/mp4",
        revision: "large-revision",
      },
    }));
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const client = clientFixture({ request });

    await expect(readChatProcessMedia(client, {
      key: "var/media/1000/proc/large.mp4",
    })).rejects.toThrow("Resource exceeds the 25 MiB display limit");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("fs.transfer.stat", {
      path: "/var/media/1000/proc/large.mp4",
    });
  });
});
