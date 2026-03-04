const WORKSPACE_MARKER_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
] as const;

function normalizeId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeOpaqueId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    output.push(path);
  }
  return output;
}

export type WorkspacePathSet = {
  primaryBasePath: string;
  fallbackBasePath?: string;
  legacyBasePath: string;
  spaceBasePath?: string;
};

export function resolveWorkspacePathSet(
  agentId: string,
  spaceId?: string,
): WorkspacePathSet {
  const normalizedAgentId = normalizeId(agentId) ?? "main";
  const normalizedSpaceId = normalizeId(spaceId);
  const legacyBasePath = `agents/${normalizedAgentId}`;

  if (!normalizedSpaceId) {
    return {
      primaryBasePath: legacyBasePath,
      legacyBasePath,
    };
  }

  const spaceBasePath = `spaces/${normalizedSpaceId}/agents/${normalizedAgentId}`;
  return {
    primaryBasePath: spaceBasePath,
    fallbackBasePath: legacyBasePath,
    legacyBasePath,
    spaceBasePath,
  };
}

async function hasWorkspaceMarker(
  bucket: R2Bucket,
  basePath: string,
): Promise<boolean> {
  const checks = await Promise.all(
    WORKSPACE_MARKER_FILES.map((fileName) =>
      bucket.head(`${basePath}/${fileName}`),
    ),
  );
  return checks.some(Boolean);
}

/**
 * Compatibility resolver: if a space workspace does not yet contain core files,
 * route operations to legacy `agents/{agentId}` storage until migration lands.
 */
export async function resolveWorkspacePathSetForRuntime(
  bucket: R2Bucket,
  agentId: string,
  spaceId?: string,
): Promise<WorkspacePathSet> {
  const base = resolveWorkspacePathSet(agentId, spaceId);
  if (!base.spaceBasePath) {
    return base;
  }

  const hasSpaceWorkspace = await hasWorkspaceMarker(bucket, base.spaceBasePath);
  if (hasSpaceWorkspace) {
    return base;
  }

  return {
    primaryBasePath: base.legacyBasePath,
    fallbackBasePath: base.spaceBasePath,
    legacyBasePath: base.legacyBasePath,
    spaceBasePath: base.spaceBasePath,
  };
}

export function resolveWorkspaceFileCandidates(
  relativePath: string,
  pathSet: WorkspacePathSet,
): string[] {
  return uniquePaths([
    `${pathSet.primaryBasePath}/${relativePath}`,
    pathSet.fallbackBasePath
      ? `${pathSet.fallbackBasePath}/${relativePath}`
      : undefined,
  ]);
}

export function resolveDailyMemoryKeyFromBasePath(
  basePath: string,
  dateStr: string,
): string {
  return `${basePath}/memory/${dateStr}.md`;
}

export function resolveSessionArchivePrefix(params: {
  agentId: string;
  spaceId?: string;
  threadId?: string;
}): string {
  const normalizedAgentId = normalizeId(params.agentId) ?? "main";
  const normalizedSpaceId = normalizeId(params.spaceId);
  const normalizedThreadId = normalizeOpaqueId(params.threadId);

  if (normalizedSpaceId && normalizedThreadId) {
    return `spaces/${normalizedSpaceId}/agents/${normalizedAgentId}/threads/${normalizedThreadId}/archives/`;
  }

  return `agents/${normalizedAgentId}/sessions/`;
}

export function resolveSessionArchiveKey(params: {
  agentId: string;
  sessionId: string;
  spaceId?: string;
  threadId?: string;
}): string {
  const prefix = resolveSessionArchivePrefix(params);
  return `${prefix}${params.sessionId}.jsonl.gz`;
}

export function resolvePartialArchiveKey(params: {
  agentId: string;
  sessionId: string;
  partNumber: number;
  spaceId?: string;
  threadId?: string;
}): string {
  const prefix = resolveSessionArchivePrefix(params);
  return `${prefix}${params.sessionId}-part${params.partNumber}.jsonl.gz`;
}

function resolveMediaScopeId(params: {
  threadId?: string;
  legacySessionKey?: string;
}): string {
  const threadId = normalizeOpaqueId(params.threadId);
  if (threadId) {
    return threadId;
  }
  const legacySessionKey = normalizeOpaqueId(params.legacySessionKey);
  if (legacySessionKey) {
    return legacySessionKey;
  }
  throw new Error("Cannot resolve media scope id: missing threadId/sessionKey");
}

export function resolveMediaStoreKey(params: {
  ext: string;
  threadId?: string;
  legacySessionKey?: string;
}): string {
  const scopeId = resolveMediaScopeId(params);
  const uuid = crypto.randomUUID();
  return `media/${scopeId}/${uuid}.${params.ext}`;
}

export function resolveMediaDeletePrefixes(params: {
  threadId?: string;
  legacySessionKey?: string;
}): string[] {
  const threadId = normalizeOpaqueId(params.threadId);
  const legacySessionKey = normalizeOpaqueId(params.legacySessionKey);
  return uniquePaths([
    threadId ? `media/${threadId}/` : undefined,
    legacySessionKey ? `media/${legacySessionKey}/` : undefined,
  ]);
}
