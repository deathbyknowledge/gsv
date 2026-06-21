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

export type AiConfigArgs = Record<string, never>;

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
  system?: {
    timezone: string;
  };
  skillIndex?: AiSkillIndexEntry[];
  accountApprovalPolicy?: string | null;
  maxContextBytes: number;
  generationTimeoutMs: number;
  generationStreaming?: "auto" | "off";
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
