import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleNetFetch,
  MAX_NET_FETCH_RESPONSE_BYTES,
  readNetFetchResponseBody,
  responseFromNetFetchResult,
} from "./net";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("responseFromNetFetchResult", () => {
  it("rebuilds null-body status responses without a body", async () => {
    for (const status of [204, 205, 304]) {
      const response = responseFromNetFetchResult({
        ok: status < 300,
        url: "https://example.test/no-content",
        status,
        statusText: status === 304 ? "Not Modified" : "No Content",
        headers: {},
        bodyBase64: "",
        bodyBytes: 0,
      });

      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }
  });

  it("rejects declared oversized gateway fetch responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response("ignored", {
        headers: {
          "content-length": String(MAX_NET_FETCH_RESPONSE_BYTES + 1),
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleNetFetch({
      url: "https://example.test/large.bin",
    }, {} as never)).rejects.toThrow(
      `net.fetch response body exceeds limit (${MAX_NET_FETCH_RESPONSE_BYTES + 1} bytes, max ${MAX_NET_FETCH_RESPONSE_BYTES})`,
    );
  });

  it("rejects streamed responses that exceed the response cap", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }));

    await expect(readNetFetchResponseBody(response, 3)).rejects.toThrow(
      "net.fetch response body exceeds limit (4 bytes, max 3)",
    );
  });
});
