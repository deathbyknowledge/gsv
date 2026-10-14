import type { GSVClient, GsvConnectOptions } from "@humansandmachines/gsv/client";
import { z } from "zod";
import type {
  ConnectResult,
  ServerBuild,
  SysSetupArgs,
  SysSetupResult,
} from "@humansandmachines/gsv/protocol";
import {
  clearInstallationOnboardingToken,
  readInstallationOnboardingToken,
} from "./installationOnboarding";

const STORAGE_USERNAME = "gsv.ui.gateway.username";
const STORAGE_SESSION_TOKEN = "gsv.ui.session.token.v1";
const STORAGE_PENDING_REVOKES = "gsv.ui.session.pending-revokes.v1";
const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SESSION_TOKEN_REFRESH_RETRY_MS = 60_000;
const LOCK_REVOKE_WAIT_MS = 1_500;
const SESSION_RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000];
const SESSION_RECONNECT_STABLE_MS = 10_000;

type PersistedSessionToken = {
  username: string;
  tokenId: string;
  token: string;
  expiresAt: number | null;
};

type UserSessionToken = {
  tokenId: string;
  token: string;
  expiresAt: number | null;
};

const persistedSessionTokenSchema = z.object({
  username: z.string(),
  tokenId: z.string(),
  token: z.string(),
  expiresAt: z.number().finite().nullable().catch(null),
});
const persistedRevokesSchema = z.array(z.string().min(1)).catch([]);
const sessionErrorSchema = z.object({
  code: z.number().optional(),
  retryable: z.boolean().optional(),
  details: z.object({
    setupMode: z.literal(true).optional(),
    setupRecovery: z.literal(true).optional(),
    setupUrl: z.url({ protocol: /^https$/ }).optional().catch(undefined),
  }).optional(),
});
const sessionWireSchema = z.unknown();
type SessionWireValue = z.input<typeof sessionWireSchema>;
const sessionMessageSchema = z.union([z.instanceof(Error), z.string()]);

export type SessionPhase = "booting" | "setup" | "setup-recovery" | "locked" | "authenticating" | "ready";

export type SessionSnapshot = {
  phase: SessionPhase;
  url: string;
  username: string;
  connectionId: string | null;
  server: ServerBuild | null;
  message: string | null;
  setupRecoveryUrl?: string;
};

export type SessionLoginInput = {
  username?: string;
  password?: string;
  token?: string;
};

export type SessionSetupInput = SysSetupArgs;

export type SessionClient = Pick<
  GSVClient,
  "connect" | "disconnect" | "isConnected" | "onStatus" | "requestOnce"
> & {
  sys: {
    token: Pick<GSVClient["sys"]["token"], "create" | "revoke" | "list">;
  };
};

export type SessionService = {
  client: SessionClient;
  snapshot: () => SessionSnapshot;
  subscribe: (listener: (snapshot: SessionSnapshot) => void) => () => void;
  login: (input: SessionLoginInput) => Promise<ConnectResult>;
  setup: (input: SessionSetupInput) => Promise<SysSetupResult>;
  lock: (reason?: string) => Promise<void>;
  start: () => Promise<void>;
  resumeSetup?: (url: string) => void;
  dispose?: () => void;
};

export type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SessionServiceOptions = {
  url?: string;
  storage?: SessionStorage;
  onboarding?: false | { token: string; discard(): Promise<void>; complete(): Promise<void> };
  resumeSetup?: (url: string) => void;
};

function readStored(key: string, storage?: SessionStorage): string | null {
  try {
    return (storage ?? window.localStorage).getItem(key);
  } catch {
    return null;
  }
}

function storeValue(key: string, value: string, storage?: SessionStorage): void {
  try {
    (storage ?? window.localStorage).setItem(key, value);
  } catch {
    // Ignore storage failures.
  }
}

