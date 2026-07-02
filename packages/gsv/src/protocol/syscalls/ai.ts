import type { ProcessIdentity } from "./system";
import type { ProcAiConfigProfileRef } from "./proc";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AiToolsArgs = Record<string, never>;

export type AiToolsDevice = {
  id: string;
  implements: string[];
  label?: string;
  description?: string;
  platform?: string;
};

export type AiToolsResult = {
  tools: ToolDefinition[];
  devices: AiToolsDevice[];
  mcpServers: string[];
};

export type AiSkillIndexEntry = {
  id: string;
  name: string;
  description: string;
  source: {
    kind: "home" | "package";
    label: string;
    writable: boolean;
  };
};

export type AiConfigArgs = {
  processOverrides?: Record<string, string>;
  processProfile?: ProcAiConfigProfileRef | null;
};

export type ContextFile = {
  name: string;
  text: string;
};

export type AiTextExecutor =
  | {
      kind: "process";
      pid: string;
    }
  | {
      kind: "kernel";
    }
  | {
      kind: "device";
      target: string;
    };

export type AiConfigResult = {
  /** Owning human's identity when the process runs as a distinct agent account. */
  owner?: ProcessIdentity | null;
  executor: AiTextExecutor;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  providerStyle?: string;
  transportTarget?: string;
  reasoning?: string;
  maxTokens: number;
  contextWindowTokens: number | null;
  contextWindowSource: "model" | "config" | "unknown";
  systemContextFiles?: ContextFile[];
  system?: {
    timezone: string;
  };
  skillIndex?: AiSkillIndexEntry[];
  accountApprovalPolicy?: string | null;
  capabilities: string[];
  maxContextBytes: number;
  generationTimeoutMs: number;
  generationStreaming?: "auto" | "off";
  media?: {
    transcriptionProvider: string;
    transcriptionModel: string;
    transcriptionApiKey: string;
    transcriptionMaxBytes: number;
    imageReadingProvider: string;
    imageReadingModel: string;
    imageReadingApiKey: string;
    imageReadingInputFormat: "auto" | "chat" | "image";
    imageReadingMaxBytes: number;
    imageReadingMaxTokens: number;
    imageReadingTimeoutMs: number;
    imageReadingPrompt: string;
    imageGenerationProvider: string;
    imageGenerationModel: string;
    imageGenerationApiKey: string;
    speechProvider: string;
    speechModel: string;
    speechApiKey: string;
    speechSpeaker: string;
    speechEncoding: string;
    speechMaxChars: number;
    speechTimeoutMs: number;
  };
};

export type AiTextContent = {
  type: "text";
  text: string;
  textSignature?: string;
};

export type AiThinkingContent = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};

export type AiImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type AiToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
};

export type AiUsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type AiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  totalTokens: number;
  cost: AiUsageCost;
};

export type AiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type AiUserMessage = {
  role: "user";
  content: string | Array<AiTextContent | AiImageContent>;
  timestamp?: number;
};

export type AiAssistantMessage = {
  role: "assistant";
  content: Array<AiTextContent | AiThinkingContent | AiToolCall>;
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: unknown[];
  usage: AiUsage;
  stopReason: AiStopReason;
  errorMessage?: string;
  timestamp?: number;
};

export type AiToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<AiTextContent | AiImageContent>;
  details?: unknown;
  isError: boolean;
  timestamp?: number;
};

export type AiTextMessage = AiUserMessage | AiAssistantMessage | AiToolResultMessage;

export type AiTextTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AiTextGenerationReasoning =
  | "inherit"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type AiTextGenerateOptions = {
  maxTokens?: number;
  reasoning?: AiTextGenerationReasoning;
  timeoutMs?: number;
};

export type AiTextGenerateConfig = {
  preset?: {
    id?: string;
    name?: string;
  };
  overrides?: Record<string, string>;
  processOverrides?: Record<string, string>;
  processProfile?: ProcAiConfigProfileRef | null;
};

export type AiTextGenerateArgs = {
  target?: string;
  systemPrompt?: string;
  messages: AiTextMessage[];
  tools?: AiTextTool[];
  config?: AiTextGenerateConfig;
  options?: AiTextGenerateOptions;
  sessionAffinityKey?: string;
};

export type AiTextGenerateResult = {
  message: AiAssistantMessage;
  provider: string;
  model: string;
  text?: string;
};

export type AiTranscriptionCreateArgs = {
  audio: {
    data: string;
    mimeType: string;
    filename?: string;
    size?: number;
  };
  language?: string;
  prompt?: string;
  mode?: "transcribe" | "translate";
};

export type AiTranscriptionCreateResult = {
  text: string;
  language?: string;
  duration?: number;
  segments?: unknown[];
  provider: string;
  model: string;
};

export type AiImageReadArgs = {
  image: {
    data: string;
    mimeType: string;
    filename?: string;
    size?: number;
  };
  prompt?: string;
  model?: string;
  inputFormat?: "auto" | "chat" | "image";
  maxTokens?: number;
};

export type AiImageReadResult = {
  text: string;
  provider: string;
  model: string;
};

export type AiImageGenerateArgs = {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  format?: string;
  timeoutMs?: number;
};

export type AiImageGenerateResult = {
  image: {
    data: string;
    mimeType: string;
    size: number;
  };
  provider: string;
  model: string;
  revisedPrompt?: string;
  url?: string;
};

export type AiSpeechCreateArgs = {
  text: string;
  textFormat?: "markdown" | "plain";
  model?: string;
  voice?: string;
  language?: string;
  encoding?: string;
  container?: string;
  sampleRate?: number;
  bitRate?: number;
};

export type AiSpeechCreateResult = {
  audio: {
    data: string;
    mimeType: string;
    size: number;
  };
  provider: string;
  model: string;
  voice?: string;
  encoding?: string;
  container?: string;
  skipped?: boolean;
};
