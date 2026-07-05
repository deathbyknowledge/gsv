import type {
  OAuthAccountRecord,
  OAuthStore,
} from "../oauth-store";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_CODEX_ACCOUNT_KEY = "default";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_DEVICE_USER_CODE_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
export const OPENAI_CODEX_DEVICE_TOKEN_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const OPENAI_CODEX_TOKEN_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`;
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/codex/device`;
export const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${OPENAI_CODEX_AUTH_BASE_URL}/deviceauth/callback`;
export const OPENAI_CODEX_SCOPE = "openid profile email offline_access";

const OPENAI_CODEX_DEVICE_EXPIRES_SECONDS = 15 * 60;
const OPENAI_CODEX_REFRESH_SKEW_MS = 60_000;
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_AUTH_RESPONSE_BYTES = 16 * 1024;

export type OpenAICodexDeviceStart = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresInSeconds: number;
};

export type OpenAICodexDevicePoll =
  | {
      status: "pending";
      intervalSeconds?: number;
    }
  | {
      status: "complete";
      authorizationCode: string;
      codeVerifier: string;
    };

export type OpenAICodexToken = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
  accountId: string | null;
};

export async function startOpenAICodexDeviceFlow(
  fetcher: typeof fetch = fetch,
): Promise<OpenAICodexDeviceStart> {
  const response = await fetcher(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI Codex device code request failed with status ${response.status}: ${await readLimitedText(response)}`);
  }

  const json = await readJsonObject(response);
  const deviceAuthId = stringField(json, "device_auth_id");
  const userCode = stringField(json, "user_code");
  const intervalSeconds = positiveNumberField(json, "interval") ?? 5;
  const expiresInSeconds = positiveNumberField(json, "expires_in") ?? OPENAI_CODEX_DEVICE_EXPIRES_SECONDS;
  if (!deviceAuthId || !userCode) {
    throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
  }

  return {
    deviceAuthId,
    userCode,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    intervalSeconds,
    expiresInSeconds,
  };
}

export async function pollOpenAICodexDeviceFlow(
  input: {
    deviceAuthId: string;
    userCode: string;
    intervalSeconds?: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<OpenAICodexDevicePoll> {
  const response = await fetcher(OPENAI_CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
  });

  if (response.ok) {
    const json = await readJsonObject(response);
    const authorizationCode = stringField(json, "authorization_code");
    const codeVerifier = stringField(json, "code_verifier");
    if (!authorizationCode || !codeVerifier) {
      throw new Error(`Invalid OpenAI Codex device token response: ${JSON.stringify(json)}`);
    }
    return {
      status: "complete",
      authorizationCode,
      codeVerifier,
    };
  }

  if (response.status === 403 || response.status === 404) {
    return { status: "pending", intervalSeconds: input.intervalSeconds };
  }

  const body = await readLimitedText(response);
  const errorCode = parseOAuthErrorCode(body);
  if (errorCode === "deviceauth_authorization_pending") {
    return { status: "pending", intervalSeconds: input.intervalSeconds };
  }
  if (errorCode === "slow_down") {
    return { status: "pending", intervalSeconds: (input.intervalSeconds ?? 5) + 5 };
  }
  throw new Error(`OpenAI Codex device auth failed with status ${response.status}${body ? `: ${body}` : ""}`);
}

export async function exchangeOpenAICodexAuthorizationCode(
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch = fetch,
): Promise<OpenAICodexToken> {
  return exchangeOpenAICodexToken({
    grant_type: "authorization_code",
    client_id: OPENAI_CODEX_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
  }, "exchange", fetcher);
}

export async function refreshOpenAICodexAccount(
  oauth: OAuthStore,
  account: OAuthAccountRecord,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<OAuthAccountRecord> {
  if (!account.refreshToken) {
    throw new Error("OpenAI Codex OAuth account is missing a refresh token");
  }
  const token = await exchangeOpenAICodexToken({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    client_id: OPENAI_CODEX_CLIENT_ID,
  }, "refresh", fetcher, account.refreshToken);
  return oauth.upsertAccount({
    uid: account.uid,
    kind: account.kind,
    provider: account.provider,
    accountKey: account.accountKey,
    label: account.label,
    scope: account.scope,
    resource: account.resource,
    clientId: account.clientId,
    tokenType: token.tokenType,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    metadata: {
      ...account.metadata,
      ...(token.accountId ? { chatgptAccountId: token.accountId } : {}),
      refreshedAt: now,
    },
  });
}

export function openAICodexAccountNeedsRefresh(
  account: OAuthAccountRecord,
  now = Date.now(),
): boolean {
  return typeof account.expiresAt === "number"
    && account.expiresAt <= now + OPENAI_CODEX_REFRESH_SKEW_MS;
}

export function extractOpenAICodexAccountId(token: string): string | null {
  try {
    return accountIdFromJwtPayload(decodeJwtPayload(token));
  } catch {
    return null;
  }
}

async function exchangeOpenAICodexToken(
  params: Record<string, string>,
  operation: "exchange" | "refresh",
  fetcher: typeof fetch,
  fallbackRefreshToken?: string,
): Promise<OpenAICodexToken> {
  const response = await fetcher(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new Error(`OpenAI Codex token ${operation} failed with status ${response.status}: ${await readLimitedText(response)}`);
  }

  const json = await readJsonObject(response);
  const accessToken = stringField(json, "access_token");
  const refreshToken = stringField(json, "refresh_token") ??
    (operation === "refresh" ? fallbackRefreshToken ?? null : null);
  const idToken = stringField(json, "id_token");
  const expiresIn = positiveNumberField(json, "expires_in");
  if (!accessToken || !refreshToken || expiresIn === null) {
    throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
  }
  const accountId = extractOpenAICodexAccountId(accessToken)
    ?? (idToken ? extractOpenAICodexAccountId(idToken) : null);
  return {
    accessToken,
    refreshToken,
    tokenType: stringField(json, "token_type") ?? "Bearer",
    expiresAt: Date.now() + expiresIn * 1000,
    accountId,
  };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await readLimitedText(response);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  throw new Error("OpenAI Codex auth endpoint returned invalid JSON");
}

async function readLimitedText(response: Response, maxBytes = MAX_AUTH_RESPONSE_BYTES): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        text += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (received - maxBytes))));
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return text;
}

function parseOAuthErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const code = (error as Record<string, unknown>).code;
      return typeof code === "string" ? code : null;
    }
  } catch {
    // not JSON
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  const number = typeof value === "string" ? Number(value.trim()) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : null;
}

function accountIdFromJwtPayload(payload: Record<string, unknown>): string | null {
  const auth = objectField(payload[OPENAI_CODEX_JWT_CLAIM_PATH]);
  return stringValue(auth?.chatgpt_account_id)
    ?? stringValue(payload.chatgpt_account_id)
    ?? stringValue(payload.account_id);
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT");
  }
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JWT payload");
  }
  return parsed as Record<string, unknown>;
}
