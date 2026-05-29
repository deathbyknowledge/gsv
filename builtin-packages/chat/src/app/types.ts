export type ChatBackend = {
  getViewer(args?: unknown): Promise<unknown>;
  listProfiles(args?: unknown): Promise<unknown>;
  listProcesses(args?: unknown): Promise<unknown>;
  spawnProcess(args: unknown): Promise<unknown>;
  sendMessage(args: unknown): Promise<unknown>;
  getHistory(args: unknown): Promise<unknown>;
  readProcessMedia(args: unknown): Promise<unknown>;
  listConversations(args: unknown): Promise<unknown>;
  compactConversation(args: unknown): Promise<unknown>;
  listConversationSegments(args: unknown): Promise<unknown>;
  readConversationSegment(args: unknown): Promise<unknown>;
  forkConversation(args: unknown): Promise<unknown>;
  abortRun(args: unknown): Promise<unknown>;
  decideHil(args: unknown): Promise<unknown>;
  watchProcessSignals(args: unknown): Promise<unknown>;
  unwatchProcessSignals(args: unknown): Promise<unknown>;
};

export type ThreadContext = {
  pid: string;
  cwd: string;
  conversationId: string;
  conversationTitle: string | null;
};

export type Profile = {
  id: string;
  alias?: string;
  displayName: string;
  description: string;
  kind: string;
  interactive: boolean;
  startable: boolean;
  background: boolean;
  spawnMode: "singleton" | "new" | string;
};

export type ProcessEntry = {
  pid: string;
  label?: string;
  profile: string;
  state: string;
  cwd: string;
  createdAt: number;
};

export type ConversationRecord = {
  id: string;
  generation: number;
  status: string;
  title: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ContextState = {
  conversationId: string;
  runId?: string;
  messageCount?: number;
  lastMessageId?: number | null;
  provider: string | null;
  model: string | null;
  contextWindowTokens: number | null;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  inputTokens: number;
  outputTokens: number | null;
  totalTokens: number | null;
  availableInputTokens: number | null;
  pressure: number | null;
  level: "ok" | "warn" | "critical" | "full" | "unknown";
  source: "provider" | "estimate";
  updatedAt: number;
};

export type Attachment = {
  type: string;
  mimeType: string;
  data: string;
  filename?: string;
  size?: number;
  duration?: number;
  previewUrl?: string;
};

export type VoiceRecordingState = {
  status: "idle" | "requesting" | "recording" | "processing";
  elapsedMs: number;
  error?: string;
};

export type InteractionOrigin =
  | {
      kind: "client";
      connectionId: string;
      clientId?: string;
      platform?: string;
    }
  | {
      kind: "app";
      packageId: string;
      packageName: string;
      entrypointName: string;
      routeBase: string;
    }
  | {
      kind: "adapter";
      adapter: string;
      accountId: string;
      surface: {
        kind: "dm" | "group" | "channel" | "thread";
        id: string;
        name?: string;
        handle?: string;
        threadId?: string;
      };
      actorId: string;
      actorLabel?: string;
      messageId?: string;
    }
  | {
      kind: "device";
      deviceId: string;
      cwd?: string;
    }
  | {
      kind: "process";
      sourcePid: string;
      uid?: number;
    }
  | {
      kind: "scheduler";
      scheduleId: string;
    };

export type MessageRow = {
  kind: "message";
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  messageId?: number | null;
  origin?: InteractionOrigin;
  thinking?: string[];
  media?: unknown[];
  runId?: string | null;
  streaming?: boolean;
};

export type ToolRow = {
  kind: "toolCall" | "toolResult";
  toolName: string;
  callId: string;
  args: unknown;
  syscall?: string | null;
  timestamp: number;
  runId?: string | null;
  phase?: "planning" | "running";
  contentIndex?: number;
  output?: unknown;
  ok?: boolean;
  error?: string | null;
};

export type LogRow = MessageRow | ToolRow;

export type HilRequest = {
  requestId: string;
  runId: string;
  conversationId?: string;
  callId: string;
  toolName: string;
  syscall: string;
  args: unknown;
  createdAt: number;
};

export type ConversationSegment = {
  id: string;
  generation: number;
  fromMessageId: number;
  toMessageId: number;
  archivePath: string;
  summaryMessageId: number | null;
  createdAt: number;
};

export type StageView = "chat" | "archive";

export type PendingAssistantState = "thinking" | "tool" | null;

export type CompactDialogState = { keepLast: string; suggested: number } | null;

export type ArchiveState = {
  loading: boolean;
  error: string;
  segments: ConversationSegment[];
  selectedSegmentId: string | null;
  messages: unknown[];
  messageCount: number;
  truncated: boolean;
};
