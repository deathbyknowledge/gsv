export type SocialDid = `did:${string}`;
export type SocialAtUri = `at://${string}`;
export type SocialIsoDateString = string;
export type SocialEmptyArgs = Record<string, never>;

export const SPACE_GSV_PROFILE = "space.gsv.profile" as const;
export const SPACE_GSV_INSTANCE = "space.gsv.instance" as const;
export const SPACE_GSV_AGENT_CARD = "space.gsv.agent.card" as const;
export const SPACE_GSV_PACKAGE_LIKE = "space.gsv.package.like" as const;
export const SPACE_GSV_STATUS = "space.gsv.status" as const;

export const SPACE_GSV_COLLECTIONS = [
  SPACE_GSV_PROFILE,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_AGENT_CARD,
  SPACE_GSV_PACKAGE_LIKE,
  SPACE_GSV_STATUS,
] as const;

export type SpaceGsvCollection = typeof SPACE_GSV_COLLECTIONS[number];

const SPACE_GSV_COLLECTION_SET = new Set<string>(SPACE_GSV_COLLECTIONS);

export function isSpaceGsvCollection(value: string): value is SpaceGsvCollection {
  return SPACE_GSV_COLLECTION_SET.has(value);
}

export type SpaceGsvRecordBase<TCollection extends SpaceGsvCollection> = {
  $type: TCollection;
  createdAt: SocialIsoDateString;
  updatedAt?: SocialIsoDateString;
};

export type SpaceGsvBlobRef = {
  $type: "blob";
  ref: {
    $link: string;
  };
  mimeType: string;
  size: number;
};

export type SpaceGsvLink = {
  label: string;
  uri: string;
};

export type SpaceGsvProfileRecord = SpaceGsvRecordBase<typeof SPACE_GSV_PROFILE> & {
  displayName?: string;
  description?: string;
  avatar?: SpaceGsvBlobRef;
  avatarAlt?: string;
  links?: SpaceGsvLink[];
};

export type SpaceGsvServiceKey = {
  id: string;
  type: "Multikey";
  publicKeyMultibase: string;
};

export type SpaceGsvInstanceRecord = SpaceGsvRecordBase<typeof SPACE_GSV_INSTANCE> & {
  endpoint: string;
  protocolVersion: number;
  serviceKey: SpaceGsvServiceKey;
  acceptedSocialMethods: SocialRemoteOperation[];
};

export type SpaceGsvAgentCardRecord = SpaceGsvRecordBase<typeof SPACE_GSV_AGENT_CARD> & {
  displayName?: string;
  summary?: string;
  topics?: string[];
  acceptsMessages: boolean;
  acceptsRequests: boolean;
  humanEscalation?: "never" | "sometimes" | "required";
};

export type SpaceGsvPackageSubject = {
  kind: "gsv-package";
  name: string;
  repo?: string;
  ref?: string;
  subdir?: string;
  uri?: string;
};

export type SpaceGsvPackageLikeRecord = SpaceGsvRecordBase<typeof SPACE_GSV_PACKAGE_LIKE> & {
  subject: SpaceGsvPackageSubject;
  note?: string;
};

export type SpaceGsvStatusRecord = SpaceGsvRecordBase<typeof SPACE_GSV_STATUS> & {
  text: string;
  expiresAt?: SocialIsoDateString;
  tags?: string[];
};

export type SpaceGsvRecord =
  | SpaceGsvProfileRecord
  | SpaceGsvInstanceRecord
  | SpaceGsvAgentCardRecord
  | SpaceGsvPackageLikeRecord
  | SpaceGsvStatusRecord;

export const SOCIAL_REMOTE_OPERATIONS = [
  "social.profile.read",
  "social.agent.card.read",
  "social.package.like.read",
  "social.thread.create",
  "social.message.send",
  "social.message.reply",
  "social.request.create",
  "social.request.respond",
] as const;

export type SocialRemoteOperation = typeof SOCIAL_REMOTE_OPERATIONS[number];

const SOCIAL_REMOTE_OPERATION_SET = new Set<string>(SOCIAL_REMOTE_OPERATIONS);

export function isSocialRemoteOperation(value: string): value is SocialRemoteOperation {
  return SOCIAL_REMOTE_OPERATION_SET.has(value);
}

