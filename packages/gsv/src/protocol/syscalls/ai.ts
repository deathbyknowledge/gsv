import type { ProcessIdentity } from "./system";

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
};

export type ContextFile = {
  name: string;
  text: string;
};

export type AiConfigResult = {
  /** Owning human's identity when the process runs as a distinct agent account. */
  owner?: ProcessIdentity | null;
  provider: string;
  model: string;
  apiKey: string;
  reasoning?: string;
  maxTokens: number;
  contextWindowTokens: number | null;
  contextWindowSource: "model" | "config" | "unknown";
  systemContextFiles?: ContextFile[];
  skillIndex?: AiSkillIndexEntry[];
  accountApprovalPolicy?: string | null;
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
