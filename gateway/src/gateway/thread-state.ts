export const LEGACY_STATE_PREFIX = "legacySession:";
export const THREAD_STATE_PREFIX = "thread:";

export function stateIdFromLegacySessionKey(sessionKey: string): string {
  return `${LEGACY_STATE_PREFIX}${sessionKey}`;
}

export function legacySessionKeyFromStateId(
  stateId: string | undefined | null,
): string | undefined {
  const raw = (stateId ?? "").trim();
  if (!raw.startsWith(LEGACY_STATE_PREFIX)) {
    return undefined;
  }
  const value = raw.slice(LEGACY_STATE_PREFIX.length);
  return value || undefined;
}

export function sessionDoNameFromStateId(stateId: string): string {
  const legacy = legacySessionKeyFromStateId(stateId);
  if (legacy) {
    return legacy;
  }
  return stateId;
}

