import {
  classifyNonIdempotentProviderStatus,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  cancelResponseBody,
  responseBodyToBinaryBody,
} from "../../shared/src/media-body";
import type { BinaryBody } from "./types";
import type { SlackBlock } from "./slack-interactions";

const SLACK_API_BASE = "https://slack.com/api";

export type SlackFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type SlackApiEnvelope = {
  ok?: boolean;
  error?: string;
};

type SlackFileApiObject = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

type ParsedSlackFile = {
  filename: string;
  mimeType: string;
  size?: number;
  downloadUrl: string;
};

type SlackConversationApiObject = {
  id?: string;
  name?: string;
  user?: string;
  topic?: { value?: string };
  purpose?: { value?: string };
  is_archived?: boolean;
  is_member?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_group?: boolean;
};

type SlackMessageApiObject = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  reply_count?: number;
};

type SlackUserApiObject = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
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
  user?: {
    id: string;
    token: string;
    scope?: string;
  };
};

export type SlackPostMessageInput = {
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: SlackBlock[];
};

export type SlackPostMessageResult = {
  channel: string;
  ts: string;
};

export type SlackUserIdentity = {
  teamId: string;
  teamName?: string;
  actorId: string;
  actorName?: string;
};

export type SlackConversationSummary = {
  id: string;
  name?: string;
  userId?: string;
  topic?: string;
  purpose?: string;
  isArchived: boolean;
  isMember: boolean;
  isPrivate: boolean;
  kind: "channel" | "group" | "im" | "mpim";
};

export type SlackMessageSummary = {
  ts: string;
  text: string;
  userId?: string;
  botId?: string;
  threadTs?: string;
  replyCount?: number;
};

export type SlackUserSummary = {
  id: string;
  name?: string;
  displayName?: string;
  realName?: string;
  deleted: boolean;
  isBot: boolean;
};

export type SlackPage<T> = {
  items: T[];
  nextCursor?: string;
};

export type SlackUpdateMessageInput = {
  channel: string;
  messageTs: string;
  text: string;
  blocks: SlackBlock[];
};

type SlackPostMessagePayload = {
  channel: string;
  text: string;
  unfurl_links: false;
  unfurl_media: false;
  thread_ts?: string;
  blocks?: SlackBlock[];
};

type SlackApiJson =
  | string
  | number
  | boolean
  | null
  | SlackApiJson[]
  | { [key: string]: SlackApiJson | undefined };

type SlackApiPayload = { [key: string]: SlackApiJson | undefined };

export type SlackDownloadedFile = {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  body: BinaryBody & { length: number };
};

export type SlackUploadFile = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type SlackUploadFilesInput = {
  channel: string;
  text: string;
  threadTs?: string;
  files: SlackUploadFile[];
};

export type SlackUploadFilesResult = {
  fileIds: string[];
};

export type SlackProviderGuard = () => void | Promise<void>;

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

export async function authenticateSlackUser(
  userToken: string,
  slackFetch: SlackFetch = fetch,
): Promise<SlackUserIdentity> {
  const result = await callSlackApi<{
    team_id?: string;
    team?: string;
    user_id?: string;
    user?: string;
  }>("auth.test", userToken, {}, slackFetch);
  return {
    teamId: requireSlackId(result.team_id, "Slack workspace"),
    teamName: optionalText(result.team, 160),
    actorId: requireSlackId(result.user_id, "Slack actor"),
    actorName: optionalText(result.user, 160),
  };
}

export async function listSlackConversations(
  userToken: string,
  input: {
    types: string;
    limit: number;
    cursor?: string;
    excludeArchived?: boolean;
  },
  slackFetch: SlackFetch = fetch,
): Promise<SlackPage<SlackConversationSummary>> {
  const payload = {
    types: requireConversationTypes(input.types),
    limit: requireBoundedInteger(input.limit, "Slack conversation limit", 1, 200),
    exclude_archived: input.excludeArchived === true,
    cursor: input.cursor
      ? requireText(input.cursor, "Slack cursor", 2_048)
      : undefined,
  } satisfies SlackApiPayload;
  const result = await callSlackApi<{
    channels?: SlackConversationApiObject[];
    response_metadata?: { next_cursor?: string };
  }>("conversations.list", userToken, payload, slackFetch);
  return page(
    (result.channels ?? []).map(parseSlackConversation),
    result.response_metadata?.next_cursor,
  );
}

