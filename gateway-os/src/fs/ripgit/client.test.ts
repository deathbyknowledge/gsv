import { describe, expect, it } from "vitest";
import { RipgitClient } from "./client";

function makeFetcher(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): Fetcher {
  return {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
      return Promise.resolve(handler(url, init));
    },
  } as Fetcher;
}

describe("RipgitClient.history", () => {
  it("calls the ripgit history endpoint with ref, path, and limit", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new RipgitClient(
      makeFetcher((url, init) => {
        requests.push({
          url: url.toString(),
          headers: new Headers(init?.headers),
        });
        return Response.json({
          ok: true,
          entries: [],
        });
      }),
      "secret-key",
    );

    await client.history(
      { owner: "uid-1000", repo: "ws_demo" },
      { path: "src", limit: 5 },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://ripgit/hyperspace/repos/uid-1000/ws_demo/history?ref=main&path=src&limit=5",
    );
    expect(requests[0]?.headers.get("X-Ripgit-Internal-Key")).toBe("secret-key");
  });
});
