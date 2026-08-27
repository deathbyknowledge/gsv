import {
  classifyNonIdempotentProviderStatus,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";

const SLACK_API_BASE = "https://slack.com/api";

export type SlackFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type SlackApiEnvelope = {
  ok?: boolean;
  error?: string;
};

export type SlackBotIdentity = {
  teamId: string;
  teamName?: string;
  botUserId: string;
};

export type SlackOAuthInstallation = SlackBotIdentity & {
  botToken: string;
  appId?: string;
  scope?: string;
};

export type SlackPostMessageInput = {
  channel: string;
  text: string;
  threadTs?: string;
};

export type SlackPostMessageResult = {
  channel: string;
  ts: string;
};

type SlackPostMessagePayload = {
  channel: string;
  text: string;
  unfurl_links: false;
  unfurl_media: false;
  thread_ts?: string;
};

type SlackApiPayload = {
  channel?: string;
  text?: string;
  unfurl_links?: false;
  unfurl_media?: false;
  thread_ts?: string;
  users?: string;
  return_im?: false;
};

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly kind: DeliveryFailureKind,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export async function authenticateSlackBot(
  botToken: string,
  slackFetch: SlackFetch = fetch,
): Promise<SlackBotIdentity> {
  const result = await callSlackApi<{
    team_id?: string;
    team?: string;
    user_id?: string;
  }>("auth.test", botToken, {}, slackFetch);
  return {
    teamId: requireSlackId(result.team_id, "Slack workspace"),
    teamName: optionalText(result.team, 160),
    botUserId: requireSlackId(result.user_id, "Slack bot user"),
  };
}

export async function openSlackSocket(
  appToken: string,
  slackFetch: SlackFetch = fetch,
): Promise<string> {
  const result = await callSlackApi<{ url?: string }>(
    "apps.connections.open",
    appToken,
    {},
    slackFetch,
  );
  const url = new URL(result.url ?? "");
  if (url.protocol !== "wss:" || !url.hostname.endsWith(".slack.com")) {
    throw new SlackApiError("Slack returned an invalid Socket Mode URL", "permanent");
  }
  return url.toString();
}

export async function openSlackDm(
  botToken: string,
  actorId: string,
  slackFetch: SlackFetch = fetch,
): Promise<string> {
  const result = await callSlackApi<{ channel?: { id?: string } }>(
    "conversations.open",
    botToken,
    { users: requireSlackId(actorId, "Slack actor"), return_im: false },
    slackFetch,
  );
  return requireSlackId(result.channel?.id, "Slack direct message");
}

export async function postSlackMessage(
  botToken: string,
  input: SlackPostMessageInput,
  slackFetch: SlackFetch = fetch,
): Promise<SlackPostMessageResult> {
  const payload: SlackPostMessagePayload = {
    channel: requireSlackId(input.channel, "Slack channel"),
    text: requireText(input.text, "Slack message", 40_000),
    unfurl_links: false,
    unfurl_media: false,
  };
  if (input.threadTs) payload.thread_ts = requireSlackTimestamp(input.threadTs);
  const result = await callSlackApi<{ channel?: string; ts?: string }>(
    "chat.postMessage",
    botToken,
    payload,
    slackFetch,
  );
  return {
    channel: requireSlackId(result.channel, "Slack response channel"),
    ts: requireSlackTimestamp(result.ts),
  };
}

export async function exchangeSlackOAuthCode(
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
  slackFetch: SlackFetch = fetch,
): Promise<SlackOAuthInstallation> {
  const body = new URLSearchParams({
    code: requireText(input.code, "Slack OAuth code", 1_024),
    redirect_uri: requireHttpsUrl(input.redirectUri, "Slack OAuth redirect URI"),
  });
  const authorization = btoa(`${requireText(input.clientId, "Slack client ID", 256)}:${requireText(input.clientSecret, "Slack client secret", 512)}`);
  let response: Response;
  try {
    response = await slackFetch(`${SLACK_API_BASE}/oauth.v2.access`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body,
    });
  } catch {
    throw new SlackApiError("Slack OAuth transport failed", "retryable");
  }
  const parsed = await parseSlackResponse<{
    access_token?: string;
    bot_user_id?: string;
    app_id?: string;
    scope?: string;
    is_enterprise_install?: boolean;
    team?: { id?: string; name?: string };
  }>(response, "oauth.v2.access");
  if (parsed.is_enterprise_install === true) {
    throw new SlackApiError(
      "Organization-wide Slack installations are not supported",
      "permanent",
    );
  }
  return {
    teamId: requireSlackId(parsed.team?.id, "Slack workspace"),
    teamName: optionalText(parsed.team?.name, 160),
    botUserId: requireSlackId(parsed.bot_user_id, "Slack bot user"),
    botToken: requireSlackToken(parsed.access_token, "Slack bot token", "xoxb-"),
    appId: parsed.app_id ? requireSlackId(parsed.app_id, "Slack app") : undefined,
    scope: optionalText(parsed.scope, 2_048),
  };
}

