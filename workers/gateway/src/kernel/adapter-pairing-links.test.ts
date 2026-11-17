import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ADAPTER_PAIRING_LINK_TTL_MS, AdapterPairingLinkStore } from "./adapter-pairing-links";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("AdapterPairingLinkStore", () => {
  it("keeps a code's hash with its owner and credential epoch, and never the code", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterPairingLinkStore(sql);
      expect(store.create({ adapter: "whatsapp", ownerUid: 1000, credentialEpoch: 3, codeHash: "hash-a", now: 1_000 }))
        .toEqual({ createdAt: 1_000, expiresAt: 1_000 + ADAPTER_PAIRING_LINK_TTL_MS });
      expect(store.get("whatsapp", "hash-a")).toEqual({
        ownerUid: 1000, credentialEpoch: 3, expiresAt: 1_000 + ADAPTER_PAIRING_LINK_TTL_MS, cancelled: false, redeemed: false,
      });
      expect(store.get("telegram", "hash-a")).toBeNull();
      const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('adapter_pairing_links')").toArray().map(({ name }) => name);
      expect(columns).not.toContain("code");
    });
  });

  it("retires an owner's oldest unused code past five, and their other unused codes once one connects", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterPairingLinkStore(sql);
      for (let index = 1; index <= 6; index += 1) {
        store.create({ adapter: "whatsapp", ownerUid: 1000, credentialEpoch: 0, codeHash: `hash-${index}`, now: index });
      }
      store.create({ adapter: "telegram", ownerUid: 1000, credentialEpoch: 0, codeHash: "hash-telegram", now: 7 });
      store.create({ adapter: "whatsapp", ownerUid: 1001, credentialEpoch: 0, codeHash: "hash-other", now: 8 });
      expect(store.get("whatsapp", "hash-1")?.cancelled).toBe(true);
      expect([2, 3, 4, 5, 6].map((index) => store.get("whatsapp", `hash-${index}`)?.cancelled)).toEqual([false, false, false, false, false]);

      store.redeemed("whatsapp", "hash-3", 9);
      expect(store.get("whatsapp", "hash-3")).toMatchObject({ redeemed: true, cancelled: false });
      expect([2, 4, 5, 6].map((index) => store.get("whatsapp", `hash-${index}`)?.cancelled)).toEqual([true, true, true, true]);
      expect(store.get("telegram", "hash-telegram")?.cancelled).toBe(false);
      expect(store.get("whatsapp", "hash-other")?.cancelled).toBe(false);
      // A code that connected while its sibling retired it is recorded as used, so a retried
      // delivery of its message is answered as connected.
      store.redeemed("whatsapp", "hash-4", 10);
      expect(store.get("whatsapp", "hash-4")).toMatchObject({ redeemed: true, cancelled: false });
    });
  });

  it("forgets codes a day old when it mints another", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new AdapterPairingLinkStore(sql);
      store.create({ adapter: "whatsapp", ownerUid: 1000, credentialEpoch: 0, codeHash: "hash-old", now: 0 });
      store.create({ adapter: "whatsapp", ownerUid: 1000, credentialEpoch: 0, codeHash: "hash-new", now: DAY_MS + 1 });
      expect(store.get("whatsapp", "hash-old")).toBeNull();
      expect(store.get("whatsapp", "hash-new")).not.toBeNull();
    });
  });
});
