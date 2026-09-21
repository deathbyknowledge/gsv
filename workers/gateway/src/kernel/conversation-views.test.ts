import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { ConversationRegistry } from "./conversations";
import { FederationStore } from "./federation-store";
import type { KernelContext } from "./context";
import { handleConversationInbox, handleConversationViewGet, handleConversationViewUpdate } from "./conversation-views";
import { runSqlMigrations } from "../schema/runner";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./schema/migrations";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("private inbox state", () => {
  it("merges read positions, fences archive decisions, and keeps muted new messages archived", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const { ctx, registry, contact } = fixture(storage);
      const message = (sequence: number): ConversationMessage => ({
        id: `message:${sequence}`, conversationId: contact.conversationId, sequence,
        author: { kind: "contact", contactId: contact.id, shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id, displayName: "Person" },
        text: "hello".repeat(100), origin: { kind: "federation", contactId: contact.id, deliveryId: `delivery:${sequence}` }, createdAt: Date.now() + sequence,
      });
      registry.recordContactMessage(message(1), false);
      const first = handleConversationInbox({}, ctx).entries[0];
      expect(first.unread).toBe(true);
      expect(first.preview?.text.length).toBe(280);
      handleConversationViewUpdate({ conversationId: contact.conversationId, readThroughSequence: 1 }, ctx);
      handleConversationViewUpdate({ conversationId: contact.conversationId, readThroughSequence: 0 }, ctx);
      expect(registry.inboxEntry(1000, contact.conversationId)?.view.readThroughSequence).toBe(1);
      expect(() => handleConversationViewUpdate({ conversationId: contact.conversationId, archived: true, expectedRevision: first.view.revision }, ctx)).toThrow("changed");
      const read = registry.inboxEntry(1000, contact.conversationId)!;
      handleConversationViewUpdate({ conversationId: contact.conversationId, archived: true, expectedRevision: read.view.revision }, ctx);
      registry.recordContactMessage(message(1), false);
      expect(handleConversationInbox({}, ctx).entries).toEqual([]);
      registry.recordContactMessage(message(2), true);
      const muted = handleConversationInbox({ archived: true }, ctx).entries[0];
      expect(muted).toMatchObject({ unread: true, view: { archived: true, readThroughSequence: 1 } });
      registry.recordContactMessage(message(3), false);
      expect(handleConversationInbox({}, ctx).entries[0]).toMatchObject({ unread: true, view: { archived: false } });
      expect(() => handleConversationViewUpdate({ conversationId: contact.conversationId, readThroughSequence: 4 }, ctx)).toThrow("committed");
      expect(sql.exec("SELECT count(*) AS n FROM federation_outbox").toArray()[0].n).toBe(0);
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(1000, "conversation.changed", expect.objectContaining({ viewOnly: true }));
    });
  });

  it("admits only the signed-in owner and never treats a Process as a reader or archiver", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { ctx, registry, contact } = fixture(storage);
      const other = { ...ctx, callerOwnerUid: 1002 };
      expect(handleConversationInbox({}, other).entries).toEqual([]);
      expect(() => handleConversationViewGet({ conversationId: contact.conversationId }, other)).toThrow("not found");
      expect(() => handleConversationViewUpdate({ conversationId: contact.conversationId, archived: true, expectedRevision: 1 }, other)).toThrow("not found");
      expect(() => handleConversationInbox({}, { ...ctx, processId: "proc:ship" })).toThrow("signed-in human");
      expect(registry.inboxEntry(1000, contact.conversationId)?.view.archived).toBe(false);
      expect(() => handleConversationInbox({ limit: 101 }, ctx)).toThrow();
      expect(handleConversationInbox({ limit: 1 }, ctx).next?.conversationId).toBe(contact.conversationId);
      expect(handleConversationInbox({ before: { updatedAt: registry.get(contact.conversationId)!.updatedAt, conversationId: contact.conversationId } }, ctx).entries).toEqual([]);
    });
  });

  it("preserves established history during upgrade without declaring every old message unread", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 61));
      const { registry, contact } = fixture(storage);
      registry.recordSequence(contact.conversationId, 42);
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(registry.inboxEntry(1000, contact.conversationId)).toMatchObject({
        conversation: { latestSequence: 42 }, view: { readThroughSequence: 42 }, unread: false, preview: null,
      });
      expect(sql.exec("SELECT COUNT(*) AS n FROM federation_contacts").toArray()[0].n).toBe(1);
    });
  });
});

function fixture(storage: DurableObjectStorage) {
  const registry = new ConversationRegistry(storage.sql);
  const federation = new FederationStore(storage);
  const contact = federation.activateContact({
    ownerUid: OWNER.uid, remoteShipId: "ship:remote", remoteSubject: { id: "subject:remote", displayName: "Remote" },
    remoteOrigin: "https://remote.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    sharedSecret: "secret", generation: "generation:one", threadId: "thread:one",
  });
  registry.ensureContact(OWNER.uid, "Remote", contact.conversationId);
  const context = {
    peer: testPeer({ kind: "human", account: OWNER, calls: ["conversation.*"] }), callerOwnerUid: OWNER.uid,
    connection: {}, conversations: registry, federation, broadcastToUserUid: vi.fn(),
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
  };
  // The handlers use the actual owning stores; authentication is the explicit fixture above.
  return { ctx: context as KernelContext, registry, contact };
}
