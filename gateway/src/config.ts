// GSV Configuration Types and Defaults

export interface AgentConfig {
  id: string;
  default?: boolean;
  
  // Per-agent model override
  model?: {
    provider: string;
    id: string;
  };
  
  // Per-agent system prompt override
  systemPrompt?: string;
  
  // Heartbeat configuration
  heartbeat?: HeartbeatConfig;
}

export interface HeartbeatConfig {
  // Interval between heartbeats (e.g., "30m", "1h", "0m" to disable)
  every?: string;
  
  // Custom prompt for heartbeat
  prompt?: string;
  
  // Delivery target: "last" (last channel), "none", or specific channel
  target?: "last" | "none" | string;
  
  // Active hours (skip heartbeat outside these hours)
  activeHours?: {
    start: string;  // "08:00"
    end: string;    // "22:00"
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
  // Provider to use: "workers-ai" (free, default) or "openai"
  provider: TranscriptionProvider;
}

// DM access policy for channels
export type DmPolicy = "open" | "allowlist" | "pairing";

export interface WhatsAppChannelConfig {
  // DM access policy
  // - "pairing": Unknown senders trigger pairing flow, approve via CLI (recommended)
  // - "allowlist": Only numbers in allowFrom can message (secure)
  // - "open": Anyone can message (use with caution!)
  dmPolicy?: DmPolicy;
  
  // Allowed sender IDs (E.164 numbers like "+1234567890" or JIDs like "123@g.us")
  // Used by "allowlist" and "pairing" modes
  allowFrom?: string[];
}

// Pending pairing request
export interface PendingPair {
  channel: string;
  senderId: string;
  senderName?: string;
  requestedAt: number;
  firstMessage?: string;
}

export interface ChannelsConfig {
  whatsapp?: WhatsAppChannelConfig;
  // Future: telegram, discord, etc.
}

export interface GsvConfig {
  // Model settings (default for all agents)
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

  // Transcription settings (audio -> text)
  transcription?: TranscriptionConfig;
  
  // Channel-specific settings (allowlists, policies)
  channels?: ChannelsConfig;

  // System prompt (default for all agents)
  systemPrompt?: string;
  