export const SOCIAL_SYSCALLS = [
  "social.setup",
  "social.identity.get",
  "social.identity.set",
  "social.profile.get",
  "social.profile.update",
  "social.instance.get",
  "social.instance.update",
  "social.agent.card.get",
  "social.agent.card.update",
  "social.friend.list",
  "social.friend.add",
  "social.friend.remove",
  "social.friend.grants.set",
  "social.thread.create",
  "social.thread.list",
  "social.thread.get",
  "social.message.send",
  "social.message.reply",
  "social.request.create",
  "social.request.list",
  "social.request.get",
  "social.request.respond",
  "social.package.like.create",
  "social.package.like.delete",
  "social.package.like.list",
  "social.sync.run",
  "social.inbound",
] as const;

export type SocialSyscallName = typeof SOCIAL_SYSCALLS[number];

const SOCIAL_SYSCALL_SET = new Set<string>(SOCIAL_SYSCALLS);

export function isSocialSyscallName(value: string): value is SocialSyscallName {
  return SOCIAL_SYSCALL_SET.has(value);
}

export type SocialGrant = {
  operation: SocialRemoteOperation;
  scope?: Record<string, unknown>;
  expiresAt?: SocialIsoDateString;
};

export type SocialFriendSummary = {
  handle: string;
  displayName?: string;
  description?: string;
  agentDisplayName?: string;
  agentSummary?: string;
  acceptsMessages: boolean;
  acceptsRequests: boolean;
  acceptedSocialMethods: SocialRemoteOperation[];
  grants: SocialGrant[];
  createdAt: SocialIsoDateString;
  updatedAt: SocialIsoDateString;
  syncedAt?: SocialIsoDateString;
};

export type SocialLocalIdentity = {
  uid: number;
  did: SocialDid;
  handle?: string;
  pdsEndpoint: string;
  profile?: SpaceGsvProfileRecord;
  instance?: SpaceGsvInstanceRecord;
  agentCard?: SpaceGsvAgentCardRecord;
};

export type SocialSignedRequestEnvelope = {
  id: string;
  method: SocialRemoteOperation;
  fromDid: SocialDid;
  toDid: SocialDid;
  createdAt: SocialIsoDateString;
  expiresAt: SocialIsoDateString;
  nonce: string;
  keyId: string;
  body: unknown;
  signature: string;
};

export type SocialThreadStatus =
  | "active"
  | "waiting-on-human"
  | "completed"
  | "expired"
  | "closed";

export type SocialThreadSummary = {
  threadId: string;
  peerHandle: string;
  conversationId: string;
  status: SocialThreadStatus;
  topic?: string;
  createdAt: SocialIsoDateString;
  updatedAt: SocialIsoDateString;
  expiresAt?: SocialIsoDateString;
};

export type SocialMessageDirection = "inbound" | "outbound";
export type SocialDeliveryStatus =
  | "queued"
  | "sent"
  | "accepted"
  | "failed"
  | "retrying"
  | "delivered";

export type SocialMessageSummary = {
  messageId: string;
  threadId: string;
  direction: SocialMessageDirection;
  fromHandle: string;
  toHandle: string;
  text?: string;
  body?: unknown;
  replyToMessageId?: string;
  deliveryStatus: SocialDeliveryStatus;
  createdAt: SocialIsoDateString;
  updatedAt: SocialIsoDateString;
};

export type SocialRequestKind =
  | "question"
  | "task"
  | "collaboration"
  | "workspace-invite"
  | "package-review"
  | "other";

export type SocialRequestStatus =
  | "pending"
  | "agent-replied"
  | "needs-human"
  | "accepted"
  | "declined"
  | "completed"
  | "expired";

export type SocialRequestSummary = {
  requestId: string;
  threadId?: string;
  kind: SocialRequestKind;
  status: SocialRequestStatus;
  fromHandle: string;
  toHandle: string;
  title: string;
  body?: unknown;
  createdAt: SocialIsoDateString;
  updatedAt: SocialIsoDateString;
  expiresAt?: SocialIsoDateString;
};

export type SocialSetupArgs = {
  origin: string;
  displayName?: string;
  description?: string;
  agentDisplayName?: string;
  agentSummary?: string;
};
export type SocialSetupResult = {
  identity: SocialLocalIdentity;
  createdAccount: boolean;
  records: {
    profile?: SocialAtUri;
    instance?: SocialAtUri;
    agentCard?: SocialAtUri;
  };
  pdslsRepoUrl: string;
};

export type SocialIdentityGetArgs = SocialEmptyArgs;
export type SocialIdentityGetResult = {
  identity: SocialLocalIdentity | null;
};

