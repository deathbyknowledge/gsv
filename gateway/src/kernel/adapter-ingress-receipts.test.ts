import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSqlRows, type MockSqlRow } from "../test-support/mock-sql";
import { AdapterIngressReceiptStore } from "./adapter-ingress-receipts";

type ReceiptRow = {
  receipt_id: string;
  adapter: string;
  account_id: string;
  actor_id: string;
  surface_kind: string;
  surface_id: string;
  thread_id: string;
  provider_message_id: string;
  state: "in_progress" | "completed";
  result_json: string | null;
  created_at: number;
  completed_at: number | null;
};

function createMockSql() {
  const rows = new Map<string, ReceiptRow>();
  const key = (values: readonly unknown[]) => values.join("\0");

  function cursor<T>(items: T[] = [], rowsWritten = 0) {
    return Object.assign(mockSqlRows(items), { rowsWritten });
  }

  function exec<T = MockSqlRow>(query: string, ...bindings: unknown[]) {
    const normalized = query.trim();
    if (normalized.startsWith("SELECT receipt_id, state, result_json")) {
      const row = rows.get(key(bindings));
      return cursor((row ? [row] : []) as T[]);
    }
    if (normalized.startsWith("INSERT INTO adapter_ingress_receipts")) {
      const [
        receiptId,
        adapter,
        accountId,
        actorId,
        surfaceKind,
        surfaceId,
        threadId,
        providerMessageId,
        createdAt,
      ] = bindings as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
      ];
      rows.set(key([
        adapter,
        accountId,
        actorId,
        surfaceKind,
        surfaceId,
        threadId,
        providerMessageId,
      ]), {
        receipt_id: receiptId,
        adapter,
        account_id: accountId,
        actor_id: actorId,
        surface_kind: surfaceKind,
        surface_id: surfaceId,
        thread_id: threadId,
        provider_message_id: providerMessageId,
        state: "in_progress",
        result_json: null,
        created_at: createdAt,
        completed_at: null,
      });
      return cursor<T>([], 1);
    }
    if (normalized.startsWith("UPDATE adapter_ingress_receipts")) {
      const [resultJson, completedAt, receiptId] = bindings as [string, number, string];
      const row = [...rows.values()].find((candidate) => candidate.receipt_id === receiptId);
      if (!row || row.state !== "in_progress") return cursor<T>();
      row.state = "completed";
      row.result_json = resultJson;
      row.completed_at = completedAt;
      return cursor<T>([], 1);
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }

  return { exec, rows };
}

const BASE_KEY = {
  adapter: "telegram",
  accountId: "bot",
  actorId: "telegram:user:1",
  surfaceKind: "dm" as const,
  surfaceId: "chat-1",
  providerMessageId: "provider-message-1",
};

describe("AdapterIngressReceiptStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists an in-progress claim and the completed disposition", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new AdapterIngressReceiptStore(
      createMockSql() as unknown as SqlStorage,
    );

    expect(store.claim({ ...BASE_KEY, receiptId: "receipt-1" })).toEqual({
      state: "claimed",
      receiptId: "receipt-1",
    });
    expect(store.claim({ ...BASE_KEY, receiptId: "receipt-1" })).toEqual({
      state: "in_progress",
      receiptId: "receipt-1",
    });

    store.complete("receipt-1", {
      ok: true,
      reply: {
        deliveryId: "reply-1",
        text: "done",
      },
      replayed: "completed",
    });
    expect(store.claim({ ...BASE_KEY, receiptId: "receipt-1" })).toEqual({
      state: "completed",
      receiptId: "receipt-1",
      result: {
        ok: true,
        reply: {
          deliveryId: "reply-1",
          text: "done",
        },
      },
    });
  });

  it("keys receipts by the actor and exact surface thread", () => {
    const sql = createMockSql();
    const store = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);

    expect(store.claim({
      ...BASE_KEY,
      threadId: "thread-a",
      receiptId: "receipt-a",
    }).state)
      .toBe("claimed");
    expect(store.claim({
      ...BASE_KEY,
      threadId: "thread-b",
      receiptId: "receipt-b",
    }).state)
      .toBe("claimed");
    expect(store.claim({
      ...BASE_KEY,
      actorId: "telegram:user:2",
      threadId: "thread-a",
      receiptId: "receipt-c",
    }).state).toBe("claimed");
    expect(sql.rows.size).toBe(3);
  });

  it("rejects completion without an owned in-progress claim", () => {
    const store = new AdapterIngressReceiptStore(
      createMockSql() as unknown as SqlStorage,
    );

    expect(() => store.complete("missing", { ok: false, error: "missing" }))
      .toThrow("is not claimable");
  });

  it("rejects a completed immediate reply without its delivery id", () => {
    const sql = createMockSql();
    const store = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    store.claim({ ...BASE_KEY, receiptId: "receipt-invalid" });
    const row = [...sql.rows.values()][0];
    if (!row) throw new Error("receipt was not inserted");
    row.state = "completed";
    row.result_json = JSON.stringify({
      ok: true,
      reply: { text: "legacy reply" },
    });

    expect(() => store.claim({ ...BASE_KEY, receiptId: "receipt-invalid" }))
      .toThrow("Invalid adapter ingress receipt result");
  });
});
