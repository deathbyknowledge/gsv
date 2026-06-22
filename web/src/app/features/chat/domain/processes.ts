import type {
  ProcAbortResult,
  ProcHistoryMessage,
  ProcHistoryResult,
  ProcListEntry,
  ProcMediaInput,
  ProcSendArgs,
} from "@humansandmachines/gsv/protocol";

export type ChatRunState = "idle" | "running" | "queued" | "awaiting_hil";

export type ChatProcessSummary = {
  pid: string;
  uid: number;
  username: string;
  interactive: boolean;
  parentPid: string | null;
  state: string;
  runState: ChatRunState;
  activeRunId: string | null;
  activeConversationId: string | null;
  queuedCount: number;
  lastActiveAt: number | null;
  label: string | null;
  title: string;
  createdAt: number;
  cwd: string;
  isDefaultConversation: boolean;
};

export type ChatHistoryMessageRole = ProcHistoryMessage["role"];

export type ChatHistoryMessage = {
  id: number | null;
  clientId: string;
  runId: string | null;
  role: ChatHistoryMessageRole;
  content: unknown;
  text: string;
  timestamp: number | null;
  origin: ProcHistoryMessage["origin"];
  metadata: ProcHistoryMessage["metadata"];
};

export type ChatHistory = {
  pid: string;
  conversationId: string | null;
  messages: ChatHistoryMessage[];
  messageCount: number;
  truncated: boolean;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  activeRunId: string | null;
  activeConversationId: string | null;
  runState: ChatRunState;
  pendingHil: NonNullable<Extract<ProcHistoryResult, { ok: true }>["pendingHil"]> | null;
  context: Extract<ProcHistoryResult, { ok: true }>["context"];
};

export type ChatSendDraft = {
  pid?: string;
  conversationId?: string;
  message: string;
  media?: ProcMediaInput[];
};

export type ChatSendPayload = ProcSendArgs;

function cleanOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (value && typeof value === "object" && "text" in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }

  return "";
}

export function normalizeRunState(input: {
  activeRunId?: string | null;
  queuedCount?: number | null;
  pendingHil?: unknown;
}): ChatRunState {
  if (input.pendingHil) {
    return "awaiting_hil";
  }
  if (input.activeRunId) {
    return "running";
  }
  if ((input.queuedCount ?? 0) > 0) {
    return "queued";
  }
  return "idle";
}

export function normalizeProcessSummary(process: ProcListEntry): ChatProcessSummary {
  const title = process.label?.trim() || (process.isDefaultConversation ? "Home" : process.pid);

  return {
    pid: process.pid,
    uid: process.uid,
    username: process.username,
    interactive: process.interactive,
    parentPid: process.parentPid,
    state: process.state,
    runState: normalizeRunState({
      activeRunId: process.activeRunId,
      queuedCount: process.queuedCount,
    }),
    activeRunId: process.activeRunId,
    activeConversationId: process.activeConversationId,
    queuedCount: process.queuedCount,
    lastActiveAt: process.lastActiveAt,
    label: process.label,
    title,
    createdAt: process.createdAt,
    cwd: process.cwd,
    isDefaultConversation: process.isDefaultConversation === true,
  };
}

export function normalizeProcessSummaries(processes: readonly ProcListEntry[]): ChatProcessSummary[] {
  return [...processes]
    .map(normalizeProcessSummary)
    .sort((left, right) => {
      const leftActivity = left.lastActiveAt ?? left.createdAt;
      const rightActivity = right.lastActiveAt ?? right.createdAt;
      return rightActivity - leftActivity || left.title.localeCompare(right.title);
    });
}

export function normalizeHistoryMessage(message: ProcHistoryMessage, index: number): ChatHistoryMessage {
  const id = typeof message.id === "number" ? message.id : null;
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : null;

  return {
    id,
    clientId: id === null ? `transient-${index}` : String(id),
    runId: message.runId ?? null,
    role: message.role,
    content: message.content,
    text: normalizeMessageText(message.content),
    timestamp,
    origin: message.origin,
    metadata: message.metadata,
  };
}

export function normalizeHistory(result: Extract<ProcHistoryResult, { ok: true }>): ChatHistory {
  return {
    pid: result.pid,
    conversationId: result.conversationId ?? null,
    messages: result.messages.map(normalizeHistoryMessage),
    messageCount: result.messageCount,
    truncated: result.truncated === true,
    hasMoreBefore: result.hasMoreBefore === true,
    hasMoreAfter: result.hasMoreAfter === true,
    activeRunId: result.activeRunId ?? null,
    activeConversationId: result.activeConversationId ?? null,
    runState: normalizeRunState({
      activeRunId: result.activeRunId,
      pendingHil: result.pendingHil,
    }),
    pendingHil: result.pendingHil ?? null,
    context: result.context ?? null,
  };
}

export function normalizeSendPayload(draft: ChatSendDraft): ChatSendPayload {
  const message = draft.message.trim();
  const pid = cleanOptionalString(draft.pid);
  const conversationId = cleanOptionalString(draft.conversationId);
  const media = draft.media?.filter(Boolean);

  return {
    message,
    ...(pid ? { pid } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(media && media.length > 0 ? { media } : {}),
  };
}

export function didAbortActiveRun(result: ProcAbortResult): boolean {
  return result.ok === true && result.aborted;
}
