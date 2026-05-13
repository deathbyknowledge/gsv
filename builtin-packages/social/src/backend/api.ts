import type { KernelClientLike } from "@gsv/package/backend";
import type {
  SocialFriendListResult,
  SocialGrant,
  SocialIdentityGetResult,
  SocialMessageReplyArgs,
  SocialMessageSendArgs,
  SocialMessageSummary,
  SocialRemoteOperation,
  SocialRequestCreateArgs,
  SocialRequestKind,
  SocialRequestListResult,
  SocialRequestRespondArgs,
  SocialRequestSummary,
  SocialThreadGetResult,
  SocialThreadListResult,
  SocialThreadSummary,
} from "@gsv/protocol/syscalls/social";
import type {
  AddFriendArgs,
  CreateRequestArgs,
  LoadSocialStateArgs,
  RemoveFriendArgs,
  RespondRequestArgs,
  SendMessageArgs,
  SetFriendGrantsArgs,
  SocialMessageItem,
  SocialPeerSummary,
  SocialRequestItem,
  SocialState,
  SocialThreadDetail,
  SocialThreadItem,
} from "../app/types";
import { SOCIAL_GRANT_OPTIONS } from "../app/types";

const DEFAULT_GRANTS = SOCIAL_GRANT_OPTIONS.map((option) => option.operation);

export async function loadState(
  args: LoadSocialStateArgs | undefined,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const [identityResult, friendResult, threadResult, requestResult] = await Promise.all([
    kernel.request("social.identity.get", {}) as Promise<SocialIdentityGetResult>,
    kernel.request("social.friend.list", {}) as Promise<SocialFriendListResult>,
    kernel.request("social.thread.list", { limit: 100 }) as Promise<SocialThreadListResult>,
    kernel.request("social.request.list", { limit: 100 }) as Promise<SocialRequestListResult>,
  ]);

  const threads = threadResult.threads.map(normalizeThread);
  const requestedThreadId = normalizeOptional(args?.threadId);
  const selectedThreadId = requestedThreadId && threads.some((thread) => thread.threadId === requestedThreadId)
    ? requestedThreadId
    : threads[0]?.threadId ?? null;
  const selectedThread = selectedThreadId
    ? normalizeThreadDetail(await kernel.request("social.thread.get", { threadId: selectedThreadId }) as SocialThreadGetResult)
    : null;

  return {
    identity: identityResult.identity,
    friends: friendResult.friends.map(normalizeFriend),
    threads: threads.map((thread) => ({
      ...thread,
      requestCount: requestResult.requests.filter((request) => request.threadId === thread.threadId).length,
    })),
    requests: requestResult.requests.map(normalizeRequest),
    selectedThread,
  };
}

export async function addFriend(
  args: AddFriendArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  await kernel.request("social.friend.add", {
    handle: normalizeRequired(args.handle, "handle"),
    grants: normalizeGrants(args.grants),
  });
  return loadState({}, kernel);
}

export async function setFriendGrants(
  args: SetFriendGrantsArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  await kernel.request("social.friend.grants.set", {
    handle: normalizeRequired(args.handle, "handle"),
    grants: normalizeGrants(args.grants),
  });
  return loadState({ threadId: normalizeOptional(args.threadId) }, kernel);
}

export async function removeFriend(
  args: RemoveFriendArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  await kernel.request("social.friend.remove", {
    handle: normalizeRequired(args.handle, "handle"),
  });
  return loadState({ threadId: normalizeOptional(args.threadId) }, kernel);
}

export async function sendMessage(
  args: SendMessageArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const text = normalizeRequired(args.text, "message");
  const threadId = normalizeOptional(args.threadId);
  if (threadId) {
    const replyArgs: SocialMessageReplyArgs = {
      threadId,
      text,
    };
    await kernel.request("social.message.reply", replyArgs);
    return loadState({ threadId }, kernel);
  }

  const sendArgs: SocialMessageSendArgs = {
    toHandle: normalizeRequired(args.toHandle, "toHandle"),
    text,
  };
  const created = await kernel.request("social.message.send", sendArgs) as { thread?: { threadId?: string } };
  return loadState({ threadId: created.thread?.threadId }, kernel);
}

