import type { GatewayEnv } from "../runtime-env";
import { RefusingExecutor } from "../test-fixtures/inference-execution";
import { answerFromEmptyRipgit } from "../test-fixtures/ripgit";

/**
 * The services every Gateway composes, as local objects for a hand-built
 * test env. They behave like the unit-test Worker's own bindings, without
 * RPC stubs that assertions would probe.
 */
export function requiredTestBindings(): Pick<GatewayEnv, "INFERENCE_EXECUTION" | "RIPGIT"> {
  return {
    INFERENCE_EXECUTION: {
      getExecutor: async () => new RefusingExecutor(),
      resolveModel: async (provider, model) => ({ provider, model, contextWindowTokens: null }),
    },
    // SAFETY: Gateway code reaches ripgit only through fetch.
    RIPGIT: { fetch: (input: RequestInfo | URL, init?: RequestInit) => answerFromEmptyRipgit(new Request(input, init)) } as Fetcher,
  };
}
