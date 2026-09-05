import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * OAuth client state for one MCP server, kept in the Kernel's Durable Object
 * storage. Keys are laid out exactly as the Agents SDK provider laid them out,
 * so installations that authorized servers before the swap keep their tokens:
 *
 *   /{clientName}/{serverId}/{clientId}/client_info/
 *   /{clientName}/{serverId}/{clientId}/token
 *   /{clientName}/{serverId}/{clientId}/code_verifier/{nonce}
 *   /{clientName}/{serverId}/{clientId}/code_verifier_challenge/{challenge}
 *   /{clientName}/{serverId}/state/{nonce}
 */

const STATE_EXPIRATION_MS = 10 * 60 * 1000;

/** The slice of Durable Object storage the provider needs; the real storage satisfies it. */
export type OAuthKeyValueStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string | string[]): Promise<boolean | number>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};

type StoredOAuthState = {
  nonce: string;
  serverId: string;
  createdAt: number;
};

type StoredCodeVerifier = {
  verifier: string;
  createdAt: number;
};

export type OAuthStateCheck =
  | { valid: true; serverId: string }
  | { valid: false; error: string };

export function parseOAuthState(state: string): { nonce: string; serverId: string } | undefined {
  const parts = state.split(".");
  if (parts.length !== 2) return undefined;
  const [nonce, serverId] = parts;
  if (!nonce || !serverId) return undefined;
  return { nonce, serverId };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomNonce(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function isExpired(createdAt: number): boolean {
  return Date.now() - createdAt > STATE_EXPIRATION_MS;
}

export class McpOAuthProvider implements OAuthClientProvider {
  clientMetadataUrl?: string;
  private storedClientId?: string;
  private storedServerId?: string;
  private authorizationUrl?: string;
  private callbackState?: string;
  private servedVerifierKey?: string;

  constructor(
    private readonly storage: OAuthKeyValueStorage,
    private readonly clientName: string,
    readonly redirectUrl: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      client_uri: new URL(this.redirectUrl).origin,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  get clientId(): string {
    if (!this.storedClientId) throw new Error("MCP OAuth client id is not set");
    return this.storedClientId;
  }

  set clientId(clientId: string) {
    this.storedClientId = clientId;
  }

  /** The client id once the server registered this client, else `undefined`. */
  get registeredClientId(): string | undefined {
    return this.storedClientId;
  }

  get serverId(): string {
    if (!this.storedServerId) throw new Error("MCP OAuth server id is not set");
    return this.storedServerId;
  }

  set serverId(serverId: string) {
    this.storedServerId = serverId;
  }

  /** The authorization URL captured by the last `redirectToAuthorization`. */
  get authUrl(): string | undefined {
    return this.authorizationUrl;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (!this.storedClientId) return undefined;
    return await this.storage.get<OAuthClientInformationMixed>(this.clientInfoKey(this.clientId))
      ?? undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.storage.put(this.clientInfoKey(clientInformation.client_id), clientInformation);
    this.clientId = clientInformation.client_id;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (!this.storedClientId) return undefined;
    return await this.storage.get<OAuthTokens>(this.tokenKey(this.clientId)) ?? undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.storage.put(this.tokenKey(this.clientId), tokens);
  }

  async state(): Promise<string> {
    const nonce = randomNonce();
    const stored: StoredOAuthState = { nonce, serverId: this.serverId, createdAt: Date.now() };
    await this.storage.put(this.stateKey(nonce), stored);
    return `${nonce}.${this.serverId}`;
  }

  async checkState(state: string): Promise<OAuthStateCheck> {
    const parsed = parseOAuthState(state);
    if (!parsed) return { valid: false, error: "Invalid state format" };
    const key = this.stateKey(parsed.nonce);
    const stored = await this.storage.get<StoredOAuthState>(key);
    if (!stored) return { valid: false, error: "State not found or already used" };
    if (stored.serverId !== parsed.serverId) {
      await this.storage.delete(key);
      return { valid: false, error: "State serverId mismatch" };
    }
    if (isExpired(stored.createdAt)) {
      const keys = [key];
      if (this.storedClientId) keys.push(this.stateCodeVerifierKey(this.clientId, parsed.nonce));
      await this.storage.delete(keys);
      return { valid: false, error: "State expired" };
    }
    return { valid: true, serverId: parsed.serverId };
  }

  async consumeState(state: string): Promise<void> {
    const parsed = parseOAuthState(state);
    if (!parsed) return;
    await this.storage.delete(this.stateKey(parsed.nonce));
  }

  /**
   * Remember the authorization URL, and move the PKCE verifier the SDK saved
   * under its challenge to the state nonce, so the callback can find it.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl.toString();
    if (!this.storedClientId || !this.storedServerId) return;
    const state = authorizationUrl.searchParams.get("state");
    const challenge = authorizationUrl.searchParams.get("code_challenge");
    if (!state || !challenge) return;
    const parsed = parseOAuthState(state);
    if (!parsed || parsed.serverId !== this.storedServerId) return;
    const challengeKey = this.challengeCodeVerifierKey(this.clientId, challenge);
    const pending = await this.storage.get<StoredCodeVerifier>(challengeKey);
    if (!pending) return;
    if (isExpired(pending.createdAt)) {
      await this.storage.delete(challengeKey);
      return;
    }
    await this.storage.put(this.stateCodeVerifierKey(this.clientId, parsed.nonce), pending);
    await this.storage.delete(challengeKey);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.deleteExpiredChallengeCodeVerifiers(this.clientId);
    const challenge = await createCodeChallenge(verifier);
    const stored: StoredCodeVerifier = { verifier, createdAt: Date.now() };
    await this.storage.put(this.challengeCodeVerifierKey(this.clientId, challenge), stored);
  }

  /**
   * Run `callback` while the code verifier lookup is bound to the callback's
   * state, so finishing authorization reads the verifier of that exact flow.
   */
  async withCallbackState<T>(state: string, callback: () => Promise<T>): Promise<T> {
    if (this.callbackState !== undefined) {
      throw new Error("Another OAuth callback is already completing for this server");
    }
    this.callbackState = state;
    this.servedVerifierKey = undefined;
    try {
      return await callback();
    } finally {
      this.callbackState = undefined;
      this.servedVerifierKey = undefined;
    }
  }

  async codeVerifier(): Promise<string> {
    if (this.callbackState !== undefined) {
      const parsed = parseOAuthState(this.callbackState);
      if (!parsed) throw new Error("Invalid state format");
      const key = this.stateCodeVerifierKey(this.clientId, parsed.nonce);
      const stored = await this.storage.get<StoredCodeVerifier>(key);
      if (stored) {
        if (isExpired(stored.createdAt)) {
          await this.storage.delete(key);
          throw new Error("Code verifier expired");
        }
        this.servedVerifierKey = key;
        return stored.verifier;
      }
    }
    const legacyKey = this.codeVerifierKey(this.clientId);
    const legacy = await this.storage.get<string>(legacyKey);
    if (legacy) {
      this.servedVerifierKey = legacyKey;
      return legacy;
    }
    if (this.callbackState !== undefined) throw new Error("No code verifier found for OAuth state");
    const pending = await this.storage.list<StoredCodeVerifier>({
      prefix: this.stateCodeVerifierPrefix(this.clientId),
    });
    const live: string[] = [];
    const expired: string[] = [];
    for (const [key, stored] of pending) {
      (isExpired(stored.createdAt) ? expired : live).push(key);
    }
    if (expired.length > 0) await this.storage.delete(expired);
    if (live.length === 1) {
      const stored = pending.get(live[0]);
      if (stored) return stored.verifier;
    }
    if (live.length > 1) {
      throw new Error("Multiple OAuth code verifiers are pending; complete authorization with the callback state");
    }
    throw new Error("No code verifier found");
  }

  async deleteCodeVerifier(): Promise<void> {
    if (this.servedVerifierKey) {
      await this.storage.delete(this.servedVerifierKey);
      this.servedVerifierKey = undefined;
      return;
    }
    if (this.callbackState !== undefined) {
      const parsed = parseOAuthState(this.callbackState);
      if (parsed) {
        await this.storage.delete(this.stateCodeVerifierKey(this.clientId, parsed.nonce));
        return;
      }
    }
    const keys = await this.codeVerifierKeys(this.clientId, { includeChallengeKeys: false });
    if (keys.length > 0) await this.storage.delete(keys);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (!this.storedClientId) return;
    const keys: string[] = [];
    if (scope === "all" || scope === "client") keys.push(this.clientInfoKey(this.clientId));
    if (scope === "all" || scope === "tokens") keys.push(this.tokenKey(this.clientId));
    if (scope === "all" || scope === "verifier") {
      keys.push(...await this.codeVerifierKeys(this.clientId, { includeChallengeKeys: true }));
    }
    if (keys.length > 0) await this.storage.delete(keys);
  }

  private async codeVerifierKeys(
    clientId: string,
    options: { includeChallengeKeys: boolean },
  ): Promise<string[]> {
    const keys: string[] = [];
    const legacyKey = this.codeVerifierKey(clientId);
    if (await this.storage.get(legacyKey)) keys.push(legacyKey);
    const byState = await this.storage.list({ prefix: this.stateCodeVerifierPrefix(clientId) });
    keys.push(...byState.keys());
    if (options.includeChallengeKeys) {
      const byChallenge = await this.storage.list({
        prefix: this.challengeCodeVerifierPrefix(clientId),
      });
      keys.push(...byChallenge.keys());
    }
    return keys;
  }

  private async deleteExpiredChallengeCodeVerifiers(clientId: string): Promise<void> {
    const entries = await this.storage.list<StoredCodeVerifier>({
      prefix: this.challengeCodeVerifierPrefix(clientId),
    });
    const expired = [...entries].filter(([, stored]) => isExpired(stored.createdAt)).map(([key]) => key);
    if (expired.length > 0) await this.storage.delete(expired);
  }

  private keyPrefix(clientId: string): string {
    return `/${this.clientName}/${this.serverId}/${clientId}`;
  }

  private clientInfoKey(clientId: string): string {
    return `${this.keyPrefix(clientId)}/client_info/`;
  }

  private tokenKey(clientId: string): string {
    return `${this.keyPrefix(clientId)}/token`;
  }

  private stateKey(nonce: string): string {
    return `/${this.clientName}/${this.serverId}/state/${nonce}`;
  }

  private codeVerifierKey(clientId: string): string {
    return `${this.keyPrefix(clientId)}/code_verifier`;
  }

  private stateCodeVerifierPrefix(clientId: string): string {
    return `${this.keyPrefix(clientId)}/code_verifier/`;
  }

  private stateCodeVerifierKey(clientId: string, nonce: string): string {
    return `${this.stateCodeVerifierPrefix(clientId)}${nonce}`;
  }

  private challengeCodeVerifierPrefix(clientId: string): string {
    return `${this.keyPrefix(clientId)}/code_verifier_challenge/`;
  }

  private challengeCodeVerifierKey(clientId: string, challenge: string): string {
    return `${this.challengeCodeVerifierPrefix(clientId)}${challenge}`;
  }
}
