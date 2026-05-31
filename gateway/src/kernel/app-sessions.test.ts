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

    if (q.startsWith("SELECT * FROM app_client_sessions WHERE session_id = ?")) {
      const [sessionId] = bindings as [string];
      const row = table.get(sessionId);
      return result<T>(row ? [row as T] : []);
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
});
