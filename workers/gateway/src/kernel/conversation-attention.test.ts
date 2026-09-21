import { describe, expect, it, vi } from "vitest";
import type { ContactSummary, ConversationMessage } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { ConversationRegistry } from "./conversations";
import { FederationStore } from "./federation-store";
import type { KernelContext } from "./context";
import { handleConversationAttentionDismiss, handleConversationAttentionList } from "./conversation-attention";
import { handleContactPreferencesUpdate } from "./federation/preferences";
import { runSqlMigrations } from "../schema/runner";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./schema/migrations";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("durable private message attention", () => {
  it("coalesces committed messages and preserves a later arrival across a stale dismiss or replay", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const { ctx, registry, contact, record } = fixture(storage);
      record(1);
      const first = handleConversationAttentionList({}, ctx);
      expect(first).toMatchObject({ readyCount: 1, digestWaitingCount: 0, entries: [{ throughSequence: 1, kind: "notify", displayName: "Remote" }] });
      record(2);
      handleConversationAttentionDismiss({ entries: [{ conversationId: contact.conversationId, throughSequence: 1 }] }, ctx);
      expect(handleConversationAttentionList({}, ctx).entries[0].throughSequence).toBe(2);
      handleConversationAttentionDismiss({ entries: [{ conversationId: contact.conversationId, throughSequence: 2 }] }, ctx);
      record(2);
      expect(new ConversationRegistry(sql).attention.list(OWNER.uid, {}).readyCount).toBe(0);
      expect(registry.inboxEntry(OWNER.uid, contact.conversationId)?.unread).toBe(true);
      record(3);
      registry.updateView(OWNER.uid, { conversationId: contact.conversationId, readThroughSequence: 3 });
      expect(registry.attention.list(OWNER.uid, {}).readyCount).toBe(0);
      expect(sql.exec("SELECT count(*) AS n FROM federation_outbox").one().n).toBe(0);
    });
  });

  it("keeps a bounded digest deadline through later messages and storage reconstruction", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const { ctx, registry, contact, record } = fixture(storage);
      handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { notifications: "digest" } }, ctx);
      expect(record(1)).toBe(true);
      const due = registry.attention.nextDigestAt()!;
      expect(due - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
      expect(registry.attention.list(OWNER.uid, {}, due - 1)).toMatchObject({ readyCount: 0, digestWaitingCount: 1, nextDigestAt: due });
      record(2);
      const restored = new ConversationRegistry(sql);
      expect(restored.attention.nextDigestAt()).toBe(due);
      expect(restored.attention.announceDue(due - 1)).toEqual([]);
      expect(restored.attention.announceDue(due)).toEqual([OWNER.uid]);
      expect(restored.attention.announceDue(due)).toEqual([]);
      expect(restored.attention.nextDigestAt()).toBeNull();
      expect(restored.attention.list(OWNER.uid, {}, due)).toMatchObject({ readyCount: 1, digestWaitingCount: 0, entries: [{ throughSequence: 2, kind: "digest" }] });
      restored.attention.dismiss(OWNER.uid, contact.conversationId, 2);
      expect(record(2)).toBe(false);
      expect(record(3)).toBe(true);
      expect(restored.attention.nextDigestAt()).not.toBeNull();
    });
  });

  it("suppresses retired, quiet, muted, read and archived conversations without changing read position", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { ctx, registry, contact, federation, record } = fixture(storage);
      record(1);
      const muted = handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { muted: true } }, ctx).contact;
      record(2);
      handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: muted.preferences!.revision, patch: { muted: false } }, ctx);
      expect(registry.attention.list(OWNER.uid, {}).readyCount).toBe(0);
      record(3);
      const view = registry.inboxEntry(OWNER.uid, contact.conversationId)!;
      registry.updateView(OWNER.uid, { conversationId: contact.conversationId, archived: true, expectedRevision: view.view.revision });
      expect(registry.attention.list(OWNER.uid, {}).readyCount).toBe(0);
      record(4);
      expect(registry.attention.list(OWNER.uid, {}).readyCount).toBe(1);
      federation.revoke(contact.id, OWNER.uid);
      expect(registry.attention.list(OWNER.uid, {}).readyCount).toBe(0);
      expect(registry.inboxEntry(OWNER.uid, contact.conversationId)?.view.readThroughSequence).toBe(0);
    });
  });

  it("gives only the signed-in owner private attention reads and exact dismissals", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { ctx, contact, record } = fixture(storage);
      record(1);
      expect(handleConversationAttentionList({}, { ...ctx, callerOwnerUid: 2000 }).entries).toEqual([]);
      handleConversationAttentionDismiss({ entries: [{ conversationId: contact.conversationId, throughSequence: 100 }] }, { ...ctx, callerOwnerUid: 2000 });
      expect(handleConversationAttentionList({}, ctx).readyCount).toBe(1);
      expect(() => handleConversationAttentionList({}, { ...ctx, processId: "proc:ship" })).toThrow("signed-in human");
      expect(() => handleConversationAttentionDismiss({ entries: [] }, { ...ctx, processId: "proc:ship" })).toThrow("signed-in human");
      expect(() => handleConversationAttentionList({ limit: 101 }, ctx)).toThrow();
    });
  });

  it("upgrades the admission checkpoint without alerting again about old committed messages", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 66));
      const { registry, contact } = fixture(storage);
      registry.recordContactMessage(message(contact, 42), false);
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(registry.recordContactMessage(message(contact, 42), false, contact)).toBe(false);
      expect(registry.attention.list(OWNER.uid, {}).readyCount).toBe(0);
    });
  });
});

function message(contact: ContactSummary, sequence: number): ConversationMessage {
  return { id: `message:${sequence}`, conversationId: contact.conversationId, sequence,
    author: { kind: "contact", contactId: contact.id, shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id, displayName: "Remote" },
    text: `Message ${sequence}`, origin: { kind: "federation", contactId: contact.id, deliveryId: `delivery:${sequence}` }, createdAt: Date.now() };
}

function fixture(storage: DurableObjectStorage) {
  const registry = new ConversationRegistry(storage.sql);
  const federation = new FederationStore(storage);
  const contact = federation.activateContact({ ownerUid: OWNER.uid, remoteShipId: "ship:remote", remoteSubject: { id: "subject:remote", displayName: "Remote" },
    remoteOrigin: "https://remote.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, sharedSecret: "secret", generation: "generation:one", threadId: "thread:one" });
  registry.ensureContact(OWNER.uid, "Remote", contact.conversationId);
  const context = { peer: testPeer({ kind: "human", account: OWNER, calls: ["conversation.*", "contact.*"] }), callerOwnerUid: OWNER.uid,
    connection: {}, conversations: registry, federation, broadcastToUserUid: vi.fn(),
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false } };
  // SAFETY: both owning stores are real; the fixture supplies the direct-human authentication boundary.
  const ctx = context as KernelContext;
  const record = (sequence: number) => federation.transaction(() => {
    const current = federation.get(contact.id)!;
    return registry.recordContactMessage(message(current, sequence), current.preferences.muted, current);
  });
  return { ctx, registry, federation, contact, record };
}
