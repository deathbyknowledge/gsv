export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";
export const DEFAULT_ACCOUNT_ID = "default";

export type DmScope =
  | "main"
  | "per-peer"
  | "per-channel-peer"
  | "per-account-channel-peer";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_ID_CHARS_RE = /[^a-z0-9_-]+/gi;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const INVALID_TOKEN_CHARS_RE = /[^a-z0-9+\-_@.]+/gi;

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_ID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_ID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_ACCOUNT_ID
  );
}

function normalizeToken(
  value: string | undefined | null,
  fallback: string = "unknown",
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.toLowerCase().replace(INVALID_TOKEN_CHARS_RE, "_");
}

export function resolveAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | null;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

export function resolveAgentIdFromSessionKey(
  sessionKey: string | undefined | null,
  fallback: string = DEFAULT_AGENT_ID,
): string {
  const raw = (sessionKey ?? "").trim();
  if (!raw.startsWith("agent:")) {
    return normalizeAgentId(fallback);
  }

  const parts = raw.split(":");
  if (parts.length < 2 || !parts[1]) {
    return normalizeAgentId(fallback);
  }

  return normalizeAgentId(parts[1]);
}

/**
 * Parse a structured session key into its constituent parts.
 * Returns null for simple aliases or unparseable keys.
 */
export type ParsedSessionKey = {
  agentId: string;
  channel?: string;
  accountId?: string;
  peer: { kind: string; id: string };
};

export function parseSessionKey(raw: string): ParsedSessionKey | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("agent:")) return null;

  const parts = trimmed.split(":");
  if (parts.length < 4) return null; // need at least agent:{id}:{kind}:{peer}

  const agentId = parts[1];
  const rest = parts.slice(2);

  // Find "dm" marker to detect DM keys at any position
  const dmIdx = rest.indexOf("dm");
  if (dmIdx >= 0 && dmIdx < rest.length - 1) {
    const peerId = rest.slice(dmIdx + 1).join(":");
    const before = rest.slice(0, dmIdx);
    return {
      agentId,
      channel: before[0],
      accountId: before[1],
      peer: { kind: "dm", id: peerId },
    };
  }

  // Non-DM: agent:{id}:{channel}:{kind}:{peer...}
  if (rest.length >= 3) {
    return {
      agentId,
      channel: rest[0],
      peer: { kind: rest[1], id: rest.slice(2).join(":") },
    };
  }

  return null;
}

export function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: {
    kind: string;
    id: string;
  };
  dmScope?: DmScope;
  mainKey?: string | null;
  linkedIdentity?: string | null;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const channel = normalizeToken(params.channel);
  const peerKind = normalizeToken(params.peer.kind, "dm");
  const dmScope = params.dmScope ?? "main";
  const peerId = normalizeToken(params.linkedIdentity ?? params.peer.id);

  if (peerKind === "dm") {
    if (dmScope === "main") {
      return resolveAgentMainSessionKey({ agentId, mainKey: params.mainKey });
    }

    if (dmScope === "per-peer") {
      return `agent:${agentId}:dm:${peerId}`;
    }

    if (dmScope === "per-channel-peer") {
      return `agent:${agentId}:${channel}:dm:${peerId}`;
    }

    const accountId = normalizeAccountId(params.accountId);
    return `agent:${agentId}:${channel}:${accountId}:dm:${peerId}`;
  }

  return `agent:${agentId}:${channel}:${peerKind}:${peerId}`;
}

/**
 * Canonicalize any session key by parsing it and rebuilding through
 * buildAgentSessionKey. This applies dmScope collapsing, main key aliasing,
 * and normalization in a single pass.
 */
export function canonicalizeSessionKey(
  raw: string,
  opts: {
    mainKey?: string | null;
    dmScope?: DmScope;
    defaultAgentId?: string;
  },
): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const mainKey = normalizeMainKey(opts.mainKey);
  const defaultAgentId = normalizeAgentId(opts.defaultAgentId);

  // Simple alias: "main", "primary", etc.
  if (!trimmed.startsWith("agent:")) {
    if (trimmed.toLowerCase() === DEFAULT_MAIN_KEY || trimmed.toLowerCase() === mainKey) {
      return resolveAgentMainSessionKey({ agentId: defaultAgentId, mainKey: opts.mainKey });
    }
    return trimmed;
  }

  // Structured key — parse and rebuild through the single source of truth
  const parsed = parseSessionKey(trimmed);
  if (parsed) {
    return buildAgentSessionKey({
      agentId: parsed.agentId,
      channel: parsed.channel ?? "unknown",
      accountId: parsed.accountId,
      peer: parsed.peer,
      dmScope: opts.dmScope,
      mainKey: opts.mainKey,
    });
  }

  // 3-part key (agent:{id}:{key}) — check if it's a main key alias
  const agentId = resolveAgentIdFromSessionKey(trimmed, defaultAgentId);
  const parts = trimmed.split(":");
  if (parts.length === 3) {
    const key = parts[2].toLowerCase();
    if (key === mainKey || key === DEFAULT_MAIN_KEY) {
      return resolveAgentMainSessionKey({ agentId, mainKey: opts.mainKey });
    }
  }

  return trimmed;
}

/**
 * Check if a session key resolves to the agent's main session
 * under the current dmScope configuration.
 */
export function isMainSessionKey(params: {
  sessionKey: string;
  mainKey?: string | null;
  dmScope?: DmScope;
}): boolean {
  const raw = params.sessionKey.trim();
  if (!raw) return false;

  const canonical = canonicalizeSessionKey(raw, {
    mainKey: params.mainKey,
    dmScope: params.dmScope,
  });
  const agentId = resolveAgentIdFromSessionKey(raw);
  return canonical === resolveAgentMainSessionKey({ agentId, mainKey: params.mainKey });
}
