import type {
  SysOAuthAccountSummary,
  SysOAuthConnectionKind,
  SysOAuthDevicePollArgs,
  SysOAuthDevicePollResult,
  SysOAuthDeviceStartArgs,
  SysOAuthDeviceStartResult,
  SysOAuthFlowSummary,
  SysOAuthForgetArgs,
  SysOAuthForgetResult,
  SysOAuthListArgs,
  SysOAuthListResult,
  SysOAuthStartArgs,
  SysOAuthStartResult,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type {
  OAuthAccountRecord,
  OAuthConnectionKind,
  OAuthFlowRecord,
  OAuthStore,
} from "../oauth-store";
import {
  OPENAI_CODEX_ACCOUNT_KEY,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_SCOPE,
  OPENAI_CODEX_TOKEN_URL,
  exchangeOpenAICodexAuthorizationCode,
  pollOpenAICodexDeviceFlow,
  startOpenAICodexDeviceFlow,
} from "./openai-codex-oauth";

const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const OAUTH_KINDS = new Set<OAuthConnectionKind>(["ai-provider", "mcp-server", "generic"]);
const OAUTH_DEVICE_FLOW_KIND: OAuthConnectionKind = "ai-provider";
const EXTRA_AUTH_RESERVED_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
]);

export type OAuthCallbackInput = {
  state?: string | null;
  code?: string | null;
  error?: string | null;
  errorDescription?: string | null;
};

export type OAuthCallbackResult =
  | { ok: true; account: SysOAuthAccountSummary }
  | { ok: false; status: number; message: string };

function requireUid(ctx: KernelContext): number {
  const uid = ctx.identity?.process.uid;
  if (typeof uid !== "number") {
    throw new Error("Authentication required");
  }
  return uid;
}

function parseOptionalUid(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Number.isInteger(input) || typeof input !== "number" || input < 0) {
    throw new Error("uid must be a non-negative integer");
  }
  return input;
}

function parseKind(input: unknown): OAuthConnectionKind {
  if (typeof input !== "string" || !OAUTH_KINDS.has(input as OAuthConnectionKind)) {
    throw new Error("kind must be one of: ai-provider, mcp-server, generic");
  }
  return input as OAuthConnectionKind;
}

