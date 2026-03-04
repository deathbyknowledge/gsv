import { resolveAgentIdFromSessionKey } from "../session/routing";
import type { SessionRegistryEntry } from "../protocol/session";
import type { Gateway } from "./do";
import {
  legacySessionKeyFromStateId,
  stateIdFromLegacySessionKey,
} from "./thread-state";

function normalizeOptionalId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveDefaultSpaceId(gw: Gateway): string {
  const configured = gw.getConfigPath("spaces.defaultSpaceId");
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().toLowerCase();
  }
  return "default";
}

function resolveStateIdFromSessionKey(sessionKey: string): {
  stateId: string;
  legacy: boolean;
  legacySessionKey?: string;
} {
  const raw = sessionKey.trim();
  if (!raw) {
    return {
      stateId: stateIdFromLegacySessionKey("agent:main:main"),
      legacy: true,
      legacySessionKey: "agent:main:main",
    };
  }

  if (raw.startsWith("thread:")) {
    return {
      stateId: raw,
      legacy: false,
    };
  }

  if (raw.startsWith("legacySession:")) {
    return {
      stateId: raw,
      legacy: true,
      legacySessionKey: legacySessionKeyFromStateId(raw) ?? undefined,
    };
  }

  return {
    stateId: stateIdFromLegacySessionKey(raw),
    legacy: true,
    legacySessionKey: raw,
  };
}

function cloneSessionEntryWithPatch(
  entry: SessionRegistryEntry,
  patch: Partial<SessionRegistryEntry>,
): SessionRegistryEntry {
  return {
    ...entry,
    ...patch,
    sessionKey: patch.sessionKey ?? entry.sessionKey,
    createdAt: patch.createdAt ?? entry.createdAt,
    lastActiveAt: patch.lastActiveAt ?? entry.lastActiveAt,
  };
}

export type RegistryBackfillParams = {
  dryRun?: boolean;
  limit?: number;
};

export type RegistryBackfillResult = {
  ok: true;
  dryRun: boolean;
  scanned: number;
  migrated: number;
  createdThreadMeta: number;
  updatedSessions: number;
  addedLegacyIndex: number;
  skipped: number;
};

