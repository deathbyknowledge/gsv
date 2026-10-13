import { auth, extractWWWAuthenticateParams, UnauthorizedError, type AuthResult } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport, type SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFetchWithInit, type FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthProvider } from "./mcp-oauth-provider";

/** One authorization flow per connection, shared by both SDK transports. */
export class McpOAuthClient {
  private pending?: Promise<AuthResult>;
  private revision = 0;
  private resourceMetadataUrl?: URL;
  private scope?: string;
  private readonly abort = new AbortController();
  private readonly fetchAuthorization: FetchLike;

  constructor(
    private readonly url: URL,
    private readonly provider: McpOAuthProvider,
    requestInit?: RequestInit,
  ) {
    this.fetchAuthorization = createFetchWithInit(
      (url, init) => fetch(url, { ...init, signal: this.abort.signal }),
      requestInit,
    );
  }

  readonly fetch: FetchLike = async (url, init) => {
    let retriedUnauthorized = false;
    let lastScopeChallenge: string | null = null;
    for (;;) {
      this.abort.signal.throwIfAborted();
      init?.signal?.throwIfAborted();
      const revision = this.revision;
      const tokens = await this.provider.tokens();
      const headers = new Headers(init?.headers);
      if (tokens && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${tokens.access_token}`);
      }
      // SDK resource requests contain reusable JSON strings, or no body for GET/DELETE.
      const response = await fetch(url, { ...init, headers });
      if (init?.method === "DELETE") return response;
      const challenge = extractWWWAuthenticateParams(response);
      const unauthorized = response.status === 401;
      const insufficientScope = response.status === 403 && challenge.error === "insufficient_scope";
      if (!unauthorized && !insufficientScope) return response;
      if (unauthorized && retriedUnauthorized) return response;
      const scopeChallenge = response.headers.get("www-authenticate");
      if (insufficientScope && scopeChallenge === lastScopeChallenge) return response;
      await response.body?.cancel();
      init?.signal?.throwIfAborted();
      if (unauthorized) retriedUnauthorized = true;
      if (insufficientScope) lastScopeChallenge = scopeChallenge;
      // A delayed rejection of an older token reuses the completed renewal.
      if (revision !== this.revision) continue;
      this.resourceMetadataUrl = challenge.resourceMetadataUrl ?? this.resourceMetadataUrl;
      this.scope = challenge.scope ?? this.scope;
      if (await this.authorize() !== "AUTHORIZED") throw new UnauthorizedError();
    }
  };

  async finishAuth(code: string): Promise<void> {
    // A callback has its own code exchange; it must not join an earlier refresh.
    await this.pending;
    if (await this.authorize(code) !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize");
  }

  async close(): Promise<void> {
    this.abort.abort();
    if (this.pending) await Promise.allSettled([this.pending]);
  }

  private async authorize(authorizationCode?: string): Promise<AuthResult> {
    this.abort.signal.throwIfAborted();
    if (this.pending) return this.pending;
    if (authorizationCode === undefined && this.provider.authUrl) return "REDIRECT";
    const pending = auth(this.provider, {
      serverUrl: this.url,
      resourceMetadataUrl: this.resourceMetadataUrl,
      scope: this.scope,
      authorizationCode,
      fetchFn: this.fetchAuthorization,
    }).then((result) => {
      if (result === "AUTHORIZED") this.revision += 1;
      return result;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
}

export class OAuthStreamableHTTPClientTransport extends StreamableHTTPClientTransport {
  constructor(
    url: URL,
    options: Omit<StreamableHTTPClientTransportOptions, "authProvider" | "fetch">,
    private readonly authorization: McpOAuthClient,
  ) {
    super(url, { ...options, fetch: authorization.fetch });
  }

  override finishAuth(code: string): Promise<void> {
    return this.authorization.finishAuth(code);
  }
}

export class OAuthSSEClientTransport extends SSEClientTransport {
  constructor(
    url: URL,
    options: Omit<SSEClientTransportOptions, "authProvider" | "fetch">,
    private readonly authorization: McpOAuthClient,
  ) {
    super(url, { ...options, fetch: authorization.fetch });
  }

  override finishAuth(code: string): Promise<void> {
    return this.authorization.finishAuth(code);
  }
}
