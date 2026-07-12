import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyFromText, bodyToText } from "@humansandmachines/gsv/protocol";
import {
  handleNetFetch,
  limitNetFetchRequestBody,
  limitNetFetchResponseBody,
  MAX_NET_FETCH_REQUEST_BYTES,
  MAX_NET_FETCH_RESPONSE_BYTES,
  MAX_NET_FETCH_TIMEOUT_MS,
  normalizeNetFetchTimeoutMs,
  requestNetFetchWithSignal,
  requestToNetFetchArgs,
  responseFromNetFetchResult,
} from "./net";
import type { ResponseOkFrame } from "../protocol/frames";

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
      });

      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }
  });

  it("cancels bodies attached to invalid responses", async () => {
    const cancelled: unknown[] = [];
    const body = {
      stream: new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelled.push(reason);
        },
      }),
    };

    expect(() => responseFromNetFetchResult({ status: 101 }, body)).toThrow(
      "net.fetch returned an invalid HTTP status",
    );
    await vi.waitFor(() => expect(cancelled).toHaveLength(1));
  });

  it("keeps the routed response body bound to its abort signal", async () => {
    const controller = new AbortController();
    let cancelled: unknown;
    const response = responseFromNetFetchResult(
      { status: 200, headers: {} },
      {
        stream: new ReadableStream<Uint8Array>({
          cancel(reason) {
            cancelled = reason;
          },
        }),
      },
      controller.signal,
    );
    const reason = new Error("stop reading");

    controller.abort(reason);

    await expect(response.arrayBuffer()).rejects.toThrow("stop reading");
    await vi.waitFor(() => expect(cancelled).toBe(reason));
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

    const result = await handleNetFetch({
      url: "https://example.test/data",
      redirect: "error",
    }, {} as never);

    expect(result.data.status).toBe(200);
    expect(result.body && await bodyToText(result.body)).toBe("ok");
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
    const request = requestToNetFetchArgs(new Request("https://example.test/redirect", {
      redirect: "manual",
    }));

    expect(request.args.redirect).toBe("manual");
  });

  it("sends request and response bytes through frame bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(await new Response(init?.body).text()).toBe("request bytes");
      return new Response("response bytes");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleNetFetch(
      { url: "https://example.test/data", method: "POST" },
      {} as never,
      bodyFromText("request bytes"),
    );

    expect(result.body && await bodyToText(result.body)).toBe("response bytes");
  });

  it("rejects legacy inline request bodies", async () => {
    for (const field of ["body", "bodyBase64"] as const) {
      await expect(handleNetFetch(
        { url: "https://example.test/data", method: "POST", [field]: "inline" } as never,
        {} as never,
      )).rejects.toThrow(`args.${field} was removed`);
    }
  });

  it("rejects declared oversized gateway request bodies before fetch", async () => {
    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleNetFetch(
      { url: "https://example.test/data", method: "POST" },
      {} as never,
      {
        length: MAX_NET_FETCH_REQUEST_BYTES + 1,
        stream: new ReadableStream({ cancel: () => { cancelled = true; } }),
      },
    )).rejects.toThrow("net.fetch request body exceeds limit");

    expect(cancelled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects streamed gateway request bodies over the cap", async () => {
    const stream = limitNetFetchRequestBody(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }), 3);

    await expect(bodyToText({ stream })).rejects.toThrow(
      "net.fetch request body exceeds limit (4 bytes, max 3)",
    );
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
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, {
      headers: { "content-length": String(MAX_NET_FETCH_RESPONSE_BYTES + 1) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleNetFetch({
      url: "https://example.test/no-body",
    }, {} as never);

    expect(result.data.status).toBe(200);
    expect(result.body).toBeUndefined();
  });

  it("rejects streamed responses that exceed the response cap", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }));
    const stream = limitNetFetchResponseBody(response.body!, response.headers, () => {}, 3);

    await expect(bodyToText({ stream })).rejects.toThrow(
      "net.fetch response body exceeds limit (4 bytes, max 3)",
    );
  });
});

describe("requestNetFetchWithSignal", () => {
  it("does not start pre-aborted requests", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    let started = false;
    let cancelled: unknown;
    controller.abort(reason);

    await expect(requestNetFetchWithSignal(
      async () => {
        started = true;
        throw new Error("unexpected request");
      },
      controller.signal,
      {
        stream: new ReadableStream<Uint8Array>({
          cancel(value) {
            cancelled = value;
          },
        }),
      },
    )).rejects.toBe(reason);

    expect(started).toBe(false);
    expect(cancelled).toBe(reason);
  });

  it("cancels a response that arrives after abort", async () => {
    const controller = new AbortController();
    let resolveRequest!: (frame: ResponseOkFrame<"net.fetch">) => void;
    const request = new Promise<ResponseOkFrame<"net.fetch">>((resolve) => {
      resolveRequest = resolve;
    });
    let responseCancelled: unknown;
    const result = requestNetFetchWithSignal(() => request, controller.signal);
    const reason = new Error("request abandoned");

    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    resolveRequest({
      type: "res",
      id: "late",
      ok: true,
      data: {
        ok: true,
        url: "https://example.test",
        status: 200,
        statusText: "OK",
        headers: {},
        redirected: false,
      },
      body: {
        stream: new ReadableStream<Uint8Array>({
          cancel(value) {
            responseCancelled = value;
          },
        }),
      },
    });

    await vi.waitFor(() => expect(responseCancelled).toBe(reason));
  });

  it("cancels the routed request when aborted", async () => {
    const controller = new AbortController();
    const cancelRequest = vi.fn(async () => {});
    const pending = new Promise<ResponseOkFrame<"net.fetch">>(() => {});
    const result = requestNetFetchWithSignal(
      () => pending,
      controller.signal,
      undefined,
      cancelRequest,
    );
    const reason = new Error("stop request");

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(cancelRequest).toHaveBeenCalledWith(reason);
  });

  it("rejects immediately when cancellation cleanup stalls", async () => {
    const controller = new AbortController();
    const request = requestNetFetchWithSignal(
      () => new Promise<ResponseOkFrame<"net.fetch">>(() => {}),
      controller.signal,
      undefined,
      () => new Promise<void>(() => {}),
    );
    const reason = new Error("take back control");

    controller.abort(reason);

    await expect(Promise.race([
      request,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("abort stayed pending")),
        50,
      )),
    ])).rejects.toBe(reason);
  });
});

describe("normalizeNetFetchTimeoutMs", () => {
  it("caps device work at the tool dispatch ceiling", () => {
    expect(normalizeNetFetchTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_NET_FETCH_TIMEOUT_MS);
  });
});
