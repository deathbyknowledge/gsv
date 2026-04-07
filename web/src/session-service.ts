import type {
  GatewayClient,
  GatewayConnectOptions,
  GatewayConnectResult,
  UserSessionToken,
} from "./gateway-client";
import type {
  SysBootstrapArgs,
  SysBootstrapResult,
  SysSetupArgs,
  SysSetupResult,
} from "../../gateway-os/src/syscalls/system";

const STORAGE_USERNAME = "gsv.ui.gateway.username";
const STORAGE_SESSION_TOKEN = "gsv.ui.session.token.v1";
const STORAGE_PENDING_REVOKES = "gsv.ui.session.pending-revokes.v1";
const APP_SESSION_USER_COOKIE = "gsv_app_user";
const APP_SESSION_TOKEN_COOKIE = "gsv_app_token";
const SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TOKEN_REFRESH_LEEWAY_MS = 10 * 60 * 1000;
const LOCK_REVOKE_WAIT_MS = 1_500;

type PersistedSessionToken = {
  username: string;
  tokenId: string;
  token: string;
  expiresAt: number | null;
};

export type SessionPhase = "setup" | "setup-complete" | "locked" | "authenticating" | "ready";

export type SessionSnapshot = {
  phase: SessionPhase;
  url: string;
  username: string;
  connectionId: string | null;
  message: string | null;
  setupResult: SysSetupResult | null;
};

export type SessionLoginInput = {
  username: string;
  password?: string;
  token?: string;
};

export type SessionSetupInput = SysSetupArgs;

export type SessionService = {
  client: GatewayClient;
  snapshot: () => SessionSnapshot;
  subscribe: (listener: (snapshot: SessionSnapshot) => void) => () => void;
  login: (input: SessionLoginInput) => Promise<GatewayConnectResult>;
  setup: (input: SessionSetupInput) => Promise<SysSetupResult>;
  initializeFromUpstream: (args?: SysBootstrapArgs) => Promise<SysBootstrapResult>;
  continueFromSetup: () => Promise<GatewayConnectResult>;
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
    const parsed = JSON.parse(raw) as Partial<PersistedSessionToken>;
    if (
      typeof parsed.username !== "string" ||
      typeof parsed.tokenId !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }

    return {
      username: parsed.username,
      tokenId: parsed.tokenId,
      token: parsed.token,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
    };
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
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
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

  syncAppSessionCookies(token);
}