function removeValue(key: string, storage?: SessionStorage): void {
  try {
    (storage ?? window.localStorage).removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function readPersistedToken(storage?: SessionStorage): PersistedSessionToken | null {
  const raw = readStored(STORAGE_SESSION_TOKEN, storage);
  if (!raw) {
    return null;
  }

  try {
    return persistedSessionTokenSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readPersistedRevokes(storage?: SessionStorage): string[] {
  const raw = readStored(STORAGE_PENDING_REVOKES, storage);
  if (!raw) {
    return [];
  }

  try {
    return persistedRevokesSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

function storePersistedToken(token: PersistedSessionToken, storage?: SessionStorage): void {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_SESSION_TOKEN, JSON.stringify(token));
  } catch {
    // Ignore storage failures.
  }
}

function deriveGatewayUrlFromOrigin(): string {
  const { protocol, host } = window.location;
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/ws`;
}

function normalizeMessage(value: SessionWireValue): string {
  const parsed = sessionMessageSchema.safeParse(value);
  if (parsed.success) return parsed.data instanceof Error ? parsed.data.message : parsed.data;
  return "Authentication failed";
}

function isSetupRequiredError(value: SessionWireValue): boolean {
  const error = sessionErrorSchema.safeParse(value);
  if (!error.success) return false;
  if (error.data.code === 425) {
    return true;
  }
  return error.data.details?.setupMode === true;
}

function setupRecovery(value: SessionWireValue): Pick<SessionSnapshot, "phase" | "message" | "setupRecoveryUrl"> | null {
  const parsed = sessionErrorSchema.safeParse(value);
  const details = parsed.success ? parsed.data.details : undefined;
  return details?.setupRecovery
    ? { phase: "setup-recovery", message: "Finish setting up your space", setupRecoveryUrl: details.setupUrl }
    : null;
}

function isAuthenticationRejectedError(value: SessionWireValue): boolean {
  const error = sessionErrorSchema.safeParse(value);
  return error.success && error.data.code === 401;
}

function isRetryableConnectError(value: SessionWireValue): boolean {
  const error = sessionErrorSchema.safeParse(value);
  if (!error.success) return true;
  const { code, retryable } = error.data;
  return retryable ?? (code === undefined || code === 408 || code === 429 || code >= 500);
}

function isTokenExpired(token: PersistedSessionToken): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now();
}

function toPersistedToken(username: string, token: UserSessionToken): PersistedSessionToken {
  return {
    username,
    tokenId: token.tokenId,
    token: token.token,
    expiresAt: token.expiresAt,
  };
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function createUserSessionToken(client: SessionClient, expiresAt: number): Promise<UserSessionToken> {
  const result = await client.sys.token.create({
    kind: "human",
    label: "gsv-ui-session",
    expiresAt,
  });

  return {
    tokenId: result.token.tokenId,
    token: result.token.token,
    expiresAt: result.token.expiresAt,
  };
}

async function revokeSessionToken(client: SessionClient, tokenId: string, reason: string): Promise<boolean> {
  const result = await client.sys.token.revoke({
    tokenId,
    reason,
  });
  return result.revoked === true;
}

async function probeSetupMode(client: SessionClient, url: string): Promise<Pick<SessionSnapshot, "phase" | "message" | "setupRecoveryUrl">> {
  try {
    await client.requestOnce(url, "sys.connect", {
      protocol: 4,
      peer: {
        id: "gsv-ui-setup-probe",
        version: "0.7.0",
        platform: "browser",
      },
    });
    return { phase: "locked", message: null };
  } catch (error) {
    const recovery = setupRecovery(error);
    if (recovery) return recovery;
    if (isSetupRequiredError(error)) {
      return { phase: "setup", message: null };
    }
    return { phase: "locked", message: isAuthenticationRejectedError(error) ? null : normalizeMessage(error) };
  }
}

export function createSessionService(client: SessionClient, options: SessionServiceOptions = {}): SessionService {
  const gatewayUrl = () => options.url ?? deriveGatewayUrlFromOrigin();
  const storage = options.storage;
  let disposed = false;
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();

  let currentSessionToken: PersistedSessionToken | null = readPersistedToken(storage);
  let installationOnboardingToken = options.onboarding ? options.onboarding.token
    : options.onboarding === false ? null : readInstallationOnboardingToken();

  let snapshot: SessionSnapshot = {
    phase: "booting",
    url: gatewayUrl(),
    username: currentSessionToken?.username ?? readStored(STORAGE_USERNAME, storage) ?? "",
    connectionId: null,
    server: null,
    message: "Booting up...",
  };

  let refreshTimerId: number | null = null;
  let reconnectTimerId: number | null = null;
  let reconnectStableTimerId: number | null = null;
  let reconnectAttempts = 0;
  let reconnectInFlight = false;
  let reconnectGeneration = 0;

  const emit = (): void => {
    if (disposed) return;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const setSnapshot = (
    next: Omit<SessionSnapshot, "server"> & { server?: ServerBuild | null },
  ): void => {
    if (disposed) return;
    snapshot = {
      ...next,
      server: next.server === undefined && next.phase === "ready"
        ? snapshot.server
        : next.server ?? null,
    };
    emit();
  };

  const clearRefreshTimer = (): void => {
    if (refreshTimerId !== null) {
      window.clearTimeout(refreshTimerId);
      refreshTimerId = null;
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimerId !== null) {
      window.clearTimeout(reconnectTimerId);
      reconnectTimerId = null;
    }
  };

  const clearReconnectStableTimer = (): void => {
    if (reconnectStableTimerId !== null) {
      window.clearTimeout(reconnectStableTimerId);
      reconnectStableTimerId = null;
    }
  };

  const cancelSilentReconnect = (): void => {
    reconnectGeneration += 1;
    reconnectInFlight = false;
    reconnectAttempts = 0;
    clearReconnectTimer();
    clearReconnectStableTimer();
  };

  const clearStoredSessionToken = (): void => {
    const stored = readPersistedToken(storage);
    if (!stored || (stored.username === snapshot.username && stored.tokenId === currentSessionToken?.tokenId)) {
      removeValue(STORAGE_SESSION_TOKEN, storage);
    }
    currentSessionToken = null;
    clearRefreshTimer();
  };

  const persistPendingRevokes = (pendingRevokes: string[]): void => {
    if (disposed) return;
    if (pendingRevokes.length === 0) {
      removeValue(STORAGE_PENDING_REVOKES, storage);
      return;
    }

    storeValue(STORAGE_PENDING_REVOKES, JSON.stringify(pendingRevokes), storage);
  };

  const queueRevoke = (tokenId: string): void => {
    if (!tokenId) {
      return;
    }
    // Called under the credential lock; another tab may have added cleanup since our last read.
    persistPendingRevokes([...new Set([...readPersistedRevokes(storage), tokenId])]);
  };

  const drainPendingRevokes = async (reason: string): Promise<void> => {
    const generation = reconnectGeneration;
    if (disposed || !client.isConnected()) return;
    const requestedRevokes = readPersistedRevokes(storage);
    for (const tokenId of requestedRevokes) {
      if (disposed || generation !== reconnectGeneration || !client.isConnected()) return;
      try {
        const revoked = await revokeSessionToken(client, tokenId, reason);
        if (disposed || generation !== reconnectGeneration) return;
        if (revoked) {
          await withSessionTokenLock(() => {
            if (disposed || generation !== reconnectGeneration) return;
            persistPendingRevokes(readPersistedRevokes(storage).filter((id) => id !== tokenId));
          });
        }
      } catch {
        // Keep failed and unattempted revocations for a later authenticated connection.
      }
    }
  };

  const scheduleRefresh = (token: PersistedSessionToken): void => {
    clearRefreshTimer();

    if (disposed || snapshot.phase !== "ready" || token.expiresAt === null) {
      return;
    }

    const refreshAt = token.expiresAt - SESSION_TOKEN_TTL_MS + SESSION_TOKEN_REFRESH_INTERVAL_MS;
    const delayMs = Math.max(1_000, refreshAt - Date.now());
    refreshTimerId = window.setTimeout(() => {
      void refreshSessionToken("scheduled");
    }, delayMs);
  };

  const withSessionTokenLock = async (action: () => void): Promise<void> => {
    // Browser tabs share one remembered credential. Native sessions have their own storage.
    // Only synchronous storage changes belong here; network I/O must never block sign-out.
    if (!storage && window.navigator?.locks) {
      await window.navigator.locks.request(STORAGE_SESSION_TOKEN, action);
    } else {
      action();
    }
  };

  const refreshSessionToken = async (reason: "post-login" | "scheduled"): Promise<void> => {
    const generation = reconnectGeneration;
    if (disposed || snapshot.phase !== "ready" || !client.isConnected()) return;
    const username = snapshot.username;
    if (!username) return;
    const previousToken = readPersistedToken(storage);
    if (reason === "scheduled") {
      if (!syncStoredSession() || !currentSessionToken) return;
      const refreshAt = currentSessionToken.expiresAt === null ? Infinity
        : currentSessionToken.expiresAt - SESSION_TOKEN_TTL_MS + SESSION_TOKEN_REFRESH_INTERVAL_MS;
      if (refreshAt > Date.now()) {
        scheduleRefresh(currentSessionToken);
        return;
      }
    }

    let nextToken: UserSessionToken;
    try {
      nextToken = await createUserSessionToken(client, Date.now() + SESSION_TOKEN_TTL_MS);
    } catch {
      if (disposed || generation !== reconnectGeneration) return;
      clearRefreshTimer();
      refreshTimerId = window.setTimeout(() => { void refreshSessionToken(reason); }, SESSION_TOKEN_REFRESH_RETRY_MS);
      return;
    }

    await withSessionTokenLock(() => {
      // A sign-out or account switch in another tab must win over an in-flight renewal.
      if (disposed || generation !== reconnectGeneration || snapshot.phase !== "ready"
        || readPersistedToken(storage)?.tokenId !== previousToken?.tokenId) {
        queueRevoke(nextToken.tokenId);
        return;
      }
      const persisted = toPersistedToken(username, nextToken);
      currentSessionToken = persisted;
      storePersistedToken(persisted, storage);
      scheduleRefresh(persisted);
      if (previousToken && previousToken.tokenId !== nextToken.tokenId) queueRevoke(previousToken.tokenId);
    });
    await drainPendingRevokes("ui session rotated");
  };

  const setLockedAfterDisconnect = (message: string): void => {
    clearRefreshTimer();
    clearReconnectTimer();
    clearReconnectStableTimer();
    setSnapshot({
      phase: "locked",
      url: snapshot.url,
      username: snapshot.username,
      connectionId: null,
      message,
    });
  };

  const syncStoredSession = (): boolean => {
    const stored = readPersistedToken(storage);
    if (stored?.tokenId === currentSessionToken?.tokenId) return true;
    currentSessionToken = stored;
    if (!stored || stored.username !== snapshot.username) {
      cancelSilentReconnect();
      setLockedAfterDisconnect(stored ? "Account changed in another tab. Sign in to continue." : "Signed out");
      client.disconnect();
      return false;
    }
    scheduleRefresh(stored);
    return true;
  };

  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== window.localStorage || (event.key !== null && event.key !== STORAGE_SESSION_TOKEN)) return;
    // Read the latest value: a suspended tab can receive older queued storage events.
    syncStoredSession();
  };
  if (!storage) window.addEventListener("storage", onStorage);

  const markConnectionStableSoon = (): void => {
    clearReconnectStableTimer();
    reconnectStableTimerId = window.setTimeout(() => {
      reconnectAttempts = 0;
      reconnectStableTimerId = null;
    }, SESSION_RECONNECT_STABLE_MS);
  };

  const finishSilentReconnectFailure = (message: string): void => {
    setLockedAfterDisconnect(message);
    client.disconnect();
  };

  const runSilentReconnect = async (generation: number): Promise<void> => {
    if (disposed || reconnectInFlight || generation !== reconnectGeneration
      || (snapshot.phase !== "ready" && snapshot.phase !== "booting")) {
      return;
    }

    if (!syncStoredSession()) return;
    const token = currentSessionToken;
    if (!token) {
      finishSilentReconnectFailure("Disconnected");
      return;
    }
    if (isTokenExpired(token)) {
      clearStoredSessionToken();
      finishSilentReconnectFailure("Session expired. Sign in again.");
      return;
    }

    reconnectAttempts += 1;
    reconnectInFlight = true;
    clearRefreshTimer();
    setSnapshot({
      phase: snapshot.phase,
      url: gatewayUrl(),
      username: token.username,
      connectionId: null,
      message: "Reconnecting...",
    });

    try {
      const result = await client.connect({
        url: gatewayUrl(),
        username: token.username,
        token: token.token,
      });

      if (disposed || generation !== reconnectGeneration || !syncStoredSession()) return;

      storeValue(STORAGE_USERNAME, token.username, storage);
      setSnapshot({ ...snapshot, phase: "ready", connectionId: result.server.connectionId, server: result.server, message: null });
      if (currentSessionToken) scheduleRefresh(currentSessionToken);
      await drainPendingRevokes("ui session cleanup");
    } catch (error) {
      if (generation === reconnectGeneration) {
        client.disconnect();
      }
      if (disposed || generation !== reconnectGeneration || !syncStoredSession()) return;

      const recovery = setupRecovery(error);
      if (recovery) {
        setSnapshot({ ...recovery, url: gatewayUrl(), username: token.username, connectionId: null });
        return;
      }
      if (isSetupRequiredError(error)) {
        setSnapshot({
          phase: "setup",
          url: gatewayUrl(),
          username: token.username,
          connectionId: null,
          message: null,
        });
        return;
      }

      if (isAuthenticationRejectedError(error)) {
        if (currentSessionToken?.tokenId === token.tokenId) {
          clearStoredSessionToken();
          finishSilentReconnectFailure("Session expired. Sign in again.");
          return;
        }
      } else if (!isRetryableConnectError(error)) {
        finishSilentReconnectFailure(normalizeMessage(error));
        return;
      }

      const nextDelay = SESSION_RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, SESSION_RECONNECT_DELAYS_MS.length - 1)];

      clearReconnectTimer();
      reconnectTimerId = window.setTimeout(() => {
        reconnectTimerId = null;
        void runSilentReconnect(generation);
      }, nextDelay);
    } finally {
      if (generation === reconnectGeneration) {
        reconnectInFlight = false;
      }
    }
  };

  const scheduleSilentReconnect = (): void => {
    if (reconnectTimerId !== null || reconnectInFlight) {
      return;
    }

    if (!syncStoredSession()) return;
    const token = currentSessionToken;
    if (!token) {
      setLockedAfterDisconnect("Disconnected");
      return;
    }
    if (isTokenExpired(token)) {
      clearStoredSessionToken();
      setLockedAfterDisconnect("Session expired. Sign in again.");
      return;
    }
    const generation = reconnectGeneration;
    const delay = SESSION_RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, SESSION_RECONNECT_DELAYS_MS.length - 1)];
    clearReconnectTimer();
    reconnectTimerId = window.setTimeout(() => {
      reconnectTimerId = null;
      void runSilentReconnect(generation);
    }, delay);
  };

  const unsubscribeStatus = client.onStatus((status) => {
    if (disposed) return;
    if (status.state === "connected") {
      reconnectInFlight = false;
      clearReconnectTimer();
      if (
        snapshot.phase !== "ready" ||
        snapshot.url !== (status.url ?? snapshot.url) ||
        snapshot.username !== (status.username ?? snapshot.username) ||
        snapshot.connectionId !== status.connectionId ||
        snapshot.message !== null
      ) {
        setSnapshot({
          phase: "ready",
          url: status.url ?? snapshot.url,
          username: status.username ?? snapshot.username,
          connectionId: status.connectionId,
          message: null,
        });
      }
      markConnectionStableSoon();
      return;
    }

    if (status.state === "connecting") {
      return;
    }

    if (reconnectInFlight) {
      return;
    }

    if (snapshot.phase === "ready") {
      clearRefreshTimer();
      clearReconnectStableTimer();
      scheduleSilentReconnect();
    }
  });

  const login = async (input: SessionLoginInput): Promise<ConnectResult> => {
    if (disposed) throw new Error("Session ended");
    cancelSilentReconnect();
    const generation = reconnectGeneration;
    const url = gatewayUrl();
    const username = input.username?.trim() ?? "";
    const password = input.password ?? "";
    const token = input.token?.trim() ?? "";

    setSnapshot({
      phase: "authenticating",
      url,
      username: username || snapshot.username,
      connectionId: null,
      message: "Connecting...",
    });

    const options: GsvConnectOptions = {
      url,
      username,
      ...(token ? { token } : { password }),
    };

    try {
      const result = await client.connect(options);
      if (disposed || generation !== reconnectGeneration) throw new Error("Session ended");
      const signedInUsername = result.peer.principal.account.username;
      storeValue(STORAGE_USERNAME, signedInUsername, storage);

      setSnapshot({
        phase: "ready",
        url,
        username: signedInUsername,
        connectionId: result.server.connectionId,
        server: result.server,
        message: null,
      });

      await drainPendingRevokes("ui session cleanup");
      await refreshSessionToken("post-login");

      return result;
    } catch (error) {
      if (disposed || generation !== reconnectGeneration) throw error;
      const recovery = setupRecovery(error);
      if (recovery) {
        setSnapshot({ ...recovery, url, username: username || snapshot.username, connectionId: null });
        throw error;
      }
      if (isSetupRequiredError(error)) {
        setSnapshot({
          phase: "setup",
          url,
          username: username || snapshot.username,
          connectionId: null,
          message: null,
        });
        throw error;
      }

      setSnapshot({
        phase: "locked",
        url,
        username: username || snapshot.username,
        connectionId: null,
        message: normalizeMessage(error),
      });
      throw error;
    }
  };

  const setup = async (input: SessionSetupInput): Promise<SysSetupResult> => {
    cancelSilentReconnect();
    const setupGeneration = reconnectGeneration;
    const url = gatewayUrl();
    const username = input.username?.trim() ?? "";
    const password = input.password.trim();

    setSnapshot({
      phase: "authenticating",
      url,
      username: username || snapshot.username,
      connectionId: null,
      message: "Creating your account...",
    });

    let result: SysSetupResult;
    try {
      result = await client.requestOnce(url, "sys.setup", {
        ...input,
        ...(installationOnboardingToken
          ? { onboardingToken: installationOnboardingToken }
          : undefined),
      });
    } catch (error) {
      if (setupGeneration === reconnectGeneration) {
        let recovery = setupRecovery(error);
        if (recovery && installationOnboardingToken) {
          try {
            if (options.onboarding) await options.onboarding.discard();
            else clearInstallationOnboardingToken();
            installationOnboardingToken = null;
          } catch (storageError) {
            if (setupGeneration === reconnectGeneration) setSnapshot({ phase: "setup", url,
              username: username || snapshot.username, connectionId: null, message: normalizeMessage(storageError) });
            throw storageError;
          }
        }
        if (recovery) recovery = await probeSetupMode(client, url);
        if (setupGeneration !== reconnectGeneration) throw error;
        setSnapshot({
          phase: "setup",
          url,
          username: username || snapshot.username,
          connectionId: null,
          message: normalizeMessage(error),
          ...recovery,
        });
      }
      throw error;
    }

    if (installationOnboardingToken) {
      installationOnboardingToken = null;
      try {
        if (options.onboarding) await options.onboarding.complete();
        else clearInstallationOnboardingToken();
      } catch (error) {
        if (setupGeneration === reconnectGeneration) setSnapshot({ phase: "locked", url, username: result.user.username,
          connectionId: null, message: "Account created. Sign in to continue." });
        throw error;
      }
    }
    if (setupGeneration !== reconnectGeneration) return result;

    storeValue(STORAGE_USERNAME, result.user.username, storage);
    await login({ username: result.user.username, password });
    return result;
  };

  const lock = async (reason = "Session locked"): Promise<void> => {
    cancelSilentReconnect();
    const lockGeneration = reconnectGeneration;
    clearRefreshTimer();
    setSnapshot({
      phase: "locked",
      url: gatewayUrl(),
      username: snapshot.username,
      connectionId: null,
      message: reason,
    });

    const clearing = withSessionTokenLock(() => {
      if (disposed || reconnectGeneration !== lockGeneration) return;
      const stored = readPersistedToken(storage);
      if (stored?.username === snapshot.username) currentSessionToken = stored;
      const previousTokenId = currentSessionToken?.username === snapshot.username ? currentSessionToken.tokenId : null;
      if (previousTokenId) queueRevoke(previousTokenId);
      clearStoredSessionToken();
    });
    // Native storage clears synchronously, preserving its immediate revocation path.
    if (!storage && window.navigator?.locks) await clearing;
    await Promise.race([
      drainPendingRevokes("ui session lock"),
      waitFor(LOCK_REVOKE_WAIT_MS),
    ]);
    await clearing;

    if (!disposed && reconnectGeneration === lockGeneration && snapshot.phase === "locked") {
      client.disconnect();
    }
  };

  const start = async (): Promise<void> => {
    if (disposed) return;
    cancelSilentReconnect();
    const generation = reconnectGeneration;
    const url = gatewayUrl();
    const persisted = currentSessionToken = readPersistedToken(storage);

    if (installationOnboardingToken) {
      setSnapshot({
        phase: "setup",
        url,
        username: snapshot.username,
        connectionId: null,
        message: null,
      });
      return;
    }

    if (!persisted) {
      const initial = await probeSetupMode(client, url);
      if (disposed || generation !== reconnectGeneration) return;
      setSnapshot({ ...initial, url, username: snapshot.username, connectionId: null });
      return;
    }

    if (persisted.expiresAt !== null && persisted.expiresAt <= Date.now()) {
      clearStoredSessionToken();
      const initial = await probeSetupMode(client, url);
      if (disposed || generation !== reconnectGeneration) return;
      setSnapshot({ ...initial, url, username: persisted.username, connectionId: null,
        message: initial.message ?? (initial.phase === "locked" ? "Session expired. Sign in again." : null) });
      return;
    }

    setSnapshot({
      phase: "booting",
      url,
      username: persisted.username,
      connectionId: null,
      message: "Booting up...",
    });

    await runSilentReconnect(generation);
  };

  return {
    client,
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    login,
    setup,
    lock,
    start,
    resumeSetup: options.resumeSetup,
    dispose: () => {
      disposed = true;
      cancelSilentReconnect();
      clearRefreshTimer();
      unsubscribeStatus();
      if (!storage) window.removeEventListener("storage", onStorage);
      listeners.clear();
      client.disconnect();
    },
  };
}
