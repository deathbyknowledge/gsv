import type {
  ConversationMessage,
  ConversationMessageOrigin,
  ConversationSummary,
  InteractionOrigin,
} from "@humansandmachines/gsv/protocol";
import type { ChatTranscriptRow } from "./transcript";

export type ChatConversation = ConversationSummary;

export function conversationMessageRow(
  message: ConversationMessage,
  directed = false,
): ChatTranscriptRow {
  return {
    id: `conversation:${message.id}`,
    messageId: message.id,
    conversationSequence: message.sequence,
    role: message.author.kind === "user" ? "user" : "assistant",
    text: message.text,
    media: message.media,
    timestamp: message.createdAt,
    time: formatTime(message.createdAt),
    origin: interactionOrigin(message.origin),
    processId: message.processId,
    runId: message.runId,
    status: "done",
    delivery: directed ? "directed" : "sync",
  };
}

export function conversationDraftRow(input: {
  conversationId: string;
  messageId: string;
  processId: string;
  runId: string;
  timestamp: number;
}): ChatTranscriptRow {
  return {
    id: `conversation-draft:${input.messageId}`,
    messageId: input.messageId,
    role: "assistant",
    text: "",
    timestamp: input.timestamp,
    time: formatTime(input.timestamp),
    processId: input.processId,
    runId: input.runId,
    status: "streaming",
    streaming: true,
    delivery: "directed",
  };
}

export function preserveDirectedConversationDelivery(
  current: ChatTranscriptRow | undefined,
  next: ChatTranscriptRow,
): ChatTranscriptRow {
  return current?.id === next.id
    && current.delivery === "directed"
    && next.delivery === "sync"
    ? { ...next, delivery: "directed" }
    : next;
}

function interactionOrigin(origin: ConversationMessageOrigin): InteractionOrigin | undefined {
  if (origin.kind === "client") {
    return {
      kind: "client",
      connectionId: "conversation",
      ...(origin.clientId ? { clientId: origin.clientId } : {}),
      ...(origin.platform ? { platform: origin.platform } : {}),
    };
  }
  if (origin.kind === "adapter") {
    return {
      kind: "adapter",
      adapter: origin.adapter,
      accountId: origin.accountId,
      actorId: origin.actorId,
      surface: origin.surface,
      ...(origin.providerMessageId ? { messageId: origin.providerMessageId } : {}),
    };
  }
  if (origin.kind === "process") {
    return { kind: "process", sourcePid: origin.pid };
  }
  if (origin.kind === "device") {
    return { kind: "device", deviceId: origin.deviceId };
  }
  if (origin.kind === "scheduler") {
    return { kind: "scheduler", scheduleId: origin.scheduleId };
  }
  return undefined;
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
