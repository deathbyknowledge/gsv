import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { Kernel } from "./do";
import { OAuthStore } from "./oauth-store";

describe("OAuthStore", () => {
  it("atomically consumes callback state once", async () => {
    const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance, state) => {
      const store = new OAuthStore(state.storage.sql);
      const now = Date.now();
      store.createFlow({
        flowId: "flow-1",
        stateHash: "state-hash",
        uid: 1000,
        kind: "generic",
        provider: "example",
        accountKey: "default",
        label: null,
        authorizationEndpoint: "https://example.com/authorize",
        tokenEndpoint: "https://example.com/token",
        clientId: "client",
        redirectUri: "https://gsv.example/oauth/callback",
        scope: null,
        resource: null,
        extraAuthParams: {},
        codeVerifier: "verifier",
        createdAt: now,
        expiresAt: now + 60_000,
      });

      expect(store.consumeFlowByStateHash("state-hash", now)?.flowId).toBe("flow-1");
      expect(store.consumeFlowByStateHash("state-hash", now)).toBeNull();
    });
  });
});
