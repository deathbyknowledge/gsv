import { describe, expect, it, vi } from "vitest";
import { getConversationById } from "../shared/utils";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { makeShadowEntry } from "../auth/shadow";
import { AuthStore } from "./auth-store";
import { ConversationRegistry } from "./conversations";
import type { KernelContext } from "./context";
import { FederationIdentity } from "./federation-crypto";
import { FederationStore } from "./federation-store";
import { ProcessRegistry } from "./processes";
import { handleContactDraftApprove, handleContactDraftCreate } from "./contact-draft-handlers";
import { handleConversationSend } from "./conversation-handlers";

describe("private helper to approved federation reply", () => {
  it("binds the reviewed canonical reply to one attributed outbox effect", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const owner = { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" };
      const installationId = `inst_draft_${crypto.randomUUID()}`;
      const auth = new AuthStore(sql);
      auth.addUser({ ...owner, gecos: "Owner", shell: "/bin/init" });
      auth.setShadow(makeShadowEntry(owner.username, "fixture-unlocked"));
      const federation = new FederationStore(storage);
      const contact = federation.activateContact({ ownerUid: owner.uid, remoteShipId: "ship:remote", remoteSubject: { id: "subject:remote", displayName: "Sam" },
        remoteOrigin: "https://sam.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, sharedSecret: "fixture", generation: "generation:one", threadId: "thread:one" });
      federation.setProtocol(contact.id, contact.generation, { version: 2, features: ["messages"], checkedAtMs: Date.now() });
      const procs = new ProcessRegistry(sql);
      const scope = federation.transaction(() => procs.scopes.create(owner.uid, "proc:helper", {
        conversations: [{ contactId: contact.id, conversationId: contact.conversationId, generation: contact.generation, read: false, send: false }],
        resources: [], materials: [], expiresAtMs: Date.now() + 60_000, budgets: { processes: 1, generations: 4, messages: 0 },
      }));
      procs.spawn("proc:helper", owner, { ownerUid: owner.uid, interactive: true, scopeId: scope.id });
      const conversations = new ConversationRegistry(sql);
      const work = conversations.ensureWork(owner.uid, "proc:helper", "Help with Sam");
      const conversation = getConversationById(installationId, work.id);
      await conversation.initialize({ ownerUid: owner.uid, kind: "work" });
      const source = await conversation.append({ messageId: "reply:one", idempotencyKey: "reply:one", text: "The private proposed answer", createdAt: Date.now(),
        author: { kind: "process", pid: "proc:helper", uid: owner.uid }, origin: { kind: "process", pid: "proc:helper", runId: "run:one" } });
      // SAFETY: real ownership, scope, draft, Conversation and federation stores; only external scheduling is intercepted.
      const ctx = { installationId, installationIdentity: { installationId, handle: "local", canonicalOrigin: "https://local.example" },
        auth, procs, conversations, federation, federationIdentity: new FederationIdentity(storage),
        peer: testPeer({ kind: "human", account: owner, calls: ["contact.*", "conversation.*"] }), connection: { id: "web", state: {} },
        broadcastToUserUid: vi.fn(), scheduleFederationDelivery: vi.fn(async () => {}) } as KernelContext;
      const reviewed = { contactId: contact.id, expectedGeneration: contact.generation, source: { conversationId: work.id, messageId: source.message.id, sequence: source.message.sequence },
        text: "The exact answer after human editing", idempotencyKey: "review:one" };
      const { draft } = await handleContactDraftCreate(reviewed, ctx);
      const approved = await handleContactDraftApprove({ draftId: draft.id, expectedRevision: 1 }, ctx);
      const retried = await handleContactDraftApprove({ draftId: draft.id, expectedRevision: 1 }, ctx);
      expect(retried.draft.result).toEqual(approved.draft.result);
      const outbox = federation.outbox(approved.draft.result!.deliveryId)!;
      expect(outbox).toMatchObject({ wireVersion: 2, payload: { text: reviewed.text, social: {
        provenance: { kind: "approved", processId: "proc:helper", approvalId: draft.id },
      } } });
      expect(federation.pendingOutboxCount({ contactId: contact.id })).toBe(1);
      expect(procs.scopes.get(scope.id)?.used.messages).toBe(0);
      await expect(handleContactDraftCreate({ ...reviewed, text: "Different text" }, ctx)).rejects.toThrow("different content");
      await expect(handleConversationSend({ conversationId: work.id, text: "Use my laptop", selectedTarget: "laptop" }, ctx)).rejects.toThrow("fresh helper");
      expect((await conversation.history()).messages).toHaveLength(1);
    });
  });
});
