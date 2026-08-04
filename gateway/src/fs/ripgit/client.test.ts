import { describe, expect, it, vi } from "vitest";
import { RipgitClient } from "./client";

describe("ripgit export client", () => {
  it("returns a validated streaming bundle", async () => {
    const fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => (
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-length": "3",
          "content-type": "application/x-git-bundle",
        },
      })
    ));
    const client = new RipgitClient({ fetch } as unknown as Fetcher);

    const bundle = await client.exportBundle({ owner: "alice", repo: "home" }, "root");

    expect(bundle.size).toBe(3);
    expect([...new Uint8Array(await new Response(bundle.body).arrayBuffer())])
      .toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://ripgit/alice/home/bundle"),
      { headers: { "X-Ripgit-Actor-Name": "root" } },
    );
  });

  it("cancels a bundle with invalid response metadata", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { headers: { "content-type": "application/octet-stream" } },
    ));
    const client = new RipgitClient({ fetch } as unknown as Fetcher);

    await expect(client.exportBundle({ owner: "alice", repo: "home" }, "root"))
      .rejects.toThrow("returned invalid metadata");
    expect(cancel).toHaveBeenCalledWith("ripgit export metadata is invalid");
  });
});
