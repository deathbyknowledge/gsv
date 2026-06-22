export type ChatBackend = {
  getViewer(args?: unknown): Promise<unknown>;
  listAgents(args?: unknown): Promise<unknown>;
  listProcesses(args?: unknown): Promise<unknown>;
  spawnProcess(args: unknown): Promise<unknown>;
  sendMessage(args: unknown): Promise<unknown>;
  getHistory(args: unknown): Promise<unknown>;
  readProcessMedia(args: unknown): Promise<unknown>;
  getProcessAiConfig(args: unknown): Promise<unknown>;
  setProcessAiProfile(args: unknown): Promise<unknown>;
  setProcessAiField(args: unknown): Promise<unknown>;
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
  /**
   * True when this is the viewer's personal-agent default conversation (home).
   * The executor pid is ephemeral, so home is identified by this flag rather
   * than by the pid.
   */
  isHome: boolean;
};

// An agent the viewer can run a conversation as. Sourced from account.list.
// `id` is "personal" for the viewer's personal agent (its default conversation
// is the stable home, spawned with no run-as) and the account username for
// every other agent (each conversation spawned with `runAs`).
export type Profile = {
  id: string;
  alias?: string;
  displayName: string;
  description: string;
  kind: string;
  interactive: boolean;
  startable: boolean;
  background: boolean;
  spawnMode: "default" | "new" | string;
  /** Account username to run as; absent for the personal agent. */
  runAs?: string;
  /** Account username for an explicit fresh process when `runAs` is absent. */
  newProcessRunAs?: string;
};

export type ProcessEntry = {
  pid: string;
  label?: string;
  profile: string;
  username: string;
  interactive: boolean;
  state: string;
  activeRunId?: string | null;
  activeConversationId?: string | null;
  queuedCount: number;
  cwd: string;
  createdAt: number;
  /** True when this process is the viewer's personal-agent default conversation. */
  isDefaultConversation: boolean;
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

export type UsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  currency: "USD";
  source: "provider" | "model-pricing" | "mixed";
};

export type UsageState = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: UsageCost | null;
  generations?: number;
  costIncomplete?: boolean;
  updatedAt?: number;
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
  usage: UsageState | null;
  conversationUsage: UsageState | null;
  availableInputTokens: number | null;
  pressure: number | null;
  level: "ok" | "warn" | "critical" | "full" | "unknown";
  source: "provider" | "estimate";
  updatedAt: number;
};

export type ProcessAiProfileRef = {
  id?: string;
  name?: string;
  appliedAt?: number;
};

export type ProcessAiSnapshot = {
  version?: number;
  profile?: ProcessAiProfileRef | null;
  values: Record<string, string>;
  updatedAt?: number;
};

export type ProcessAiEffectiveState = {
  profile: ProcessAiProfileRef | null;
  values: Record<string, string>;
};

export type ProcessAiModelProfile = {
  id: string;
  name: string;
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

export type ProcessAiState = {
  profile: string;
  effective: ProcessAiEffectiveState;
  local: ProcessAiSnapshot | null;
  profiles: ProcessAiModelProfile[];
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
  startedAt?: number;
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
