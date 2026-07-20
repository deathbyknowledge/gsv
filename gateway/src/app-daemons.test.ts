import { describe, expect, it } from "vitest";
import {
  AppRpcScheduleStore,
  computeInitialNextRunAt,
  computeRecurringNextRunAt,
  type AppRpcScheduleAuthority,
} from "./app-daemons";
import {
  handleMockSchemaStatement,
  mockSqlRows,
  type MockSqlRow,
} from "./test-support/mock-sql";

function createMockSql() {
  const table = new Map<string, MockSqlRow>();

  function sortRecords(records: MockSqlRow[]): MockSqlRow[] {
    return [...records].sort((left, right) => {
      const leftNext = typeof left.next_run_at === "number" ? left.next_run_at : Number.MAX_SAFE_INTEGER;
      const rightNext = typeof right.next_run_at === "number" ? right.next_run_at : Number.MAX_SAFE_INTEGER;
      if (leftNext !== rightNext) {
        return leftNext - rightNext;
      }
      return String(left.schedule_key).localeCompare(String(right.schedule_key));
    });
  }

  function exec<T = MockSqlRow>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    const schemaResult = handleMockSchemaStatement<T>(q);
    if (schemaResult) return schemaResult;

    if (q.startsWith("SELECT * FROM app_rpc_schedules WHERE schedule_key = ?")) {
      const [key, authorityKey] = bindings as [string, string];
      const candidate = table.get(key);
      const row = candidate?.authority_key === authorityKey ? candidate : undefined;
      return mockSqlRows((row ? [row] : []) as T[]);
    }

    if (q.startsWith("SELECT * FROM app_rpc_schedules\n       WHERE authority_key = ?")) {
      const [authorityKey] = bindings as [string];
      return mockSqlRows(sortRecords(
        [...table.values()].filter((row) => row.authority_key === authorityKey),
      ) as T[]);
    }

    if (q.startsWith("INSERT OR REPLACE INTO app_rpc_schedules")) {
      const [
        schedule_key,
        logical_key,
        authority_key,
        owner_uid,
        owner_username,
        kernel_username,
        kernel_generation,
        package_id,
        package_name,
        package_updated_at,
        artifact_hash,
        entrypoint_name,
        route_base,
        runtime_authority_json,
        rpc_method,
        schedule_json,
        payload_json,
        enabled,
        version,
        created_at,
        updated_at,
        next_run_at,
        running_at,
        last_run_at,
        last_status,
        last_error,
        last_duration_ms,
      ] = bindings as [
        string,
        string,
        string,
        number,
        string,
        string,
        number,
        string,
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        number,
        number,
        number,
        number,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        number | null,
      ];
      table.set(schedule_key, {
        schedule_key,
        logical_key,
        authority_key,
        owner_uid,
        owner_username,
        kernel_username,
        kernel_generation,
        package_id,
        package_name,
        package_updated_at,
        artifact_hash,
        entrypoint_name,
        route_base,
        runtime_authority_json,
        rpc_method,
        schedule_json,
        payload_json,
        enabled,
        version,
        created_at,
        updated_at,
        next_run_at,
        running_at,
        last_run_at,
        last_status,
        last_error,
        last_duration_ms,
      });
      return mockSqlRows<T>();
    }

    if (q.startsWith("DELETE FROM app_rpc_schedules WHERE schedule_key = ?")) {
      const [key, authorityKey] = bindings as [string, string];
      if (table.get(key)?.authority_key === authorityKey) {
        table.delete(key);
      }
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT * FROM app_rpc_schedules\n       WHERE authority_key IS NOT NULL")) {
      const [now] = bindings as [number];
      const matches = sortRecords(
        [...table.values()].filter((row) =>
          row.enabled === 1
          && row.authority_key !== null
          && row.runtime_authority_json !== null
          && typeof row.next_run_at === "number"
          && row.next_run_at <= now),
      );
      return mockSqlRows(matches as T[]);
    }

    if (q.startsWith("SELECT next_run_at FROM app_rpc_schedules\n       WHERE authority_key IS NOT NULL")) {
      const match = sortRecords(
        [...table.values()].filter((row) =>
          row.authority_key !== null
          && row.runtime_authority_json !== null
          && row.enabled === 1
          && typeof row.next_run_at === "number"),
      )[0];
      return mockSqlRows((match ? [{ next_run_at: match.next_run_at }] : []) as T[]);
    }

    if (q === "SELECT * FROM app_rpc_schedules WHERE running_at IS NOT NULL") {
      return mockSqlRows(
        [...table.values()].filter((row) => row.running_at !== null) as T[],
      );
    }

    return mockSqlRows<T>();
  }

  return { exec };
}

