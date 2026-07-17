import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleMockSchemaStatement,
  mockSqlRows,
  type MockSqlRow,
} from "../test-support/mock-sql";
import { SurfaceRouteStore } from "./surface-routes";

function createMockSql() {
  const routes = new Map<string, MockSqlRow>();
  const key = (
    adapter: string,
    accountId: string,
    actorId: string,
    surfaceKind: string,
    surfaceId: string,
    threadId: string,
  ) => [adapter, accountId, actorId, surfaceKind, surfaceId, threadId].join("\0");

  function exec<T = MockSqlRow>(query: string, ...bindings: unknown[]) {
    const normalized = query.trim();
    const schemaResult = handleMockSchemaStatement<T>(normalized);
    if (schemaResult) return schemaResult;

    if (normalized.startsWith("INSERT OR REPLACE INTO surface_routes")) {
      const [
        adapter,
        accountId,
        actorId,
        surfaceKind,
        surfaceId,
        threadId,
        uid,
        pid,
        updatedAt,
        updatedByUid,
      ] = bindings as [string, string, string, string, string, string, number, string, number, number];
      routes.set(key(adapter, accountId, actorId, surfaceKind, surfaceId, threadId), {
        adapter,
        account_id: accountId,
        actor_id: actorId,
        surface_kind: surfaceKind,
        surface_id: surfaceId,
        thread_id: threadId,
        uid,
        pid,
        updated_at: updatedAt,
        updated_by_uid: updatedByUid,
      });
      return mockSqlRows<T>();
    }

    if (normalized.startsWith("SELECT pid FROM surface_routes")) {
      const [adapter, accountId, actorId, surfaceKind, surfaceId, threadId, uid] =
        bindings as [string, string, string, string, string, string, number];
      const row = routes.get(key(adapter, accountId, actorId, surfaceKind, surfaceId, threadId));
      return mockSqlRows((row?.uid === uid ? [{ pid: row.pid }] : []) as T[]);
    }

    if (normalized.startsWith("SELECT adapter, account_id, actor_id")) {
      const [adapter, accountId, actorId, surfaceKind, surfaceId, threadId] =
        bindings as [string, string, string, string, string, string];
      const row = routes.get(key(adapter, accountId, actorId, surfaceKind, surfaceId, threadId));
      return mockSqlRows((row ? [row] : []) as T[]);
    }

    return mockSqlRows<T>();
  }

  return { exec };
}

describe("SurfaceRouteStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps routes actor-scoped when multiple users share a group surface", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new SurfaceRouteStore(createMockSql() as unknown as SqlStorage);
    const sharedSurface = {
      adapter: "discord",
      accountId: "bot",
      surfaceKind: "group" as const,
      surfaceId: "channel-1",
    };

    store.setRoute({
      ...sharedSurface,
      actorId: "discord:user:alice",
      uid: 1000,
      pid: "proc-alice",
      updatedByUid: 1000,
    });
    store.setRoute({
      ...sharedSurface,
      actorId: "discord:user:bob",
      uid: 2000,
      pid: "proc-bob",
      updatedByUid: 2000,
    });

    expect(store.resolvePid({
      ...sharedSurface,
      actorId: "discord:user:alice",
      uid: 1000,
    })).toBe("proc-alice");
    expect(store.resolvePid({
      ...sharedSurface,
      actorId: "discord:user:bob",
      uid: 2000,
    })).toBe("proc-bob");
    expect(store.resolvePid({
      ...sharedSurface,
      actorId: "discord:user:alice",
      uid: 2000,
    })).toBeNull();
    expect(store.get({
      ...sharedSurface,
      actorId: "discord:user:alice",
    })?.pid).toBe("proc-alice");
  });
});