function parseRequiredString(input: unknown, field: string, maxLength = 512): string {
  if (typeof input !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${field} is too long`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return trimmed;
}

function parseOptionalString(input: unknown, field: string, maxLength = 1024): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new Error(`${field} is too long`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return trimmed;
}

function parseOAuthUrl(input: unknown, field: string): string {
  const value = parseRequiredString(input, field, 2048);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not include credentials`);
  }
  if (parsed.protocol === "https:") {
    return parsed.toString();
  }
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return parsed.toString();
  }
  throw new Error(`${field} must use https, except localhost development URLs`);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function parseExtraAuthParams(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("extraAuthParams must be an object");
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(key)) {
      throw new Error(`extraAuthParams key is invalid: ${key}`);
    }
    if (EXTRA_AUTH_RESERVED_PARAMS.has(key.toLowerCase())) {
      throw new Error(`extraAuthParams cannot override ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`extraAuthParams.${key} must be a string`);
    }
    params[key] = value;
  }
  return params;
}

export async function handleSysOAuthStart(
  args: SysOAuthStartArgs,
  ctx: KernelContext,
): Promise<SysOAuthStartResult> {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;
  const raw = args as Record<string, unknown>;
  const targetUid = parseOptionalUid(raw.uid) ?? callerUid;
  if (!isRoot && targetUid !== callerUid) {
    throw new Error("Permission denied: cannot start OAuth for another user");
  }

  const kind = parseKind(raw.kind);
  const provider = parseRequiredString(raw.provider, "provider", 200);
  const accountKey = parseOptionalString(raw.accountKey, "accountKey", 200) ?? "default";
  const label = parseOptionalString(raw.label, "label", 200);
  const authorizationEndpoint = parseOAuthUrl(raw.authorizationEndpoint, "authorizationEndpoint");
  const tokenEndpoint = parseOAuthUrl(raw.tokenEndpoint, "tokenEndpoint");
  const clientId = parseRequiredString(raw.clientId, "clientId", 512);
  const redirectUri = parseOAuthUrl(raw.redirectUri, "redirectUri");
  const scope = parseOptionalString(raw.scope, "scope", 1000);
  const resource = parseOptionalString(raw.resource, "resource", 2048);
  const extraAuthParams = parseExtraAuthParams(raw.extraAuthParams);

  const now = Date.now();
  ctx.oauth.cleanupExpiredFlows(now);

  const state = createOpaqueToken();
  const stateHash = await sha256Hex(state);
  const pkce = await createPkcePair();
  const flow = ctx.oauth.createFlow({
    stateHash,
    uid: targetUid,
    kind,
    provider,
    accountKey,
    label,
    authorizationEndpoint,
    tokenEndpoint,
    clientId,
    redirectUri,
    scope,
    resource,
    extraAuthParams,
    codeVerifier: pkce.verifier,
    createdAt: now,
    expiresAt: now + OAUTH_FLOW_TTL_MS,
  });

  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (scope) authorizationUrl.searchParams.set("scope", scope);
  if (resource) authorizationUrl.searchParams.set("resource", resource);
  for (const [key, value] of Object.entries(extraAuthParams)) {
    authorizationUrl.searchParams.set(key, value);
  }

  return {
    authorizationUrl: authorizationUrl.toString(),
    flow: summarizeFlow(flow),
  };
}

export async function handleSysOAuthDeviceStart(
  args: SysOAuthDeviceStartArgs,
  ctx: KernelContext,
  fetcher: typeof fetch = fetch,
): Promise<SysOAuthDeviceStartResult> {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;
  const raw = args as Record<string, unknown>;
  const targetUid = parseOptionalUid(raw.uid) ?? callerUid;
  if (!isRoot && targetUid !== callerUid) {
    throw new Error("Permission denied: cannot start OAuth for another user");
  }

  const provider = parseRequiredString(raw.provider, "provider", 200);
  if (provider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(`Unsupported OAuth device provider: ${provider}`);
  }
  const kind = parseKind(raw.kind);
  if (kind !== OAUTH_DEVICE_FLOW_KIND) {
    throw new Error("OpenAI Codex device OAuth must use kind: ai-provider");
  }
  const accountKey = parseOptionalString(raw.accountKey, "accountKey", 200) ?? OPENAI_CODEX_ACCOUNT_KEY;
  const label = parseOptionalString(raw.label, "label", 200) ?? "OpenAI Codex";
  const now = Date.now();
  ctx.oauth.cleanupExpiredFlows(now);

  const device = await startOpenAICodexDeviceFlow(fetcher);
  const stateHash = await sha256Hex(createOpaqueToken());
  const flow = ctx.oauth.createFlow({
    stateHash,
    uid: targetUid,
    kind,
    provider,
    accountKey,
    label,
    authorizationEndpoint: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    tokenEndpoint: OPENAI_CODEX_TOKEN_URL,
    clientId: OPENAI_CODEX_CLIENT_ID,
    redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    scope: OPENAI_CODEX_SCOPE,
    resource: null,
    extraAuthParams: {
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
      verification_uri: device.verificationUrl,
      interval_seconds: String(device.intervalSeconds),
      device_token_endpoint: OPENAI_CODEX_DEVICE_TOKEN_URL,
    },
    codeVerifier: "",
    createdAt: now,
    expiresAt: now + device.expiresInSeconds * 1000,
  });

  return {
    flow: summarizeFlow(flow),
    provider,
    userCode: device.userCode,
    verificationUrl: device.verificationUrl,
    intervalSeconds: device.intervalSeconds,
    expiresAt: flow.expiresAt,
  };
}

export async function handleSysOAuthDevicePoll(
  args: SysOAuthDevicePollArgs,
  ctx: KernelContext,
  fetcher: typeof fetch = fetch,
): Promise<SysOAuthDevicePollResult> {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;
  const raw = args as Record<string, unknown>;
  const requestedUid = parseOptionalUid(raw.uid);
  if (!isRoot && requestedUid !== undefined && requestedUid !== callerUid) {
    throw new Error("Permission denied: cannot poll OAuth for another user");
  }

  const flowId = parseRequiredString(raw.flowId, "flowId", 200);
  const effectiveUid = isRoot ? requestedUid : callerUid;
  const flow = ctx.oauth.getFlow(flowId, effectiveUid);
  if (!flow) {
    throw new Error("OAuth device flow not found or expired");
  }
  if (flow.kind !== OAUTH_DEVICE_FLOW_KIND || flow.provider !== OPENAI_CODEX_PROVIDER) {
    throw new Error("OAuth device flow is not an OpenAI Codex flow");
  }

  const deviceAuthId = flow.extraAuthParams.device_auth_id;
  const userCode = flow.extraAuthParams.user_code;
  if (!deviceAuthId || !userCode) {
    throw new Error("OAuth device flow is missing device metadata");
  }
  const intervalSeconds = parsePositiveInt(flow.extraAuthParams.interval_seconds) ?? 5;
  const poll = await pollOpenAICodexDeviceFlow({
    deviceAuthId,
    userCode,
    intervalSeconds,
  }, fetcher);
  if (poll.status === "pending") {
    return {
      status: "pending",
      flow: summarizeFlow(flow),
      intervalSeconds: poll.intervalSeconds ?? intervalSeconds,
      expiresAt: flow.expiresAt,
    };
  }

  const token = await exchangeOpenAICodexAuthorizationCode(
    poll.authorizationCode,
    poll.codeVerifier,
    fetcher,
  );
  const now = Date.now();
  const account = ctx.oauth.upsertAccount({
    uid: flow.uid,
    kind: flow.kind,
    provider: flow.provider,
    accountKey: flow.accountKey,
    label: flow.label,
    scope: flow.scope,
    resource: flow.resource,
    clientId: flow.clientId,
    tokenType: token.tokenType,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    metadata: {
      authorizedAt: now,
      ...(token.accountId ? { chatgptAccountId: token.accountId } : {}),
    },
  });
  ctx.oauth.deleteFlow(flow.flowId);
  return {
    status: "complete",
    account: summarizeAccount(account),
  };
}

export function handleSysOAuthList(
  args: SysOAuthListArgs,
  ctx: KernelContext,
): SysOAuthListResult {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;
  const raw = args as Record<string, unknown>;
  const requestedUid = parseOptionalUid(raw.uid);
  if (!isRoot && requestedUid !== undefined && requestedUid !== callerUid) {
    throw new Error("Permission denied: cannot list OAuth accounts for another user");
  }

  const effectiveUid = isRoot ? requestedUid : callerUid;
  const result: SysOAuthListResult = {
    accounts: ctx.oauth.listAccounts(effectiveUid).map(summarizeAccount),
  };
  if (raw.includePending === true) {
    result.flows = ctx.oauth.listFlows(effectiveUid).map(summarizeFlow);
  }
  return result;
}

export function handleSysOAuthForget(
  args: SysOAuthForgetArgs,
  ctx: KernelContext,
): SysOAuthForgetResult {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;
  const raw = args as Record<string, unknown>;
  const accountId = parseRequiredString(raw.accountId, "accountId", 200);
  const requestedUid = parseOptionalUid(raw.uid);
  if (!isRoot && requestedUid !== undefined && requestedUid !== callerUid) {
    throw new Error("Permission denied: cannot forget OAuth accounts for another user");
  }

  const effectiveUid = isRoot ? requestedUid : callerUid;
  return { forgotten: ctx.oauth.deleteAccount(accountId, effectiveUid) };
}

export async function completeOAuthCallback(
  input: OAuthCallbackInput,
  oauth: OAuthStore,
  fetcher: typeof fetch = fetch,
): Promise<OAuthCallbackResult> {
  const state = input.state?.trim();
  if (!state) {
    return { ok: false, status: 400, message: "Missing OAuth state" };
  }

  const flow = oauth.consumeFlowByStateHash(await sha256Hex(state));
  if (!flow) {
    return { ok: false, status: 400, message: "OAuth flow not found or expired" };
  }

  const providerError = input.error?.trim();
  if (providerError) {
    const detail = input.errorDescription?.trim();
    return {
      ok: false,
      status: 400,
      message: detail
        ? `OAuth provider rejected authorization: ${providerError} (${detail})`
        : `OAuth provider rejected authorization: ${providerError}`,
    };
  }

  const code = input.code?.trim();
  if (!code) {
    return { ok: false, status: 400, message: "Missing OAuth authorization code" };
  }

  const token = await exchangeAuthorizationCode(flow, code, fetcher);
  if (!token.ok) {
    return token;
  }

  const now = Date.now();
  const account = oauth.upsertAccount({
    uid: flow.uid,
    kind: flow.kind,
    provider: flow.provider,
    accountKey: flow.accountKey,
    label: flow.label,
    scope: token.scope ?? flow.scope,
    resource: flow.resource,
    clientId: flow.clientId,
    tokenType: token.tokenType,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn === null ? null : now + token.expiresIn * 1000,
    metadata: {
      authorizedAt: now,
    },
  });
  return { ok: true, account: summarizeAccount(account) };
}

function summarizeFlow(flow: OAuthFlowRecord): SysOAuthFlowSummary {
  return {
    flowId: flow.flowId,
    uid: flow.uid,
    kind: flow.kind as SysOAuthConnectionKind,
    provider: flow.provider,
    accountKey: flow.accountKey,
    label: flow.label,
    authorizationEndpoint: flow.authorizationEndpoint,
    tokenEndpoint: flow.tokenEndpoint,
    clientId: flow.clientId,
    redirectUri: flow.redirectUri,
    scope: flow.scope,
    resource: flow.resource,
    createdAt: flow.createdAt,
    expiresAt: flow.expiresAt,
  };
}

function summarizeAccount(account: OAuthAccountRecord): SysOAuthAccountSummary {
  return {
    accountId: account.accountId,
    uid: account.uid,
    kind: account.kind as SysOAuthConnectionKind,
    provider: account.provider,
    accountKey: account.accountKey,
    label: account.label,
    scope: account.scope,
    resource: account.resource,
    clientId: account.clientId,
    tokenType: account.tokenType,
    expiresAt: account.expiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt,
    metadata: account.metadata,
  };
}

async function exchangeAuthorizationCode(
  flow: OAuthFlowRecord,
  code: string,
  fetcher: typeof fetch,
): Promise<
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      tokenType: string;
      expiresIn: number | null;
      scope: string | null;
    }
  | { ok: false; status: number; message: string }
> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", flow.clientId);
  body.set("code", code);
  body.set("redirect_uri", flow.redirectUri);
  body.set("code_verifier", flow.codeVerifier);
  if (flow.resource) body.set("resource", flow.resource);

  let response: Response;
  try {
    response = await fetcher(flow.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept": "application/json",
      },
      body,
    });
  } catch {
    return { ok: false, status: 502, message: "OAuth token endpoint request failed" };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      message: `OAuth token endpoint returned ${response.status}`,
    };
  }

  let json: Record<string, unknown>;
  try {
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 502, message: "OAuth token endpoint returned an invalid JSON object" };
    }
    json = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, status: 502, message: "OAuth token endpoint returned invalid JSON" };
  }

  const accessToken = stringField(json, "access_token");
  if (!accessToken) {
    return { ok: false, status: 502, message: "OAuth token endpoint did not return an access token" };
  }

  return {
    ok: true,
    accessToken,
    refreshToken: stringField(json, "refresh_token"),
    tokenType: stringField(json, "token_type") ?? "Bearer",
    expiresIn: numberField(json, "expires_in"),
    scope: stringField(json, "scope"),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = createOpaqueToken(48);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(digest)),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