function scheduleAuthority(
  patch: Partial<AppRpcScheduleAuthority> = {},
): AppRpcScheduleAuthority {
  return {
    key: "authority:alice:chat:v1:main",
    ownerUid: 1000,
    ownerUsername: "alice",
    kernelUsername: "alice",
    kernelGeneration: 3,
    packageId: "pkg-chat",
    packageName: "chat",
    packageUpdatedAt: 10_000,
    artifactHash: "sha256:chat-v1",
    entrypointName: "main",
    routeBase: "/apps/chat",
    runtime: { packageId: "pkg-chat", revision: 10_000 },
    ...patch,
  };
}

describe("app daemon schedule helpers", () => {
  it("computes recurring schedules relative to anchor", () => {
    expect(computeRecurringNextRunAt({ kind: "every", everyMs: 60_000, anchorMs: 1_000 }, 500)).toBe(1_000);
    expect(computeRecurringNextRunAt({ kind: "every", everyMs: 60_000, anchorMs: 1_000 }, 1_000)).toBe(61_000);
    expect(computeRecurringNextRunAt({ kind: "every", everyMs: 60_000, anchorMs: 1_000 }, 61_001)).toBe(121_000);
  });

  it("computes initial next-run times for after and at schedules", () => {
    expect(computeInitialNextRunAt({ kind: "after", afterMs: 5_000 }, 10_000)).toBe(15_000);
    expect(computeInitialNextRunAt({ kind: "at", atMs: 42_000 }, 10_000)).toBe(42_000);
  });
});

