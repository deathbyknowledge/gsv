import type { PromptContextProvider } from "../types";
import { accountContextLayer, collectAccountContext, distinctOwner } from "./account";

/**
 * Layers the owning human's `~/context.d` into the prompt, so an agent account
 * sees the context of the person it works for in addition to its own home
 * (provided by the home context provider). No-op when the process runs as its
 * own owner (no distinct agent account).
 */
export function createOwnerContextProvider(): PromptContextProvider {
  return {
    name: "owner.context",
    layer(input) {
      const owner = distinctOwner(input);
      return owner ? accountContextLayer(owner, "user") : null;
    },
    async collect(input) {
      const owner = distinctOwner(input);
      return owner ? collectAccountContext(input, owner, "owner context.d") : [];
    },
  };
}
