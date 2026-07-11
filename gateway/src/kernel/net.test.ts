import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleNetFetch,
  MAX_NET_FETCH_RESPONSE_BYTES,
  readNetFetchResponseBody,
  requestToNetFetchArgs,
  responseFromNetFetchResult,
} from "./net";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("responseFromNetFetchResult", () => {
  it("preserves routed response URL and redirect state", () => {
    const response = responseFromNetFetchResult({
      ok: true,
      url: "https://example.test/final",
      status: 200,
      statusText: "OK",
      headers: {},
      redirected: true,
      bodyBase64: "",
      bodyBytes: 0,
    });

    expect(response.url).toBe("https://example.test/final");
    expect(response.redirected).toBe(true);
  });

  it("rebuilds null-body status responses without a body", async () => {
    for (const status of [204, 205, 304]) {
      const response = responseFromNetFetchResult({
        ok: status < 300,
        url: "https://example.test/no-content",
        status,
        statusText: status === 304 ? "Not Modified" : "No Content",
        headers: {},
        redirected: false,
        bodyBase64: "",
        bodyBytes: 0,
      });

      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }
  });

  it("preserves manual redirect mode", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 302 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleNetFetch({
      url: "https://example.test/redirect",
      redirect: "manual",
    }, {} as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/redirect",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects redirects in error mode", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://example.test/final" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleNetFetch({
      url: "https://example.test/redirect",
      redirect: "error",
    }, {} as never)).rejects.toThrow(
      "net.fetch encountered a redirect with redirect mode error",
    );
  });

  it("allows non-redirect responses in error mode", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleNetFetch({
      url: "https://example.test/data",
      redirect: "error",
    }, {} as never)).resolves.toMatchObject({ status: 200 });
  });

  it("rejects invalid redirect modes", async () => {
    await expect(handleNetFetch({
      url: "https://example.test/redirect",
      redirect: "invalid",
    } as never, {} as never)).rejects.toThrow(
      "net.fetch redirect must be follow, error, or manual",
    );
  });

  it("serializes the redirect mode for routed fetches", async () => {
    const args = await requestToNetFetchArgs(new Request("https://example.test/redirect", {
      redirect: "manual",
    }));

    expect(args.redirect).toBe("manual");
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

  it("allows no-body responses with large declared content lengths", async () => {
    const response = new Response(null, {
      headers: {
        "content-length": String(MAX_NET_FETCH_RESPONSE_BYTES + 1),
      },
    });

    await expect(readNetFetchResponseBody(response)).resolves.toHaveLength(0);
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