  // Multi-agent configuration
  agents?: {
    // List of agent configurations
    list?: AgentConfig[];
    
    // Bindings map channels/chats to agents
    bindings?: AgentBinding[];
    
    // Default heartbeat config for all agents
    defaultHeartbeat?: HeartbeatConfig;
  };
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
  transcription: {
    provider: "workers-ai", // Free default
  },
};

export function mergeConfig(base: GsvConfig, overrides: Partial<GsvConfig>): GsvConfig {
  return {
    model: { ...base.model, ...overrides.model },
    apiKeys: { ...base.apiKeys, ...overrides.apiKeys },
    timeouts: { ...base.timeouts, ...overrides.timeouts },
    auth: { ...base.auth, ...overrides.auth },
    transcription: {
      provider: overrides.transcription?.provider ?? base.transcription?.provider ?? "workers-ai",
    },
    channels: overrides.channels ? {
      whatsapp: { ...base.channels?.whatsapp, ...overrides.channels.whatsapp },
    } : base.channels,
    systemPrompt: overrides.systemPrompt ?? base.systemPrompt,
    agents: overrides.agents ? {
      list: overrides.agents.list ?? base.agents?.list,
      bindings: overrides.agents.bindings ?? base.agents?.bindings,
      defaultHeartbeat: { ...base.agents?.defaultHeartbeat, ...overrides.agents.defaultHeartbeat },
    } : base.agents,
  };
}

/**
 * Parse a duration string like "30m", "1h", "2h30m" into milliseconds
 */
export function parseDuration(duration: string): number {
  if (!duration || duration === "0" || duration === "0m") return 0;
  
  let ms = 0;
  const hourMatch = duration.match(/(\d+)h/);
  const minMatch = duration.match(/(\d+)m/);
  const secMatch = duration.match(/(\d+)s/);
  
  if (hourMatch) ms += parseInt(hourMatch[1]) * 60 * 60 * 1000;
  if (minMatch) ms += parseInt(minMatch[1]) * 60 * 1000;
  if (secMatch) ms += parseInt(secMatch[1]) * 1000;
  
  return ms;
}

/**
 * Get agent config by ID, with defaults merged
 */
export function getAgentConfig(config: GsvConfig, agentId: string): AgentConfig {
  const agentList = config.agents?.list ?? [];
  const found = agentList.find(a => a.id === agentId);
  
  if (found) {
    return found;
  }
  
  // Return a default agent config for the requested ID
  return {
    id: agentId,
    default: agentId === "main",
  };
}

/**
 * Get the default agent ID
 */
export function getDefaultAgentId(config: GsvConfig): string {
  const agentList = config.agents?.list ?? [];
  const defaultAgent = agentList.find(a => a.default);
  return defaultAgent?.id ?? "main";
}

/**
 * Normalize a phone number to E.164 format (e.g., "+1234567890")
 * Handles WhatsApp JIDs like "1234567890@s.whatsapp.net"
 */
export function normalizeE164(raw: string): string {
  if (!raw) return "";
  
  // Strip WhatsApp JID suffix
  let cleaned = raw.replace(/@s\.whatsapp\.net$/, "").replace(/@c\.us$/, "");
  
  // Strip device suffix (e.g., "1234567890:13" -> "1234567890")
  cleaned = cleaned.replace(/:\d+$/, "");
  
  // Strip non-digit characters except leading +
  const hasPlus = cleaned.startsWith("+");
  cleaned = cleaned.replace(/\D/g, "");
  
  if (!cleaned) return "";
  
  return hasPlus || cleaned.length >= 10 ? `+${cleaned}` : cleaned;
}

/**
 * Check if a sender is allowed based on channel config
 * Returns: { allowed, needsPairing, reason }
 */
export function isAllowedSender(
  config: GsvConfig,
  channel: string,
  senderId: string,
  peerId?: string,
): { allowed: boolean; needsPairing?: boolean; reason?: string } {
  if (channel !== "whatsapp") {
    // For now, only WhatsApp has allowlist support
    return { allowed: true };
  }
  
  const waConfig = config.channels?.whatsapp;
  const policy = waConfig?.dmPolicy ?? "pairing"; // Default to pairing (safest)
  
  if (policy === "open") {
    return { allowed: true };
  }
  
  const allowFrom = waConfig?.allowFrom ?? [];
  
  // Check for wildcard
  if (allowFrom.includes("*")) {
    return { allowed: true };
  }
  
  // Normalize the sender ID
  const normalizedSender = normalizeE164(senderId);
  
  // Check if sender is in allowlist
  for (const entry of allowFrom) {
    const normalizedEntry = normalizeE164(entry);
    if (normalizedEntry && normalizedSender === normalizedEntry) {
      return { allowed: true };
    }
    
    // Also check against the raw peerId (for groups)
    if (peerId && entry === peerId) {
      return { allowed: true };
    }
  }
  
  // Sender not in allowlist
  if (policy === "pairing") {
    // Pairing mode: mark as needing pairing approval
    return { 
      allowed: false, 
      needsPairing: true,
      reason: `Sender ${normalizedSender} needs pairing approval` 
    };
  }
  
  // Allowlist mode: just block
  return { 
    allowed: false, 
    reason: `Sender ${normalizedSender} not in allowFrom list` 
  };
}

/**
 * Resolve agent ID from a channel/peer match
 */
export function resolveAgentIdFromBinding(
  config: GsvConfig,
  channel: string,
  accountId?: string,
  peer?: { kind: "dm" | "group"; id: string },
): string {
  const bindings = config.agents?.bindings ?? [];
  
  for (const binding of bindings) {
    const match = binding.match;
    
    // Check channel match
    if (match.channel && match.channel !== channel) continue;
    
    // Check account match
    if (match.accountId && match.accountId !== accountId) continue;
    
    // Check peer match
    if (match.peer) {
      if (!peer) continue;
      if (match.peer.kind && match.peer.kind !== peer.kind) continue;
      if (match.peer.id && match.peer.id !== peer.id) continue;
    }
    
    // All conditions matched
    return binding.agentId;
  }
  
  // No binding matched, return default agent
  return getDefaultAgentId(config);
}
