import type {
  SocialDeliveryStatus,
  SocialGrant,
  SocialLocalIdentity,
  SocialMessageDirection,
  SocialMessageStatusState,
  SocialRemoteOperation,
  SocialThreadStatus,
  SpaceGsvPackageLikeRecord,
  SpaceGsvUserRecord,
} from "@gsv/protocol/syscalls/social";

export type SocialView = "inbox" | "threads" | "friends";

export type SocialPeerSummary = {
  handle: string;
  note: string;
  displayName?: string;
  agentDisplayName?: string;
  acceptsMessages: boolean;
  acceptedSocialMethods: SocialRemoteOperation[];
  grants: SocialGrant[];
  updatedAt: string;
};

export type SocialThreadItem = {
  threadId: string;
  peerHandle: string;
  conversationId: string;
  status: SocialThreadStatus;
  updatedAt: string;
  statusCount: number;
};

export type SocialMessageItem = {
  messageId: string;
  threadId: string;
  direction: SocialMessageDirection;
  fromHandle: string;
  toHandle: string;
  text?: string;
  body?: unknown;
  deliveryStatus: SocialDeliveryStatus;
  createdAt: string;
};

export type SocialMessageStatusItem = {
  messageId: string;
  threadId: string;
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

export type SocialThreadDetail = {
  thread: SocialThreadItem | null;
  messages: SocialMessageItem[];
  statuses: SocialMessageStatusItem[];
};

export type SocialRemoteUserItem = {
  handle: string;
  uri?: string;
  record: SpaceGsvUserRecord;
};

export type SocialPackageLikeItem = {
  handle: string;
  uri: string;
  record: SpaceGsvPackageLikeRecord;
};

export type SocialFriendDirectory = {
  handle: string;
  users: SocialRemoteUserItem[];
  packageLikes: SocialPackageLikeItem[];
};

export type SocialState = {
  identity: SocialLocalIdentity | null;
  friends: SocialPeerSummary[];
  threads: SocialThreadItem[];
  statuses: SocialMessageStatusItem[];
  selectedThread: SocialThreadDetail | null;
  friendDirectory: SocialFriendDirectory | null;
};

export type LoadSocialStateArgs = {
  threadId?: string | null;
  friendHandle?: string | null;
};

export type AddFriendArgs = {
  handle: string;
  note: string;
  grants: SocialGrant[];
};

export type SetFriendGrantsArgs = {
  handle: string;
  grants: SocialGrant[];
  threadId?: string | null;
};

export type RemoveFriendArgs = {
  handle: string;
  threadId?: string | null;
};

export type SendMessageArgs = {
  toHandle: string;
  threadId?: string;
  text: string;
};

export type UpdateMessageStatusArgs = {
  messageId: string;
  threadId?: string | null;
  state: SocialMessageStatusState;
  summary?: string;
  needsHumanReason?: string;
};

export interface SocialBackend {
  loadState(args: LoadSocialStateArgs): Promise<SocialState>;
  addFriend(args: AddFriendArgs): Promise<SocialState>;
  setFriendGrants(args: SetFriendGrantsArgs): Promise<SocialState>;
  removeFriend(args: RemoveFriendArgs): Promise<SocialState>;
  sendMessage(args: SendMessageArgs): Promise<SocialState>;
  updateMessageStatus(args: UpdateMessageStatusArgs): Promise<SocialState>;
}

export const SOCIAL_GRANT_OPTIONS: Array<{ operation: SocialRemoteOperation; label: string }> = [
  { operation: "social.thread.create", label: "Start threads" },
  { operation: "social.message.send", label: "Send messages" },
  { operation: "social.message.status.update", label: "Update message status" },
];
