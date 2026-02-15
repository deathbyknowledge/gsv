export interface AgentConfig {
  id: string;
  default?: boolean;
  
  // model override
  model?: {
    provider: string;
    id: string;
  };
  
  // system prompt override
  systemPrompt?: string;
  
  // Heartbeat configuration
  heartbeat?: HeartbeatConfig;
}

export interface HeartbeatConfig {
  // Interval between heartbeats (e.g., "30m", "1h", "0m" to disable)
  every: string;
  
  // Custom prompt for heartbeat
  prompt: string;
  
  // Delivery target: "last" (last channel), "none", or specific channel
  target: "last" | "none" | string;
  
  // Active hours (skip heartbeat outside these hours)
  activeHours: {
    start: string;  // "08:00"
    end: string;    // "23:00"
    timezone?: string;  // "user", "local", or IANA zone
  };
}

export interface AgentBinding {
  agentId: string;
  match: {
    channel?: string;
    accountId?: string;
    peer?: {
      kind?: "dm" | "group";
      id?: string;
    };
  };
}

export type TranscriptionProvider = "workers-ai" | "openai";

export interface TranscriptionConfig {
  provider: TranscriptionProvider;
}

export type DmPolicy = "open" | "allowlist" | "pairing";

export interface ChannelConfig {
  // DM access policy
  // - "pairing": Unknown senders trigger pairing flow, approve via CLI (recommended)
  // - "allowlist": Only numbers in allowFrom can message (secure)
  // - "open": Anyone can message (use with caution!)
  dmPolicy: DmPolicy;
  
  // Allowed sender IDs
  allowFrom: string[];
}

// Pending pairing request
export interface PendingPair {
  channel: string;
  senderId: string;
  senderName?: string;
  requestedAt: number;
  firstMessage?: string;
}

export type ChannelsConfig = Record<string, ChannelConfig>;

export type DmScope =
  | "main"
  | "per-peer"
  | "per-channel-peer"
  | "per-account-channel-peer";

export interface SessionConfig {
  // Default auto-reset policy for new sessions.
  defaultResetPolicy: {
    mode: "manual" | "daily" | "idle";
    atHour?: number; // For daily mode (0-23)
    idleMinutes?: number; // For idle mode
  };

  // Canonical key used for the per-agent main session.
  mainKey: string;

  // How direct-message sessions are keyed.
  dmScope: DmScope;

  // Identity links: map multiple channel identities to a single session
  // Key is canonical name, value is array of channel:id strings
  // Example: { "steve": ["+31628552611", "telegram:123456789"] }
  identityLinks: Record<string, string[]>;
}

export interface SkillRequirementsConfig {
  // Restrict to hosts with these roles.
  hostRoles?: string[];
  // Require all of these capabilities on the same host.
  capabilities?: string[];
  // Require at least one of these capabilities on the same host.
  anyCapabilities?: string[];
  // Require all binaries to be available on the selected host.
  bins?: string[];
  // Require at least one of these binaries on the selected host.
  anyBins?: string[];
  // Require all environment variable keys to exist on the selected host.
  env?: string[];
  // Require all dotted config paths to resolve to non-empty values.
  config?: string[];
  // Restrict to hosts matching one of these OS identifiers (e.g. darwin, linux).
  os?: string[];
}

export interface SkillEntryConfig {
  // Hard toggle for the skill in prompt visibility.
  enabled?: boolean;
  // Overrides skill frontmatter always=true/false.
  always?: boolean;
  // Overrides skill frontmatter runtime requirements.
  requires?: SkillRequirementsConfig;
}

export interface SkillsConfig {
  // Per-skill policy entries keyed by skill name/path key.
  entries: Record<string, SkillEntryConfig>;
}

export interface AgentsConfig {
  // List of agent configurations
  list: AgentConfig[];
  
  // Bindings map channels/chats to agents
  bindings: AgentBinding[];
  
  // Default heartbeat config for all agents
  defaultHeartbeat: HeartbeatConfig;
}

export interface CronConfig {
  enabled: boolean;
  maxJobs: number;
  maxRunsPerJobHistory: number;
  maxConcurrentRuns: number;
}

export interface GsvConfig {
  // Model settings 
  model: {
    provider: string;
    id: string;
  };

  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
    openrouter?: string;
  };

  // Timeouts
  timeouts: {
    llmMs: number;
    toolMs: number;
    skillProbeMaxAgeMs?: number;
  };

  // Auth settings
  auth: {
    token?: string;
  };

  // Transcription settings (audio -> text)
  transcription: TranscriptionConfig;
  
  // Channel-specific settings (allowlists, policies)
  channels: ChannelsConfig;

  // System prompt (default for all agents)
  systemPrompt?: string;
  
  // Session configuration (identity links, scoping)
  session: SessionConfig;

  // Skill availability and runtime eligibility overrides
  skills: SkillsConfig;
  
  // Multi-agent configuration
  agents: AgentsConfig;

  // Cron job scheduler configuration
  cron: CronConfig;

  // User timezone (IANA string, e.g. "America/Chicago"). Defaults to "UTC".
  // Used in message envelopes, cron scheduling context, and system prompt.
  userTimezone: string;
}

/** Deep-partial input type for user overrides */
export type GsvConfigInput = {
  model?: Partial<GsvConfig["model"]>;
  apiKeys?: Partial<GsvConfig["apiKeys"]>;
  timeouts?: Partial<GsvConfig["timeouts"]>;
  auth?: Partial<GsvConfig["auth"]>;
  transcription?: Partial<TranscriptionConfig>;
  channels?: Record<string, Partial<ChannelConfig>>;
  systemPrompt?: string;
  session?: {
    defaultResetPolicy?: Partial<SessionConfig["defaultResetPolicy"]>;
    mainKey?: string;
    dmScope?: DmScope;
    identityLinks?: Record<string, string[]>;
  };
  skills?: {
    entries?: Record<string, SkillEntryConfig>;
  };
  agents?: {
    list?: AgentConfig[];
    bindings?: AgentBinding[];
    defaultHeartbeat?: Partial<HeartbeatConfig>;
  };
  cron?: Partial<CronConfig>;
  userTimezone?: string;
};


/** Deep merge where arrays and primitives are replaced, objects are recursively merged */
function deepMerge<T>(base: T, overrides: any): T {
  if (overrides === undefined || overrides === null) return base;
  if (typeof base !== "object" || base === null) return overrides ?? base;
  if (Array.isArray(base) || Array.isArray(overrides)) return overrides ?? base;

  const result = { ...base } as any;
  for (const key of Object.keys(overrides)) {
    const baseVal = (base as any)[key];
    const overVal = overrides[key];
    if (overVal === undefined) continue;
    if (baseVal !== undefined && typeof baseVal === "object" && !Array.isArray(baseVal)
        && typeof overVal === "object" && !Array.isArray(overVal) && overVal !== null) {
      result[key] = deepMerge(baseVal, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

export function mergeConfig(base: GsvConfig, overrides: GsvConfigInput): GsvConfig {
  return deepMerge(base, overrides);
}
