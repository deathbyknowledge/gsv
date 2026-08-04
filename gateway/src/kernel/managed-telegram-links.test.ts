import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";
import { IdentityLinkStore } from "./identity-links";
import { ManagedTelegramLinkStore } from "./managed-telegram-links";

describe("managed Telegram Kernel links", () => {
  it("links only an active managed membership and replays idempotently", async () => {
    const stub = env.KERNEL.get(env.KERNEL.newUniqueId());
    await runInDurableObject(stub, (_kernel: Kernel, state) => {
      seedMembership(state.storage.sql, "principal_owner", 1000);
      const links = new IdentityLinkStore(state.storage.sql);
      const store = new ManagedTelegramLinkStore(state.storage, links);
      const input = {
        operationId: "operation_link_1",
        installationId: "inst_test",
        principalId: "principal_owner",
        localUid: 1000,
        actorId: "123456",
        surfaceId: "123456",
      };

      expect(store.link(input)).toMatchObject({ state: "linked", localUid: 1000 });
      expect(store.link(input)).toMatchObject({ state: "linked", localUid: 1000 });
      expect(links.get("telegram", "managed", "123456")).toMatchObject({
        uid: 1000,
        linkedByUid: 0,
        metadata: {
          managed: true,
          surfaceKind: "dm",
          surfaceId: "123456",
        },
      });
      expect(() => store.link({ ...input, localUid: 1001 })).toThrow(
        "already used with different input",
      );
    });
  });

  it("fails closed when membership or unlink ownership changed", async () => {
    const stub = env.KERNEL.get(env.KERNEL.newUniqueId());
    await runInDurableObject(stub, (_kernel: Kernel, state) => {
      const links = new IdentityLinkStore(state.storage.sql);
      const store = new ManagedTelegramLinkStore(state.storage, links);
      const link = {
        operationId: "operation_link_2",
        installationId: "inst_test",
        principalId: "principal_owner",
        localUid: 1000,
        actorId: "654321",
        surfaceId: "654321",
      };
      expect(() => store.link(link)).toThrow("membership is not active");

      seedMembership(state.storage.sql, "principal_owner", 1000);
      store.link(link);
      const unlink = {
        operationId: "operation_unlink_2",
        installationId: "inst_test",
        actorId: "654321",
        surfaceId: "654321",
        expectedLocalUid: 1001,
      };
      expect(() => store.unlink(unlink)).toThrow("ownership changed before unlink");
      const result = store.unlink({ ...unlink, expectedLocalUid: 1000 });
      expect(result).toMatchObject({ state: "unlinked", removed: true });
      expect(store.unlink({ ...unlink, expectedLocalUid: 1000 })).toEqual(result);
      expect(links.get("telegram", "managed", "654321")).toBeNull();
    });
  });
});

function seedMembership(sql: SqlStorage, principalId: string, localUid: number): void {
  sql.exec(
    `INSERT INTO managed_principal_memberships (
       principal_id, local_uid, role, state, created_at, revoked_at
     ) VALUES (?, ?, 'owner', 'active', ?, NULL)`,
    principalId,
    localUid,
    Date.now(),
  );
}
