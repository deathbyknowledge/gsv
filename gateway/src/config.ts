// GSV Configuration Types and Defaults

export interface GsvConfig {
  // Model settings
  model: {
    provider: string;
    id: string;
  };

  // API Keys (stored securely)
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
  };

  // Timeouts
  timeouts: {
    llmMs: number;
    toolMs: number;
  };

  // Auth settings
  auth: {
    token?: string;
  };

  // System prompt
  systemPrompt?: string;
}

export const DEFAULT_CONFIG: GsvConfig = {
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
  },
  apiKeys: {},
  timeouts: {
    llmMs: 300_000, // 5 minutes
    toolMs: 60_000, // 1 minute
  },
  auth: {},
};

export function mergeConfig(base: GsvConfig, overrides: Partial<GsvConfig>): GsvConfig {
  return {
    model: { ...base.model, ...overrides.model },
    apiKeys: { ...base.apiKeys, ...overrides.apiKeys },
    timeouts: { ...base.timeouts, ...overrides.timeouts },
    auth: { ...base.auth, ...overrides.auth },
    systemPrompt: overrides.systemPrompt ?? base.systemPrompt,
  };
}
