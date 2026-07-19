import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { Kernel } from "./do";
import type { LinkChallengeStore } from "./link-challenges";

function issueChallenge(store: LinkChallengeStore, actorId: string) {
  return store.issue({
    adapter: "test",
    accountId: "default",
    actorId,
    surfaceKind: "dm",
    surfaceId: actorId,
  });
}

describe("LinkChallengeStore attempt limits", () => {
  it("durably blocks a uid after repeated invalid guesses", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    const code = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = (instance as any).adapters.linkChallenges as LinkChallengeStore;
      const challenge = issueChallenge(store, "actor:blocked");
      for (let attempt = 0; attempt < 8; attempt += 1) {
        expect(store.consume("ZZZZ-ZZZZ", 1000)).toBeNull();
      }
      return challenge.code;
    });

    const result = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = (instance as any).adapters.linkChallenges as LinkChallengeStore;
      return {
        blocked: store.consume(code, 1000),
        otherUser: store.consume(code, 1001),
      };
    });

    expect(result.blocked).toBeNull();
    expect(result.otherUser).toMatchObject({ code, usedByUid: 1001 });
  });

  it("clears a uid's failed-attempt budget after a successful link", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    const result = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = (instance as any).adapters.linkChallenges as LinkChallengeStore;
      const first = issueChallenge(store, "actor:first");
      for (let attempt = 0; attempt < 7; attempt += 1) {
        expect(store.consume("YYYY-YYYY", 1000)).toBeNull();
      }
      const firstResult = store.consume(first.code, 1000);

      const second = issueChallenge(store, "actor:second");
      for (let attempt = 0; attempt < 7; attempt += 1) {
        expect(store.consume("XXXX-XXXX", 1000)).toBeNull();
      }
      const secondResult = store.consume(second.code, 1000);
      return { firstResult, secondResult };
    });

    expect(result.firstResult).toMatchObject({ usedByUid: 1000 });
    expect(result.secondResult).toMatchObject({ usedByUid: 1000 });
  });
});
