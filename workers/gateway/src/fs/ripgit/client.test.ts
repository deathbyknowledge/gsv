import { describe, expect, it, vi } from "vitest";
import { RipgitClient } from "./client";

const repo = { owner: "alice", repo: "demo", branch: "a".repeat(40) };
function client(fetch: typeof globalThis.fetch): RipgitClient {
  // SAFETY: RipgitClient only uses the service binding's fetch method.
  return new RipgitClient({ fetch } as Fetcher);
}

describe("bounded repository snapshot reads", () => {
  it("keeps exact binary bytes and tree metadata within the limit", async () => {
    const binary = new Uint8Array([0, 255, 128, 10]);
    expect(await client(async () => new Response(binary)).readPath(repo, "image.bin", { maxBytes: 4 }))
      .toEqual({ kind: "file", bytes: binary, size: 4 });
    const entries = [{ name: "link", mode: "120000", type: "symlink", hash: "b".repeat(40) }];
    expect(await client(async () => Response.json(entries)).readPath(repo, "", { maxBytes: 1024 }))
      .toEqual({ kind: "tree", entries });
  });

  it("cancels an oversized response instead of buffering it", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(3)); }, cancel });
    await expect(client(async () => new Response(stream)).readPath(repo, "large.bin", { maxBytes: 4 }))
      .rejects.toThrow(/exceeds|limit/i);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation to fetch and to a waiting source body", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    let fetched: RequestInit | undefined;
    const reading = client(async (_input, init) => {
      fetched = init;
      return new Response(new ReadableStream<Uint8Array>({ cancel }));
    }).readPath(repo, "waiting.bin", { maxBytes: 4, signal: abort.signal });
    const rejected = expect(reading).rejects.toThrow("stop source read");
    await Promise.resolve();
    abort.abort(new Error("stop source read"));
    await rejected;
    expect(fetched?.signal).toBe(abort.signal);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
