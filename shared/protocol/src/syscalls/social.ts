export type SocialDid = `did:${string}`;
export type SocialAtUri = `at://${string}`;
export type SocialIsoDateString = string;
export type SocialEmptyArgs = Record<string, never>;

export const SPACE_GSV_PROFILE = "space.gsv.profile" as const;
export const SPACE_GSV_INSTANCE = "space.gsv.instance" as const;
export const SPACE_GSV_USER = "space.gsv.user" as const;
export const SPACE_GSV_CONTACT = "space.gsv.contact" as const;
export const SPACE_GSV_PACKAGE = "space.gsv.package" as const;
export const SPACE_GSV_PACKAGE_RELEASE = "space.gsv.package.release" as const;
export const SPACE_GSV_VOUCH = "space.gsv.vouch" as const;
export const SPACE_GSV_NEWS = "space.gsv.news" as const;

export const SPACE_GSV_COLLECTIONS = [
  SPACE_GSV_PROFILE,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_USER,
  SPACE_GSV_CONTACT,
  SPACE_GSV_PACKAGE,
  SPACE_GSV_PACKAGE_RELEASE,
  SPACE_GSV_VOUCH,
  SPACE_GSV_NEWS,
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

export type SpaceGsvUserRecord = SpaceGsvRecordBase<typeof SPACE_GSV_USER> & {
  username: string;
  displayName?: string;
  description?: string;
  publicHandle?: string;
  acceptsContact?: boolean;
};

export type SpaceGsvContactSubject = {
  did: SocialDid;
  handle?: string;
  uri?: SocialAtUri;
};

export type SpaceGsvContactRecord = SpaceGsvRecordBase<typeof SPACE_GSV_CONTACT> & {
  subject: SpaceGsvContactSubject;
  label?: string;
  tags?: string[];
};

export type SpaceGsvRecordReference = {
  uri: SocialAtUri;
  cid?: string;
};

export type SpaceGsvPackageSource = {
  repo?: string;
  ref?: string;
  subdir?: string;
  uri?: string;
};

export type SpaceGsvPackageRecord = SpaceGsvRecordBase<typeof SPACE_GSV_PACKAGE> & {
  name: string;
  displayName?: string;
  description?: string;
  source?: SpaceGsvPackageSource;
  homepage?: string;
  tags?: string[];
};

export type SpaceGsvPackageReleaseRecord = SpaceGsvRecordBase<typeof SPACE_GSV_PACKAGE_RELEASE> & {
  package: SpaceGsvRecordReference;
  version: string;
  title?: string;
  description?: string;
  source?: SpaceGsvPackageSource;
  releasedAt?: SocialIsoDateString;
  tags?: string[];
};

export type SpaceGsvVouchRecord = SpaceGsvRecordBase<typeof SPACE_GSV_VOUCH> & {
  subject: SpaceGsvRecordReference;
  note?: string;
  tags?: string[];
};

export type SpaceGsvNewsRecord = SpaceGsvRecordBase<typeof SPACE_GSV_NEWS> & {
  title?: string;
  text: string;
  tags?: string[];
  startsAt?: SocialIsoDateString;
  endsAt?: SocialIsoDateString;
  subjects?: SpaceGsvRecordReference[];
};

export type SpaceGsvRecord =
  | SpaceGsvProfileRecord
  | SpaceGsvInstanceRecord
  | SpaceGsvUserRecord
  | SpaceGsvContactRecord
  | SpaceGsvPackageRecord
  | SpaceGsvPackageReleaseRecord
  | SpaceGsvVouchRecord
  | SpaceGsvNewsRecord;

export const SOCIAL_REMOTE_OPERATIONS = [
  "social.profile.read",
  "social.user.read",
  "social.contact.read",
  "social.package.read",
  "social.package.release.read",
  "social.vouch.read",
  "social.news.read",
  "social.thread.create",
  "social.message.send",
  "social.message.status.update",
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
  "social.identity.republish",
  "social.profile.get",
  "social.profile.update",
  "social.instance.get",
  "social.instance.update",
  "social.contact.list",
  "social.contact.add",
  "social.contact.remove",
  "social.contact.grants.set",
  "social.contact.public.list",
  "social.contact.publish",
  "social.contact.unpublish",
  "social.user.list",
  "social.package.list",
  "social.package.release.list",
  "social.vouch.create",
  "social.vouch.delete",
  "social.vouch.list",
  "social.news.create",
  "social.news.delete",
  "social.news.list",
  "social.thread.create",
  "social.thread.list",
  "social.thread.get",
  "social.message.send",
  "social.message.status.list",
  "social.message.status.get",
  "social.message.status.update",
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

export type SocialContactSummary = {
  handle: string;
  note: string;
  displayName?: string;
  description?: string;
  publicHandle?: string;
  acceptsContact: boolean;
  acceptedSocialMethods: SocialRemoteOperation[];
  grants: SocialGrant[];
  createdAt: SocialIsoDateString;
  updatedAt: SocialIsoDateString;
  syncedAt?: SocialIsoDateString;
};

export type SocialLocalIdentity = {
  uid: number;
  handle: string;
  pdsEndpoint: string;
  profile?: SpaceGsvProfileRecord;
  instance?: SpaceGsvInstanceRecord;
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

export type SocialMessageSender =
  | {
    kind: "gsv";
    displayName?: string;
  }
  | {
    kind: "mind";
    username?: string;
    displayName?: string;
    publicHandle?: string;
    processId?: string;
  }
  | {
    kind: "user";
    username: string;
    displayName?: string;
    publicHandle?: string;
  }
  | {
    kind: "process";
    username: string;
    displayName?: string;
    publicHandle?: string;
    processId?: string;
    processLabel?: string;
    profile?: string;
  };

export type SocialMessageSummary = {
  messageId: string;
  threadId: string;
  direction: SocialMessageDirection;
  fromHandle: string;
  toHandle: string;
  sender?: SocialMessageSender;
  text?: string;
  body?: unknown;
  deliveryStatus: SocialDeliveryStatus;
  createdAt: SocialIsoDateString;
  updatedAt: SocialIsoDateString;
};

export type SocialMessageStatusState =
  | "received"
  | "triaged"
  | "in_progress"
  | "needs_human"
  | "completed"
  | "declined"
  | "failed";

export type SocialMessageStatusSummary = {
  messageId: string;
  threadId: string;
  direction: SocialMessageDirection;
  fromHandle: string;
  toHandle: string;
  state: SocialMessageStatusState;
  summary?: string;
  needsHumanReason?: string;
  body?: unknown;
  createdAt: SocialIsoDateString;
  updatedAt: SocialIsoDateString;
};

export type SocialSetupArgs = {
  origin: string;
  handle?: string;
  displayName?: string;
  description?: string;
  acceptsContact?: boolean;
};
export type SocialSetupResult = {
  identity: SocialLocalIdentity;
  createdAccount: boolean;
  records: {
    profile?: SocialAtUri;
    instance?: SocialAtUri;
    users?: SocialAtUri[];
  };
};

export type SocialIdentityGetArgs = SocialEmptyArgs;
export type SocialIdentityGetResult = {
  identity: SocialLocalIdentity | null;
};

export type SocialIdentitySetArgs = {
  handle: string;
  pdsEndpoint: string;
};
export type SocialIdentitySetResult = {
  identity: SocialLocalIdentity;
};

export type SocialIdentityRepublishArgs = SocialEmptyArgs;
export type SocialIdentityRepublishResult = {
  identity: SocialLocalIdentity;
  records: {
    profile?: SocialAtUri;
    instance?: SocialAtUri;
    users?: SocialAtUri[];
  };
};

export type SocialProfileGetArgs = {
  handle?: string;
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
  handle?: string;
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

export type SocialContactListArgs = SocialEmptyArgs;
export type SocialContactListResult = {
  contacts: SocialContactSummary[];
};

export type SocialContactAddArgs = {
  handle: string;
  note: string;
  displayName?: string;
  grants?: SocialGrant[];
};
export type SocialContactAddResult = {
  contact: SocialContactSummary;
  created: boolean;
};

export type SocialContactRemoveArgs = {
  handle: string;
};
export type SocialContactRemoveResult = {
  removed: boolean;
};

export type SocialContactGrantsSetArgs = {
  handle: string;
  grants: SocialGrant[];
};
export type SocialContactGrantsSetResult = {
  contact: SocialContactSummary;
};

export type SocialThreadCreateArgs = {
  peerHandle: string;
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
  statuses: SocialMessageStatusSummary[];
};

export type SocialMessageSendArgs = {
  toHandle: string;
  threadId?: string;
  text?: string;
  body?: unknown;
  expiresAt?: SocialIsoDateString;
};
export type SocialMessageSendResult = {
  thread: SocialThreadSummary;
  message: SocialMessageSummary;
};

export type SocialMessageStatusListArgs = {
  state?: SocialMessageStatusState;
  peerHandle?: string;
  direction?: SocialMessageDirection | "all";
  limit?: number;
};
export type SocialMessageStatusListResult = {
  statuses: SocialMessageStatusSummary[];
};

export type SocialMessageStatusGetArgs = {
  messageId: string;
};
export type SocialMessageStatusGetResult = {
  status: SocialMessageStatusSummary | null;
};

export type SocialMessageStatusUpdateArgs = {
  messageId: string;
  state: SocialMessageStatusState;
  summary?: string;
  needsHumanReason?: string;
  body?: unknown;
};
export type SocialMessageStatusUpdateResult = {
  status: SocialMessageStatusSummary;
};

export type SocialUserListArgs = {
  handle?: string;
  limit?: number;
};
export type SocialUserListResult = {
  users: Array<{
    handle: string;
    uri?: SocialAtUri;
    record: SpaceGsvUserRecord;
  }>;
};

export type SocialPublicRecordEntry<TRecord extends SpaceGsvRecord> = {
  handle: string;
  uri: SocialAtUri;
  cid?: string;
  record: TRecord;
};

export type SocialContactPublicListArgs = {
  handle?: string;
  limit?: number;
};
export type SocialContactPublicListResult = {
  contacts: Array<SocialPublicRecordEntry<SpaceGsvContactRecord>>;
};

export type SocialContactPublishArgs = {
  record: SpaceGsvContactRecord;
  rkey?: string;
};
export type SocialContactPublishResult = {
  record: SpaceGsvContactRecord;
  uri?: SocialAtUri;
};

export type SocialContactUnpublishArgs = {
  uri: SocialAtUri;
};
export type SocialContactUnpublishResult = {
  deleted: boolean;
};

export type SocialPackageListArgs = {
  handle?: string;
  limit?: number;
};
export type SocialPackageListResult = {
  packages: Array<SocialPublicRecordEntry<SpaceGsvPackageRecord>>;
};

export type SocialPackageReleaseListArgs = {
  handle?: string;
  packageUri?: SocialAtUri;
  limit?: number;
};
export type SocialPackageReleaseListResult = {
  releases: Array<SocialPublicRecordEntry<SpaceGsvPackageReleaseRecord>>;
};

export type SocialVouchCreateArgs = {
  record: SpaceGsvVouchRecord;
  rkey?: string;
};
export type SocialVouchCreateResult = {
  record: SpaceGsvVouchRecord;
  uri?: SocialAtUri;
};

export type SocialVouchDeleteArgs = {
  uri: SocialAtUri;
};
export type SocialVouchDeleteResult = {
  deleted: boolean;
};

export type SocialVouchListArgs = {
  handle?: string;
  limit?: number;
};
export type SocialVouchListResult = {
  vouches: Array<SocialPublicRecordEntry<SpaceGsvVouchRecord>>;
};

export type SocialNewsCreateArgs = {
  record: SpaceGsvNewsRecord;
  rkey?: string;
};
export type SocialNewsCreateResult = {
  record: SpaceGsvNewsRecord;
  uri?: SocialAtUri;
};

export type SocialNewsDeleteArgs = {
  uri: SocialAtUri;
};
export type SocialNewsDeleteResult = {
  deleted: boolean;
};

export type SocialNewsListArgs = {
  handle?: string;
  limit?: number;
};
export type SocialNewsListResult = {
  news: Array<SocialPublicRecordEntry<SpaceGsvNewsRecord>>;
};

export type SocialInboundArgs = {
  envelope: SocialSignedRequestEnvelope;
  receivedAt?: SocialIsoDateString;
};
export type SocialInboundResult =
  | { ok: true; status: "accepted"; threadId?: string; messageId?: string }
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
  "social.identity.republish": {
    args: SocialIdentityRepublishArgs;
    result: SocialIdentityRepublishResult;
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
  "social.contact.list": {
    args: SocialContactListArgs;
    result: SocialContactListResult;
  };
  "social.contact.add": {
    args: SocialContactAddArgs;
    result: SocialContactAddResult;
  };
  "social.contact.remove": {
    args: SocialContactRemoveArgs;
    result: SocialContactRemoveResult;
  };
  "social.contact.grants.set": {
    args: SocialContactGrantsSetArgs;
    result: SocialContactGrantsSetResult;
  };
  "social.contact.public.list": {
    args: SocialContactPublicListArgs;
    result: SocialContactPublicListResult;
  };
  "social.contact.publish": {
    args: SocialContactPublishArgs;
    result: SocialContactPublishResult;
  };
  "social.contact.unpublish": {
    args: SocialContactUnpublishArgs;
    result: SocialContactUnpublishResult;
  };
  "social.user.list": {
    args: SocialUserListArgs;
    result: SocialUserListResult;
  };
  "social.package.list": {
    args: SocialPackageListArgs;
    result: SocialPackageListResult;
  };
  "social.package.release.list": {
    args: SocialPackageReleaseListArgs;
    result: SocialPackageReleaseListResult;
  };
  "social.vouch.create": {
    args: SocialVouchCreateArgs;
    result: SocialVouchCreateResult;
  };
  "social.vouch.delete": {
    args: SocialVouchDeleteArgs;
    result: SocialVouchDeleteResult;
  };
  "social.vouch.list": {
    args: SocialVouchListArgs;
    result: SocialVouchListResult;
  };
  "social.news.create": {
    args: SocialNewsCreateArgs;
    result: SocialNewsCreateResult;
  };
  "social.news.delete": {
    args: SocialNewsDeleteArgs;
    result: SocialNewsDeleteResult;
  };
  "social.news.list": {
    args: SocialNewsListArgs;
    result: SocialNewsListResult;
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
  "social.message.status.list": {
    args: SocialMessageStatusListArgs;
    result: SocialMessageStatusListResult;
  };
  "social.message.status.get": {
    args: SocialMessageStatusGetArgs;
    result: SocialMessageStatusGetResult;
  };
  "social.message.status.update": {
    args: SocialMessageStatusUpdateArgs;
    result: SocialMessageStatusUpdateResult;
  };
  "social.inbound": {
    args: SocialInboundArgs;
    result: SocialInboundResult;
  };
};
