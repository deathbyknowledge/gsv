import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSessionStore } from "./app-sessions";

type Row = Record<string, unknown>;

function result<T = Row>(rows: T[] = []) {
  return {
    toArray: () => rows,
    *[Symbol.iterator]() {
      yield* rows;
    },
  };
}

function createMockSql() {
  const sessions = new Map<string, Row>();
  const clients = new Map<string, Row>();
  const keys = new Map<string, Row>();
  const clientKey = (sessionId: string, clientId: string) => `${sessionId}:${clientId}`;

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (q.startsWith("DROP TABLE IF EXISTS")) {
      return result<T>();
    }
    if (q.startsWith("CREATE TABLE IF NOT EXISTS")) {
      return result<T>();
    }
    if (q.startsWith("CREATE INDEX IF NOT EXISTS")) {
      return result<T>();
    }

    if (q.startsWith("DELETE FROM app_session_client_keys WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      for (const [keyId, row] of keys.entries()) {
        if ((row.expires_at as number) <= now || row.revoked_at !== null) {
          keys.delete(keyId);
        }
      }
      return result<T>();
    }

    if (q.startsWith("DELETE FROM app_session_clients WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      for (const [key, row] of clients.entries()) {
        if ((row.expires_at as number) <= now || row.closed_at !== null) {
          clients.delete(key);
        }
      }
      return result<T>();
    }

    if (q.startsWith("DELETE FROM app_sessions WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      for (const [sessionId, row] of sessions.entries()) {
        if ((row.expires_at as number) <= now || row.closed_at !== null) {
          sessions.delete(sessionId);
        }
      }
      return result<T>();
    }

    if (q.startsWith("DELETE FROM app_session_client_keys WHERE session_id NOT IN")) {
      for (const [keyId, row] of keys.entries()) {
        if (!sessions.has(row.session_id as string)) {
          keys.delete(keyId);
        }
      }
      return result<T>();
    }

    if (q.startsWith("DELETE FROM app_session_clients WHERE session_id NOT IN")) {
      for (const [key, row] of clients.entries()) {
        if (!sessions.has(row.session_id as string)) {
          clients.delete(key);
        }
      }
      return result<T>();
    }

    if (q.startsWith("INSERT INTO app_sessions")) {
      const [
        sessionId,
        uid,
        username,
        packageId,
        packageName,
        entrypointName,
        routeBase,
        createdAt,
        lastUsedAt,
        expiresAt,
        closedAt,
      ] = bindings as [
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        number,
        number | null,
        number,
        number | null,
      ];
      sessions.set(sessionId, {
        session_id: sessionId,
        uid,
        username,
        package_id: packageId,
        package_name: packageName,
        entrypoint_name: entrypointName,
        route_base: routeBase,
        created_at: createdAt,
        last_used_at: lastUsedAt,
        expires_at: expiresAt,
        closed_at: closedAt,
      });
      return result<T>();
    }

    if (q.startsWith("INSERT INTO app_session_clients")) {
      const [
        sessionId,
        clientId,
        createdAt,
        lastUsedAt,
        expiresAt,
        closedAt,
      ] = bindings as [string, string, number, number | null, number, number | null];
      clients.set(clientKey(sessionId, clientId), {
        session_id: sessionId,
        client_id: clientId,
        created_at: createdAt,
        last_used_at: lastUsedAt,
        expires_at: expiresAt,
        closed_at: closedAt,
      });
      return result<T>();
    }

    if (q.startsWith("INSERT INTO app_session_client_keys")) {
      const [
        keyId,
        sessionId,
        clientId,
        secretHash,
        createdAt,
        expiresAt,
        revokedAt,
      ] = bindings as [string, string, string, string, number, number, number | null];
      keys.set(keyId, {
        key_id: keyId,
        session_id: sessionId,
        client_id: clientId,
        secret_hash: secretHash,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: revokedAt,
      });
      return result<T>();
    }

    if (q.startsWith("SELECT * FROM app_sessions WHERE session_id = ?")) {
      const [sessionId] = bindings as [string];
      const row = sessions.get(sessionId);
      return result<T>(row ? [row as T] : []);
    }

    if (q.startsWith("SELECT * FROM app_sessions") && q.includes("WHERE uid = ?")) {
      const [uid, now] = bindings as [number, number];
      return result<T>([...sessions.values()]
        .filter((row) => row.uid === uid && row.closed_at === null && (row.expires_at as number) > now)
        .sort((left, right) => {
          const leftTime = (left.last_used_at as number | null) ?? (left.created_at as number);
          const rightTime = (right.last_used_at as number | null) ?? (right.created_at as number);
          return rightTime - leftTime;
        }) as T[]);
    }

    if (q.startsWith("SELECT * FROM app_session_clients") && q.includes("client_id = ?")) {
      const [sessionId, clientId] = bindings as [string, string];
      const row = clients.get(clientKey(sessionId, clientId));
      return result<T>(row ? [row as T] : []);
    }

    if (q.startsWith("SELECT * FROM app_session_clients")) {
      const [sessionId, now] = bindings as [string, number];
      return result<T>([...clients.values()]
        .filter((row) => row.session_id === sessionId && row.closed_at === null && (row.expires_at as number) > now)
        .sort((left, right) => {
          const leftTime = (left.last_used_at as number | null) ?? (left.created_at as number);
          const rightTime = (right.last_used_at as number | null) ?? (right.created_at as number);
          return rightTime - leftTime;
        }) as T[]);
    }

    if (q.startsWith("SELECT * FROM app_session_client_keys")) {
      const [sessionId, now] = bindings as [string, number];
      return result<T>([...keys.values()]
        .filter((row) => row.session_id === sessionId && row.revoked_at === null && (row.expires_at as number) > now) as T[]);
    }

    if (q.startsWith("UPDATE app_sessions SET last_used_at = ?, expires_at = MAX")) {
      const [lastUsedAt, expiresAt, sessionId] = bindings as [number, number, string];
      const row = sessions.get(sessionId);
      if (row) {
        row.last_used_at = lastUsedAt;
        row.expires_at = Math.max(row.expires_at as number, expiresAt);
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_sessions SET last_used_at = ?")) {
      const [lastUsedAt, sessionId] = bindings as [number, string];
      const row = sessions.get(sessionId);
      if (row) {
        row.last_used_at = lastUsedAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_session_clients SET last_used_at = ?, expires_at = ?")) {
      const [lastUsedAt, expiresAt, sessionId, clientId] = bindings as [number, number, string, string];
      const row = clients.get(clientKey(sessionId, clientId));
      if (row) {
        row.last_used_at = lastUsedAt;
        row.expires_at = expiresAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_session_clients SET last_used_at = ?")) {
      const [lastUsedAt, sessionId, clientId] = bindings as [number, string, string];
      const row = clients.get(clientKey(sessionId, clientId));
      if (row) {
        row.last_used_at = lastUsedAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_session_client_keys SET expires_at = ?")) {
      const [expiresAt, keyId] = bindings as [number, string];
      const row = keys.get(keyId);
      if (row) {
        row.expires_at = expiresAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_sessions SET closed_at = ?")) {
      const [closedAt, sessionId] = bindings as [number, string];
      const row = sessions.get(sessionId);
      if (row) {
        row.closed_at = closedAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_session_clients SET closed_at = ?") && q.includes("client_id = ?")) {
      const [closedAt, sessionId, clientId] = bindings as [number, string, string];
      const row = clients.get(clientKey(sessionId, clientId));
      if (row && row.closed_at === null) {
        row.closed_at = closedAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_session_clients SET closed_at = ?")) {
      const [closedAt, sessionId] = bindings as [number, string];
      for (const row of clients.values()) {
        if (row.session_id === sessionId && row.closed_at === null) {
          row.closed_at = closedAt;
        }
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_session_client_keys SET revoked_at = ?") && q.includes("client_id = ?")) {
      const [revokedAt, sessionId, clientId] = bindings as [number, string, string];
      for (const row of keys.values()) {
        if (row.session_id === sessionId && row.client_id === clientId && row.revoked_at === null) {
          row.revoked_at = revokedAt;
        }
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_session_client_keys SET revoked_at = ?")) {
      const [revokedAt, sessionId] = bindings as [number, string];
      for (const row of keys.values()) {
        if (row.session_id === sessionId && row.revoked_at === null) {
          row.revoked_at = revokedAt;
        }
      }
      return result<T>();
    }

    throw new Error(`unexpected query: ${q}`);
  }

  return { exec };
}

describe("AppSessionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues cookie-backed app sessions with a session socket rpc base", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    const store = new AppSessionStore(createMockSql() as unknown as SqlStorage);
    store.init();

    const issued = await store.issue({
      uid: 1000,
      username: "alice",
      packageId: "pkg-chat",
      packageName: "chat",
      entrypointName: "Chat",
      routeBase: "/apps/chat",
      clientId: "win-1",
      ttlMs: 60_000,
    });

    expect(issued.secret).toMatch(/[0-9a-f-]+/i);
    expect(issued.rpcBase).toBe(`/apps/sessions/${issued.sessionId}/clients/win-1/socket`);
    expect(issued.expiresAt).toBe(70_000);

    vi.spyOn(Date, "now").mockReturnValue(20_000);
    const resolved = await store.resolve(issued.sessionId, issued.secret);

    expect(resolved?.clientId).toBe("win-1");
    expect(resolved?.rpcBase).toBe(issued.rpcBase);
    expect(resolved?.lastUsedAt).toBe(20_000);
  });

  it("refreshes an existing session without changing its socket path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const store = new AppSessionStore(createMockSql() as unknown as SqlStorage);
    store.init();

    const issued = await store.issue({
      uid: 1000,
      username: "alice",
      packageId: "pkg-chat",
      packageName: "chat",
      entrypointName: "Chat",
      routeBase: "/apps/chat",
      clientId: "win-1",
      ttlMs: 10_000,
    });

    vi.spyOn(Date, "now").mockReturnValue(105_000);
    const refreshed = await store.refresh(issued.sessionId, issued.secret, 30_000);

    expect(refreshed?.sessionId).toBe(issued.sessionId);
    expect(refreshed?.rpcBase).toBe(issued.rpcBase);
    expect(refreshed?.expiresAt).toBe(135_000);
    expect(refreshed?.lastUsedAt).toBe(105_000);
  });

  it("attaches additional clients without invalidating existing sessions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(200_000);

    const store = new AppSessionStore(createMockSql() as unknown as SqlStorage);
    store.init();

    const issued = await store.issue({
      uid: 1000,
      username: "alice",
      packageId: "pkg-chat",
      packageName: "chat",
      entrypointName: "Chat",
      routeBase: "/apps/chat",
      clientId: "win-1",
      ttlMs: 10_000,
    });

    vi.spyOn(Date, "now").mockReturnValue(201_000);
    const minted = await store.attach({
      uid: 1000,
      sessionId: issued.sessionId,
      clientId: "win-2",
      ttlMs: 20_000,
    });
    expect(minted?.secret).toMatch(/[0-9a-f-]+/i);
    expect(minted?.secret).not.toBe(issued.secret);
    expect(minted?.expiresAt).toBe(221_000);

    expect(await store.resolve(issued.sessionId, issued.secret)).toMatchObject({
      sessionId: issued.sessionId,
    });
    expect(await store.resolve(issued.sessionId, minted!.secret)).toMatchObject({
      sessionId: issued.sessionId,
      clientId: "win-2",
    });

    vi.spyOn(Date, "now").mockReturnValue(202_000);
    expect(store.detach(1000, issued.sessionId, "win-2")).toMatchObject({
      sessionId: issued.sessionId,
      clientId: "win-2",
    });
    expect(await store.resolve(issued.sessionId, minted!.secret)).toBeNull();
    expect(await store.resolve(issued.sessionId, issued.secret)).toMatchObject({
      sessionId: issued.sessionId,
      clientId: "win-1",
    });
  });

  it("lists and closes active sessions for the owning user", async () => {
    vi.spyOn(Date, "now").mockReturnValue(300_000);

    const store = new AppSessionStore(createMockSql() as unknown as SqlStorage);
    store.init();

    const issued = await store.issue({
      uid: 1000,
      username: "alice",
      packageId: "pkg-chat",
      packageName: "chat",
      entrypointName: "Chat",
      routeBase: "/apps/chat",
      clientId: "win-1",
      ttlMs: 10_000,
    });

    expect(store.list(1000)).toEqual([expect.objectContaining({
      sessionId: issued.sessionId,
      clients: [expect.objectContaining({ clientId: "win-1" })],
      state: "active",
    })]);
    expect(store.list(1001)).toHaveLength(0);
    expect(store.close(1001, issued.sessionId)).toBeNull();
    expect(store.close(1000, issued.sessionId)).toMatchObject({
      sessionId: issued.sessionId,
      state: "closed",
    });
    expect(store.list(1000)).toHaveLength(0);
  });
});