export type SocialIdentitySetArgs = {
  did: SocialDid;
  handle?: string;
  pdsEndpoint: string;
};
export type SocialIdentitySetResult = {
  identity: SocialLocalIdentity;
};

export type SocialProfileGetArgs = {
  did?: SocialDid;
};
export type SocialProfileGetResult = {
  profile: SpaceGsvProfileRecord | null;
};

export type SocialProfileUpdateArgs = {
  record: SpaceGsvProfileRecord;
};
export type SocialProfileUpdateResult = {
  record: SpaceGsvProfileRecord;
  uri?: SocialAtUri;
};

export type SocialInstanceGetArgs = {
  did?: SocialDid;
};
export type SocialInstanceGetResult = {
  instance: SpaceGsvInstanceRecord | null;
};

export type SocialInstanceUpdateArgs = {
  record: SpaceGsvInstanceRecord;
};
export type SocialInstanceUpdateResult = {
  record: SpaceGsvInstanceRecord;
  uri?: SocialAtUri;
};

export type SocialAgentCardGetArgs = {
  did?: SocialDid;
};
export type SocialAgentCardGetResult = {
  agentCard: SpaceGsvAgentCardRecord | null;
};

export type SocialAgentCardUpdateArgs = {
  record: SpaceGsvAgentCardRecord;
};
export type SocialAgentCardUpdateResult = {
  record: SpaceGsvAgentCardRecord;
  uri?: SocialAtUri;
};

export type SocialFriendListArgs = SocialEmptyArgs;
export type SocialFriendListResult = {
  friends: SocialFriendSummary[];
};

export type SocialFriendAddArgs = {
  handle: string;
  displayName?: string;
  grants?: SocialGrant[];
};
export type SocialFriendAddResult = {
  friend: SocialFriendSummary;
  created: boolean;
};

export type SocialFriendRemoveArgs = {
  handle: string;
};
export type SocialFriendRemoveResult = {
  removed: boolean;
};

export type SocialFriendGrantsSetArgs = {
  handle: string;
  grants: SocialGrant[];
};
export type SocialFriendGrantsSetResult = {
  friend: SocialFriendSummary;
};

export type SocialThreadCreateArgs = {
  peerHandle: string;
  topic?: string;
  initialMessage?: string;
  expiresAt?: SocialIsoDateString;
};
export type SocialThreadCreateResult = {
  thread: SocialThreadSummary;
  initialMessage?: SocialMessageSummary;
};

export type SocialThreadListArgs = {
  peerHandle?: string;
  status?: SocialThreadStatus;
  limit?: number;
};
export type SocialThreadListResult = {
  threads: SocialThreadSummary[];
};

export type SocialThreadGetArgs = {
  threadId: string;
};
export type SocialThreadGetResult = {
  thread: SocialThreadSummary | null;
  messages: SocialMessageSummary[];
  requests: SocialRequestSummary[];
};

export type SocialMessageSendArgs = {
  toHandle: string;
  threadId?: string;
  text?: string;
  body?: unknown;
  replyToMessageId?: string;
  expiresAt?: SocialIsoDateString;
};
export type SocialMessageSendResult = {
  thread: SocialThreadSummary;
  message: SocialMessageSummary;
};

export type SocialMessageReplyArgs = {
  threadId: string;
  text?: string;
  body?: unknown;
  replyToMessageId?: string;
};
export type SocialMessageReplyResult = {
  message: SocialMessageSummary;
};

export type SocialRequestCreateArgs = {
  toHandle: string;
  threadId?: string;
  kind: SocialRequestKind;
  title: string;
  body?: unknown;
  expiresAt?: SocialIsoDateString;
};
export type SocialRequestCreateResult = {
  request: SocialRequestSummary;
  thread: SocialThreadSummary;
};

export type SocialRequestListArgs = {
  status?: SocialRequestStatus;
  peerHandle?: string;
  limit?: number;
};
export type SocialRequestListResult = {
  requests: SocialRequestSummary[];
};

export type SocialRequestGetArgs = {
  requestId: string;
};
export type SocialRequestGetResult = {
  request: SocialRequestSummary | null;
};

export type SocialRequestRespondArgs = {
  requestId: string;
  status: Extract<
    SocialRequestStatus,
    "agent-replied" | "needs-human" | "accepted" | "declined" | "completed"
  >;
  text?: string;
  body?: unknown;
};
export type SocialRequestRespondResult = {
  request: SocialRequestSummary;
  message?: SocialMessageSummary;
};