export async function getSlackConversationHistory(
  userToken: string,
  input: { channel: string; limit: number; cursor?: string },
  slackFetch: SlackFetch = fetch,
): Promise<SlackPage<SlackMessageSummary>> {
  return await getSlackMessagesPage(
    "conversations.history",
    userToken,
    input,
    slackFetch,
  );
}

export async function getSlackConversationReplies(
  userToken: string,
  input: { channel: string; timestamp: string; limit: number; cursor?: string },
  slackFetch: SlackFetch = fetch,
): Promise<SlackPage<SlackMessageSummary>> {
  return await getSlackMessagesPage(
    "conversations.replies",
    userToken,
    input,
    slackFetch,
  );
}

export async function addSlackReaction(
  botToken: string,
  input: { channel: string; timestamp: string; name: string },
  slackFetch: SlackFetch = fetch,
): Promise<void> {
  await callSlackApi(
    "reactions.add",
    botToken,
    {
      channel: requireSlackId(input.channel, "Slack channel"),
      timestamp: requireSlackTimestamp(input.timestamp),
      name: requireSlackReaction(input.name),
    },
    slackFetch,
  );
}

export async function listSlackUsers(
  userToken: string,
  input: { limit: number; cursor?: string },
  slackFetch: SlackFetch = fetch,
): Promise<SlackPage<SlackUserSummary>> {
  const payload = {
    limit: requireBoundedInteger(input.limit, "Slack user limit", 1, 200),
    cursor: input.cursor
      ? requireText(input.cursor, "Slack cursor", 2_048)
      : undefined,
  } satisfies SlackApiPayload;
  const result = await callSlackApi<{
    members?: SlackUserApiObject[];
    response_metadata?: { next_cursor?: string };
  }>("users.list", userToken, payload, slackFetch);
  return page(
    (result.members ?? []).map(parseSlackUser),
    result.response_metadata?.next_cursor,
  );
}