export function runRegistryBackfill(
  gw: Gateway,
  params?: RegistryBackfillParams,
): RegistryBackfillResult {
  const dryRun = params?.dryRun !== false;
  const limit =
    typeof params?.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : Number.POSITIVE_INFINITY;

  let scanned = 0;
  let migrated = 0;
  let createdThreadMeta = 0;
  let updatedSessions = 0;
  let addedLegacyIndex = 0;
  let skipped = 0;

  const sessionEntries = Object.entries(gw.sessionRegistry);
  for (const [registryKey, rawEntry] of sessionEntries) {
    if (scanned >= limit) {
      break;
    }
    scanned += 1;

    const entry = rawEntry as SessionRegistryEntry;
    const canonicalSessionKey = gw.canonicalizeSessionKey(
      entry.sessionKey || registryKey,
      entry.agentId,
    );

    let threadId = normalizeOptionalId(entry.threadId);
    if (!threadId) {
      threadId = gw.registryStore.getLegacyThreadId(canonicalSessionKey);
    }

    const stateFromSession = normalizeOptionalId(entry.stateId);
    const stateResolution = stateFromSession
      ? {
          stateId: stateFromSession,
          legacySessionKey: legacySessionKeyFromStateId(stateFromSession) ?? undefined,
          legacy: Boolean(legacySessionKeyFromStateId(stateFromSession)),
        }
      : resolveStateIdFromSessionKey(canonicalSessionKey);

    if (!threadId) {
      threadId = crypto.randomUUID();
      migrated += 1;
    }

    const existingMeta = gw.registryStore.getThreadMeta(threadId);
    const defaultSpaceId = resolveDefaultSpaceId(gw);
    const resolvedSpaceId =
      normalizeOptionalId(entry.spaceId) ??
      normalizeOptionalId(existingMeta?.spaceId) ??
      defaultSpaceId;
    const resolvedAgentId =
      normalizeOptionalId(entry.agentId) ??
      normalizeOptionalId(existingMeta?.agentId) ??
      resolveAgentIdFromSessionKey(canonicalSessionKey, "main");

    if (!existingMeta) {
      createdThreadMeta += 1;
      if (!dryRun) {
        gw.registryStore.putThreadMeta(threadId, {
          stateId: stateResolution.stateId,
          spaceId: resolvedSpaceId,
          agentId: resolvedAgentId,
          createdAt: entry.createdAt,
          lastActiveAt: entry.lastActiveAt,
          legacy: stateResolution.legacy,
          legacySessionKey: stateResolution.legacySessionKey,
        });
      }
    } else {
      const nextLegacySessionKey =
        existingMeta.legacySessionKey ?? stateResolution.legacySessionKey;
      const needsMetaPatch =
        !existingMeta.spaceId ||
        !existingMeta.agentId ||
        !existingMeta.stateId ||
        (stateResolution.legacy && !existingMeta.legacy);
      if (needsMetaPatch && !dryRun) {
        gw.registryStore.putThreadMeta(threadId, {
          ...existingMeta,
          stateId: existingMeta.stateId || stateResolution.stateId,
          spaceId: existingMeta.spaceId || resolvedSpaceId,
          agentId: existingMeta.agentId || resolvedAgentId,
          legacy: existingMeta.legacy || stateResolution.legacy,
          legacySessionKey: nextLegacySessionKey,
        });
      }
    }

    const expectedLegacyKey =
      stateResolution.legacySessionKey ??
      legacySessionKeyFromStateId(stateResolution.stateId) ??
      undefined;
    if (expectedLegacyKey) {
      const mappedThreadId = gw.registryStore.getLegacyThreadId(expectedLegacyKey);
      if (mappedThreadId !== threadId) {
        addedLegacyIndex += 1;
        if (!dryRun) {
          gw.registryStore.putLegacyThreadId(expectedLegacyKey, threadId);
        }
      }
    }

    const patchedEntry = cloneSessionEntryWithPatch(entry, {
      threadId,
      stateId: entry.stateId || stateResolution.stateId,
      spaceId: entry.spaceId || resolvedSpaceId,
      agentId: entry.agentId || resolvedAgentId,
    });

    const changed =
      patchedEntry.threadId !== entry.threadId ||
      patchedEntry.stateId !== entry.stateId ||
      patchedEntry.spaceId !== entry.spaceId ||
      patchedEntry.agentId !== entry.agentId;

    if (changed) {
      updatedSessions += 1;
      if (!dryRun) {
        gw.sessionRegistry[registryKey] = patchedEntry;
      }
    } else {
      skipped += 1;
    }
  }

  return {
    ok: true,
    dryRun,
    scanned,
    migrated,
    createdThreadMeta,
    updatedSessions,
    addedLegacyIndex,
    skipped,
  };
}

export type RegistryRepairParams = {
  dryRun?: boolean;
  pruneDanglingRoutes?: boolean;
  pruneDanglingLegacyIndex?: boolean;
};

export type RegistryRepairResult = {
  ok: true;
  dryRun: boolean;
  scannedSessions: number;
  scannedThreadRoutes: number;
  scannedLegacyIndex: number;
  createdThreadMeta: number;
  updatedSessions: number;
  addedLegacyIndex: number;
  removedDanglingRoutes: number;
  removedDanglingLegacyIndex: number;
};

