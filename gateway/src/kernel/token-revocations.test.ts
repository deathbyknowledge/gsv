import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";
import { TokenRevocationStore } from "./token-revocations";

describe("TokenRevocationStore", () => {
  it("persists non-secret tombstones and retry state", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const store = new TokenRevocationStore(state.storage.sql);
      const notice = { tokenId: "token-a", uid: 1000, revokedAt: 100 };

      store.remember(notice);
      expect(store.isRevoked(notice.tokenId)).toBe(true);
      expect(store.isRevoked("token-b")).toBe(false);

      state.storage.sql.exec(
        `INSERT INTO auth_token_revocation_outbox (
          token_id, uid, revoked_at, attempt_count, next_attempt_at, last_error
        ) VALUES (?, ?, ?, 0, ?, NULL)`,
        notice.tokenId,
        notice.uid,
        notice.revokedAt,
        notice.revokedAt,
      );
      expect(store.listDue(100)).toEqual([{
        ...notice,
        attemptCount: 0,
        nextAttemptAt: 100,
        lastError: null,
      }]);

      store.recordFailure(notice.tokenId, new Error("temporary failure"), 200);
      expect(store.listDue(200)).toEqual([]);
      expect(store.nextAttemptAt()).toBe(1_200);
      expect(store.acknowledge(notice.tokenId, notice.uid)).toBe(true);
      expect(store.nextAttemptAt()).toBeNull();
    });
  });

  it("rolls back token revocation when its durable outbox cannot be written", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const sql = state.storage.sql;
      sql.exec(`
        INSERT INTO auth_tokens (
          token_id, uid, kind, label, token_hash, token_prefix, allowed_role,
          allowed_device_id, created_at, last_used_at, expires_at, revoked_at, revoked_reason
        ) VALUES (
          'atomic-token', 0, 'user', NULL, 'atomic-hash', 'atomic-prefix',
          'user', NULL, 1, NULL, NULL, NULL, NULL
        )
      `);
      sql.exec("DROP TABLE auth_token_revocation_outbox");

      expect(() => sql.exec(`
        UPDATE auth_tokens
        SET revoked_at = 10, revoked_reason = 'test'
        WHERE token_id = 'atomic-token'
      `)).toThrow();
      expect(sql.exec<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM auth_tokens WHERE token_id = 'atomic-token'",
      ).toArray()).toEqual([{ revoked_at: null }]);
    });
  });
});