describe("AppRpcScheduleStore", () => {
  it("upserts schedules and surfaces the earliest alarm time", () => {
    const store = new AppRpcScheduleStore(createMockSql() as unknown as SqlStorage);
    const authority = scheduleAuthority();

    const first = store.upsert(authority, {
      key: "curator:personal",
      rpcMethod: "curateInbox",
      schedule: { kind: "after", afterMs: 5_000 },
      payload: { db: "personal" },
    }, 10_000);
    const second = store.upsert(authority, {
      key: "curator:research",
      rpcMethod: "curateInbox",
      schedule: { kind: "after", afterMs: 15_000 },
      payload: { db: "research" },
    }, 10_000);

    expect(first.nextRunAt).toBe(15_000);
    expect(second.nextRunAt).toBe(25_000);
    expect(store.nextAlarmAt()).toBe(15_000);
    expect(store.due(14_999)).toHaveLength(0);
    expect(store.due(15_000).map((record) => record.key)).toEqual(["curator:personal"]);
  });

  it("disables one-shot schedules after they run", () => {
    const store = new AppRpcScheduleStore(createMockSql() as unknown as SqlStorage);
    const authority = scheduleAuthority();

    const created = store.upsert(authority, {
      key: "wiki:once",
      rpcMethod: "curateInbox",
      schedule: { kind: "after", afterMs: 5_000 },
    }, 10_000);
    const running = store.markRunning(authority, created.key, created.version, 15_000);
    expect(running?.runningAt).toBe(15_000);
    expect(running?.nextRunAt).toBeNull();

    const finished = store.finishRun({
      authority,
      key: created.key,
      version: created.version,
      finishedAt: 15_100,
      status: "ok",
      durationMs: 100,
    });

    expect(finished?.enabled).toBe(false);
    expect(finished?.nextRunAt).toBeNull();
    expect(finished?.lastStatus).toBe("ok");
    expect(store.nextAlarmAt()).toBeNull();
  });

  it("preserves a newer reschedule when a running job finishes", () => {
    const store = new AppRpcScheduleStore(createMockSql() as unknown as SqlStorage);
    const authority = scheduleAuthority();

    const original = store.upsert(authority, {
      key: "wiki:loop",
      rpcMethod: "curateInbox",
      schedule: { kind: "every", everyMs: 60_000 },
    }, 10_000);
    store.markRunning(authority, original.key, original.version, 70_000);

    const rescheduled = store.upsert(authority, {
      key: "wiki:loop",
      rpcMethod: "curateInbox",
      schedule: { kind: "after", afterMs: 10_000 },
    }, 70_010);

    const finished = store.finishRun({
      authority,
      key: original.key,
      version: original.version,
      finishedAt: 70_100,
      status: "error",
      error: "temporary failure",
      durationMs: 90,
    });

    expect(finished?.version).toBe(rescheduled.version);
    expect(finished?.schedule).toEqual({ kind: "after", afterMs: 10_000 });
    expect(finished?.nextRunAt).toBe(80_010);
    expect(finished?.lastStatus).toBe("error");
    expect(finished?.lastError).toBe("temporary failure");
  });

  it("isolates the same logical key by immutable runtime authority", () => {
    const store = new AppRpcScheduleStore(createMockSql() as unknown as SqlStorage);
    const oldAuthority = scheduleAuthority();
    const newAuthority = scheduleAuthority({
      key: "authority:alice:chat:v2:admin",
      packageUpdatedAt: 20_000,
      artifactHash: "sha256:chat-v2",
      entrypointName: "admin",
      runtime: { packageId: "pkg-chat", revision: 20_000 },
    });

    const oldSchedule = store.upsert(oldAuthority, {
      key: "refresh",
      rpcMethod: "refresh",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { revision: 1 },
    }, 10_000);
    const newSchedule = store.upsert(newAuthority, {
      key: "refresh",
      rpcMethod: "refresh",
      schedule: { kind: "after", afterMs: 5_000 },
      payload: { revision: 2 },
    }, 20_000);

    expect(oldSchedule.version).toBe(1);
    expect(newSchedule.version).toBe(1);
    expect(store.list(oldAuthority).map((record) => record.payload)).toEqual([{ revision: 1 }]);
    expect(store.list(newAuthority).map((record) => record.payload)).toEqual([{ revision: 2 }]);

    expect(store.remove(newAuthority, "refresh")).toBe(true);
    expect(store.get(newAuthority, "refresh")).toBeNull();
    expect(store.get(oldAuthority, "refresh")?.payload).toEqual({ revision: 1 });
  });

  it("keeps interleaved completions inside their exact authority", () => {
    const store = new AppRpcScheduleStore(createMockSql() as unknown as SqlStorage);
    const firstAuthority = scheduleAuthority();
    const secondAuthority = scheduleAuthority({
      key: "authority:alice:chat:v2:main",
      packageUpdatedAt: 20_000,
      artifactHash: "sha256:chat-v2",
      runtime: { packageId: "pkg-chat", revision: 20_000 },
    });
    const first = store.upsert(firstAuthority, {
      key: "sync",
      rpcMethod: "sync",
      schedule: { kind: "every", everyMs: 60_000 },
    }, 10_000);
    const second = store.upsert(secondAuthority, {
      key: "sync",
      rpcMethod: "sync",
      schedule: { kind: "every", everyMs: 60_000 },
    }, 20_000);

    store.markRunning(firstAuthority, first.key, first.version, 70_000);
    store.markRunning(secondAuthority, second.key, second.version, 80_000);
    store.finishRun({
      authority: secondAuthority,
      key: second.key,
      version: second.version,
      finishedAt: 80_100,
      status: "ok",
      durationMs: 100,
    });
    store.finishRun({
      authority: firstAuthority,
      key: first.key,
      version: first.version,
      finishedAt: 70_200,
      status: "error",
      error: "old runtime failed",
      durationMs: 200,
    });

    expect(store.get(firstAuthority, "sync")?.lastError).toBe("old runtime failed");
    expect(store.get(secondAuthority, "sync")?.lastStatus).toBe("ok");
  });

  it("durably disables interrupted daemon runs after a package fence drains", () => {
    const store = new AppRpcScheduleStore(createMockSql() as unknown as SqlStorage);
    const authority = scheduleAuthority();
    const created = store.upsert(authority, {
      key: "sync",
      rpcMethod: "sync",
      schedule: { kind: "every", everyMs: 60_000 },
    }, 10_000);
    store.markRunning(authority, created.key, created.version, 70_000);

    expect(store.interruptRunning("Package runtime authority was fenced", 70_250)).toBe(1);
    expect(store.get(authority, created.key)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      runningAt: null,
      lastRunAt: 70_250,
      lastStatus: "error",
      lastError: "Package runtime authority was fenced",
      lastDurationMs: 250,
    });
    expect(store.interruptRunning("Package runtime authority was fenced", 70_300)).toBe(0);
  });
});
