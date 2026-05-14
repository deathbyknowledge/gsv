import type { KernelClientLike } from "@gsv/package/backend";
import type {
  SocialFriendListResult,
  SocialGrant,
  SocialIdentityGetResult,
  SocialMessageReplyArgs,
  SocialMessageSendArgs,
  SocialMessageStatusListResult,
  SocialMessageStatusSummary,
  SocialMessageStatusUpdateArgs,
  SocialMessageSummary,
  SocialRemoteOperation,
  SocialThreadGetResult,
  SocialThreadListResult,
  SocialThreadSummary,
} from "@gsv/protocol/syscalls/social";
import type {
  AddFriendArgs,
  LoadSocialStateArgs,
  RemoveFriendArgs,
  SendMessageArgs,
  SetFriendGrantsArgs,
  SocialMessageItem,
  SocialMessageStatusItem,
  SocialPeerSummary,
  SocialState,
  SocialThreadDetail,
  SocialThreadItem,
  UpdateMessageStatusArgs,
} from "../app/types";
import { SOCIAL_GRANT_OPTIONS } from "../app/types";

const DEFAULT_GRANTS = SOCIAL_GRANT_OPTIONS.map((option) => option.operation);

export async function loadState(
  args: LoadSocialStateArgs | undefined,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const [identityResult, friendResult, threadResult, statusResult] = await Promise.all([
    kernel.request("social.identity.get", {}) as Promise<SocialIdentityGetResult>,
    kernel.request("social.friend.list", {}) as Promise<SocialFriendListResult>,
    kernel.request("social.thread.list", { limit: 100 }) as Promise<SocialThreadListResult>,
    kernel.request("social.message.status.list", { limit: 100 }) as Promise<SocialMessageStatusListResult>,
  ]);

  const threads = threadResult.threads.map(normalizeThread);
  const statuses = statusResult.statuses.map(normalizeStatus);
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
      statusCount: statuses.filter((status) => status.threadId === thread.threadId).length,
    })),
    statuses,
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

export async function updateMessageStatus(
  args: UpdateMessageStatusArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const statusArgs: SocialMessageStatusUpdateArgs = {
    messageId: normalizeRequired(args.messageId, "messageId"),
    state: args.state,
    ...(normalizeOptional(args.summary) ? { summary: normalizeOptional(args.summary) } : {}),
    ...(normalizeOptional(args.needsHumanReason) ? { needsHumanReason: normalizeOptional(args.needsHumanReason) } : {}),
  };
  await kernel.request("social.message.status.update", statusArgs);
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
    statusCount: 0,
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

function normalizeStatus(status: SocialMessageStatusSummary): SocialMessageStatusItem {
  return {
    messageId: status.messageId,
    threadId: status.threadId,
    direction: status.direction,
    fromHandle: status.fromHandle,
    toHandle: status.toHandle,
    state: status.state,
    summary: status.summary,
    needsHumanReason: status.needsHumanReason,
    body: status.body,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
  };
}

function normalizeThreadDetail(detail: SocialThreadGetResult): SocialThreadDetail {
  return {
    thread: detail.thread ? normalizeThread(detail.thread) : null,
    messages: detail.messages.map(normalizeMessage),
    statuses: detail.statuses.map(normalizeStatus),
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