export async function getSlackUser(
  userToken: string,
  actorId: string,
  slackFetch: SlackFetch = fetch,
): Promise<SlackUserSummary> {
  const result = await callSlackApi<{ user?: SlackUserApiObject }>(
    "users.info",
    userToken,
    { user: requireSlackId(actorId, "Slack actor") },
    slackFetch,
  );
  return parseSlackUser(result.user);
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
  if (input.blocks?.length) payload.blocks = requireSlackBlocks(input.blocks);
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

export async function updateSlackMessage(
  botToken: string,
  input: SlackUpdateMessageInput,
  slackFetch: SlackFetch = fetch,
): Promise<SlackPostMessageResult> {
  const channel = requireSlackId(input.channel, "Slack channel");
  const ts = requireSlackTimestamp(input.messageTs);
  const result = await callSlackApi<{ channel?: string; ts?: string }>(
    "chat.update",
    botToken,
    {
      channel,
      ts,
      text: requireText(input.text, "Slack message", 40_000),
      blocks: requireSlackBlocks(input.blocks),
    },
    slackFetch,
  );
  return {
    channel: requireSlackId(result.channel, "Slack response channel"),
    ts: requireSlackTimestamp(result.ts),
  };
}

export async function downloadSlackFile(
  botToken: string,
  fileIdInput: string,
  maxBytes: number,
  slackFetch: SlackFetch = fetch,
  guard?: SlackProviderGuard,
): Promise<SlackDownloadedFile> {
  const fileId = requireSlackId(fileIdInput, "Slack file");
  const limit = requireNonNegativeInteger(maxBytes, "Slack file limit");
  await guard?.();
  const result = await callSlackApi<{ file?: SlackFileApiObject }>(
    "files.info",
    botToken,
    { file: fileId },
    slackFetch,
  );
  const file = parseSlackFile(result.file, fileId);
  if (file.size !== undefined && file.size > limit) {
    throw new SlackApiError("Slack file exceeds the GSV media limit", "permanent");
  }

  await guard?.();
  let response: Response;
  try {
    response = await slackFetch(file.downloadUrl, {
      headers: { Authorization: `Bearer ${normalizedSlackToken(botToken)}` },
    });
  } catch {
    throw new SlackApiError("Slack file download transport failed", "retryable");
  }
  if (!response.ok) {
    await cancelResponseBody(response, "Slack file download failed");
    throw new SlackApiError(
      "Slack file download failed",
      response.status === 408 || response.status === 429 || response.status >= 500
        ? "retryable"
        : "permanent",
      undefined,
      response.status,
    );
  }
  try {
    await guard?.();
  } catch (error) {
    await cancelResponseBody(response, error instanceof Error ? error : String(error));
    throw error;
  }
  const body = await responseBodyToBinaryBody(response, {
    maxBytes: limit,
    expectedBytes: file.size,
    label: "Slack file",
  });
  return {
    fileId,
    filename: file.filename,
    mimeType: file.mimeType,
    size: body.length,
    body,
  };
}

export async function uploadSlackFiles(
  botToken: string,
  input: SlackUploadFilesInput,
  slackFetch: SlackFetch = fetch,
  guard?: SlackProviderGuard,
): Promise<SlackUploadFilesResult> {
  const channel = requireSlackId(input.channel, "Slack channel");
  const text = input.text.trim();
  if (text.length > 40_000) throw new Error("Slack message is invalid");
  const threadTs = input.threadTs
    ? requireSlackTimestamp(input.threadTs)
    : undefined;
  if (input.files.length === 0 || input.files.length > 20) {
    throw new Error("Slack deliveries require 1-20 files");
  }

  const tickets: Array<{ id: string }> = [];
  for (const file of input.files) {
    const filename = requireSlackFilename(file.filename);
    const length = requireNonNegativeInteger(file.bytes.byteLength, "Slack file length");
    if (length === 0) throw new Error("Slack cannot upload an empty file");
    await guard?.();
    let ticket: { upload_url?: string; file_id?: string };
    try {
      ticket = await callSlackApi<{ upload_url?: string; file_id?: string }>(
        "files.getUploadURLExternal",
        botToken,
        { filename, length },
        slackFetch,
      );
    } catch (error) {
      if (error instanceof SlackApiError) {
        throw new SlackApiError(
          "Slack upload ticket request failed",
          error.kind === "permanent" ? "permanent" : "retryable",
          error.code,
          error.status,
        );
      }
      throw new SlackApiError("Slack upload ticket request failed", "permanent");
    }
    const uploadUrl = requireSlackHostedUrl(ticket.upload_url, "Slack upload URL");
    const ticketId = requireSlackId(ticket.file_id, "Slack upload file");

    await guard?.();
    let response: Response;
    try {
      response = await slackFetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": normalizedMimeType(file.mimeType),
        },
        body: new Blob([file.bytes], { type: normalizedMimeType(file.mimeType) }),
      });
    } catch {
      throw new SlackApiError("Slack file upload transport failed", "retryable");
    }
    await cancelResponseBody(
      response,
      response.ok ? "Slack upload response consumed" : "Slack file upload failed",
    );
    if (!response.ok) {
      throw new SlackApiError(
        "Slack file upload failed",
        response.status === 408 || response.status === 429 || response.status >= 500
          ? "retryable"
          : "permanent",
        undefined,
        response.status,
      );
    }
    tickets.push({ id: ticketId });
  }

  await guard?.();
  const payload = {
    channel_id: channel,
    files: tickets,
    initial_comment: text || undefined,
    thread_ts: threadTs,
  } satisfies SlackApiPayload;
  let completed: { files?: Array<{ id?: string }> };
  try {
    completed = await callSlackApi<{ files?: Array<{ id?: string }> }>(
      "files.completeUploadExternal",
      botToken,
      payload,
      slackFetch,
    );
  } catch (error) {
    if (
      error instanceof SlackApiError
      && (error.code === "ratelimited" || error.code === "rate_limited")
    ) {
      throw error;
    }
    if (error instanceof SlackApiError && error.kind === "permanent") throw error;
    throw new SlackApiError("Slack file completion outcome is unknown", "ambiguous");
  }
  const fileIds = (completed.files ?? []).map((file) =>
    requireSlackId(file.id, "Slack completed file"));
  if (fileIds.length !== tickets.length) {
    throw new SlackApiError("Slack file completion outcome is unknown", "ambiguous");
  }
  return { fileIds };
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
    authed_user?: {
      id?: string;
      access_token?: string;
      scope?: string;
    };
  }>(response, "oauth.v2.access");
  if (parsed.is_enterprise_install === true) {
    throw new SlackApiError(
      "Organization-wide Slack installations are not supported",
      "permanent",
    );
  }
  const installation: SlackOAuthInstallation = {
    teamId: requireSlackId(parsed.team?.id, "Slack workspace"),
    teamName: optionalText(parsed.team?.name, 160),
    botUserId: requireSlackId(parsed.bot_user_id, "Slack bot user"),
    botToken: requireSlackToken(parsed.access_token, "Slack bot token", "xoxb-"),
    appId: parsed.app_id ? requireSlackId(parsed.app_id, "Slack app") : undefined,
    scope: optionalText(parsed.scope, 2_048),
  };
  if (parsed.authed_user?.access_token) {
    installation.user = {
      id: requireSlackId(parsed.authed_user.id, "Slack authorizing user"),
      token: requireSlackToken(
        parsed.authed_user.access_token,
        "Slack user token",
        "xoxp-",
      ),
      scope: optionalText(parsed.authed_user.scope, 4_096),
    };
  }
  return installation;
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
  prefix: "xoxb-" | "xapp-" | "xoxp-",
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

