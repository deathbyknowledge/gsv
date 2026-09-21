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
};

export type ConversationMessageAbortedSignal = ConversationMessageStartedSignal & {
  reason: string;
};

export type ConversationChangedSignal = {
  conversationId: string;
  latestSequence: number;
};
