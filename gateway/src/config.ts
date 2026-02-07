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

export interface SessionConfig {
  // Identity links: map multiple channel identities to a single session
  // Key is canonical name, value is array of channel:id strings
  // Example: { "steve": ["+31628552611", "telegram:123456789"] }
  identityLinks: Record<string, string[]>;
}

export interface AgentsConfig {
  // List of agent configurations
  list: AgentConfig[];
  
  // Bindings map channels/chats to agents
  bindings: AgentBinding[];
  
  // Default heartbeat config for all agents
  defaultHeartbeat: HeartbeatConfig;
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
  
  // Multi-agent configuration
  agents: AgentsConfig;
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
    identityLinks?: Record<string, string[]>;
  };
  agents?: {
    list?: AgentConfig[];
    bindings?: AgentBinding[];
    defaultHeartbeat?: Partial<HeartbeatConfig>;
  };
};

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
  channels: {
    whatsapp: { dmPolicy: "pairing", allowFrom: [] },
    discord: { dmPolicy: "open", allowFrom: [] },
  },
  session: {
    identityLinks: {},
  },
  agents: {
    list: [],
    bindings: [],
    defaultHeartbeat: {
      every: "30m",
      prompt: "Read HEARTBEAT.md if it exists in your workspace. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      target: "last",
      activeHours: { start: "08:00", end: "23:00" },
    },
  },
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
  const found = config.agents.list.find(a => a.id === agentId);
  
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
  const defaultAgent = config.agents.list.find(a => a.default);
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
  const channelConfig = config.channels[channel];
  if (!channelConfig) { // allow on unset
    return { allowed: true };
  }
  
  const policy = channelConfig.dmPolicy;
  
  if (policy === "open") {
    return { allowed: true };
  }
  
  const allowFrom = channelConfig.allowFrom;
  
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
  peer?: { kind: string; id: string },
): string {
  const bindings = config.agents.bindings;
  
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

/**
 * Resolve linked identity for session routing.
 * 
 * Identity links allow multiple channel identities (WhatsApp number, Telegram ID, etc.)
 * to route to a single session using a canonical name.
 * 
 * Config example:
 * ```
 * session:
 *   identityLinks:
 *     steve:
 *       - "+31628552611"           # WhatsApp number (E.164)
 *       - "telegram:123456789"     # Telegram user ID
 *       - "whatsapp:+34675706329"  # Explicit channel prefix
 * ```
 * 
 * @param config - GsvConfig containing identity links
 * @param channel - Channel name (e.g., "whatsapp", "telegram", "cli")
 * @param senderId - Sender ID (phone number, user ID, etc.)
 * @returns Canonical name if found, null otherwise
 */
export function resolveLinkedIdentity(
  config: GsvConfig,
  channel: string,
  senderId: string,
): string | null {
  const links = config.session.identityLinks;
  
  // Normalize sender ID for matching
  const normalizedSender = normalizeE164(senderId);
  
  for (const [canonicalName, identities] of Object.entries(links)) {
    for (const identity of identities) {
      // Check for channel-prefixed format: "whatsapp:+123" or "telegram:456"
      if (identity.includes(":")) {
        const [idChannel, idValue] = identity.split(":", 2);
        if (idChannel.toLowerCase() === channel.toLowerCase()) {
          const normalizedIdValue = normalizeE164(idValue);
          if (normalizedIdValue === normalizedSender) {
            return canonicalName;
          }
        }
        continue;
      }
      
      // No prefix - assume it's a phone number (matches any channel)
      const normalizedIdentity = normalizeE164(identity);
      if (normalizedIdentity && normalizedIdentity === normalizedSender) {
        return canonicalName;
      }
    }
  }
  
  return null;
}
