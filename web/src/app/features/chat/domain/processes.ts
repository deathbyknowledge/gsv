import type {
  ProcAbortResult,
  ProcAiConfigGetResult,
  ProcAiConfigSetArgs,
  ProcAiConfigSetResult,
  ProcConversation,
  ProcConversationCompactArgs,
  ProcConversationCompactResult,
  ProcConversationForkArgs,
  ProcConversationForkResult,
  ProcConversationListArgs,
  ProcConversationSegment,
  ProcConversationSegmentReadArgs,
  ProcConversationSegmentReadResult,
  ProcConversationSegmentsArgs,
  ProcHilArgs,
  ProcHilDecision,
  ProcHilResult,
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
export type ChatHilDecision = ProcHilDecision;
export type ChatHilDecisionArgs = ProcHilArgs;
export type ChatHilDecisionResult = Extract<ProcHilResult, { ok: true }>;
export type ChatConversation = ProcConversation;
export type ChatConversationSegment = ProcConversationSegment;
export type ChatConversationListArgs = ProcConversationListArgs;
export type ChatConversationCompactArgs = ProcConversationCompactArgs;
export type ChatConversationCompactResult = Extract<ProcConversationCompactResult, { ok: true }>;
export type ChatConversationForkArgs = ProcConversationForkArgs;
export type ChatConversationForkResult = Extract<ProcConversationForkResult, { ok: true }>;
export type ChatConversationSegmentReadArgs = ProcConversationSegmentReadArgs;
export type ChatConversationSegmentReadResult = Extract<ProcConversationSegmentReadResult, { ok: true }>;
export type ChatConversationSegmentsArgs = ProcConversationSegmentsArgs;
export type ChatProcessAiConfig = Extract<ProcAiConfigGetResult, { ok: true }>["config"];
export type ChatProcessAiConfigSetArgs = ProcAiConfigSetArgs;
export type ChatProcessAiConfigSetResult = Extract<ProcAiConfigSetResult, { ok: true }>;

function cleanOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function stringifyMessageContent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeMessageText(value: unknown, role?: ChatHistoryMessageRole): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
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
        if (part && typeof part === "object" && "output" in part) {
          return normalizeMessageText((part as { output?: unknown }).output, role);
        }
        if (part && typeof part === "object" && "content" in part) {
          return normalizeMessageText((part as { content?: unknown }).content, role);
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

  if (value && typeof value === "object" && "output" in value) {
    return normalizeMessageText((value as { output?: unknown }).output, role);
  }

  if (value && typeof value === "object" && "content" in value) {
    return normalizeMessageText((value as { content?: unknown }).content, role);
  }

  if (value && typeof value === "object" && "result" in value) {
    return normalizeMessageText((value as { result?: unknown }).result, role);
  }

  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    const text = normalizeMessageText(error, role);
    return text ? `Error: ${text}` : "";
  }

  if (value && typeof value === "object" && "toolName" in value) {
    const toolName = (value as { toolName?: unknown }).toolName;
    const label = typeof toolName === "string" && toolName.trim()
      ? `Tool result: ${toolName.trim()}`
      : "Tool result";
    const args = "args" in value ? (value as { args?: unknown }).args : undefined;
    const details = args === undefined ? "" : stringifyMessageContent(args);
    return details ? `${label}\n${details}` : label;
  }

  if (role === "system" || role === "toolResult") {
    const text = stringifyMessageContent(value);
    return text === undefined ? "" : text;
  }

  if (value !== null && value !== undefined) {
    const text = stringifyMessageContent(value);
    return text === undefined ? "" : text;
  }

  return "";
}

function normalizeFallbackToolText(value: unknown): string {
  if (value && typeof value === "object" && "toolName" in value) {
    const toolName = (value as { toolName?: unknown }).toolName;
    return typeof toolName === "string" && toolName.trim()
      ? `Tool result: ${toolName}`
      : "";
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
    text: normalizeMessageText(message.content, message.role)
      || normalizeFallbackToolText(message.content),
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
