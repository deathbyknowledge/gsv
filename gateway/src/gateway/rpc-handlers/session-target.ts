import { RpcError } from "../../shared/utils";
import type { Gateway } from "../do";
import {
  legacySessionKeyFromStateId,
  sessionDoNameFromStateId,
} from "../thread-state";

export type ResolvedSessionTarget = {
  sessionKey: string;
  sessionDoName: string;
  threadId?: string;
  stateId?: string;
};

type ResolveSessionTargetParams = {
  sessionKey?: string;
  threadRef?: string;
  agentIdHint?: string;
};

function normalizeOptional(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function fromThreadId(gw: Gateway, threadId: string): ResolvedSessionTarget {
  const normalizedThreadId = normalizeOptional(threadId);
  if (!normalizedThreadId) {
    throw new RpcError(400, "threadRef id is empty");
  }

  const meta = gw.registryStore.getThreadMeta(normalizedThreadId);
  if (!meta) {
    throw new RpcError(404, `Unknown threadId: ${normalizedThreadId}`);
  }

  const stateId = meta.stateId;
  const sessionDoName = sessionDoNameFromStateId(stateId);
  const legacySessionKey =
    meta.legacySessionKey ?? legacySessionKeyFromStateId(stateId);
  return {
    sessionKey: legacySessionKey ?? sessionDoName,
    sessionDoName,
    threadId: normalizedThreadId,
    stateId,
  };
}

function fromSessionKey(
  gw: Gateway,
  sessionKey: string,
  agentIdHint?: string,
): ResolvedSessionTarget {
  const canonical = gw.canonicalizeSessionKey(sessionKey, agentIdHint);
  const existing = gw.getSessionRegistryEntry(canonical);
  const stateId = existing?.stateId;
  const sessionDoName = stateId ? sessionDoNameFromStateId(stateId) : canonical;

  return {
    sessionKey: canonical,
    sessionDoName,
    threadId: existing?.threadId,
    stateId,
  };
}

export function resolveSessionTarget(
  gw: Gateway,
  params: ResolveSessionTargetParams,
): ResolvedSessionTarget {
  const threadRef = normalizeOptional(params.threadRef);
  if (threadRef) {
    if (threadRef.startsWith("id:")) {
      return fromThreadId(gw, threadRef.slice(3));
    }

    if (threadRef.startsWith("alias:") || threadRef.startsWith("addr:")) {
      throw new RpcError(
        400,
        `Unsupported threadRef format '${threadRef.split(":")[0]}:' (only id: is supported in this phase)`,
      );
    }

    const threadMeta = gw.registryStore.getThreadMeta(threadRef);
    if (threadMeta) {
      return fromThreadId(gw, threadRef);
    }

    return fromSessionKey(gw, threadRef, params.agentIdHint);
  }

  const sessionKey = normalizeOptional(params.sessionKey);
  if (!sessionKey) {
    throw new RpcError(400, "sessionKey or threadRef required");
  }

  return fromSessionKey(gw, sessionKey, params.agentIdHint);
}
