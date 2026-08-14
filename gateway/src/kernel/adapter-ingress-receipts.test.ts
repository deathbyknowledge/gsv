import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AdapterIngressReceiptStore } from "./adapter-ingress-receipts";
import { PrivateAdapterDestinationStore } from "./private-adapter-destinations";

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

  it("persists an in-progress claim and the completed disposition", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new AdapterIngressReceiptStore(sql);

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
  });

  it("keeps a stable delivery receipt across actor aliases", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterIngressReceiptStore(sql);

      const original = store.claim({
        ...BASE_KEY,
        threadId: "thread-a",
        receiptId: "receipt-a",
      });
      expect(original.state).toBe("claimed");
      if (original.state !== "claimed")
        throw new Error("receipt was not claimed");
      store.prepare(original.receiptId, original.claimToken, { ok: true });
      store.complete(original.receiptId, original.claimToken);
      expect(
        store.claim({
          ...BASE_KEY,
          actorId: "telegram:user:2",
          threadId: "thread-a",
          receiptId: "receipt-a",
        }),
      ).toEqual({
        state: "completed",
        receiptId: "receipt-a",
        result: { ok: true },
      });
      expect(
        sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM adapter_ingress_receipts",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("fences an older DM message after a later receipt regardless of provider time", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterIngressReceiptStore(sql);
      const privateDestinations = new PrivateAdapterDestinationStore(sql);
      const destination = {
        kind: "adapter" as const,
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:1",
        surface: { kind: "dm" as const, id: "chat-1" },
      };
      store.claim({ ...BASE_KEY, receiptId: "receipt-original" });
      privateDestinations.recordActivity(1000, destination, "provider-message-1", 200);

      expect(store.isLatestPrivateMessage(destination, "provider-message-1")).toBe(true);

      store.claim({
        ...BASE_KEY,
        actorId: "telegram:user:alias",
        providerMessageId: "provider-home-older-timestamp",
        providerDeliveryId: "provider-home-older-timestamp",
        receiptId: "receipt-home",
      });
      privateDestinations.recordActivity(
        1000,
        destination,
        "provider-home-older-timestamp",
        100,
      );

      expect(privateDestinations.get(1000)?.messageId).toBe("provider-message-1");
      expect(store.isLatestPrivateMessage(destination, "provider-message-1")).toBe(false);
      expect(store.isLatestPrivateMessage(destination, "provider-home-older-timestamp")).toBe(true);
    });
  });

  it("reclaims one unambiguous legacy receipt across actor aliases", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterIngressReceiptStore(sql);
      const original = store.claim({
        ...BASE_KEY,
        receiptId: "legacy-receipt",
      });
      if (original.state !== "claimed")
        throw new Error("receipt was not claimed");
      store.prepare(original.receiptId, original.claimToken, { ok: true });
      store.complete(original.receiptId, original.claimToken);
      sql.exec(
        `UPDATE adapter_ingress_receipts
            SET provider_delivery_id = NULL
          WHERE receipt_id = ?`,
        original.receiptId,
      );

      expect(
        store.claim({
          ...BASE_KEY,
          actorId: "telegram:user:alias",
          providerDeliveryId: "stable-delivery-id",
          receiptId: "stable-receipt",
        }),
      ).toEqual({
        state: "completed",
        receiptId: "legacy-receipt",
        result: { ok: true },
      });
    });
  });

  it("does not collapse ambiguous legacy receipts across actors", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterIngressReceiptStore(sql);
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
      sql.exec(
        "UPDATE adapter_ingress_receipts SET provider_delivery_id = NULL",
      );

      expect(
        store.claim({
          ...BASE_KEY,
          actorId: "telegram:user:2",
          providerDeliveryId: "stable-delivery-b",
          receiptId: "stable-receipt-b",
        }),
      ).toEqual({ state: "in_progress", receiptId: "old-receipt-b" });
      expect(
        store.claim({
          ...BASE_KEY,
          actorId: "telegram:user:4",
          providerDeliveryId: "stable-delivery-d",
          receiptId: "stable-receipt-d",
        }),
      ).toEqual({
        state: "ambiguous",
        receiptId: "stable-receipt-d",
        error: "Legacy adapter ingress identity is ambiguous",
      });
      expect(
        sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM adapter_ingress_receipts",
          )
          .one().count,
      ).toBe(3);
    });
  });

  it("rejects completion without an owned in-progress claim", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterIngressReceiptStore(sql);

      expect(() => store.complete("missing", "missing-token")).toThrow(
        "is not owned",
      );
    });
  });

  it("reclaims an unfinished receipt immediately after a Kernel restart", async () => {
    await runWithRealKernelSql((sql) => {
      const firstStore = new AdapterIngressReceiptStore(sql);
      const first = firstStore.claim({
        ...BASE_KEY,
        receiptId: "receipt-restart",
      });
      if (first.state !== "claimed") throw new Error("receipt was not claimed");

      const restartedStore = new AdapterIngressReceiptStore(sql);
      const reclaimed = restartedStore.claim({
        ...BASE_KEY,
        receiptId: "receipt-restart",
      });

      expect(reclaimed).toMatchObject({
        state: "claimed",
        receiptId: "receipt-restart",
      });
      if (reclaimed.state !== "claimed")
        throw new Error("receipt was not reclaimed");
      expect(reclaimed.claimToken).not.toBe(first.claimToken);
      expect(() =>
        firstStore.prepare("receipt-restart", first.claimToken, { ok: true }),
      ).toThrow("is not owned");

      restartedStore.prepare(reclaimed.receiptId, reclaimed.claimToken, {
        ok: true,
      });
      restartedStore.complete(reclaimed.receiptId, reclaimed.claimToken);
      expect(
        restartedStore.claim({ ...BASE_KEY, receiptId: "receipt-restart" }),
      ).toMatchObject({ state: "completed", result: { ok: true } });
    });
  });

  it("restores a durable side-effect checkpoint when reclaiming", async () => {
    await runWithRealKernelSql((sql) => {
      const firstStore = new AdapterIngressReceiptStore(sql);
      const first = firstStore.claim({
        ...BASE_KEY,
        receiptId: "receipt-progress",
      });
      if (first.state !== "claimed") throw new Error("receipt was not claimed");
      firstStore.checkpoint("receipt-progress", first.claimToken, {
        kind: "process_delivery",
        runId: "run-stable",
      });

      const restartedStore = new AdapterIngressReceiptStore(sql);
      expect(
        restartedStore.claim({
          ...BASE_KEY,
          receiptId: "receipt-progress",
        }),
      ).toMatchObject({
        state: "claimed",
        recovery: { kind: "process_delivery", runId: "run-stable" },
      });
    });
  });

  it("reclaims a prepared result without repeating its side effects", async () => {
    await runWithRealKernelSql((sql) => {
      const firstStore = new AdapterIngressReceiptStore(sql);
      const first = firstStore.claim({
        ...BASE_KEY,
        receiptId: "receipt-prepared",
      });
      if (first.state !== "claimed") throw new Error("receipt was not claimed");
      firstStore.prepare("receipt-prepared", first.claimToken, {
        ok: true,
        reply: { deliveryId: "reply-stable", text: "done" },
      });

      const restartedStore = new AdapterIngressReceiptStore(sql);
      const reclaimed = restartedStore.claim({
        ...BASE_KEY,
        receiptId: "receipt-prepared",
      });
      expect(reclaimed).toMatchObject({
        state: "prepared",
        receiptId: "receipt-prepared",
        result: {
          ok: true,
          reply: { deliveryId: "reply-stable", text: "done" },
        },
      });
      if (reclaimed.state !== "prepared")
        throw new Error("result was not prepared");
      restartedStore.complete(reclaimed.receiptId, reclaimed.claimToken);
      expect(
        restartedStore.claim({ ...BASE_KEY, receiptId: "receipt-prepared" }),
      ).toMatchObject({
        state: "completed",
        result: { ok: true },
      });
    });
  });

  it("rejects a completed immediate reply without its delivery id", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterIngressReceiptStore(sql);
      const claim = store.claim({ ...BASE_KEY, receiptId: "receipt-invalid" });
      if (claim.state !== "claimed") throw new Error("receipt was not claimed");
      sql.exec(
        `UPDATE adapter_ingress_receipts
            SET state = 'completed', result_json = ?
          WHERE receipt_id = ?`,
        JSON.stringify({
          ok: true,
          reply: { text: "legacy reply" },
        }),
        claim.receiptId,
      );

      expect(() =>
        store.claim({ ...BASE_KEY, receiptId: "receipt-invalid" }),
      ).toThrow("Invalid adapter ingress receipt result");
    });
  });

  it("prunes receipts after the bounded replay-retention window", async () => {
    await runWithRealKernelSql((sql) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1);
      const store = new AdapterIngressReceiptStore(sql);
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

      expect(
        sql
          .exec<{ receipt_id: string }>(
            "SELECT receipt_id FROM adapter_ingress_receipts ORDER BY receipt_id",
          )
          .toArray()
          .map((row) => row.receipt_id),
      ).toEqual(["receipt-new"]);
    });
  });
});
