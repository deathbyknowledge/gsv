import type {
  GatewayClient,
  GatewayConnectOptions,
  GatewayConnectResult,
  UserSessionToken,
} from "./gateway-client";

const STORAGE_USERNAME = "gsv.ui.gateway.username";
const STORAGE_SESSION_TOKEN = "gsv.ui.session.token.v1";
const SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TOKEN_REFRESH_LEEWAY_MS = 10 * 60 * 1000;

type PersistedSessionToken = {
  username: string;
  tokenId: string;
  token: string;
  expiresAt: number | null;
};

export type SessionPhase = "locked" | "authenticating" | "ready";

export type SessionSnapshot = {
  phase: SessionPhase;
  url: string;
  username: string;
  connectionId: string | null;
  message: string | null;
};

export type SessionLoginInput = {
  username: string;
  password?: string;
  token?: string;
};

export type SessionService = {
  client: GatewayClient;
  snapshot: () => SessionSnapshot;
  subscribe: (listener: (snapshot: SessionSnapshot) => void) => () => void;
  login: (input: SessionLoginInput) => Promise<GatewayConnectResult>;
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

function normalizeMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  return "Authentication failed";
}

function toPersistedToken(username: string, token: UserSessionToken): PersistedSessionToken {
  return {
    username,
    tokenId: token.tokenId,
    token: token.token,
    expiresAt: token.expiresAt,
  };
}

export function createSessionService(client: GatewayClient): SessionService {
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();

  let snapshot: SessionSnapshot = {
    phase: "locked",
    url: deriveGatewayUrlFromOrigin(),
    username: readStored(STORAGE_USERNAME) ?? "",
    connectionId: null,
    message: null,
  };

  let currentSessionToken: PersistedSessionToken | null = readPersistedToken();
  let refreshTimerId: number | null = null;

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
    clearRefreshTimer();
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

    if (
      previousToken &&
      previousToken.tokenId !== nextToken.tokenId &&
      client.isConnected()
    ) {
      void client.revokeToken(previousToken.tokenId, "ui session rotated").catch(() => {
        // Best effort.
      });
    }
  };

  client.onStatus((status) => {
    if (status.state === "connected") {
      if (snapshot.phase !== "ready") {
        setSnapshot({
          phase: "ready",
          url: status.url ?? snapshot.url,
          username: status.username ?? snapshot.username,
          connectionId: status.connectionId,
          message: null,
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
    });

    const options: GatewayConnectOptions = {
      url,
      username,
      ...(token ? { token } : { password }),
    };

    try {
      const result = await client.connectUser(options);
      storeValue(STORAGE_USERNAME, username);

      setSnapshot({
        phase: "ready",
        url,
        username,
        connectionId: result.server.connectionId,
        message: null,
      });

      await refreshSessionToken("post-login");

      return result;
    } catch (error) {
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

  const lock = (reason = "Session locked"): void => {
    const previousTokenId = currentSessionToken?.tokenId ?? null;
    clearStoredSessionToken();

    if (previousTokenId && client.isConnected()) {
      void client.revokeToken(previousTokenId, "ui session lock").catch(() => {
        // Best effort.
      });
    }

    client.disconnect();
    setSnapshot({
      phase: "locked",
      url: deriveGatewayUrlFromOrigin(),
      username: snapshot.username,
      connectionId: null,
      message: reason,
    });
  };

  const start = async (): Promise<void> => {
    const persisted = currentSessionToken;
    if (!persisted) {
      return;
    }

    if (persisted.expiresAt !== null && persisted.expiresAt <= Date.now()) {
      clearStoredSessionToken();
      return;
    }

    const url = deriveGatewayUrlFromOrigin();
    setSnapshot({
      phase: "authenticating",
      url,
      username: persisted.username,
      connectionId: null,
      message: "Restoring session...",
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
      });

      scheduleRefresh(persisted);
      await refreshSessionToken("post-login");
    } catch {
      clearStoredSessionToken();
      setSnapshot({
        phase: "locked",
        url,
        username: persisted.username,
        connectionId: null,
        message: "Session expired. Sign in again.",
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
    lock,
    start,
  };
}
