/**
 * AI syscall types.
 *
 * Kernel-internal queries used by Process DOs to bootstrap each agent run.
 * ai.tools returns available syscall tool schemas + online devices.
 * ai.config returns model/provider/apiKey resolved from the filesystem.
 */

import type { ToolDefinition } from "./index";
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

export type SystemAiContextProfile =
  | "init"
  | "task"
  | "review"
  | "cron"
  | "mcp"
  | "app";

export type PackageAiContextProfile = `${string}#${string}`;

export type UserAiContextProfile = string;

export type AiContextProfile = SystemAiContextProfile | PackageAiContextProfile | UserAiContextProfile;

const USER_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isSystemAiContextProfile(value: unknown): value is SystemAiContextProfile {
  return value === "init"
    || value === "task"
    || value === "review"
    || value === "cron"
    || value === "mcp"
    || value === "app";
}

export function isPackageAiContextProfile(value: unknown): value is PackageAiContextProfile {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("#");
  return separator > 0 && separator < trimmed.length - 1;
}

export function isUserAiContextProfile(value: unknown): value is UserAiContextProfile {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return USER_PROFILE_PATTERN.test(trimmed)
    && !isSystemAiContextProfile(trimmed)
    && !isPackageAiContextProfile(trimmed);
}

export function isAiContextProfile(value: unknown): value is AiContextProfile {
  return isSystemAiContextProfile(value)
    || isPackageAiContextProfile(value)
    || isUserAiContextProfile(value);
}

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
    kind: "profile" | "home" | "package";
    label: string;
    writable: boolean;
  };
};

export type AiConfigArgs = {
  profile?: AiContextProfile;
};

export type ContextFile = {
  name: string;
  text: string;
};

export type AiConfigResult = {
  profile?: AiContextProfile;
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
