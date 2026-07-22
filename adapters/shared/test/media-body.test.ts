import { describe, expect, it } from "vitest";

import {
  readResponseBodyBytes,
  responseBodyToBinaryBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
} from "../src/media-body";

describe("adapter response media bodies", () => {
  it("allows one materialized item to use the complete media byte budget", async () => {
    const response = new Response(new ReadableStream<Uint8Array>(), {
      headers: { "content-length": String(SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES) },
    });

    const body = await responseBodyToBinaryBody(response, {
      maxBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
    });

    expect(SAFE_MATERIALIZED_MEDIA_PART_BYTES).toBe(48 * 1024 * 1024);
    expect(body.length).toBe(SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES);
    await body.stream.cancel();
  });

  it("caps a response whose length is unknown", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3));
      },
      cancel() {
        cancelled = true;
      },
    }));

    await expect(readResponseBodyBytes(response, {
      maxBytes: 2,
      label: "attachment",
    })).rejects.toThrow("Body exceeds limit");
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized declared response before reading it", async () => {
    let pulled = false;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
      cancel() {
        cancelled = true;
      },
    }), {
      headers: { "content-length": "3" },
    });

    await expect(responseBodyToBinaryBody(response, {
      maxBytes: 2,
      label: "attachment",
    })).rejects.toThrow("exceeds transfer limit");
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("preserves streaming when an exact safe length is known", async () => {
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(Uint8Array.of(1, 2));
        controller.close();
      },
    }), {
      headers: { "content-length": "2" },
    });

    const original = response.body;
    const body = await responseBodyToBinaryBody(response, { maxBytes: 2 });

    expect(body.length).toBe(2);
    expect(body.stream).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(body.stream.locked).toBe(false);
    expect(pulls).toBeLessThanOrEqual(1);
    expect([...new Uint8Array(await new Response(body.stream).arrayBuffer())]).toEqual([1, 2]);
  });

  it("materializes an unknown-length response within the cap", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        controller.enqueue(Uint8Array.of(2, 3));
        controller.close();
      },
    }));

    const body = await responseBodyToBinaryBody(response, { maxBytes: 3 });

    expect(body.length).toBe(3);
    expect([...new Uint8Array(await new Response(body.stream).arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("rejects a response shorter than its declared length", async () => {
    const response = new Response(Uint8Array.of(1, 2), {
      headers: { "content-length": "3" },
    });

    await expect(readResponseBodyBytes(response, {
      maxBytes: 3,
      label: "attachment",
    })).rejects.toThrow("Body length 2 did not match 3");
  });

  it("rejects a response longer than its declared length", async () => {
    const response = new Response(Uint8Array.of(1, 2, 3), {
      headers: { "content-length": "2" },
    });

    await expect(readResponseBodyBytes(response, {
      maxBytes: 3,
      label: "attachment",
    })).rejects.toThrow("Body length 3 did not match 2");
  });

  it("cancels a response with invalid fallback length metadata", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }));

    await expect(responseBodyToBinaryBody(response, {
      maxBytes: 3,
      expectedBytes: -1,
    })).rejects.toThrow("non-negative safe integer");
    expect(cancelled).toBe(true);
  });
});
