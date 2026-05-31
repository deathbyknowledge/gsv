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
  const table = new Map<string, Row>();
  const keys = new Map<string, Row>();

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (q.startsWith("CREATE TABLE IF NOT EXISTS")) {
      return result<T>();
    }
    if (q.startsWith("CREATE INDEX IF NOT EXISTS")) {
      return result<T>();
    }

    if (q.startsWith("DELETE FROM app_client_sessions WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      for (const [sessionId, row] of table.entries()) {
        if ((row.expires_at as number) <= now || row.revoked_at !== null) {
          table.delete(sessionId);
        }
      }
      return result<T>();
    }

    if (q.startsWith("DELETE FROM app_client_session_keys WHERE expires_at <= ?")) {
      const [now] = bindings as [number];
      for (const [keyId, row] of keys.entries()) {
        if ((row.expires_at as number) <= now || row.revoked_at !== null) {
          keys.delete(keyId);
        }
      }
      return result<T>();
    }

    if (q.startsWith("INSERT INTO app_client_sessions")) {
      const [
        sessionId,
        uid,
        username,
        packageId,
        packageName,
        entrypointName,
        routeBase,
        clientId,
        secretHash,
        createdAt,
        lastUsedAt,
        expiresAt,
        revokedAt,
      ] = bindings as [
        string,
        number,
        string,
        string,
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
      table.set(sessionId, {
        session_id: sessionId,
        uid,
        username,
        package_id: packageId,
        package_name: packageName,
        entrypoint_name: entrypointName,
        route_base: routeBase,
        client_id: clientId,
        secret_hash: secretHash,
        created_at: createdAt,
        last_used_at: lastUsedAt,
        expires_at: expiresAt,
        revoked_at: revokedAt,
      });
      return result<T>();
    }

    if (q.startsWith("INSERT INTO app_client_session_keys")) {
      const [
        keyId,
        sessionId,
        secretHash,
        createdAt,
        expiresAt,
        revokedAt,
      ] = bindings as [string, string, string, number, number, number | null];
      keys.set(keyId, {
        key_id: keyId,
        session_id: sessionId,
        secret_hash: secretHash,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: revokedAt,
      });
      return result<T>();
    }

    if (q.startsWith("SELECT * FROM app_client_sessions WHERE session_id = ?")) {
      const [sessionId] = bindings as [string];
      const row = table.get(sessionId);
      return result<T>(row ? [row as T] : []);
    }

    if (q.startsWith("SELECT * FROM app_client_sessions") && q.includes("WHERE uid = ?")) {
      const [uid, now] = bindings as [number, number];
      return result<T>([...table.values()]
        .filter((row) => row.uid === uid && row.revoked_at === null && (row.expires_at as number) > now)
        .sort((left, right) => {
          const leftTime = (left.last_used_at as number | null) ?? (left.created_at as number);
          const rightTime = (right.last_used_at as number | null) ?? (right.created_at as number);
          return rightTime - leftTime;
        }) as T[]);
    }

    if (q.startsWith("SELECT * FROM app_client_session_keys")) {
      const [sessionId, now] = bindings as [string, number];
      return result<T>([...keys.values()]
        .filter((row) => row.session_id === sessionId && row.revoked_at === null && (row.expires_at as number) > now) as T[]);
    }

    if (q.startsWith("UPDATE app_client_sessions SET last_used_at = ?, expires_at = ?")) {
      const [lastUsedAt, expiresAt, sessionId] = bindings as [number, number, string];
      const row = table.get(sessionId);
      if (row) {
        row.last_used_at = lastUsedAt;
        row.expires_at = expiresAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_client_sessions SET last_used_at = ?")) {
      const [lastUsedAt, sessionId] = bindings as [number, string];
      const row = table.get(sessionId);
      if (row) {
        row.last_used_at = lastUsedAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_client_sessions SET revoked_at = ?")) {
      const [revokedAt, sessionId] = bindings as [number, string];
      const row = table.get(sessionId);
      if (row) {
        row.revoked_at = revokedAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_client_session_keys SET expires_at = ?")) {
      const [expiresAt, keyId] = bindings as [number, string];
      const row = keys.get(keyId);
      if (row) {
        row.expires_at = expiresAt;
      }
      return result<T>();
    }

    if (q.startsWith("UPDATE app_client_session_keys SET revoked_at = ?")) {
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
    expect(issued.rpcBase).toBe(`/apps/sessions/${issued.sessionId}/socket`);
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

  it("mints additional launch secrets without invalidating existing sessions", async () => {
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
    const minted = await store.mintSecret(1000, issued.sessionId, 20_000);
    expect(minted?.secret).toMatch(/[0-9a-f-]+/i);
    expect(minted?.secret).not.toBe(issued.secret);
    expect(minted?.expiresAt).toBe(221_000);

    expect(await store.resolve(issued.sessionId, issued.secret)).toMatchObject({
      sessionId: issued.sessionId,
    });
    expect(await store.resolve(issued.sessionId, minted!.secret)).toMatchObject({
      sessionId: issued.sessionId,
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

    expect(store.list(1000)).toHaveLength(1);
    expect(store.list(1001)).toHaveLength(0);
    expect(store.close(1001, issued.sessionId)).toBe(false);
    expect(store.close(1000, issued.sessionId)).toBe(true);
    expect(store.list(1000)).toHaveLength(0);
  });
});
