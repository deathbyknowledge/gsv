/**
 * AI syscall types.
 *
 * Kernel-internal queries used by Process DOs to bootstrap each agent run.
 * ai.tools returns available syscall tool schemas + online devices.
 * ai.config returns model/provider/apiKey resolved from the filesystem.
 */

import type { ToolDefinition } from "./index";

export type SystemAiContextProfile =
  | "init"
  | "task"
  | "review"
  | "cron"
  | "mcp"
  | "app"
  | "archivist"
  | "curator";

export type PackageAiContextProfile = `${string}#${string}`;

export type AiContextProfile = SystemAiContextProfile | PackageAiContextProfile;

export function isSystemAiContextProfile(value: unknown): value is SystemAiContextProfile {
  return value === "init"
    || value === "task"
    || value === "review"
    || value === "cron"
    || value === "mcp"
    || value === "app"
    || value === "archivist"
    || value === "curator";
}

export function isPackageAiContextProfile(value: unknown): value is PackageAiContextProfile {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("#");
  return separator > 0 && separator < trimmed.length - 1;
}

export function isAiContextProfile(value: unknown): value is AiContextProfile {
  return isSystemAiContextProfile(value) || isPackageAiContextProfile(value);
}

// --- ai.tools ---

export type AiToolsArgs = Record<string, never>;

export type AiToolsDevice = {
  id: string;
  implements: string[];
  platform?: string;
};

export type AiToolsResult = {
  tools: ToolDefinition[];
  devices: AiToolsDevice[];
};


export type AiConfigArgs = {
  profile?: AiContextProfile;
};

export type AiConfigResult = {
  profile?: AiContextProfile;
  provider: string;
  model: string;
  apiKey: string;
  reasoning?: string;
  maxTokens: number;
  profileContextFiles?: Array<{
    name: string;
    text: string;
  }>;
  profileApprovalPolicy?: string | null;
  maxContextBytes: number;
};