export async function workspaceAccountId(teamId: string): Promise<string> {
  const normalized = requireSlackId(teamId, "Slack workspace");
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`slack-workspace:${normalized}`),
  ));
  const encoded = bytesToBase64Url(digest);
  return `workspace:${encoded}`;
}

export function requireSlackToken(
  value: string | undefined,
  label: string,
  prefix: "xoxb-" | "xapp-",
): string {
  const token = value?.trim() ?? "";
  if (!token.startsWith(prefix) || token.length < prefix.length + 12 || token.length > 1_024) {
    throw new Error(`${label} is invalid`);
  }
  return token;
}

export function requireSlackId(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^[A-Z][A-Z0-9]{1,31}$/.test(normalized)) {
    throw new Error(`${label} ID is invalid`);
  }
  return normalized;
}

export function requireSlackTimestamp(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9]{1,16}\.[0-9]{1,16}$/.test(normalized)) {
    throw new Error("Slack timestamp is invalid");
  }
  return normalized;
}

async function callSlackApi<T extends object>(
  method: string,
  token: string,
  payload: SlackApiPayload,
  slackFetch: SlackFetch,
): Promise<T> {
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > 1_024) {
    throw new SlackApiError("Slack token is invalid", "permanent");
  }
  let response: Response;
  try {
    response = await slackFetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new SlackApiError(`Slack API ${method} transport failed`, "ambiguous");
  }
  return await parseSlackResponse<T>(response, method);
}

async function parseSlackResponse<T extends object>(
  response: Response,
  method: string,
): Promise<T> {
  let value: SlackApiEnvelope & T;
  try {
    value = await response.json<SlackApiEnvelope & T>();
  } catch {
    throw new SlackApiError(
      `Slack API ${method} returned an unreadable response`,
      response.ok ? "ambiguous" : classifyNonIdempotentProviderStatus(response.status),
      undefined,
      response.status,
    );
  }
  if (!response.ok || value.ok !== true) {
    const code = optionalText(value.error, 200) ?? "unknown_error";
    throw new SlackApiError(
      `Slack API ${method} failed (${code})`,
      slackFailureKind(response.status, code),
      code,
      response.status,
    );
  }
  return value;
}

function slackFailureKind(status: number, code: string): DeliveryFailureKind {
  if (status === 429 || code === "ratelimited" || code === "rate_limited") {
    return "retryable";
  }
  if (status >= 500 || status === 408) return "ambiguous";
  if (["internal_error", "request_timeout", "service_unavailable"].includes(code)) {
    return "retryable";
  }
  return "permanent";
}

function requireText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} is invalid`);
  return normalized;
}

function optionalText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim().slice(0, maxLength) ?? "";
  return normalized || undefined;
}

function requireHttpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} is invalid`);
  }
  return url.toString();
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