function deriveGatewayUrlFromOrigin(): string {
  const { protocol, host } = window.location;
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/ws`;
}

function normalizeMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  return "Authentication failed";
}

function isSetupRequiredError(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const error = value as Error & { code?: number; details?: unknown };
  if (error.code === 425) {
    return true;
  }

  if (!error.details || typeof error.details !== "object") {
    return false;
  }

  return (error.details as { setupMode?: unknown }).setupMode === true;
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

function writeCookie(name: string, value: string, expiresAt: number | null): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
  ];

  if (window.location.protocol === "https:") {
    parts.push("Secure");
  }
  if (typeof expiresAt === "number") {
    parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  }

  document.cookie = parts.join("; ");
}

function clearCookie(name: string): void {
  const parts = [
    `${name}=`,
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "SameSite=Strict",
  ];
  if (window.location.protocol === "https:") {
    parts.push("Secure");
  }
  document.cookie = parts.join("; ");
}

function syncAppSessionCookies(token: PersistedSessionToken): void {
  writeCookie(APP_SESSION_USER_COOKIE, token.username, token.expiresAt);
  writeCookie(APP_SESSION_TOKEN_COOKIE, token.token, token.expiresAt);
}

function clearAppSessionCookies(): void {
  clearCookie(APP_SESSION_USER_COOKIE);
  clearCookie(APP_SESSION_TOKEN_COOKIE);
}

export function createSessionService(client: GatewayClient): SessionService {
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();

  let snapshot: SessionSnapshot = {
    phase: "locked",
    url: deriveGatewayUrlFromOrigin(),
    username: readStored(STORAGE_USERNAME) ?? "",
    connectionId: null,
    message: null,
    setupResult: null,
  };

  let currentSessionToken: PersistedSessionToken | null = readPersistedToken();
  let pendingRevokes = Array.from(new Set(readPersistedRevokes()));
  let refreshTimerId: number | null = null;
  let pendingSetupLogin: SessionLoginInput | null = null;
  let holdReadyUntilBootstrap = false;

  if (currentSessionToken) {
    syncAppSessionCookies(currentSessionToken);
  } else {
    clearAppSessionCookies();
  }

  const emit = (): void => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const setSnapshot = (next: SessionSnapshot): void => {
    snapshot = next;
    emit();
  };

  const clearRefreshTimer = (): void => {
    if (refreshTimerId !== null) {
      window.clearTimeout(refreshTimerId);
      refreshTimerId = null;
    }
  };

  const clearStoredSessionToken = (): void => {
    currentSessionToken = null;
    removeValue(STORAGE_SESSION_TOKEN);
    clearAppSessionCookies();
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
        const revoked = await client.revokeToken(tokenId, reason);
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

    if (typeof token.expiresAt !== "number") {
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
      nextToken = await client.createUserSessionToken(nextExpiry);
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

  client.onStatus((status) => {
    if (status.state === "connected") {
      if (holdReadyUntilBootstrap) {
        return;
      }
      if (snapshot.phase !== "ready") {
        setSnapshot({
          phase: "ready",
          url: status.url ?? snapshot.url,
          username: status.username ?? snapshot.username,
          connectionId: status.connectionId,
          message: null,
          setupResult: null,
        });
      }
      return;
    }

    if (status.state === "connecting") {
      return;
    }

    if (snapshot.phase === "ready") {
      clearRefreshTimer();
      setSnapshot({
        phase: "locked",
        url: snapshot.url,
        username: snapshot.username,
        connectionId: null,
        message: status.message ?? "Disconnected",
        setupResult: null,
      });
    }
  });

  const login = async (input: SessionLoginInput): Promise<GatewayConnectResult> => {
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

    const options: GatewayConnectOptions = {
      url,
      username,
      ...(token ? { token } : { password }),
    };

    try {
      const result = await client.connectUser(options);
      storeValue(STORAGE_USERNAME, username);
      pendingSetupLogin = null;

      if (!holdReadyUntilBootstrap) {
        setSnapshot({
          phase: "ready",
          url,
          username,
          connectionId: result.server.connectionId,
          message: null,
          setupResult: null,
        });
      }

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
      const result = await client.setupSystem(url, input);
      pendingSetupLogin = { username, password };
      storeValue(STORAGE_USERNAME, username);

      setSnapshot({
        phase: "setup-complete",
        url,
        username,
        connectionId: null,
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

  const continueFromSetup = async (): Promise<GatewayConnectResult> => {
    if (!pendingSetupLogin) {
      throw new Error("Setup credentials are no longer available. Sign in manually.");
    }

    return await login(pendingSetupLogin);
  };

  const initializeFromUpstream = async (
    args: SysBootstrapArgs = {},
  ): Promise<SysBootstrapResult> => {
    const url = deriveGatewayUrlFromOrigin();
    const setupResult = snapshot.setupResult;
    const username = snapshot.username;
    const wasConnected = client.isConnected();

    if (!wasConnected) {
      holdReadyUntilBootstrap = true;
      setSnapshot({
        phase: "authenticating",
        url,
        username,
        connectionId: null,
        message: "Initializing system from upstream...",
        setupResult,
      });
    }

    try {
      if (!wasConnected) {
        await continueFromSetup();
      }
      const result = await client.bootstrapSystem(args);
      holdReadyUntilBootstrap = false;
      const status = client.getStatus();
      setSnapshot({
        phase: "ready",
        url: status.url ?? url,
        username: status.username ?? username,
        connectionId: status.connectionId,
        message: null,
        setupResult: null,
      });
      return result;
    } catch (error) {
      holdReadyUntilBootstrap = false;
      if (!wasConnected && client.isConnected()) {
        client.disconnect();
      }
      setSnapshot({
        phase: "setup-complete",
        url,
        username,
        connectionId: null,
        message: normalizeMessage(error),
        setupResult,
      });
      throw error;
    }
  };

  const lock = (reason = "Session locked"): void => {
    const previousTokenId = currentSessionToken?.tokenId ?? null;
    clearStoredSessionToken();
    pendingSetupLogin = null;

    if (previousTokenId) {
      queueRevoke(previousTokenId);
    }

    void (async () => {
      await Promise.race([
        drainPendingRevokes("ui session lock"),
        waitFor(LOCK_REVOKE_WAIT_MS),
      ]);

      client.disconnect();
      setSnapshot({
        phase: "locked",
        url: deriveGatewayUrlFromOrigin(),
        username: snapshot.username,
        connectionId: null,
        message: reason,
        setupResult: null,
      });
    })();
  };

  const start = async (): Promise<void> => {
    const url = deriveGatewayUrlFromOrigin();
    const persisted = currentSessionToken;

    if (!persisted) {
      const setupRequired = await client.probeSetupMode(url);
      if (setupRequired) {
        setSnapshot({
          phase: "setup",
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
      const setupRequired = await client.probeSetupMode(url);
      if (setupRequired) {
        setSnapshot({
          phase: "setup",
          url,
          username: snapshot.username,
          connectionId: null,
          message: null,
          setupResult: null,
        });
      }
      return;
    }

    setSnapshot({
      phase: "authenticating",
      url,
      username: persisted.username,
      connectionId: null,
      message: "Restoring session...",
      setupResult: null,
    });

    try {
      const result = await client.connectUser({
        url,
        username: persisted.username,
        token: persisted.token,
      });

      setSnapshot({
        phase: "ready",
        url,
        username: persisted.username,
        connectionId: result.server.connectionId,
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
    initializeFromUpstream,
    continueFromSetup,
    lock,
    start,
  };
}
