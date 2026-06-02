/**
 * AI syscall types.
 *
 * Kernel-internal queries used by Process DOs to bootstrap each agent run.
 * ai.tools returns available syscall tool schemas + online devices.
 * ai.config returns model/provider/apiKey resolved from the filesystem.
 */

import type { ToolDefinition } from "./index";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type {
  AiSpeechCreateArgs,
  AiSpeechCreateResult,
  AiTranscriptionCreateArgs,
  AiTranscriptionCreateResult,
} from "@gsv/protocol/syscalls/ai";

export type {
  AiSpeechCreateArgs,
  AiSpeechCreateResult,
  AiTranscriptionCreateArgs,
  AiTranscriptionCreateResult,
} from "@gsv/protocol/syscalls/ai";

// --- ai.tools ---

export type AiToolsArgs = Record<string, never>;

export type AiToolsDevice = {
  id: string;
  implements: string[];
  label?: string;
  description?: string;
  platform?: string;
  lifecycle?: "persistent" | "ephemeral";
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
  profileContextFiles?: ContextFile[];
  skillIndex?: AiSkillIndexEntry[];
  profileApprovalPolicy?: string | null;
  maxContextBytes: number;
  generationTimeoutMs: number;
  generationStreaming?: "auto" | "off";
};
