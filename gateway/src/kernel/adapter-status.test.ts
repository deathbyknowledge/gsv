import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { Kernel } from "./do";
import type { AdapterStatusStore } from "./adapter-status";

describe("AdapterStatusStore ownership", () => {
  it("preserves owners across service status updates", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(kernel, (instance: Kernel) => {
      const status = (instance as unknown as {
        adapters: { status: AdapterStatusStore };
      }).adapters.status;

      status.setOwner("whatsapp", "primary", 1000);
      status.upsert("whatsapp", "primary", {
        accountId: "primary",
        connected: true,
        authenticated: true,
      });
      status.upsert("telegram", "bot", {
        accountId: "bot",
        connected: false,
        authenticated: false,
      });

      expect(status.get("whatsapp", "primary")).toMatchObject({ ownerUid: 1000 });
      expect(status.get("telegram", "bot")).toMatchObject({ ownerUid: null });
      expect(status.listByOwner(1000).map((record) => record.accountId)).toEqual(["primary"]);

      status.beginLifecycle("telegram", "bot");
      expect(() => status.beginLifecycle("telegram", "bot")).toThrow("lifecycle operation");
      status.endLifecycle("telegram", "bot");
      expect(() => status.beginLifecycle("telegram", "bot")).not.toThrow();
      status.endLifecycle("telegram", "bot");
    });
  });

  it("rejects new invalid IDs and only cleans pristine invalid owner claims", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(kernel, (instance: Kernel, state) => {
      const status = (instance as unknown as {
        adapters: { status: AdapterStatusStore };
      }).adapters.status;
      const providerId = "15551234567:4@s.whatsapp.net/device";
      status.setOwner("whatsapp", providerId, 1000);
      status.upsert("whatsapp", providerId, {
        accountId: providerId,
        connected: true,
        authenticated: true,
      });
      expect(status.get("whatsapp", providerId)).toMatchObject({
        connected: true,
        authenticated: true,
      });
      expect(() => status.setOwner("whatsapp", "x".repeat(257), 1000)).toThrow(
        "account ID is invalid",
      );
      expect(() => status.upsert("whatsapp", "primary", {
        accountId: "different",
        connected: false,
        authenticated: false,
      })).toThrow("does not match");

      const pristineInvalid = "p".repeat(257);
      const connectedInvalid = "c".repeat(257);
      const referencedInvalid = "r".repeat(257);
      for (const [accountId, connected] of [
        [pristineInvalid, 0],
        [connectedInvalid, 1],
        [referencedInvalid, 0],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO adapter_status (
             adapter, account_id, connected, authenticated, mode,
             last_activity, error, extra_json, owner_uid, updated_at
           ) VALUES ('whatsapp', ?, ?, 0, NULL, NULL, NULL, NULL, 1000, 1)`,
          accountId,
          connected,
        );
      }
      state.storage.sql.exec(
        `INSERT INTO identity_links (
           adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
         ) VALUES ('whatsapp', ?, 'actor', 1000, 1, 1000, NULL)`,
        referencedInvalid,
      );

      expect(status.cleanupInvalidManagedAccounts([
        "whatsapp",
        "discord",
        "telegram",
      ])).toEqual({ removed: 1, blocked: 2 });
      const remaining = state.storage.sql.exec<{ account_id: string }>(
        `SELECT account_id FROM adapter_status WHERE LENGTH(account_id) > 256 ORDER BY account_id`,
      ).toArray().map((row) => row.account_id);
      expect(remaining).toEqual([connectedInvalid, referencedInvalid]);
    });
  });
});
