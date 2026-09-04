import type {
  JsonObject,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type {
  OAuthAccountRecord,
  OAuthStore,
} from "../oauth-store";
import { z } from "zod";

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
const nonemptyTextSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.union([
  z.number(),
  z.string().trim().min(1).transform(Number),
]).pipe(z.number().finite().positive()).transform(Math.floor);

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
    throw new Error(`OpenAI Codex device code request failed with status ${response.status}${describeAuthFailure(await readLimitedText(response))}`);
  }

  const json = await readJsonObject(response);
  const deviceAuthId = stringField(json, "device_auth_id");
  const userCode = stringField(json, "user_code");
  const intervalSeconds = positiveNumberField(json, "interval") ?? 5;
  const expiresInSeconds = positiveNumberField(json, "expires_in") ?? OPENAI_CODEX_DEVICE_EXPIRES_SECONDS;
  if (!deviceAuthId || !userCode) {
    throw new Error(`Invalid OpenAI Codex device code response: ${describeMissingFields(json, ["device_auth_id", "user_code"])}`);
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
      throw new Error(`Invalid OpenAI Codex device token response: ${describeMissingFields(json, ["authorization_code", "code_verifier"])}`);
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
  throw new Error(`OpenAI Codex device auth failed with status ${response.status}${describeAuthFailure(body)}`);
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

/**
 * Reduces an auth endpoint's failure body to its OAuth error code and
 * description. Anything else in the body, including any token material a
 * misbehaving endpoint might echo, never reaches an error message.
 */
function describeAuthFailure(body: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return "";
  }
  const parsed = z.object({
    error: z.string().trim().min(1).optional(),
    error_description: z.string().trim().min(1).optional(),
  }).safeParse(decoded);
  if (!parsed.success || !parsed.data.error) {
    return "";
  }
  const description = parsed.data.error_description?.slice(0, 200);
  return `: ${parsed.data.error}${description ? `: ${description}` : ""}`;
}

/**
 * Names the expected fields a response lacks. Auth responses carry tokens, so
 * errors describe their shape and never echo their contents.
 */
function describeMissingFields(json: JsonObject, expected: readonly string[]): string {
  const missing = expected.filter((field) => !stringField(json, field) && positiveNumberField(json, field) === null);
  const present = Object.keys(json).sort();
  return `missing ${missing.length > 0 ? missing.join(", ") : "expected fields"}; received ${present.length > 0 ? present.join(", ") : "an empty object"}`;
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
  const metadata: OAuthAccountRecord["metadata"] = {
    ...account.metadata,
    refreshedAt: now,
  };
  if (token.accountId) {
    metadata.chatgptAccountId = token.accountId;
  }
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
    metadata,
  });
}

export function openAICodexAccountNeedsRefresh(
  account: OAuthAccountRecord,
  now = Date.now(),
): boolean {
  return account.expiresAt !== null
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
    throw new Error(`OpenAI Codex token ${operation} failed with status ${response.status}${describeAuthFailure(await readLimitedText(response))}`);
  }

  const json = await readJsonObject(response);
  const accessToken = stringField(json, "access_token");
  const refreshToken = stringField(json, "refresh_token") ??
    (operation === "refresh" ? fallbackRefreshToken ?? null : null);
  const idToken = stringField(json, "id_token");
  const expiresIn = positiveNumberField(json, "expires_in");
  if (!accessToken || !refreshToken || expiresIn === null) {
    const expected = fallbackRefreshToken
      ? ["access_token", "expires_in"]
      : ["access_token", "refresh_token", "expires_in"];
    throw new Error(`OpenAI Codex token ${operation} response ${describeMissingFields(json, expected)}`);
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

async function readJsonObject(response: Response): Promise<JsonObject> {
  const text = await readLimitedText(response);
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
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
    const parsed = jsonObjectSchema.parse(JSON.parse(body));
    const directError = stringValue(parsed.error);
    if (directError) {
      return directError;
    }
    const nestedError = objectField(parsed.error);
    return stringValue(nestedError?.code);
  } catch {
    // not JSON
  }
  return null;
}

function stringField(record: JsonObject, key: string): string | null {
  return stringValue(record[key]);
}

function positiveNumberField(record: JsonObject, key: string): number | null {
  const parsed = positiveIntegerSchema.safeParse(record[key]);
  return parsed.success ? parsed.data : null;
}

function accountIdFromJwtPayload(payload: JsonObject): string | null {
  const auth = objectField(payload[OPENAI_CODEX_JWT_CLAIM_PATH]);
  return stringValue(auth?.chatgpt_account_id)
    ?? stringValue(payload.chatgpt_account_id)
    ?? stringValue(payload.account_id);
}

function objectField(value: JsonValue | undefined): JsonObject | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stringValue(value: JsonValue | undefined): string | null {
  const parsed = nonemptyTextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeJwtPayload(token: string): JsonObject {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT");
  }
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  const parsed = jsonObjectSchema.safeParse(JSON.parse(decoded));
  if (!parsed.success) {
    throw new Error("Invalid JWT payload");
  }
  return parsed.data;
}
