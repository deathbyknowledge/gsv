/**
 * AI syscall types.
 *
 * Kernel-internal queries used by Process DOs to bootstrap each agent run.
 * ai.tools returns available syscall tool schemas + online devices.
 * ai.config returns model/provider/apiKey resolved from the filesystem.
 */

import type { ToolDefinition } from "./index";

export type AiContextProfile =
  | "init"
  | "task"
  | "review"
  | "cron"
  | "mcp"
  | "app"
  | "archivist"
  | "curator";

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
  maxContextBytes: number;
};
