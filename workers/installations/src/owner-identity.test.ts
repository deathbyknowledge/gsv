import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { OwnerIdentityProvider } from "./owner-identity";
import type { OwnerAttempt } from "./owner-store";

async function fixture(overrides: JWTPayload = {}, wrongSignature = false) {
  const key = await generateKeyPair("RS256", { extractable: true });
  const other = wrongSignature ? await generateKeyPair("RS256") : key;
  const now = Math.floor(Date.now() / 1000);
  const issuer = "https://identity.example.com";
  const claims = { iss: issuer, sub: "owner-subject", aud: "gsv-owners", iat: now, exp: now + 300, auth_time: now,
    nonce: "test-nonce", email: "owner@example.com", email_verified: true, name: "Owner", ...overrides };
  const token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "owner-key" }).sign(other.privateKey);
  const jwk = await exportJWK(key.publicKey);
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, id_token_signing_alg_values_supported: ["RS256"] });
    if (url.endsWith("/token")) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code_verifier")).toBe("test-code-verifier");
      expect(body.get("redirect_uri")).toBe("https://accounts.example.com/owner/callback");
      return Response.json({ access_token: "not-retained", token_type: "Bearer", id_token: token });
    }
    if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...jwk, kid: "owner-key", alg: "RS256", use: "sig" }] });
    throw new Error("Unexpected provider request");
  };
  const provider = new OwnerIdentityProvider({ issuer, clientId: "gsv-owners", origin: "https://accounts.example.com" }, request);
  const attempt: OwnerAttempt = { id: crypto.randomUUID(), installation_id: "installation_one", purpose: "recover", expected_owner_id: "principal_one",
    link_secret_hash: null, browser_secret_hash: "hash", code_verifier: "test-code-verifier", nonce: "test-nonce", principal_id: null,
    state: "authenticating", created_at: Date.now(), expires_at: Date.now() + 300_000 };
  const callback = new URL(`https://accounts.example.com/owner/callback?state=${attempt.id}&code=test-code`);
  return { provider, attempt, callback };
}

describe("fresh OIDC owner authentication", () => {
  it("uses PKCE, nonce and fresh authentication and verifies the returned signature and identity", async () => {
    const f = await fixture();
    const url = new URL(await f.provider.authorizationUrl(f.attempt));
    expect(url.searchParams.get("max_age")).toBe("0");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe(f.attempt.nonce);
    expect(url.searchParams.get("state")).toBe(f.attempt.id);
    await expect(f.provider.complete(f.callback, f.attempt)).resolves.toEqual({ issuer: "https://identity.example.com", subject: "owner-subject", email: "owner@example.com", name: "Owner" });
  });

  it.each([
    { iss: "https://attacker.example.com" }, { aud: "another-application" }, { nonce: "another-attempt" },
    { email_verified: false }, { auth_time: Math.floor(Date.now() / 1000) - 3600 }, { auth_time: undefined },
    { exp: Math.floor(Date.now() / 1000) - 3600 },
  ])("rejects invalid issuer, audience, nonce, freshness and email evidence: %j", async (claims) => {
    const f = await fixture(claims);
    await expect(f.provider.complete(f.callback, f.attempt)).rejects.toThrow();
  });

  it("rejects a matching identity with an invalid signature", async () => {
    const f = await fixture({}, true);
    await expect(f.provider.complete(f.callback, f.attempt)).rejects.toThrow();
  });

  it("does not accept a token issued now for authentication before this attempt", async () => {
    const f = await fixture({ auth_time: Math.floor(Date.now() / 1000) - 120 });
    await expect(f.provider.complete(f.callback, f.attempt)).rejects.toThrow("freshly authenticated");
  });
});
