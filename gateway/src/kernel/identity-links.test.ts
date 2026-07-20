import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";
import { IdentityLinkStore } from "./identity-links";

describe("IdentityLinkStore generations", () => {
  it("advances a permanent generation ledger across link, unlink, and relink", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const store = new IdentityLinkStore(state.storage.sql);

      const first = store.link("discord", "primary", "actor-1", 1000, 0);
      expect(first.generation).toBe(1);
      expect(store.isCurrentGeneration("discord", "primary", "actor-1", 1)).toBe(true);

      expect(store.unlink("discord", "primary", "actor-1")).toBe(true);
      expect(store.get("discord", "primary", "actor-1")).toBeNull();
      expect(store.isCurrentGeneration("discord", "primary", "actor-1", 1)).toBe(false);
      expect(state.storage.sql.exec<{ generation: number }>(`
        SELECT generation FROM identity_link_generations
        WHERE adapter = 'discord' AND account_id = 'primary' AND actor_id = 'actor-1'
      `).one()).toEqual({ generation: 2 });

      const relinked = store.link("discord", "primary", "actor-1", 1000, 0);
      expect(relinked.generation).toBe(3);
      expect(store.isCurrentGeneration("discord", "primary", "actor-1", 1)).toBe(false);
      expect(store.isCurrentGeneration("discord", "primary", "actor-1", 2)).toBe(false);
      expect(store.isCurrentGeneration("discord", "primary", "actor-1", 3)).toBe(true);

      const replaced = store.link("discord", "primary", "actor-1", 2000, 0);
      expect(replaced.generation).toBe(4);
      expect(store.isCurrentGeneration("discord", "primary", "actor-1", 3)).toBe(false);
      expect(store.isCurrentGeneration("discord", "primary", "actor-1", 4)).toBe(true);
    });
  });
});