async function getSlackMessagesPage(
  method: "conversations.history" | "conversations.replies",
  userToken: string,
  input: {
    channel: string;
    timestamp?: string;
    limit: number;
    cursor?: string;
  },
  slackFetch: SlackFetch,
): Promise<SlackPage<SlackMessageSummary>> {
  const payload = {
    channel: requireSlackId(input.channel, "Slack channel"),
    limit: requireBoundedInteger(input.limit, "Slack message limit", 1, 100),
    ts: input.timestamp ? requireSlackTimestamp(input.timestamp) : undefined,
    cursor: input.cursor
      ? requireText(input.cursor, "Slack cursor", 2_048)
      : undefined,
  } satisfies SlackApiPayload;
  const result = await callSlackApi<{
    messages?: SlackMessageApiObject[];
    response_metadata?: { next_cursor?: string };
  }>(method, userToken, payload, slackFetch);
  return page(
    (result.messages ?? []).map(parseSlackMessage),
    result.response_metadata?.next_cursor,
  );
}

function parseSlackConversation(value: SlackConversationApiObject): SlackConversationSummary {
  return {
    id: requireSlackId(value.id, "Slack conversation"),
    name: optionalText(value.name, 160),
    userId: optionalSlackId(value.user, "Slack conversation user"),
    topic: optionalText(value.topic?.value, 2_000),
    purpose: optionalText(value.purpose?.value, 2_000),
    isArchived: value.is_archived === true,
    isMember: value.is_member === true,
    isPrivate: value.is_private === true,
    kind: value.is_im === true
      ? "im"
      : value.is_mpim === true
        ? "mpim"
        : value.is_group === true
          ? "group"
          : "channel",
  };
}

