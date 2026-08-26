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
const SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TOKEN_REFRESH_LEEWAY_MS = 10 * 60 * 1000;
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
  details: z.object({ setupMode: z.literal(true).optional() }).optional(),
});
const sessionWireSchema = z.unknown();
type SessionWireValue = z.input<typeof sessionWireSchema>;
const sessionMessageSchema = z.union([z.instanceof(Error), z.string()]);

export type SessionPhase = "booting" | "setup" | "setup-complete" | "locked" | "authenticating" | "ready";

export type SessionSnapshot = {
  phase: SessionPhase;
  url: string;
  username: string;
  connectionId: string | null;
  server: ServerBuild | null;
  message: string | null;
  setupResult: SysSetupResult | null;
};

export type SessionLoginInput = {
  username: string;
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
  continueFromSetup: () => Promise<ConnectResult>;
  lock: (reason?: string) => void;
  start: () => Promise<void>;
};

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures.
  }
}

function removeValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function readPersistedToken(): PersistedSessionToken | null {
  const raw = readStored(STORAGE_SESSION_TOKEN);
  if (!raw) {
    return null;
  }

  try {
    return persistedSessionTokenSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readPersistedRevokes(): string[] {
  const raw = readStored(STORAGE_PENDING_REVOKES);
  if (!raw) {
    return [];
  }

  try {
    return persistedRevokesSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

function storePersistedToken(token: PersistedSessionToken): void {
  try {
    window.localStorage.setItem(STORAGE_SESSION_TOKEN, JSON.stringify(token));
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

function isAuthenticationRejectedError(value: SessionWireValue): boolean {
  const error = sessionErrorSchema.safeParse(value);
  return error.success && error.data.code === 401;
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
    kind: "user",
    label: "gsv-ui-session",
    allowedRole: "user",
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

async function probeSetupMode(client: SessionClient, url: string): Promise<boolean> {
  try {
    await client.requestOnce(url, "sys.connect", {
      protocol: 3,
      peer: {
        id: "gsv-ui-setup-probe",
        version: "0.4.1",
        platform: "browser",
      },
    });
    return false;
  } catch (error) {
    if (isSetupRequiredError(error)) {
      return true;
    }
    return false;
  }
}

export function createSessionService(client: SessionClient): SessionService {
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();

  let currentSessionToken: PersistedSessionToken | null = readPersistedToken();
  let installationOnboardingToken = readInstallationOnboardingToken();

  let snapshot: SessionSnapshot = {
    phase: "booting",
    url: deriveGatewayUrlFromOrigin(),
    username: currentSessionToken?.username ?? readStored(STORAGE_USERNAME) ?? "",
    connectionId: null,
    server: null,
    message: "Booting up...",
    setupResult: null,
  };

  let pendingRevokes = Array.from(new Set(readPersistedRevokes()));
  let refreshTimerId: number | null = null;
  let reconnectTimerId: number | null = null;
  let reconnectStableTimerId: number | null = null;
  let reconnectAttempts = 0;
  let reconnectInFlight = false;
  let reconnectGeneration = 0;
  let pendingSetupLogin: SessionLoginInput | null = null;

  const emit = (): void => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const setSnapshot = (
    next: Omit<SessionSnapshot, "server"> & { server?: ServerBuild | null },
  ): void => {
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
    currentSessionToken = null;
    removeValue(STORAGE_SESSION_TOKEN);
    clearRefreshTimer();
  };

  const persistPendingRevokes = (): void => {
    if (pendingRevokes.length === 0) {
      removeValue(STORAGE_PENDING_REVOKES);
      return;
    }

    storeValue(STORAGE_PENDING_REVOKES, JSON.stringify(pendingRevokes));
  };

  const queueRevoke = (tokenId: string): void => {
    if (!tokenId) {
      return;
    }
    if (!pendingRevokes.includes(tokenId)) {
      pendingRevokes.push(tokenId);
      persistPendingRevokes();
    }
  };

  const drainPendingRevokes = async (reason: string): Promise<void> => {
    if (!client.isConnected() || pendingRevokes.length === 0) {
      return;
    }

    const remaining: string[] = [];
    for (const tokenId of pendingRevokes) {
      try {
        const revoked = await revokeSessionToken(client, tokenId, reason);
        if (!revoked) {
          remaining.push(tokenId);
        }
      } catch {
        remaining.push(tokenId);
        if (!client.isConnected()) {
          break;
        }
      }
    }

    pendingRevokes = Array.from(new Set(remaining));
    persistPendingRevokes();
  };

  const scheduleRefresh = (token: PersistedSessionToken): void => {
    clearRefreshTimer();

    if (token.expiresAt === null) {
      return;
    }

    const refreshAt = token.expiresAt - SESSION_TOKEN_REFRESH_LEEWAY_MS;
    const delayMs = Math.max(1_000, refreshAt - Date.now());
    refreshTimerId = window.setTimeout(() => {
      void refreshSessionToken("scheduled");
    }, delayMs);
  };

  const refreshSessionToken = async (reason: "post-login" | "scheduled"): Promise<void> => {
    if (!client.isConnected()) {
      return;
    }

    const username = snapshot.username;
    if (!username) {
      return;
    }

    const nextExpiry = Date.now() + SESSION_TOKEN_TTL_MS;

    let nextToken: UserSessionToken;
    try {
      nextToken = await createUserSessionToken(client, nextExpiry);
    } catch {
      if (reason === "scheduled" && currentSessionToken?.expiresAt && currentSessionToken.expiresAt <= Date.now()) {
        clearStoredSessionToken();
      }
      return;
    }

    const previousToken = currentSessionToken;
    const persisted = toPersistedToken(username, nextToken);
    currentSessionToken = persisted;
    storePersistedToken(persisted);
    scheduleRefresh(persisted);

    if (previousToken && previousToken.tokenId !== nextToken.tokenId) {
      queueRevoke(previousToken.tokenId);
    }

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
      setupResult: null,
    });
  };

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
    if (reconnectInFlight || generation !== reconnectGeneration || snapshot.phase !== "ready") {
      return;
    }

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
    if (reconnectAttempts >= SESSION_RECONNECT_DELAYS_MS.length) {
      finishSilentReconnectFailure("Connection interrupted. Sign in again.");
      return;
    }

    reconnectAttempts += 1;
    reconnectInFlight = true;
    clearRefreshTimer();
    setSnapshot({
      phase: "ready",
      url: deriveGatewayUrlFromOrigin(),
      username: token.username,
      connectionId: null,
      message: "Reconnecting...",
      setupResult: null,
    });

    try {
      const result = await client.connect({
        url: deriveGatewayUrlFromOrigin(),
        username: token.username,
        token: token.token,
      });

      if (generation !== reconnectGeneration || currentSessionToken?.tokenId !== token.tokenId) {
        client.disconnect();
        return;
      }

      storeValue(STORAGE_USERNAME, token.username);
      pendingSetupLogin = null;
      setSnapshot({ ...snapshot, server: result.server });
      scheduleRefresh(token);
      await drainPendingRevokes("ui session cleanup");
    } catch (error) {
      if (generation === reconnectGeneration) {
        client.disconnect();
      }
      if (generation !== reconnectGeneration || snapshot.phase !== "ready") {
        return;
      }

      if (isSetupRequiredError(error)) {
        setSnapshot({
          phase: "setup",
          url: deriveGatewayUrlFromOrigin(),
          username: token.username,
          connectionId: null,
          message: null,
          setupResult: null,
        });
        return;
      }

      if (isAuthenticationRejectedError(error)) {
        clearStoredSessionToken();
        finishSilentReconnectFailure("Session expired. Sign in again.");
        return;
      }

      const nextDelay = SESSION_RECONNECT_DELAYS_MS[reconnectAttempts];
      if (nextDelay === undefined) {
        finishSilentReconnectFailure("Unable to reconnect. Sign in again.");
        return;
      }

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
    if (reconnectAttempts >= SESSION_RECONNECT_DELAYS_MS.length) {
      setLockedAfterDisconnect("Connection interrupted. Sign in again.");
      return;
    }

    const generation = reconnectGeneration;
    const delay = SESSION_RECONNECT_DELAYS_MS[reconnectAttempts] ?? 0;
    clearReconnectTimer();
    reconnectTimerId = window.setTimeout(() => {
      reconnectTimerId = null;
      void runSilentReconnect(generation);
    }, delay);
  };

  client.onStatus((status) => {
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
          setupResult: null,
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
    cancelSilentReconnect();
    const url = deriveGatewayUrlFromOrigin();
    const username = input.username.trim();
    const password = input.password?.trim() ?? "";
    const token = input.token?.trim() ?? "";

    setSnapshot({
      phase: "authenticating",
      url,
      username: username || snapshot.username,
      connectionId: null,
      message: "Connecting...",
      setupResult: null,
    });

    const options: GsvConnectOptions = {
      url,
      username,
      ...(token ? { token } : { password }),
    };

    try {
      const result = await client.connect(options);
      storeValue(STORAGE_USERNAME, username);
      pendingSetupLogin = null;

      setSnapshot({
        phase: "ready",
        url,
        username,
        connectionId: result.server.connectionId,
        server: result.server,
        message: null,
        setupResult: null,
      });

      await drainPendingRevokes("ui session cleanup");
      await refreshSessionToken("post-login");

      return result;
    } catch (error) {
      if (isSetupRequiredError(error)) {
        setSnapshot({
          phase: "setup",
          url,
          username: username || snapshot.username,
          connectionId: null,
          message: null,
          setupResult: null,
        });
        throw error;
      }

      setSnapshot({
        phase: "locked",
        url,
        username: username || snapshot.username,
        connectionId: null,
        message: normalizeMessage(error),
        setupResult: null,
      });
      throw error;
    }
  };

  const setup = async (input: SessionSetupInput): Promise<SysSetupResult> => {
    cancelSilentReconnect();
    const url = deriveGatewayUrlFromOrigin();
    const username = input.username.trim();
    const password = input.password.trim();

    setSnapshot({
      phase: "authenticating",
      url,
      username: username || snapshot.username,
      connectionId: null,
      message: "Configuring gateway...",
      setupResult: null,
    });

    try {
      const result = await client.requestOnce(url, "sys.setup", {
        ...input,
        ...(installationOnboardingToken
          ? { onboardingToken: installationOnboardingToken }
          : undefined),
      });
      if (installationOnboardingToken) {
        clearInstallationOnboardingToken();
        installationOnboardingToken = null;
      }
      pendingSetupLogin = { username, password };
      storeValue(STORAGE_USERNAME, username);

      setSnapshot({
        phase: "setup-complete",
        url,
        username,
        connectionId: null,
        server: result.server,
        message: null,
        setupResult: result,
      });

      return result;
    } catch (error) {
      setSnapshot({
        phase: "setup",
        url,
        username: username || snapshot.username,
        connectionId: null,
        message: normalizeMessage(error),
        setupResult: null,
      });
      throw error;
    }
  };

  const continueFromSetup = async (): Promise<ConnectResult> => {
    if (!pendingSetupLogin) {
      throw new Error("Setup credentials are no longer available. Sign in manually.");
    }

    return await login(pendingSetupLogin);
  };

  const lock = (reason = "Session locked"): void => {
    cancelSilentReconnect();
    const lockGeneration = reconnectGeneration;
    const previousTokenId = currentSessionToken?.tokenId ?? null;
    clearStoredSessionToken();
    pendingSetupLogin = null;

    if (previousTokenId) {
      queueRevoke(previousTokenId);
    }

    setSnapshot({
      phase: "locked",
      url: deriveGatewayUrlFromOrigin(),
      username: snapshot.username,
      connectionId: null,
      message: reason,
      setupResult: null,
    });

    void (async () => {
      await Promise.race([
        drainPendingRevokes("ui session lock"),
        waitFor(LOCK_REVOKE_WAIT_MS),
      ]);

      if (reconnectGeneration === lockGeneration && snapshot.phase === "locked") {
        client.disconnect();
      }
    })();
  };

  const start = async (): Promise<void> => {
    cancelSilentReconnect();
    const url = deriveGatewayUrlFromOrigin();
    const persisted = currentSessionToken;

    if (installationOnboardingToken) {
      setSnapshot({
        phase: "setup",
        url,
        username: snapshot.username,
        connectionId: null,
        message: null,
        setupResult: null,
      });
      return;
    }

    if (!persisted) {
      const setupRequired = await probeSetupMode(client, url);
      if (setupRequired) {
        setSnapshot({
          phase: "setup",
          url,
          username: snapshot.username,
          connectionId: null,
          message: null,
          setupResult: null,
        });
      } else {
        setSnapshot({
          phase: "locked",
          url,
          username: snapshot.username,
          connectionId: null,
          message: null,
          setupResult: null,
        });
      }
      return;
    }

    if (persisted.expiresAt !== null && persisted.expiresAt <= Date.now()) {
      clearStoredSessionToken();
      const setupRequired = await probeSetupMode(client, url);
      if (setupRequired) {
        setSnapshot({
          phase: "setup",
          url,
          username: snapshot.username,
          connectionId: null,
          message: null,
          setupResult: null,
        });
      } else {
        setSnapshot({
          phase: "locked",
          url,
          username: persisted.username,
          connectionId: null,
          message: "Session expired. Sign in again.",
          setupResult: null,
        });
      }
      return;
    }

    setSnapshot({
      phase: "booting",
      url,
      username: persisted.username,
      connectionId: null,
      message: "Booting up...",
      setupResult: null,
    });

    try {
      const result = await client.connect({
        url,
        username: persisted.username,
        token: persisted.token,
      });

      setSnapshot({
        phase: "ready",
        url,
        username: persisted.username,
        connectionId: result.server.connectionId,
        server: result.server,
        message: null,
        setupResult: null,
      });

      await drainPendingRevokes("ui session cleanup");
      scheduleRefresh(persisted);
    } catch (error) {
      clearStoredSessionToken();
      if (isSetupRequiredError(error)) {
        setSnapshot({
          phase: "setup",
          url,
          username: persisted.username,
          connectionId: null,
          message: null,
          setupResult: null,
        });
        return;
      }

      setSnapshot({
        phase: "locked",
        url,
        username: persisted.username,
        connectionId: null,
        message: "Session expired. Sign in again.",
        setupResult: null,
      });
    }
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
    continueFromSetup,
    lock,
    start,
  };
}
