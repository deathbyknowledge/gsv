import type { KernelClientLike } from "@gsv/package/backend";
import type {
  SocialContactPublicListResult,
  SocialContactListResult,
  SocialContactSummary as ProtocolContactSummary,
  SocialGrant,
  SocialIdentityGetResult,
  SocialIdentityRepublishResult,
  SocialMessageSendArgs,
  SocialMessageStatusListResult,
  SocialMessageStatusSummary,
  SocialMessageStatusUpdateArgs,
  SocialMessageSummary,
  SocialNewsListResult,
  SocialPackageReleaseListResult,
  SocialPackageListResult,
  SocialRemoteOperation,
  SocialThreadGetResult,
  SocialThreadListResult,
  SocialThreadSummary,
  SocialUserListResult,
  SocialVouchListResult,
} from "@gsv/protocol/syscalls/social";
import type {
  EstablishContactArgs,
  LoadSocialStateArgs,
  RemoveContactArgs,
  SendMessageArgs,
  SetContactGrantsArgs,
  SocialChannelDetail,
  SocialChannelItem,
  SocialContactSummary,
  SocialMessageItem,
  SocialMessageWorkflowItem,
  SocialState,
  UpdateMessageWorkflowArgs,
} from "../app/types";
import { SOCIAL_GRANT_OPTIONS } from "../app/types";

type LegacyLoadSocialStateArgs = LoadSocialStateArgs & {
  threadId?: string | null;
};

type ContactDirectory = NonNullable<SocialState["contactDirectory"]>;

export async function loadState(
  args: LoadSocialStateArgs | undefined,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const loadArgs = args as LegacyLoadSocialStateArgs | undefined;
  const [identityResult, contactResult, threadResult, statusResult] = await Promise.all([
    kernel.request("social.identity.get", {}) as Promise<SocialIdentityGetResult>,
    listContacts(kernel),
    kernel.request("social.thread.list", { limit: 100 }) as Promise<SocialThreadListResult>,
    kernel.request("social.message.status.list", { limit: 100 }) as Promise<SocialMessageStatusListResult>,
  ]);

  const channels = threadResult.threads.map(normalizeChannel);
  const messageWorkflows = statusResult.statuses.map(normalizeWorkflow);
  const contacts = contactResult.map(normalizeContact);
  const requestedChannelId = normalizeOptional(loadArgs?.channelId ?? loadArgs?.threadId);
  const selectedChannelId = requestedChannelId && channels.some((channel) => channel.channelId === requestedChannelId)
    ? requestedChannelId
    : channels[0]?.channelId ?? null;
  const selectedChannel = selectedChannelId
    ? normalizeChannelDetail(await kernel.request("social.thread.get", { threadId: selectedChannelId }) as SocialThreadGetResult)
    : null;
  const requestedContactHandle = normalizeOptional(loadArgs?.contactHandle);
  const selectedContact = requestedContactHandle
    ? contacts.find((contact) => contact.handle === requestedContactHandle) ?? null
    : null;
  const [usersResult, publicContactRecords, packageRecords, packageReleaseRecords, vouchRecords, newsRecords] = selectedContact
    ? await Promise.all([
        hasAcceptedMethod(selectedContact, "social.user.read")
          ? kernel.request("social.user.list", { handle: selectedContact.handle }) as Promise<SocialUserListResult>
          : Promise.resolve({ users: [] }),
        loadPublicContactRecords(kernel, selectedContact),
        loadContactPackages(kernel, selectedContact),
        loadPackageReleases(kernel, selectedContact),
        loadVouches(kernel, selectedContact),
        loadContactNews(kernel, selectedContact),
      ])
    : [{ users: [] }, [], [], [], [], []];

  return {
    identity: identityResult.identity,
    contacts,
    channels: channels.map((channel) => ({
      ...channel,
      workflowCount: messageWorkflows.filter((workflow) => workflow.channelId === channel.channelId).length,
    })),
    messageWorkflows,
    selectedChannel,
    contactDirectory: selectedContact
      ? {
          contactHandle: selectedContact.handle,
          users: usersResult.users,
          contacts: publicContactRecords,
          news: newsRecords,
          packages: packageRecords,
          packageReleases: packageReleaseRecords,
          vouches: vouchRecords,
        }
      : null,
  };
}

export async function establishContact(
  args: EstablishContactArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  await kernel.request("social.contact.add", {
    handle: normalizeRequired(args.handle, "handle"),
    note: normalizeRequired(args.note, "note"),
    grants: normalizeGrants(args.grants),
  });
  return loadState({}, kernel);
}

export async function setContactGrants(
  args: SetContactGrantsArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  await kernel.request("social.contact.grants.set", {
    handle: normalizeRequired(args.handle, "handle"),
    grants: normalizeGrants(args.grants),
  });
  return loadState({ channelId: normalizeOptional(args.channelId) }, kernel);
}

export async function removeContact(
  args: RemoveContactArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  await kernel.request("social.contact.remove", {
    handle: normalizeRequired(args.handle, "handle"),
  });
  return loadState({ channelId: normalizeOptional(args.channelId) }, kernel);
}

export async function sendMessage(
  args: SendMessageArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const text = normalizeRequired(args.text, "message");
  const sendArgsInput = args as SendMessageArgs & { threadId?: string };
  const threadId = normalizeOptional(sendArgsInput.channelId ?? sendArgsInput.threadId);
  const sendArgs: SocialMessageSendArgs = {
    toHandle: normalizeRequired(args.toHandle, "toHandle"),
    text,
    ...(threadId ? { threadId } : {}),
  };
  const created = await kernel.request("social.message.send", sendArgs) as { thread?: { threadId?: string } };
  return loadState({ channelId: created.thread?.threadId ?? threadId }, kernel);
}

