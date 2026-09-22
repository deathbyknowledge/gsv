import type { MessageAttachment } from "./proc";
import type { ResourceBlock } from "../resource";
import type { SocialMessageMetadata } from "../social";

export type ConversationKind = "ship" | "work" | "group" | "contact";

export type ConversationMemberRole = "member" | "handler" | "observer";

export type ConversationMember = {
  kind: "account" | "process";
  id: string;
  role: ConversationMemberRole;
};

export type ConversationSummary = {
  id: string;
  ownerUid: number;
  title: string | null;
  latestSequence: number;
  createdAt: number;
  updatedAt: number;
} & (
  | { kind: "ship" | "work" | "group"; handlerPid: string }
  | { kind: "contact"; handlerPid?: string }
);

export type ConversationMessageAuthor =
  | { kind: "user"; uid: number }
  | { kind: "process"; pid: string; uid: number }
  | {
      kind: "contact";
      contactId: string;
      shipId: string;
      subjectId: string;
      displayName: string;
    };

export type ConversationMessageOrigin =
  | {
      kind: "client";
      clientId?: string;
      platform?: string;
    }
  | {
      kind: "adapter";
      adapter: string;
      accountId: string;
      actorId: string;
      surface: {
        kind: "dm" | "group" | "channel" | "thread";
        id: string;
        threadId?: string;
      };
      providerMessageId?: string;
    }
  | {
      kind: "process";
      pid: string;
      runId: string;
    }
  | { kind: "device"; deviceId: string }
  | { kind: "scheduler"; scheduleId: string }
  | { kind: "mail"; messageId: string }
  | { kind: "federation"; contactId: string; deliveryId: string };

export type ConversationMessage = {
  id: string;
  conversationId: string;
  sequence: number;
  author: ConversationMessageAuthor;
  text: string;
  /** Absent on historical and v1 messages whose remote submission path is unspecified. */
  social?: SocialMessageMetadata;
  /** Target selected for this message, independently of its source and reply endpoint. */
  selectedTarget?: string;
  media?: MessageAttachment[];
  origin: ConversationMessageOrigin;
  processId?: string;
  runId?: string;
  createdAt: number;
};

export type ConversationShipArgs = Record<string, never>;
export type ConversationShipResult = { conversation: ConversationSummary };

export type ConversationForProcessArgs = { pid: string };
export type ConversationForProcessResult = { conversation: ConversationSummary };

export type ConversationListArgs = Record<string, never>;
export type ConversationListResult = { conversations: ConversationSummary[] };

export type ConversationView = {
  readThroughSequence: number;
  archived: boolean;
  revision: number;
};

export type ConversationPreview = Pick<ConversationMessage, "id" | "sequence" | "author" | "createdAt"> & {
  text: string;
  attachmentCount: number;
  provenance?: SocialMessageMetadata["provenance"];
};

export type ConversationInboxEntry = {
  conversation: ConversationSummary;
  contactId: string;
  view: ConversationView;
  unread: boolean;
  latestIncomingSequence: number;
  preview: ConversationPreview | null;
};

export type ConversationInboxArgs = {
  archived?: boolean;
  before?: { updatedAt: number; conversationId: string };
  limit?: number;
};
export type ConversationInboxResult = {
  entries: ConversationInboxEntry[];
  next?: { updatedAt: number; conversationId: string };
};

export type ConversationAttentionEntry = {
  conversationId: string;
  contactId: string;
  displayName: string;
  origin: string;
  throughSequence: number;
  kind: "notify" | "digest";
  availableAt: number;
  preview: ConversationPreview;
};
export type ConversationAttentionListArgs = {
  before?: { availableAt: number; conversationId: string };
  limit?: number;
};
export type ConversationAttentionListResult = {
  entries: ConversationAttentionEntry[];
  readyCount: number;
  digestWaitingCount: number;
  nextDigestAt?: number;
  next?: { availableAt: number; conversationId: string };
};
export type ConversationAttentionDismissArgs = {
  entries: { conversationId: string; throughSequence: number }[];
};
export type ConversationAttentionDismissResult = Record<string, never>;
export type ConversationAttentionChangedSignal = { digestId?: string };

export type ConversationViewGetArgs = { conversationId: string };
export type ConversationViewGetResult = { entry: ConversationInboxEntry };

export type ConversationViewUpdateArgs = {
  conversationId: string;
  readThroughSequence?: number;
  archived?: boolean;
  /** Required for an archive change; read position always merges monotonically. */
  expectedRevision?: number;
};
export type ConversationViewUpdateResult = { entry: ConversationInboxEntry };

export type ConversationHistoryArgs = {
  conversationId: string;
  beforeSequence?: number;
  limit?: number;
};

export type ConversationHistoryResult = {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  hasMore: boolean;
};

export type ConversationSearchArgs = {
  conversationId: string;
  query: string;
  beforeSequence?: number;
  limit?: number;
};

export type ConversationSearchCoverage = {
  state: "complete" | "building" | "limited" | "error";
  indexedMessages: number;
  truncatedMessages: number;
  omittedMessages: number;
  historicalBeforeSequence: number;
  latestSequence: number;
};

export type ConversationSearchResult = {
  conversationId: string;
  matches: { messageId: string; sequence: number; excerpt: string; createdAt: number }[];
  nextBeforeSequence?: number;
  coverage: ConversationSearchCoverage;
};

export type ConversationSendArgs = {
  conversationId: string;
  text: string;
  /** Optional target context for this message; does not change process defaults or permissions. */
  selectedTarget?: string;
  media?: ResourceBlock[];
  idempotencyKey?: string;
};

export type ConversationSendResult = {
  message: ConversationMessage;
  handlerPid: string;
  runId: string;
  queued?: boolean;
};

export type ConversationMediaReadArgs = {
  conversationId: string;
  key: string;
};

export type ConversationMediaReadResult =
  | {
      ok: true;
      conversationId: string;
      key: string;
      mimeType: string;
      size: number;
    }
  | { ok: false; error: string };

export type ConversationMessageStartedSignal = {
  conversationId: string;
  messageId: string;
  processId: string;
  runId: string;
  timestamp: number;
};

export type ConversationMessageDeltaSignal = ConversationMessageStartedSignal & {
  delta: string;
};

export type ConversationMessageCommittedSignal = {
  message: ConversationMessage;
  directed: boolean;
  /** Private human attention policy, derived locally rather than supplied by a peer. */
  attention?: "notify" | "digest" | "quiet";
};

export type ConversationMessageAbortedSignal = ConversationMessageStartedSignal & {
  reason: string;
};

export type ConversationChangedSignal = {
  viewOnly?: boolean;
  conversationId: string;
  latestSequence: number;
};
