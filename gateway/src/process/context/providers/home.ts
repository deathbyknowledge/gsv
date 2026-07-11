import type { PromptContextProvider } from "../types";
import { collectAccountContext } from "./account";

export function createHomeContextProvider(): PromptContextProvider {
  return {
    name: "home.context",
    async collect(input) {
      return collectAccountContext(input, input.identity, "program", "context.d");
    },
  };
}
