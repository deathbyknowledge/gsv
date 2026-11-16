import type { PromptContextProvider } from "../types";
import { accountContextLayer, collectAccountContext, distinctOwner } from "./account";

export function createHomeContextProvider(): PromptContextProvider {
  return {
    name: "home.context",
    // A person's own process reads their home as the user layer; an agent's home is the agent layer.
    layer: (input) => accountContextLayer(input.identity, distinctOwner(input) ? "agent" : "user"),
    async collect(input) {
      return collectAccountContext(input, input.identity, "context.d");
    },
  };
}
