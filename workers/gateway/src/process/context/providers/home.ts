import type { PromptContextProvider } from "../types";
import { collectAccountContext } from "./account";

export function createHomeContextProvider(): PromptContextProvider {
  return {
    name: "home.context",
    async collect(input) {
      // A person's own process reads their home as the user layer; an agent's home is the agent layer.
      const owner = input.ownerIdentity;
      const layer = !owner || owner.username === input.identity.username ? "user" : "agent";
      return collectAccountContext(input, input.identity, layer, "context.d");
    },
  };
}