export type SocialPackageLikeCreateArgs = {
  record: SpaceGsvPackageLikeRecord;
};
export type SocialPackageLikeCreateResult = {
  record: SpaceGsvPackageLikeRecord;
  uri?: SocialAtUri;
};

export type SocialPackageLikeDeleteArgs = {
  uri: SocialAtUri;
};
export type SocialPackageLikeDeleteResult = {
  deleted: boolean;
};

export type SocialPackageLikeListArgs = {
  handle?: string;
  limit?: number;
};
export type SocialPackageLikeListResult = {
  likes: Array<{
    handle: string;
    uri: SocialAtUri;
    record: SpaceGsvPackageLikeRecord;
  }>;
};

export type SocialSyncRunArgs = {
  handle?: string;
  limit?: number;
};
export type SocialSyncRunResult = {
  checked: number;
  updated: number;
  failed: number;
};

export type SocialInboundArgs = {
  envelope: SocialSignedRequestEnvelope;
  receivedAt?: SocialIsoDateString;
};
export type SocialInboundResult =
  | { ok: true; status: "accepted"; threadId?: string; messageId?: string; requestId?: string }
  | { ok: false; status: "rejected"; error: string };

export type SocialSyscalls = {
  "social.setup": {
    args: SocialSetupArgs;
    result: SocialSetupResult;
  };
  "social.identity.get": {
    args: SocialIdentityGetArgs;
    result: SocialIdentityGetResult;
  };
  "social.identity.set": {
    args: SocialIdentitySetArgs;
    result: SocialIdentitySetResult;
  };
  "social.profile.get": {
    args: SocialProfileGetArgs;
    result: SocialProfileGetResult;
  };
  "social.profile.update": {
    args: SocialProfileUpdateArgs;
    result: SocialProfileUpdateResult;
  };
  "social.instance.get": {
    args: SocialInstanceGetArgs;
    result: SocialInstanceGetResult;
  };
  "social.instance.update": {
    args: SocialInstanceUpdateArgs;
    result: SocialInstanceUpdateResult;
  };
  "social.agent.card.get": {
    args: SocialAgentCardGetArgs;
    result: SocialAgentCardGetResult;
  };
  "social.agent.card.update": {
    args: SocialAgentCardUpdateArgs;
    result: SocialAgentCardUpdateResult;
  };
  "social.friend.list": {
    args: SocialFriendListArgs;
    result: SocialFriendListResult;
  };
  "social.friend.add": {
    args: SocialFriendAddArgs;
    result: SocialFriendAddResult;
  };
  "social.friend.remove": {
    args: SocialFriendRemoveArgs;
    result: SocialFriendRemoveResult;
  };
  "social.friend.grants.set": {
    args: SocialFriendGrantsSetArgs;
    result: SocialFriendGrantsSetResult;
  };
  "social.thread.create": {
    args: SocialThreadCreateArgs;
    result: SocialThreadCreateResult;
  };
  "social.thread.list": {
    args: SocialThreadListArgs;
    result: SocialThreadListResult;
  };
  "social.thread.get": {
    args: SocialThreadGetArgs;
    result: SocialThreadGetResult;
  };
  "social.message.send": {
    args: SocialMessageSendArgs;
    result: SocialMessageSendResult;
  };
  "social.message.reply": {
    args: SocialMessageReplyArgs;
    result: SocialMessageReplyResult;
  };
  "social.request.create": {
    args: SocialRequestCreateArgs;
    result: SocialRequestCreateResult;
  };
  "social.request.list": {
    args: SocialRequestListArgs;
    result: SocialRequestListResult;
  };
  "social.request.get": {
    args: SocialRequestGetArgs;
    result: SocialRequestGetResult;
  };
  "social.request.respond": {
    args: SocialRequestRespondArgs;
    result: SocialRequestRespondResult;
  };
  "social.package.like.create": {
    args: SocialPackageLikeCreateArgs;
    result: SocialPackageLikeCreateResult;
  };
  "social.package.like.delete": {
    args: SocialPackageLikeDeleteArgs;
    result: SocialPackageLikeDeleteResult;
  };
  "social.package.like.list": {
    args: SocialPackageLikeListArgs;
    result: SocialPackageLikeListResult;
  };
  "social.sync.run": {
    args: SocialSyncRunArgs;
    result: SocialSyncRunResult;
  };
  "social.inbound": {
    args: SocialInboundArgs;
    result: SocialInboundResult;
  };
};