export async function updateMessageWorkflow(
  args: UpdateMessageWorkflowArgs,
  kernel: KernelClientLike,
): Promise<SocialState> {
  const statusArgs: SocialMessageStatusUpdateArgs = {
    messageId: normalizeRequired(args.messageId, "messageId"),
    state: args.state,
    ...(normalizeOptional(args.summary) ? { summary: normalizeOptional(args.summary) } : {}),
    ...(normalizeOptional(args.needsHumanReason) ? { needsHumanReason: normalizeOptional(args.needsHumanReason) } : {}),
  };
  await kernel.request("social.message.status.update", statusArgs);
  return loadState({ channelId: normalizeOptional(args.channelId) }, kernel);
}

export async function republishPublicRecords(kernel: KernelClientLike): Promise<SocialState> {
  await kernel.request("social.identity.republish", {}) as SocialIdentityRepublishResult;
  return loadState({}, kernel);
}

async function listContacts(kernel: KernelClientLike): Promise<ProtocolContactSummary[]> {
  const result = await kernel.request("social.contact.list", {}) as SocialContactListResult;
  return result.contacts;
}

async function loadContactPackages(
  kernel: KernelClientLike,
  contact: SocialContactSummary,
): Promise<ContactDirectory["packages"]> {
  if (!hasAcceptedMethod(contact, "social.package.read")) {
    return [];
  }
  try {
    const result = await kernel.request("social.package.list", {
      handle: contact.handle,
      limit: 100,
    }) as SocialPackageListResult;
    return result.packages;
  } catch {
    return [];
  }
}

async function loadPublicContactRecords(
  kernel: KernelClientLike,
  contact: SocialContactSummary,
): Promise<ContactDirectory["contacts"]> {
  if (!hasAcceptedMethod(contact, "social.contact.read")) {
    return [];
  }
  try {
    const result = await kernel.request("social.contact.public.list", {
      handle: contact.handle,
      limit: 100,
    }) as SocialContactPublicListResult;
    return result.contacts;
  } catch {
    return [];
  }
}

async function loadPackageReleases(
  kernel: KernelClientLike,
  contact: SocialContactSummary,
): Promise<ContactDirectory["packageReleases"]> {
  if (!hasAcceptedMethod(contact, "social.package.release.read")) {
    return [];
  }
  try {
    const result = await kernel.request("social.package.release.list", {
      handle: contact.handle,
      limit: 100,
    }) as SocialPackageReleaseListResult;
    return result.releases;
  } catch {
    return [];
  }
}

async function loadVouches(
  kernel: KernelClientLike,
  contact: SocialContactSummary,
): Promise<ContactDirectory["vouches"]> {
  if (!hasAcceptedMethod(contact, "social.vouch.read")) {
    return [];
  }
  try {
    const result = await kernel.request("social.vouch.list", {
      handle: contact.handle,
      limit: 100,
    }) as SocialVouchListResult;
    return result.vouches;
  } catch {
    return [];
  }
}

async function loadContactNews(
  kernel: KernelClientLike,
  contact: SocialContactSummary,
): Promise<ContactDirectory["news"]> {
  if (!hasAcceptedMethod(contact, "social.news.read")) {
    return [];
  }
  try {
    const result = await kernel.request("social.news.list", {
      handle: contact.handle,
      limit: 100,
    }) as SocialNewsListResult;
    return result.news;
  } catch {
    return [];
  }
}

function normalizeContact(contact: ProtocolContactSummary): SocialContactSummary {
  return {
    handle: contact.handle,
    note: contact.note,
    displayName: contact.displayName,
    description: contact.description,
    publicHandle: contact.publicHandle,
    acceptsContact: contact.acceptsContact,
    acceptedSocialMethods: contact.acceptedSocialMethods,
    grants: contact.grants,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
    syncedAt: contact.syncedAt,
  };
}

function normalizeChannel(thread: SocialThreadSummary): SocialChannelItem {
  return {
    channelId: thread.threadId,
    contactHandle: thread.peerHandle,
    conversationId: thread.conversationId,
    status: thread.status,
    updatedAt: thread.updatedAt,
    workflowCount: 0,
  };
}

function normalizeMessage(message: SocialMessageSummary): SocialMessageItem {
  return {
    messageId: message.messageId,
    channelId: message.threadId,
    direction: message.direction,
    fromHandle: message.fromHandle,
    toHandle: message.toHandle,
    text: message.text,
    body: message.body,
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
  };
}

function normalizeWorkflow(status: SocialMessageStatusSummary): SocialMessageWorkflowItem {
  return {
    messageId: status.messageId,
    channelId: status.threadId,
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

function normalizeChannelDetail(detail: SocialThreadGetResult): SocialChannelDetail {
  return {
    channel: detail.thread ? normalizeChannel(detail.thread) : null,
    messages: detail.messages.map(normalizeMessage),
    workflows: detail.statuses.map(normalizeWorkflow),
  };
}

function normalizeGrants(grants: SocialGrant[] | undefined): SocialGrant[] {
  const raw = grants?.map((grant) => grant.operation) ?? [];
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

function hasAcceptedMethod(contact: SocialContactSummary, method: string): boolean {
  return contact.acceptedSocialMethods.includes(method);
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