function parseSlackMessage(value: SlackMessageApiObject): SlackMessageSummary {
  const message: SlackMessageSummary = {
    ts: requireSlackTimestamp(value.ts),
    text: optionalText(value.text, 40_000) ?? "",
  };
  const userId = optionalSlackId(value.user, "Slack message user");
  const botId = optionalSlackId(value.bot_id, "Slack message bot");
  if (userId) message.userId = userId;
  if (botId) message.botId = botId;
  if (value.thread_ts) message.threadTs = requireSlackTimestamp(value.thread_ts);
  if (value.reply_count !== undefined) {
    message.replyCount = requireBoundedInteger(
      value.reply_count,
      "Slack reply count",
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  return message;
}

function parseSlackUser(value: SlackUserApiObject | undefined): SlackUserSummary {
  if (!value) throw new SlackApiError("Slack user is unavailable", "permanent");
  return {
    id: requireSlackId(value.id, "Slack user"),
    name: optionalText(value.name, 160),
    displayName: optionalText(value.profile?.display_name, 160),
    realName: optionalText(value.profile?.real_name ?? value.real_name, 160),
    deleted: value.deleted === true,
    isBot: value.is_bot === true,
  };
}

function page<T>(items: T[], cursor: string | undefined): SlackPage<T> {
  const result: SlackPage<T> = { items };
  const nextCursor = optionalText(cursor, 2_048);
  if (nextCursor) result.nextCursor = nextCursor;
  return result;
}

function optionalSlackId(value: string | undefined, label: string): string | undefined {
  return value ? requireSlackId(value, label) : undefined;
}

function requireConversationTypes(value: string): string {
  const allowed = new Set(["public_channel", "private_channel", "mpim", "im"]);
  const types = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (types.length === 0 || types.some((entry) => !allowed.has(entry))) {
    throw new Error("Slack conversation types are invalid");
  }
  return types.join(",");
}

function requireSlackReaction(value: string): string {
  const normalized = value.trim().replace(/^:|:$/g, "");
  if (!/^[a-z0-9_+-]+(?:::[a-z0-9_-]+)?$/i.test(normalized) || normalized.length > 100) {
    throw new Error("Slack reaction is invalid");
  }
  return normalized;
}

function requireBoundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
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
  const normalizedToken = normalizedSlackToken(token);
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

function parseSlackFile(
  value: SlackFileApiObject | undefined,
  expectedFileId: string,
): ParsedSlackFile {
  if (!value) {
    throw new SlackApiError("Slack file metadata is unavailable", "permanent");
  }
  const fileId = requireSlackId(value.id, "Slack file");
  if (fileId !== expectedFileId) {
    throw new SlackApiError("Slack file identity changed", "permanent");
  }
  const size = value.size === undefined
    ? undefined
    : requireNonNegativeInteger(value.size, "Slack file size");
  const filename = requireSlackFilename(
    optionalText(value.name, 255)
      ?? optionalText(value.title, 255)
      ?? `slack-file-${fileId}`,
  );
  return {
    filename,
    mimeType: normalizedMimeType(value.mimetype),
    size,
    downloadUrl: requireSlackHostedUrl(
      value.url_private_download ?? value.url_private,
      "Slack file download URL",
    ),
  };
}

function requireSlackHostedUrl(value: string | undefined, label: string): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new SlackApiError(`${label} is invalid`, "permanent");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || (hostname !== "slack.com" && !hostname.endsWith(".slack.com"))
  ) {
    throw new SlackApiError(`${label} is invalid`, "permanent");
  }
  return url.toString();
}

function requireSlackFilename(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const withoutControls = [...leaf].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }).join("");
  const normalized = withoutControls
    .replace(/[<>:"|?*]/g, "-")
    .trim()
    .slice(0, 255);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Slack filename is invalid");
  }
  return normalized;
}

function normalizedMimeType(value: string | undefined): string {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function requireSlackBlocks(value: SlackBlock[]): SlackBlock[] {
  if (value.length === 0 || value.length > 50) {
    throw new Error("Slack blocks are invalid");
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function normalizedSlackToken(token: string): string {
  const normalized = token.trim();
  if (!normalized || normalized.length > 1_024) {
    throw new SlackApiError("Slack token is invalid", "permanent");
  }
  return normalized;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
