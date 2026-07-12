import { describe, expect, it } from "vitest";
import { frameBodyFromBlob, frameBodyToBlob } from "./frameBody";

describe("gateway frame bodies", () => {
  it("streams blobs without converting them to data URLs", async () => {
    const source = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const body = frameBodyFromBlob(source);

    expect(body.length).toBe(3);
    expect(Array.from(new Uint8Array(await new Response(body.stream).arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("materializes response bodies as typed blobs", async () => {
    const body = frameBodyFromBlob(new Blob([new Uint8Array([4, 5, 6])]));
    const blob = await frameBodyToBlob(body, {
      mimeType: "audio/mpeg",
      expectedLength: 3,
      label: "Speech audio",
    });

    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe(3);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([4, 5, 6]);
  });

  it("rejects descriptor and metadata length mismatches before reading", async () => {
    let cancelReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason;
      },
    });

    await expect(frameBodyToBlob({ stream, length: 2 }, {
      mimeType: "image/png",
      expectedLength: 3,
      label: "Process media",
    })).rejects.toThrow("Process media length mismatch: expected 3, got 2");
    expect(cancelReason).toBe("Process media length does not match response metadata");
  });

  it("cancels the body before rejecting invalid response metadata lengths", async () => {
    let cancelReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason;
      },
    });

    await expect(frameBodyToBlob({ stream }, {
      mimeType: "audio/mpeg",
      expectedLength: -1,
      label: "Speech audio",
    })).rejects.toThrow("Speech audio length is invalid: -1");
    expect(cancelReason).toBeInstanceOf(Error);
    expect((cancelReason as Error).message).toBe("Speech audio length is invalid: -1");
  });
});
