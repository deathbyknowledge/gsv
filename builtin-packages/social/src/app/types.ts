import type {
  SocialDeliveryStatus,
  SocialGrant,
  SocialLocalIdentity,
  SocialMessageDirection,
  SocialRemoteOperation,
  SocialRequestKind,
  SocialRequestStatus,
  SocialThreadStatus,
} from "@gsv/protocol/syscalls/social";

export type SocialView = "threads" | "requests" | "friends";

export type SocialPeerSummary = {
  handle: string;
  displayName?: string;
  agentDisplayName?: string;
  acceptsMessages: boolean;
  acceptsRequests: boolean;
  acceptedSocialMethods: SocialRemoteOperation[];
  grants: SocialGrant[];
  updatedAt: string;
};

export type SocialThreadItem = {
  threadId: string;
  peerHandle: string;
  conversationId: string;
  status: SocialThreadStatus;
  topic?: string;
  updatedAt: string;
  requestCount: number;
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

export type SocialRequestItem = {
  requestId: string;
  threadId?: string;
  kind: SocialRequestKind;
  status: SocialRequestStatus;
  fromHandle: string;
  toHandle: string;
  title: string;
  body?: unknown;
  updatedAt: string;
  expiresAt?: string;
};

export type SocialThreadDetail = {
  thread: SocialThreadItem | null;
  messages: SocialMessageItem[];
  requests: SocialRequestItem[];
};

export type SocialState = {
  identity: SocialLocalIdentity | null;
  friends: SocialPeerSummary[];
  threads: SocialThreadItem[];
  requests: SocialRequestItem[];
  selectedThread: SocialThreadDetail | null;
};

export type LoadSocialStateArgs = {
  threadId?: string | null;
};

export type AddFriendArgs = {
  handle: string;
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

export type CreateRequestArgs = {
  toHandle: string;
  threadId?: string;
  kind: SocialRequestKind;
  title: string;
  bodyText?: string;
};

export type RespondRequestArgs = {
  requestId: string;
  status: Extract<SocialRequestStatus, "agent-replied" | "needs-human" | "accepted" | "declined" | "completed">;
  text?: string;
  threadId?: string | null;
};

export interface SocialBackend {
  loadState(args: LoadSocialStateArgs): Promise<SocialState>;
  addFriend(args: AddFriendArgs): Promise<SocialState>;
  setFriendGrants(args: SetFriendGrantsArgs): Promise<SocialState>;
  removeFriend(args: RemoveFriendArgs): Promise<SocialState>;
  sendMessage(args: SendMessageArgs): Promise<SocialState>;
  createRequest(args: CreateRequestArgs): Promise<SocialState>;
  respondRequest(args: RespondRequestArgs): Promise<SocialState>;
}

export const SOCIAL_GRANT_OPTIONS: Array<{ operation: SocialRemoteOperation; label: string }> = [
  { operation: "social.thread.create", label: "Start threads" },
  { operation: "social.message.send", label: "Send messages" },
  { operation: "social.message.reply", label: "Reply to messages" },
  { operation: "social.request.create", label: "Create requests" },
  { operation: "social.request.respond", label: "Respond to requests" },
];

export const REQUEST_KIND_OPTIONS: Array<{ kind: SocialRequestKind; label: string }> = [
  { kind: "question", label: "Question" },
  { kind: "task", label: "Task" },
  { kind: "collaboration", label: "Collaboration" },
  { kind: "workspace-invite", label: "Workspace invite" },
  { kind: "package-review", label: "Package review" },
  { kind: "other", label: "Other" },
];
