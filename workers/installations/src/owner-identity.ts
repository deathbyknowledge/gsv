import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { OwnerAttempt, VerifiedOwnerIdentity } from "./owner-store";

export type OwnerIdentityConfiguration = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  origin: string;
};

const ownerClaimsSchema = z.object({
  iss: z.string().url(), sub: z.string().min(1).max(512), auth_time: z.number().int(),
  email: z.string().trim().email().max(254), email_verified: z.literal(true), name: z.string().max(200).optional(),
});

/** OIDC authenticates an individual owner; operator administration grants no ownership. */
export class OwnerIdentityProvider {
  constructor(private readonly configuration: OwnerIdentityConfiguration, private readonly request: typeof fetch = fetch) {}

  async authorizationUrl(attempt: OwnerAttempt): Promise<string> {
    const { server, client, redirectUri } = await this.metadata();
    if (!attempt.code_verifier || !attempt.nonce || !server.authorization_endpoint) throw new Error("Owner authentication is unavailable");
    const url = new URL(server.authorization_endpoint);
    if (url.protocol !== "https:") throw new Error("Owner identity provider must use HTTPS");
    url.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile",
      state: attempt.id, nonce: attempt.nonce, code_challenge: await oauth.calculatePKCECodeChallenge(attempt.code_verifier),
      code_challenge_method: "S256", max_age: "0",
    }).toString();
    return url.href;
  }

  async complete(url: URL, attempt: OwnerAttempt): Promise<VerifiedOwnerIdentity> {
    if (!attempt.code_verifier || !attempt.nonce) throw new Error("Owner authentication attempt is unavailable");
    const { server, client, redirectUri } = await this.metadata();
    const parameters = oauth.validateAuthResponse(server, client, url, attempt.id);
    const response = await oauth.authorizationCodeGrantRequest(server, client,
      this.configuration.clientSecret ? oauth.ClientSecretBasic(this.configuration.clientSecret) : oauth.None(),
      parameters, redirectUri, attempt.code_verifier, this.options());
    const result = await oauth.processAuthorizationCodeResponse(server, client, response, {
      expectedNonce: attempt.nonce, requireIdToken: true, maxAge: 10 * 60,
    });
    await oauth.validateApplicationLevelSignature(server, response, this.options());
    const identity = ownerClaimsSchema.parse(oauth.getValidatedIdTokenClaims(result));
    // max_age=0 requires a new authentication for this attempt, not merely a freshly issued token.
    if (identity.auth_time * 1000 < attempt.created_at - 30_000) throw new Error("A freshly authenticated, verified owner identity is required");
    return { issuer: identity.iss, subject: identity.sub, email: identity.email,
      name: identity.name ?? identity.email };
  }

  private async metadata(): Promise<{ server: oauth.AuthorizationServer; client: oauth.Client; redirectUri: string }> {
    const issuer = new URL(this.configuration.issuer);
    const origin = new URL(this.configuration.origin);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash || issuer.search
      || origin.protocol !== "https:" || origin.origin !== this.configuration.origin || !this.configuration.clientId) {
      throw new Error("Owner identity provider is not configured");
    }
    const response = await oauth.discoveryRequest(issuer, this.options());
    const server = await oauth.processDiscoveryResponse(issuer, response);
    return { server, client: { client_id: this.configuration.clientId, id_token_signed_response_alg: "RS256" },
      redirectUri: `${origin.origin}/owner/callback` };
  }

  private options() {
    return { [oauth.customFetch]: this.request, signal: AbortSignal.timeout(10_000) };
  }
}