export function runRegistryRepair(
  gw: Gateway,
  params?: RegistryRepairParams,
): RegistryRepairResult {
  const dryRun = params?.dryRun !== false;
  const pruneDanglingRoutes = params?.pruneDanglingRoutes !== false;
  const pruneDanglingLegacyIndex = params?.pruneDanglingLegacyIndex !== false;

  let scannedSessions = 0;
  let scannedThreadRoutes = 0;
  let scannedLegacyIndex = 0;
  let createdThreadMeta = 0;
  let updatedSessions = 0;
  let addedLegacyIndex = 0;
  let removedDanglingRoutes = 0;
  let removedDanglingLegacyIndex = 0;

  for (const [sessionKey, rawEntry] of Object.entries(gw.sessionRegistry)) {
    scannedSessions += 1;
    const entry = rawEntry as SessionRegistryEntry;
    const threadId = normalizeOptionalId(entry.threadId);
    if (!threadId) {
      continue;
    }

    let meta = gw.registryStore.getThreadMeta(threadId);
    if (!meta) {
      createdThreadMeta += 1;
      const stateResolution = normalizeOptionalId(entry.stateId)
        ? {
            stateId: entry.stateId!,
            legacy: Boolean(legacySessionKeyFromStateId(entry.stateId!)),
            legacySessionKey: legacySessionKeyFromStateId(entry.stateId!) ?? undefined,
          }
        : resolveStateIdFromSessionKey(sessionKey);
      const spaceId = normalizeOptionalId(entry.spaceId) ?? resolveDefaultSpaceId(gw);
      const agentId =
        normalizeOptionalId(entry.agentId) ?? resolveAgentIdFromSessionKey(sessionKey, "main");

      if (!dryRun) {
        gw.registryStore.putThreadMeta(threadId, {
          stateId: stateResolution.stateId,
          spaceId,
          agentId,
          createdAt: entry.createdAt,
          lastActiveAt: entry.lastActiveAt,
          legacy: stateResolution.legacy,
          legacySessionKey: stateResolution.legacySessionKey,
        });
        meta = gw.registryStore.getThreadMeta(threadId);
      } else {
        meta = {
          stateId: stateResolution.stateId,
          spaceId,
          agentId,
          createdAt: entry.createdAt,
          lastActiveAt: entry.lastActiveAt,
          legacy: stateResolution.legacy,
          legacySessionKey: stateResolution.legacySessionKey,
        };
      }
    }

    if (!meta) {
      continue;
    }

    const patchedEntry = cloneSessionEntryWithPatch(entry, {
      stateId: meta.stateId,
      spaceId: meta.spaceId,
      agentId: meta.agentId,
    });
    const changed =
      patchedEntry.stateId !== entry.stateId ||
      patchedEntry.spaceId !== entry.spaceId ||
      patchedEntry.agentId !== entry.agentId;
    if (changed) {
      updatedSessions += 1;
      if (!dryRun) {
        gw.sessionRegistry[sessionKey] = patchedEntry;
      }
    }

    const legacySessionKey =
      meta.legacySessionKey ?? legacySessionKeyFromStateId(meta.stateId) ?? undefined;
    if (legacySessionKey) {
      const mapped = gw.registryStore.getLegacyThreadId(legacySessionKey);
      if (mapped !== threadId) {
        addedLegacyIndex += 1;
        if (!dryRun) {
          gw.registryStore.putLegacyThreadId(legacySessionKey, threadId);
        }
      }
    }
  }

  const threadRouteEntries = Object.entries(gw.threadRoutes);
  for (const [routeHash, route] of threadRouteEntries) {
    scannedThreadRoutes += 1;
    const threadId = normalizeOptionalId((route as { threadId?: string }).threadId);
    if (!threadId) {
      if (pruneDanglingRoutes) {
        removedDanglingRoutes += 1;
        if (!dryRun) {
          delete gw.threadRoutes[routeHash];
        }
      }
      continue;
    }

    if (!gw.registryStore.getThreadMeta(threadId) && pruneDanglingRoutes) {
      removedDanglingRoutes += 1;
      if (!dryRun) {
        delete gw.threadRoutes[routeHash];
      }
    }
  }

  const legacyIndexEntries = Object.entries(gw.legacyThreadIndex);
  for (const [legacySessionKey, threadId] of legacyIndexEntries) {
    scannedLegacyIndex += 1;
    if (!gw.registryStore.getThreadMeta(threadId)) {
      if (pruneDanglingLegacyIndex) {
        removedDanglingLegacyIndex += 1;
        if (!dryRun) {
          delete gw.legacyThreadIndex[legacySessionKey];
        }
      }
    }
  }

  return {
    ok: true,
    dryRun,
    scannedSessions,
    scannedThreadRoutes,
    scannedLegacyIndex,
    createdThreadMeta,
    updatedSessions,
    addedLegacyIndex,
    removedDanglingRoutes,
    removedDanglingLegacyIndex,
  };
}
