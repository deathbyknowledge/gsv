import { describe, expect, it, vi } from "vitest";
import { sendFrameToProcess } from "../shared/utils";
import type { KernelContext } from "./context";
import { handleSqlExec, handleSqlQuery } from "./sql";

type CursorRow = Record<string, SqlStorageValue>;

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

function createCursor<T extends CursorRow>(
  rows: T[],
  options?: {
    columns?: string[];
    rowsRead?: number;
    rowsWritten?: number;
  },
) {
  return {
    toArray: () => rows,
    columnNames: options?.columns ?? Object.keys(rows[0] ?? {}),
    rowsRead: options?.rowsRead ?? rows.length,
    rowsWritten: options?.rowsWritten ?? 0,
  };
}

function makeContext(uid: number, sql: { exec: ReturnType<typeof vi.fn> }): KernelContext {
  return {
    env: {} as Env,
    sql: sql as unknown as SqlStorage,
    auth: {} as KernelContext["auth"],
    caps: {} as KernelContext["caps"],
    config: {} as KernelContext["config"],
    devices: {} as KernelContext["devices"],
    procs: {
      get: vi.fn((pid: string) => ({
        processId: pid,
        uid,
      })),
    } as unknown as KernelContext["procs"],
    workspaces: {} as KernelContext["workspaces"],
    adapters: {} as KernelContext["adapters"],
    runRoutes: {} as KernelContext["runRoutes"],
    connection: {} as KernelContext["connection"],
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : "sam",
        home: uid === 0 ? "/root" : "/home/sam",
        cwd: uid === 0 ? "/root" : "/home/sam",
        workspaceId: null,
      },
      capabilities: uid === 0 ? ["*"] : ["proc.*"],
    },
    serverVersion: "test",
  };
}

describe("operator sql handlers", () => {
  it("forwards process-target sql.query to the target Process DO", async () => {
    const sql = { exec: vi.fn() };
    vi.mocked(sendFrameToProcess).mockResolvedValueOnce({
      type: "res",
      id: crypto.randomUUID(),
      ok: true,
      data: {
        ok: true,
        target: "process:task:123",
        columns: ["cnt"],
        rows: [{ cnt: 1 }],
        rowCount: 1,
        rowsRead: 1,
        rowsWritten: 0,
      },
    });

    const result = await handleSqlQuery(
      {
        target: "process:task:123",
        statement: "SELECT COUNT(*) as cnt FROM messages",
      },
      makeContext(0, sql),
    );

    expect(sql.exec).not.toHaveBeenCalled();
    expect(sendFrameToProcess).toHaveBeenCalledWith(
      "task:123",
      expect.objectContaining({
        type: "req",
        call: "sql.query",
        args: {
          target: "process:task:123",
          statement: "SELECT COUNT(*) as cnt FROM messages",
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      target: "process:task:123",
      columns: ["cnt"],
      rows: [{ cnt: 1 }],
      rowCount: 1,
      rowsRead: 1,
      rowsWritten: 0,
    });
  });

  it("returns structured rows for sql.query against kernel", async () => {
    const sql = {
      exec: vi.fn(() =>
        createCursor(
          [{ process_id: "mcp:123", profile: "mcp", uid: 0 }],
          {
            columns: ["process_id", "profile", "uid"],
            rowsRead: 1,
          },
        ),
      ),
    };

    const result = await handleSqlQuery(
      {
        target: "kernel",
        statement: "SELECT process_id, profile, uid FROM processes WHERE uid = ?",
        bindings: [0],
      },
      makeContext(0, sql),
    );

    expect(sql.exec).toHaveBeenCalledWith(
      "SELECT process_id, profile, uid FROM processes WHERE uid = ?",
      0,
    );
    expect(result).toEqual({
      ok: true,
      target: "kernel",
      columns: ["process_id", "profile", "uid"],
      rows: [{ process_id: "mcp:123", profile: "mcp", uid: 0 }],
      rowCount: 1,
      rowsRead: 1,
      rowsWritten: 0,
    });
  });

  it("defaults sql.query to the kernel target when target is omitted", async () => {
    const sql = {
      exec: vi.fn(() =>
        createCursor([{ cnt: 1 }], {
          columns: ["cnt"],
          rowsRead: 1,
        }),
      ),
    };

    const result = await handleSqlQuery(
      {
        statement: "SELECT COUNT(*) as cnt FROM processes",
      },
      makeContext(0, sql),
    );

    expect(result).toMatchObject({
      ok: true,
      target: "kernel",
      columns: ["cnt"],
      rows: [{ cnt: 1 }],
    });
  });

  it("rejects sql.query for non-root callers", async () => {
    const sql = { exec: vi.fn() };

    await expect(
      handleSqlQuery(
        { statement: "SELECT 1" },
        makeContext(1000, sql),
      ),
    ).rejects.toThrow("Permission denied: sql.query requires root");
    expect(sql.exec).not.toHaveBeenCalled();
  });

  it("rejects mutation verbs on sql.query before execution", async () => {
    const sql = { exec: vi.fn() };

    await expect(
      handleSqlQuery(
        { target: "kernel", statement: "UPDATE processes SET state = 'paused'" },
        makeContext(0, sql),
      ),
    ).rejects.toThrow("sql.query only accepts read statements");
    expect(sql.exec).not.toHaveBeenCalled();
  });

  it("returns structured mutation metadata for sql.exec", async () => {
    const sql = {
      exec: vi.fn(() =>
        createCursor([], {
          columns: [],
          rowsRead: 0,
          rowsWritten: 2,
        }),
      ),
    };

    const result = await handleSqlExec(
      {
        target: "kernel",
        statement: "UPDATE processes SET state = ? WHERE profile = ?",
        bindings: ["paused", "task"],
      },
      makeContext(0, sql),
    );

    expect(result).toEqual({
      ok: true,
      target: "kernel",
      rowsRead: 0,
      rowsWritten: 2,
    });
  });

  it("rejects process targets when the pid does not exist", async () => {
    const sql = { exec: vi.fn() };
    const ctx = makeContext(0, sql);
    (ctx.procs as { get: ReturnType<typeof vi.fn> }).get.mockReturnValueOnce(null);

    await expect(
      handleSqlQuery(
        { target: "process:task:123", statement: "SELECT 1" },
        ctx,
      ),
    ).rejects.toThrow("Process not found: task:123");
    expect(sql.exec).not.toHaveBeenCalled();
  });
});
