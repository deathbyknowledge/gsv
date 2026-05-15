import type {
  SocialDeliveryStatus,
  SocialGrant,
  SocialIdentityRepublishResult,
  SocialLocalIdentity,
  SocialMessageDirection,
  SocialMessageStatusState,
  SocialRemoteOperation,
  SocialThreadStatus,
  SpaceGsvContactRecord,
  SpaceGsvNewsRecord,
  SpaceGsvPackageReleaseRecord,
  SpaceGsvPackageRecord,
  SpaceGsvUserRecord,
  SpaceGsvVouchRecord,
} from "@gsv/protocol/syscalls/social";

export type SocialSection = "inbox" | "channels" | "contacts" | "directory" | "advanced";

export type SocialRoute = {
  section: SocialSection;
  channelId: string | null;
  contactHandle: string | null;
  workflowMessageId: string | null;
  detail: boolean;
};

export type PendingAction =
  | "load"
  | "establish-contact"
  | "save-contact-grants"
  | "remove-contact"
  | "send-message"
  | "update-message-workflow"
  | "republish-public-records";

export type SocialContactSummary = {
  handle: string;
  note: string;
  displayName?: string;
  description?: string;
  publicHandle?: string;
  acceptsContact: boolean;
  acceptedSocialMethods: string[];
  grants: SocialGrant[];
  createdAt: string;
  updatedAt: string;
  syncedAt?: string;
};

export type SocialChannelItem = {
  channelId: string;
  contactHandle: string;
  conversationId: string;
  status: SocialThreadStatus;
  updatedAt: string;
  workflowCount: number;
};

export type SocialMessageItem = {
  messageId: string;
  channelId: string;
  direction: SocialMessageDirection;
  fromHandle: string;
  toHandle: string;
  text?: string;
  body?: unknown;
  deliveryStatus: SocialDeliveryStatus;
  createdAt: string;
};

export type SocialMessageWorkflowItem = {
  messageId: string;
  channelId: string;
  direction: SocialMessageDirection;
  fromHandle: string;
  toHandle: string;
  state: SocialMessageStatusState;
  summary?: string;
  needsHumanReason?: string;
  body?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type SocialChannelDetail = {
  channel: SocialChannelItem | null;
  messages: SocialMessageItem[];
  workflows: SocialMessageWorkflowItem[];
};

export type SocialPublishedUserRecord = {
  handle: string;
  uri?: string;
  record: SpaceGsvUserRecord;
};

export type SocialPublishedContactRecord = {
  handle: string;
  uri?: string;
  record: SpaceGsvContactRecord;
};

export type SocialPublishedNewsRecord = {
  handle: string;
  uri?: string;
  record: SpaceGsvNewsRecord;
};

export type SocialPublishedPackageRecord = {
  handle: string;
  uri: string;
  record: SpaceGsvPackageRecord;
};

export type SocialPublishedPackageReleaseRecord = {
  handle: string;
  uri: string;
  record: SpaceGsvPackageReleaseRecord;
};

export type SocialPublishedVouchRecord = {
  handle: string;
  uri: string;
  record: SpaceGsvVouchRecord;
};

export type SocialContactDirectory = {
  contactHandle: string;
  users: SocialPublishedUserRecord[];
  contacts: SocialPublishedContactRecord[];
  news: SocialPublishedNewsRecord[];
  packages: SocialPublishedPackageRecord[];
  packageReleases: SocialPublishedPackageReleaseRecord[];
  vouches: SocialPublishedVouchRecord[];
};

export type SocialState = {
  identity: SocialLocalIdentity | null;
  contacts: SocialContactSummary[];
  channels: SocialChannelItem[];
  messageWorkflows: SocialMessageWorkflowItem[];
  selectedChannel: SocialChannelDetail | null;
  contactDirectory: SocialContactDirectory | null;
};

export type LoadSocialStateArgs = {
  channelId?: string | null;
  contactHandle?: string | null;
};

export type EstablishContactArgs = {
  handle: string;
  note: string;
  grants: SocialGrant[];
};

export type SetContactGrantsArgs = {
  handle: string;
  grants: SocialGrant[];
  channelId?: string | null;
};

export type RemoveContactArgs = {
  handle: string;
  channelId?: string | null;
};

export type SendMessageArgs = {
  toHandle: string;
  channelId?: string;
  text: string;
};

export type UpdateMessageWorkflowArgs = {
  messageId: string;
  channelId?: string | null;
  state: SocialMessageStatusState;
  summary?: string;
  needsHumanReason?: string;
};

export interface SocialBackend {
  loadState(args: LoadSocialStateArgs): Promise<SocialState>;
  establishContact(args: EstablishContactArgs): Promise<SocialState>;
  setContactGrants(args: SetContactGrantsArgs): Promise<SocialState>;
  removeContact(args: RemoveContactArgs): Promise<SocialState>;
  sendMessage(args: SendMessageArgs): Promise<SocialState>;
  updateMessageWorkflow(args: UpdateMessageWorkflowArgs): Promise<SocialState>;
  republishPublicRecords(): Promise<SocialState>;
}

export type RepublishIdentityResult = SocialIdentityRepublishResult;

export const SOCIAL_GRANT_OPTIONS: Array<{ operation: SocialRemoteOperation; label: string }> = [
  { operation: "social.thread.create", label: "Open channels" },
  { operation: "social.message.send", label: "Send channel messages" },
  { operation: "social.message.status.update", label: "Update internal message workflow" },
  { operation: "social.user.read", label: "Read published users" },
  { operation: "social.contact.read", label: "Read public Contacts" },
  { operation: "social.package.read", label: "Read public packages" },
  { operation: "social.package.release.read", label: "Read package releases" },
  { operation: "social.vouch.read", label: "Read vouches" },
  { operation: "social.news.read", label: "Read local news" },
];
