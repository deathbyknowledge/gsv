import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellSessionStore } from "./shell-sessions";

type Row = Record<string, unknown>;

function createMockSql() {
  const table = new Map<string, Row>();

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (q.startsWith("CREATE TABLE IF NOT EXISTS") || q.startsWith("CREATE INDEX IF NOT EXISTS")) {
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT OR REPLACE INTO shell_sessions")) {
      const [
        sessionId,
        deviceId,
        status,
        exitCode,
        error,
        createdAt,
        updatedAt,
        expiresAt,
      ] = bindings as [string, string, string, number | null, string | null, number, number, number | null];
      table.set(sessionId, {
        session_id: sessionId,
        device_id: deviceId,
        status,
        exit_code: exitCode,
        error,
        created_at: createdAt,
        updated_at: updatedAt,
        expires_at: expiresAt,
      });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT * FROM shell_sessions WHERE session_id = ?")) {
      const [sessionId] = bindings as [string];
      const row = table.get(sessionId);
      return { toArray: () => (row ? [row] : []) as T[] };
    }

    if (q.startsWith("UPDATE shell_sessions")) {
      const [statusOrError, exitCodeOrUpdatedAt, errorOrDeviceId, updatedAt, maybeSessionId] = bindings;
      if (typeof maybeSessionId === "string") {
        const row = table.get(maybeSessionId);
        if (row) {
          row.status = statusOrError;
          row.exit_code = exitCodeOrUpdatedAt;
          row.error = errorOrDeviceId;
          row.updated_at = updatedAt;
        }
      } else {
        const deviceId = errorOrDeviceId;
        for (const row of table.values()) {
          if (row.device_id === deviceId && row.status === "running") {
            row.status = "failed";
            row.error = statusOrError;
            row.updated_at = exitCodeOrUpdatedAt;
          }
        }
      }
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("DELETE FROM shell_sessions WHERE session_id = ?")) {
      const [sessionId] = bindings as [string];
      table.delete(sessionId);
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("DELETE FROM shell_sessions WHERE expires_at")) {
      const [now] = bindings as [number];
      for (const [sessionId, row] of table.entries()) {
        if (typeof row.expires_at === "number" && row.expires_at <= now) {
          table.delete(sessionId);
        }
      }
      return { toArray: () => [] as T[] };
    }

    return { toArray: () => [] as T[] };
  }

  return { exec };
}

describe("ShellSessionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remembers the owning device for a running session", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new ShellSessionStore(createMockSql() as unknown as SqlStorage);
    store.init();

    store.rememberDeviceSession("sh_1", "macbook");

    expect(store.get("sh_1")).toMatchObject({
      sessionId: "sh_1",
      deviceId: "macbook",
      status: "running",
    });
  });

  it("rejects expired sessions during lookup", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new ShellSessionStore(createMockSql() as unknown as SqlStorage);
    store.init();
    store.rememberDeviceSession("sh_1", "macbook", "running", { ttlMs: 10 });

    now.mockReturnValue(1_010);

    expect(store.get("sh_1")).toBeNull();
    expect(store.get("sh_1")).toBeNull();
  });

  it("marks active sessions failed when a device disconnects", () => {
    const store = new ShellSessionStore(createMockSql() as unknown as SqlStorage);
    store.init();
    store.rememberDeviceSession("sh_1", "macbook");

    store.failForDevice("macbook", "Device disconnected");

    expect(store.get("sh_1")).toMatchObject({
      status: "failed",
      error: "Device disconnected",
    });
  });
});
