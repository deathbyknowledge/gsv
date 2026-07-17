import { describe, expect, it } from "vitest";
import { SetupRecoveryStore, type SetupRecoveryRecord } from "./setup-recovery";

type State = {
  recovery: SetupRecoveryRecord | null;
  authRows: string[];
  tokenRows: string[];
};

function rows<T>(values: T[]) {
  return {
    toArray: () => values,
  };
}

function createStorage() {
  let state: State = { recovery: null, authRows: [], tokenRows: [] };
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]) {
      const normalized = query.trim().replace(/\s+/g, " ");
      if (normalized.startsWith("SELECT username, uid, gid, plan_fingerprint")) {
        return rows(state.recovery
          ? [{
              username: state.recovery.username,
              uid: state.recovery.uid,
              gid: state.recovery.gid,
              plan_fingerprint: state.recovery.planFingerprint,
              created_at: state.recovery.createdAt,
            } as T]
          : []);
      }
      if (normalized.startsWith("INSERT INTO setup_recovery")) {
        state.recovery = {
          username: bindings[0] as string,
          uid: bindings[1] as number,
          gid: bindings[2] as number,
          planFingerprint: bindings[3] as string,
          createdAt: bindings[4] as number,
        };
        return rows<T>([]);
      }
      if (normalized.startsWith("DELETE FROM setup_recovery")) {
        state.recovery = null;
        return rows<T>([]);
      }
      if (normalized === "INSERT FAKE AUTH") {
        state.authRows.push(bindings[0] as string);
        return rows<T>([]);
      }
      if (normalized === "INSERT FAKE TOKEN") {
        state.tokenRows.push(bindings[0] as string);
        return rows<T>([]);
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };
  const storage = {
    sql,
    transactionSync<T>(run: () => T): T {
      const before = structuredClone(state);
      try {
        return run();
      } catch (error) {
        state = before;
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return {
    storage,
    state: () => structuredClone(state),
  };
}

const recovery: SetupRecoveryRecord = {
  username: "alice",
  uid: 1000,
  gid: 1000,
  planFingerprint: "a".repeat(64),
  createdAt: 1_700_000_000_000,
};

describe("SetupRecoveryStore", () => {
  it("commits first-user auth and the recovery marker atomically", () => {
    const fixture = createStorage();
    const store = new SetupRecoveryStore(fixture.storage);

    store.start(recovery, () => {
      fixture.storage.sql.exec("INSERT FAKE AUTH", "alice");
    });

    expect(store.current()).toEqual(recovery);
    expect(fixture.state().authRows).toEqual(["alice"]);
  });

  it("rolls auth state back when the initial commit fails", () => {
    const fixture = createStorage();
    const store = new SetupRecoveryStore(fixture.storage);

    expect(() => store.start(recovery, () => {
      fixture.storage.sql.exec("INSERT FAKE AUTH", "alice");
      throw new Error("injected auth failure");
    })).toThrow("injected auth failure");

    expect(store.current()).toBeNull();
    expect(fixture.state().authRows).toEqual([]);
  });

  it("persists the node token and removes recovery in one final commit", () => {
    const fixture = createStorage();
    const store = new SetupRecoveryStore(fixture.storage);
    store.start(recovery, () => {});

    const result = store.finish(recovery, () => {
      fixture.storage.sql.exec("INSERT FAKE TOKEN", "tok-1");
      return "raw-token";
    });

    expect(result).toBe("raw-token");
    expect(store.current()).toBeNull();
    expect(fixture.state().tokenRows).toEqual(["tok-1"]);
  });

  it("keeps recovery active and rolls the token back when finalization fails", () => {
    const fixture = createStorage();
    const store = new SetupRecoveryStore(fixture.storage);
    store.start(recovery, () => {});

    expect(() => store.finish(recovery, () => {
      fixture.storage.sql.exec("INSERT FAKE TOKEN", "tok-1");
      throw new Error("injected token failure");
    })).toThrow("injected token failure");

    expect(store.current()).toEqual(recovery);
    expect(fixture.state().tokenRows).toEqual([]);
  });
});
