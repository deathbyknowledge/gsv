import { describe, expect, it } from "vitest";
import { RipgitClient } from "./client";

const DIAGNOSTIC_ID = "0b8f5f2e-4b9a-4c1e-9d3a-6f2b8c7d1e0a";
const REPO = { owner: "alice", repo: "home" };

function answering(response: Response): RipgitClient {
  // SAFETY: RipgitClient only calls fetch on its binding.
  return new RipgitClient({ fetch: async () => response } as Fetcher);
}

describe("ripgit client failures", () => {
  it("keeps ripgit's cause, kind and reference when a request fails unexpectedly", async () => {
    const client = answering(Response.json({
      error: "InternalError", kind: "repository", diagnosticId: DIAGNOSTIC_ID, message: "Installation is retired",
    }, { status: 500 }));

    await expect(client.apply(REPO, "alice", "alice@example.invalid", "write", [])).rejects.toThrow(
      `ripgit apply 'alice/home' failed: Installation is retired (repository error, reference ${DIAGNOSTIC_ID})`,
    );
  });

  it("keeps a plain refusal's own text", async () => {
    const client = answering(new Response("Missing installation routing header", { status: 400 }));

    await expect(client.refs(REPO)).rejects.toThrow(/^Missing installation routing header$/);
  });
});
