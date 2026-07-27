import { describe, expect, it } from "vitest";
import { mockSqlRows, type MockSqlRow } from "../test-support/mock-sql";
import { AuthStore } from "./auth-store";

function createSql(nextId = 1000): SqlStorage & { nextId: () => number } {
  let next = nextId;
  const exec = <T = MockSqlRow>(query: string, ...bindings: unknown[]) => {
    const sql = query.trim().replace(/\s+/g, " ");
    if (sql.startsWith("UPDATE identity_id_allocator SET next_id = next_id + 1")) {
      return mockSqlRows([{ id: next++ }] as T[]);
    }
    if (sql.startsWith("UPDATE identity_id_allocator SET next_id = MAX")) {
      next = Math.max(next, (bindings[0] as number) + 1);
    }
    return mockSqlRows<T>();
  };
  return { exec, nextId: () => next } as SqlStorage & { nextId: () => number };
}

describe("AuthStore identity id allocation", () => {
  it("shares one monotonic allocator across uids and gids and burns unused ids", () => {
    const sql = createSql();
    const auth = new AuthStore(sql);

    expect(auth.nextUid()).toBe(1000);
    expect(auth.nextGid()).toBe(1001);
    expect(auth.nextUid()).toBe(1002);
    expect(sql.nextId()).toBe(1003);
  });

  it("advances past explicitly authored passwd and group ids", () => {
    const auth = new AuthStore(createSql());
    auth.addUser({
      username: "alice",
      uid: 1200,
      gid: 1300,
      gecos: "Alice",
      home: "/home/alice",
      shell: "/bin/init",
    });
    expect(auth.nextUid()).toBe(1301);

    auth.addGroup({ name: "external", gid: 1400, members: [] });
    expect(auth.nextGid()).toBe(1401);
  });
});
