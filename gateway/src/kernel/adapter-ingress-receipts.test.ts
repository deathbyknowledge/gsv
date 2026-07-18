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
  provider_delivery_id: string | null;
  state: "in_progress" | "completed";
  result_json: string | null;
  progress_json: string | null;
  claim_token: string;
  claimed_at: number;
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
    if (normalized.startsWith("SELECT receipt_id,")) {
      if (normalized.includes("WHERE receipt_id = ?")) {
        const row = [...rows.values()].find(
          (candidate) => candidate.receipt_id === bindings[0],
        );
        return cursor((row ? [row] : []) as T[]);
      }
      const matches = [...rows.values()].filter((candidate) =>
        candidate.provider_delivery_id === null
        && candidate.adapter === bindings[0]
        && candidate.account_id === bindings[1]
        && candidate.surface_kind === bindings[2]
        && candidate.surface_id === bindings[3]
        && candidate.thread_id === bindings[4]
        && candidate.provider_message_id === bindings[5]
      ).sort((left, right) =>
        Number(right.actor_id === bindings[6])
        - Number(left.actor_id === bindings[6])
      ).slice(0, 2);
      return cursor(matches as T[]);
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
        providerDeliveryId,
        claimToken,
        claimedAt,
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
        string,
        string,
        number,
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
        provider_delivery_id: providerDeliveryId,
        state: "in_progress",
        result_json: null,
        progress_json: null,
        claim_token: claimToken,
        claimed_at: claimedAt,
        created_at: createdAt,
        completed_at: null,
      });
      return cursor<T>([], 1);
    }
    if (normalized.includes("SET result_json = ?")) {
      const [resultJson, receiptId, claimToken] = bindings as [string, string, string];
      const row = [...rows.values()].find((candidate) => candidate.receipt_id === receiptId);
      if (!row || row.state !== "in_progress" || row.claim_token !== claimToken) {
        return cursor<T>();
      }
      row.result_json = resultJson;
      return cursor<T>([], 1);
    }
    if (normalized.includes("SET progress_json = ?")) {
      const [progressJson, receiptId, claimToken] = bindings as [string, string, string];
      const row = [...rows.values()].find((candidate) => candidate.receipt_id === receiptId);
      if (!row || row.state !== "in_progress" || row.claim_token !== claimToken) {
        return cursor<T>();
      }
      row.progress_json = progressJson;
      return cursor<T>([], 1);
    }
    if (normalized.includes("SET state = 'completed'")) {
      const [completedAt, receiptId, claimToken] = bindings as [number, string, string];
      const row = [...rows.values()].find((candidate) => candidate.receipt_id === receiptId);
      if (
        !row
        || row.state !== "in_progress"
        || row.claim_token !== claimToken
        || row.result_json === null
      ) {
        return cursor<T>();
      }
      row.state = "completed";
      row.completed_at = completedAt;
      return cursor<T>([], 1);
    }
    if (normalized.includes("SET claimed_at = 0")) {
      const [receiptId, claimToken] = bindings as [string, string];
      const row = [...rows.values()].find((candidate) => candidate.receipt_id === receiptId);
      if (!row || row.state !== "in_progress" || row.claim_token !== claimToken) {
        return cursor<T>();
      }
      row.claimed_at = 0;
      return cursor<T>([], 1);
    }
    if (normalized.includes("SET claim_token = ?, claimed_at = ?")) {
      const [nextClaimToken, claimedAt, receiptId, previousClaimToken] = bindings as [
        string,
        number,
        string,
        string,
      ];
      const row = [...rows.values()].find((candidate) => candidate.receipt_id === receiptId);
      if (!row || row.state !== "in_progress" || row.claim_token !== previousClaimToken) {
        return cursor<T>();
      }
      row.claim_token = nextClaimToken;
      row.claimed_at = claimedAt;
      return cursor<T>([], 1);
    }
    if (normalized.startsWith("DELETE FROM adapter_ingress_receipts")) {
      let deleted = 0;
      if (normalized.includes("completed_at < ?")) {
        const [completedCutoff, claimedCutoff] = bindings as [number, number];
        for (const [rowKey, row] of rows) {
          if (
            (row.state === "completed" && (row.completed_at ?? 0) < completedCutoff)
            || (row.state === "in_progress" && row.claimed_at < claimedCutoff)
          ) {
            rows.delete(rowKey);
            deleted++;
          }
        }
      } else {
        const [limit] = bindings as [number];
        const completed = [...rows.entries()]
          .filter(([, row]) => row.state === "completed")
          .sort(([, left], [, right]) => (right.completed_at ?? 0) - (left.completed_at ?? 0));
        for (const [rowKey] of completed.slice(limit)) {
          rows.delete(rowKey);
          deleted++;
        }
      }
      return cursor<T>([], deleted);
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
  providerDeliveryId: "provider-message-1",
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

    const claim = store.claim({ ...BASE_KEY, receiptId: "receipt-1" });
    expect(claim).toMatchObject({
      state: "claimed",
      receiptId: "receipt-1",
    });
    expect(store.claim({ ...BASE_KEY, receiptId: "receipt-1" })).toEqual({
      state: "in_progress",
      receiptId: "receipt-1",
    });

    if (claim.state !== "claimed") throw new Error("receipt was not claimed");
    store.prepare("receipt-1", claim.claimToken, {
      ok: true,
      reply: {
        deliveryId: "reply-1",
        text: "done",
      },
      replayed: "completed",
    });
    store.complete("receipt-1", claim.claimToken);
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

  it("keeps a stable delivery receipt across actor aliases", () => {
    const sql = createMockSql();
    const store = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);

    const original = store.claim({
      ...BASE_KEY,
      threadId: "thread-a",
      receiptId: "receipt-a",
    });
    expect(original.state).toBe("claimed");
    if (original.state !== "claimed") throw new Error("receipt was not claimed");
    store.prepare(original.receiptId, original.claimToken, { ok: true });
    store.complete(original.receiptId, original.claimToken);
    expect(store.claim({
      ...BASE_KEY,
      actorId: "telegram:user:2",
      threadId: "thread-a",
      receiptId: "receipt-a",
    })).toEqual({
      state: "completed",
      receiptId: "receipt-a",
      result: { ok: true },
    });
    expect(sql.rows.size).toBe(1);
  });

  it("reclaims one unambiguous legacy receipt across actor aliases", () => {
    const sql = createMockSql();
    const store = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const original = store.claim({ ...BASE_KEY, receiptId: "legacy-receipt" });
    if (original.state !== "claimed") throw new Error("receipt was not claimed");
    store.prepare(original.receiptId, original.claimToken, { ok: true });
    store.complete(original.receiptId, original.claimToken);
    const row = [...sql.rows.values()][0];
    if (!row) throw new Error("receipt was not inserted");
    row.provider_delivery_id = null;

    expect(store.claim({
      ...BASE_KEY,
      actorId: "telegram:user:alias",
      providerDeliveryId: "stable-delivery-id",
      receiptId: "stable-receipt",
    })).toEqual({
      state: "completed",
      receiptId: "legacy-receipt",
      result: { ok: true },
    });
  });

  it("does not collapse ambiguous legacy receipts across actors", () => {
    const sql = createMockSql();
    const store = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const first = store.claim({
      ...BASE_KEY,
      providerDeliveryId: "old-delivery-a",
      receiptId: "old-receipt-a",
    });
    const second = store.claim({
      ...BASE_KEY,
      actorId: "telegram:user:2",
      providerDeliveryId: "old-delivery-b",
      receiptId: "old-receipt-b",
    });
    const third = store.claim({
      ...BASE_KEY,
      actorId: "telegram:user:3",
      providerDeliveryId: "old-delivery-c",
      receiptId: "old-receipt-c",
    });
    expect(first.state).toBe("claimed");
    expect(second.state).toBe("claimed");
    expect(third.state).toBe("claimed");
    for (const row of sql.rows.values()) {
      row.provider_delivery_id = null;
    }

    expect(store.claim({
      ...BASE_KEY,
      actorId: "telegram:user:2",
      providerDeliveryId: "stable-delivery-b",
      receiptId: "stable-receipt-b",
    })).toEqual({ state: "in_progress", receiptId: "old-receipt-b" });
    expect(store.claim({
      ...BASE_KEY,
      actorId: "telegram:user:4",
      providerDeliveryId: "stable-delivery-d",
      receiptId: "stable-receipt-d",
    })).toEqual({
      state: "ambiguous",
      receiptId: "stable-receipt-d",
      error: "Legacy adapter ingress identity is ambiguous",
    });
    expect(sql.rows.size).toBe(3);
  });

  it("rejects completion without an owned in-progress claim", () => {
    const store = new AdapterIngressReceiptStore(
      createMockSql() as unknown as SqlStorage,
    );

    expect(() => store.complete("missing", "missing-token"))
      .toThrow("is not owned");
  });

  it("reclaims an unfinished receipt immediately after a Kernel restart", () => {
    const sql = createMockSql();
    const firstStore = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const first = firstStore.claim({ ...BASE_KEY, receiptId: "receipt-restart" });
    if (first.state !== "claimed") throw new Error("receipt was not claimed");

    const restartedStore = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const reclaimed = restartedStore.claim({ ...BASE_KEY, receiptId: "receipt-restart" });

    expect(reclaimed).toMatchObject({ state: "claimed", receiptId: "receipt-restart" });
    if (reclaimed.state !== "claimed") throw new Error("receipt was not reclaimed");
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
    expect(() => firstStore.prepare("receipt-restart", first.claimToken, { ok: true }))
      .toThrow("is not owned");

    restartedStore.prepare(reclaimed.receiptId, reclaimed.claimToken, { ok: true });
    restartedStore.complete(reclaimed.receiptId, reclaimed.claimToken);
    expect(restartedStore.claim({ ...BASE_KEY, receiptId: "receipt-restart" }))
      .toMatchObject({ state: "completed", result: { ok: true } });
  });

  it("restores a durable side-effect checkpoint when reclaiming", () => {
    const sql = createMockSql();
    const firstStore = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const first = firstStore.claim({ ...BASE_KEY, receiptId: "receipt-progress" });
    if (first.state !== "claimed") throw new Error("receipt was not claimed");
    firstStore.checkpoint("receipt-progress", first.claimToken, {
      kind: "process_delivery",
      runId: "run-stable",
    });

    const restartedStore = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    expect(restartedStore.claim({ ...BASE_KEY, receiptId: "receipt-progress" })).toMatchObject({
      state: "claimed",
      recovery: { kind: "process_delivery", runId: "run-stable" },
    });
  });

  it("reclaims a prepared result without repeating its side effects", () => {
    const sql = createMockSql();
    const firstStore = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const first = firstStore.claim({ ...BASE_KEY, receiptId: "receipt-prepared" });
    if (first.state !== "claimed") throw new Error("receipt was not claimed");
    firstStore.prepare("receipt-prepared", first.claimToken, {
      ok: true,
      reply: { deliveryId: "reply-stable", text: "done" },
    });

    const restartedStore = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const reclaimed = restartedStore.claim({ ...BASE_KEY, receiptId: "receipt-prepared" });
    expect(reclaimed).toMatchObject({
      state: "prepared",
      receiptId: "receipt-prepared",
      result: {
        ok: true,
        reply: { deliveryId: "reply-stable", text: "done" },
      },
    });
    if (reclaimed.state !== "prepared") throw new Error("result was not prepared");
    restartedStore.complete(reclaimed.receiptId, reclaimed.claimToken);
    expect(restartedStore.claim({ ...BASE_KEY, receiptId: "receipt-prepared" })).toMatchObject({
      state: "completed",
      result: { ok: true },
    });
  });

  it("rejects a completed immediate reply without its delivery id", () => {
    const sql = createMockSql();
    const store = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const claim = store.claim({ ...BASE_KEY, receiptId: "receipt-invalid" });
    if (claim.state !== "claimed") throw new Error("receipt was not claimed");
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

  it("prunes receipts after the bounded replay-retention window", () => {
    const sql = createMockSql();
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    const store = new AdapterIngressReceiptStore(sql as unknown as SqlStorage);
    const claim = store.claim({ ...BASE_KEY, receiptId: "receipt-old" });
    if (claim.state !== "claimed") throw new Error("receipt was not claimed");
    store.prepare(claim.receiptId, claim.claimToken, { ok: true });
    store.complete(claim.receiptId, claim.claimToken);

    now.mockReturnValue(8 * 24 * 60 * 60 * 1000);
    store.claim({
      ...BASE_KEY,
      providerMessageId: "provider-message-new",
      providerDeliveryId: "provider-message-new",
      receiptId: "receipt-new",
    });

    expect([...sql.rows.values()].map((row) => row.receipt_id)).toEqual(["receipt-new"]);
  });
});
