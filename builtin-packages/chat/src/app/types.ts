export type ChatBackend = {
  getViewer(args?: unknown): Promise<unknown>;
  listProfiles(args?: unknown): Promise<unknown>;
  listWorkspaces(args?: unknown): Promise<unknown>;
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
  workspaceId: string | null;
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

export type WorkspaceEntry = {
  workspaceId: string;
  label?: string;
  updatedAt: number;
  processCount?: number;
  activeProcess?: {
    pid: string;
    cwd: string;
  } | null;
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

export type MessageRow = {
  kind: "message";
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  messageId?: number | null;
  thinking?: string[];
  media?: unknown[];
  runId?: string | null;
};

export type ToolRow = {
  kind: "toolCall" | "toolResult";
  toolName: string;
  callId: string;
  args: unknown;
  syscall?: string | null;
  timestamp: number;
  runId?: string | null;
  output?: unknown;
  ok?: boolean;
  error?: string | null;
  collapsed?: boolean;
  childRows?: ToolRow[];
};

export type LogRow = MessageRow | ToolRow;

export type HilRequest = {
  requestId: string;
  runId: string;
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

export type WorkspaceView = "chat" | "archive";

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
