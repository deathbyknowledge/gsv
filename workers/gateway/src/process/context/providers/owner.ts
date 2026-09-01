import type { PromptContextProvider } from "../types";
import { collectAccountContext } from "./account";

/**
 * Layers the owning human's `~/context.d` into the prompt, so an agent account
 * sees the context of the person it works for in addition to its own home
 * (provided by the home context provider). No-op when the process runs as its
 * own owner (no distinct agent account).
 */
export function createOwnerContextProvider(): PromptContextProvider {
  return {
    name: "owner.context",
    async collect(input) {
      const owner = input.ownerIdentity;
      if (!owner || owner.username === input.identity.username) {
        return [];
      }

      return collectAccountContext(input, owner, "user", "owner context.d");
    },
  };
}
