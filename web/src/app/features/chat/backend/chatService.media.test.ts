import type { GSVClient } from "@humansandmachines/gsv/client";
import { describe, expect, it, vi } from "vitest";
import { frameBodyFromBlob } from "../../../services/gateway/frameBody";
import { readChatProcessMedia, sendChatMessage } from "./chatService";

describe("chat process media", () => {
  it("uploads attachment bodies before sending their references", async () => {
    const request = vi.fn(async (
      _call: string,
      args: Record<string, unknown>,
      options?: { body?: { stream: ReadableStream<Uint8Array> } },
    ) => {
      expect(args).toMatchObject({ pid: "proc:test", type: "image", size: 3 });
      expect(await new Response(options?.body?.stream).text()).toBe("abc");
      return {
        data: {
          ok: true as const,
          media: {
            type: "image" as const,
            mimeType: "image/png",
            key: "var/media/1000/proc/test.png",
            size: 3,
          },
        },
      };
    });
    const send = vi.fn(async () => ({ ok: true as const, status: "started" as const, runId: "run:1" }));
    const client = {
      request,
      proc: { send },
    } as unknown as Pick<GSVClient, "proc" | "request">;

    await sendChatMessage(client, {
      pid: "proc:test",
      message: "look",
      media: [{
        type: "image",
        mimeType: "image/png",
        filename: "test.png",
        size: 3,
        body: new Blob(["abc"]),
      }],
    });

    expect(request).toHaveBeenCalledWith(
      "proc.media.write",
      expect.objectContaining({ pid: "proc:test", filename: "test.png" }),
      expect.objectContaining({ body: expect.any(Object) }),
    );
    expect(send).toHaveBeenCalledWith({
      pid: "proc:test",
      message: "look",
      media: [{
        type: "image",
        mimeType: "image/png",
        key: "var/media/1000/proc/test.png",
        size: 3,
      }],
    });
  });

  it("caches the response body as a Blob instead of a data URL", async () => {
    const request = vi.fn(async () => ({
      data: {
        ok: true as const,
        key: "var/media/1000/proc/example.png",
        mimeType: "image/png",
        size: 3,
      },
      body: frameBodyFromBlob(new Blob([new Uint8Array([1, 2, 3])])),
    }));
    const client = { request } as unknown as Pick<GSVClient, "request">;

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
        ok: true as const,
        key: "var/media/1000/proc/example.png",
        mimeType: "image/png",
        size: 3,
      },
    }));
    const client = { request } as unknown as Pick<GSVClient, "request">;

    await expect(readChatProcessMedia(client, {
      key: "var/media/1000/proc/example.png",
    })).rejects.toThrow("Process media response did not include a body");
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
        ok: true as const,
        key: "var/media/1000/proc/large.mp4",
        mimeType: "video/mp4",
        size: 25 * 1024 * 1024 + 1,
      },
      body,
    }));
    const client = { request } as unknown as Pick<GSVClient, "request">;

    await expect(readChatProcessMedia(client, {
      key: "var/media/1000/proc/large.mp4",
    })).rejects.toThrow("Process media exceeds the 25 MiB display limit");
    expect(cancelReason).toBeInstanceOf(Error);
  });
});