export async function createRequest(
  args: CreateRequestArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const body = parseBodyText(args.bodyText);
  const requestArgs: SocialRequestCreateArgs = {
    toHandle: normalizeRequired(args.toHandle, "toHandle"),
    kind: normalizeRequestKind(args.kind),
    title: normalizeRequired(args.title, "title"),
    ...(normalizeOptional(args.threadId) ? { threadId: normalizeOptional(args.threadId) } : {}),
    ...(body === undefined ? {} : { body }),
  };
  const created = await kernel.request("social.request.create", requestArgs) as { thread?: { threadId?: string } };
  return loadState({ threadId: created.thread?.threadId ?? normalizeOptional(args.threadId) }, kernel);
}

export async function respondRequest(
  args: RespondRequestArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const requestArgs: SocialRequestRespondArgs = {
    requestId: normalizeRequired(args.requestId, "requestId"),
    status: normalizeRequestResponseStatus(args.status),
    ...(normalizeOptional(args.text) ? { text: normalizeOptional(args.text) } : {}),
  };
  await kernel.request("social.request.respond", requestArgs);
  return loadState({ threadId: normalizeOptional(args.threadId) }, kernel);
}

function normalizeFriend(friend: SocialFriendListResult["friends"][number]): SocialPeerSummary {
  return {
    handle: friend.handle,
    displayName: friend.displayName,
    agentDisplayName: friend.agentDisplayName,
    acceptsMessages: friend.acceptsMessages,
    acceptsRequests: friend.acceptsRequests,
    acceptedSocialMethods: friend.acceptedSocialMethods,
    grants: friend.grants,
    updatedAt: friend.updatedAt,
  };
}

function normalizeThread(thread: SocialThreadSummary): SocialThreadItem {
  return {
    threadId: thread.threadId,
    peerHandle: thread.peerHandle,
    conversationId: thread.conversationId,
    status: thread.status,
    topic: thread.topic,
    updatedAt: thread.updatedAt,
    requestCount: 0,
  };
}

function normalizeMessage(message: SocialMessageSummary): SocialMessageItem {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    direction: message.direction,
    fromHandle: message.fromHandle,
    toHandle: message.toHandle,
    text: message.text,
    body: message.body,
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
  };
}

function normalizeRequest(request: SocialRequestSummary): SocialRequestItem {
  return {
    requestId: request.requestId,
    threadId: request.threadId,
    kind: request.kind,
    status: request.status,
    fromHandle: request.fromHandle,
    toHandle: request.toHandle,
    title: request.title,
    body: request.body,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
  };
}

function normalizeThreadDetail(detail: SocialThreadGetResult): SocialThreadDetail {
  return {
    thread: detail.thread ? normalizeThread(detail.thread) : null,
    messages: detail.messages.map(normalizeMessage),
    requests: detail.requests.map(normalizeRequest),
  };
}

function normalizeGrants(grants: SocialGrant[] | undefined): SocialGrant[] {
  const raw = grants && grants.length > 0
    ? grants.map((grant) => grant.operation)
    : DEFAULT_GRANTS;
  const allowed = new Set(SOCIAL_GRANT_OPTIONS.map((option) => option.operation));
  const seen = new Set<string>();
  const normalized: SocialGrant[] = [];
  for (const operation of raw) {
    if (seen.has(operation) || !allowed.has(operation as SocialRemoteOperation)) {
      continue;
    }
    seen.add(operation);
    normalized.push({ operation });
  }
  return normalized;
}

function parseBodyText(value: string | undefined): unknown {
  const text = normalizeOptional(value);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function normalizeRequestKind(value: SocialRequestKind | undefined): SocialRequestKind {
  return value ?? "question";
}

function normalizeRequestResponseStatus(
  value: RespondRequestArgs["status"] | undefined,
): RespondRequestArgs["status"] {
  if (
    value === "agent-replied" ||
    value === "needs-human" ||
    value === "accepted" ||
    value === "declined" ||
    value === "completed"
  ) {
    return value;
  }
  return "agent-replied";
}

function normalizeRequired(value: string | undefined, field: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
}
