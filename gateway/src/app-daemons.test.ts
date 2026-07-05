import { describe, expect, it } from "vitest";
import {
  AppRpcScheduleStore,
  computeInitialNextRunAt,
  computeRecurringNextRunAt,
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
      const [key] = bindings as [string];
      const row = table.get(key);
      return mockSqlRows((row ? [row] : []) as T[]);
    }

    if (q.startsWith("SELECT * FROM app_rpc_schedules ORDER BY")) {
      return mockSqlRows(sortRecords([...table.values()]) as T[]);
    }

    if (q.startsWith("INSERT OR REPLACE INTO app_rpc_schedules")) {
      const [
        schedule_key,
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
      const [key] = bindings as [string];
      table.delete(key);
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT * FROM app_rpc_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")) {
      const [now] = bindings as [number];
      const matches = sortRecords(
        [...table.values()].filter((row) =>
          row.enabled === 1
          && typeof row.next_run_at === "number"
          && row.next_run_at <= now),
      );
      return mockSqlRows(matches as T[]);
    }

    if (q.startsWith("SELECT next_run_at FROM app_rpc_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL")) {
      const match = sortRecords(
        [...table.values()].filter((row) => row.enabled === 1 && typeof row.next_run_at === "number"),
      )[0];
      return mockSqlRows((match ? [{ next_run_at: match.next_run_at }] : []) as T[]);
    }

    return mockSqlRows<T>();
  }

  return { exec };
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

    const first = store.upsert({
      key: "curator:personal",
      rpcMethod: "curateInbox",
      schedule: { kind: "after", afterMs: 5_000 },
      payload: { db: "personal" },
    }, 10_000);
    const second = store.upsert({
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

    const created = store.upsert({
      key: "wiki:once",
      rpcMethod: "curateInbox",
      schedule: { kind: "after", afterMs: 5_000 },
    }, 10_000);
    const running = store.markRunning(created.key, created.version, 15_000);
    expect(running?.runningAt).toBe(15_000);
    expect(running?.nextRunAt).toBeNull();

    const finished = store.finishRun({
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

    const original = store.upsert({
      key: "wiki:loop",
      rpcMethod: "curateInbox",
      schedule: { kind: "every", everyMs: 60_000 },
    }, 10_000);
    store.markRunning(original.key, original.version, 70_000);

    const rescheduled = store.upsert({
      key: "wiki:loop",
      rpcMethod: "curateInbox",
      schedule: { kind: "after", afterMs: 10_000 },
    }, 70_010);

    const finished = store.finishRun({
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
});
