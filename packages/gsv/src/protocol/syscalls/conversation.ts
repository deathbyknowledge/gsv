import type { MessageAttachment } from "./proc";
import type { ResourceBlock } from "../resource";

export type ConversationKind = "home" | "work" | "group";

export type ConversationMemberRole = "member" | "handler" | "observer";

export type ConversationMember = {
  kind: "account" | "process";
  id: string;
  role: ConversationMemberRole;
};

export type ConversationSummary = {
  id: string;
  kind: ConversationKind;
  ownerUid: number;
  title: string | null;
  handlerPid: string;
  latestSequence: number;
  createdAt: number;
  updatedAt: number;
};

export type ConversationMessageAuthor =
  | { kind: "user"; uid: number }
  | { kind: "process"; pid: string; uid: number };

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
  | { kind: "mail"; messageId: string };

export type ConversationMessage = {
  id: string;
  conversationId: string;
  sequence: number;
  author: ConversationMessageAuthor;
  text: string;
  media?: MessageAttachment[];
  origin: ConversationMessageOrigin;
  processId?: string;
  runId?: string;
  createdAt: number;
};

export type ConversationHomeArgs = Record<string, never>;
export type ConversationHomeResult = { conversation: ConversationSummary };

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

export type ConversationSendArgs = {
  conversationId: string;
  text: string;
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
