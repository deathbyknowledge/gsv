import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApproachClaim, ApproachCreateArgs, PublicProfile } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { testPeer } from "../../test-support/peers";
import { createInstallationStorage } from "../../installation/storage";
import { getConversationById } from "../../shared/utils";
import type { KernelContext } from "../context";
import { ApproachStore } from "../approach-store";
import { FederationStore } from "../federation-store";
import { FederationIdentity } from "../federation-crypto";
import { ProfileStore } from "../profile-store";
import { ConversationRegistry } from "../conversations";
import { ResponsibilityStore } from "../responsibility-store";
import { handleProfilePublish, handleProfileUpdate, processProfilePublication } from "../profiles";
import { handleFederationHttpRequest } from "../federation";
import { handleContactBlockSet } from "../federation/preferences";
import { localShipDocumentV2 } from "../federation/protocol";
import { handleApproachCreate, handleApproachDecide, handleApproachRetry } from "./admission";
import { processApproachMaintenance } from "./runtime";
import { claimApproach } from "./pairing";
import { APPROACH_CLAIM_PATH, APPROACH_PATH, signApproachValue } from "./shared";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "private-login", gecos: "Private name", home: "/home/person", cwd: "/home/person" };

describe("authenticated first contact", () => {
  afterEach(() => vi.restoreAllMocks());

  it("recovers lost delivery and claim receipts without changing the message, consent or generation", async () => {
    await withSpaces(async (sender, recipient, profile) => {
      let loseDelivery = true;
      let loseClaim = true;
      const route = installTransport(sender, recipient, profile, (path) => {
        if (path === APPROACH_PATH && loseDelivery) { loseDelivery = false; throw new Error("response lost"); }
        if (path === APPROACH_CLAIM_PATH && loseClaim) { loseClaim = false; throw new Error("response lost"); }
      });
      const input = sendIntent(profile);
      const created = (await handleApproachCreate(input, sender)).approach;
      expect(created.state).toBe("preparing");
      expect((await handleApproachCreate(input, sender)).approach.id).toBe(created.id);
      expect(sender.federation.listInvites(OWNER.uid, true)).toEqual([]);
      expect(sender.federation.outstandingInviteCount(OWNER.uid)).toBe(0);
      await processApproachMaintenance(sender);
      const request = recipient.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })[0];
      expect(request).toMatchObject({ state: "pending", delivery: "received" });
      expect(sender.approaches.get(created.id)?.summary.delivery).toBe("queued");
      expect(recipient.federation.contactCount()).toBe(0);
      expect(recipient.conversations.get(request.conversationId)?.handlerPid).toBeUndefined();
      await handleApproachRetry({ approachId: created.id, expectedRevision: created.revision }, sender);
      await processApproachMaintenance(sender);
      expect(sender.approaches.get(created.id)?.summary.delivery).toBe("received");
      expect(recipient.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })).toHaveLength(1);

      const pending = recipient.approaches.get(request.id)!;
      const leaked = await handleFederationHttpRequest(new Request("https://sender.example/_gsv/federation/v1/invites/accept", {
        method: "POST", body: JSON.stringify({ version: 1, token: pending.setupToken,
          document: await recipient.federationIdentity.ensure("https://recipient.example"), subject: recipient.federation.subject(OWNER.uid) }),
      }), sender);
      expect(leaked.status).toBe(404);
      await leaked.arrayBuffer();
      const decision = (await handleApproachDecide({ approachId: request.id, expectedRevision: request.revision, decision: "accept" }, recipient)).approach;
      await processApproachMaintenance(recipient);
      const claimed = sender.approaches.get(created.id)!;
      expect(claimed.summary.state).toBe("accepting");
      expect(sender.approaches.pendingConnection(claimed.contactId, claimed.generation!)).toBe(true);
      expect(recipient.federation.contactCount()).toBe(0);
      const generation = claimed.generation;

      const later = Date.now() + 15 * 60_000;
      vi.spyOn(Date, "now").mockReturnValue(later);
      await handleApproachRetry({ approachId: request.id, expectedRevision: decision.revision }, recipient);
      await processApproachMaintenance(recipient);
      await processApproachMaintenance(recipient);
      expect(sender.approaches.get(created.id)?.summary.connection).toBe("connected");
      expect(recipient.approaches.get(request.id)?.summary.connection).toBe("connected");
      expect(sender.approaches.get(created.id)?.generation).toBe(generation);
      expect(recipient.approaches.get(request.id)?.generation).toBe(generation);
      const peer = recipient.approaches.get(request.id)!;
      expect(recipient.federation.get(peer.contactId)?.sharedSecret).toBe(sender.federation.get(claimed.contactId)?.sharedSecret);
      expect(recipient.federation.get(peer.contactId)?.preferences.saved).toBe(false);
      for (const [ctx, id] of [[sender, created.id], [recipient, request.id]] as const) {
        const saved = ctx.approaches.get(id)!;
        expect(saved.setupToken).toBeNull();
        const history = await getConversationById(ctx.installationId, saved.summary.conversationId).history();
        expect(history.messages.map((message) => message.text)).toEqual([input.text]);
        expect(history.messages[0].social?.provenance.kind).toBe("human");
        expect(JSON.stringify(history)).not.toContain(pending.setupToken);
      }
      expect(sender.scheduleApproachMaintenance).toHaveBeenCalled();
      expect(route).toHaveBeenCalled();
    });
  });

  it("requires direct human creation and key possession for the exact recipient, then fences a block", async () => {
    await withSpaces(async (sender, recipient, profile) => {
      installTransport(sender, recipient, profile);
      await expect(handleApproachCreate(sendIntent(profile), { ...sender, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      const created = (await handleApproachCreate(sendIntent(profile), sender)).approach;
      await processApproachMaintenance(sender);
      const incoming = recipient.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })[0];
      const owned = recipient.approaches.get(incoming.id)!;
      const document = await localShipDocumentV2(recipient);
      const unsigned = { version: 2, domain: "gsv-federation/2/approach-claim", document,
        reference: owned.summary.reference, recipient: owned.metadata.recipient, attemptId: "attempt:one", token: owned.setupToken! } satisfies Omit<ApproachClaim, "signature">;
      await expect(claimApproach({ ...unsigned, signature: document.signature }, sender)).rejects.toThrow("authentication");
      const signed = await signApproachValue(unsigned, recipient);
      await expect(claimApproach({ ...signed, recipient: { ...signed.recipient, subjectId: "another-person" } }, sender)).rejects.toThrow("unavailable");
      await handleContactBlockSet({ actor: profile.actor, blocked: true }, sender);
      await expect(claimApproach(signed, sender)).rejects.toThrow("no longer available");
      await handleContactBlockSet({ actor: profile.actor, blocked: false }, sender);
      await expect(claimApproach(signed, sender)).rejects.toThrow("no longer available");
      expect(sender.federation.contactCount()).toBe(0);
      expect(sender.approaches.get(created.id)?.summary.state).toBe("blocked");
    });
  });

  it("withdraws an unclaimed request, retains its first decision and never creates an active contact", async () => {
    await withSpaces(async (sender, recipient, profile) => {
      installTransport(sender, recipient, profile);
      const created = (await handleApproachCreate(sendIntent(profile), sender)).approach;
      await processApproachMaintenance(sender);
      const incoming = recipient.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })[0];
      await handleApproachDecide({ approachId: created.id, expectedRevision: created.revision, decision: "withdraw" }, sender);
      await processApproachMaintenance(sender);
      expect(recipient.approaches.get(incoming.id)?.summary.state).toBe("withdrawn");
      await expect(handleApproachDecide({ approachId: incoming.id, expectedRevision: incoming.revision, decision: "accept" }, recipient)).rejects.toThrow("changed");
      expect(recipient.federation.contactCount()).toBe(0);
    });
  });
});

function sendIntent(profile: PublicProfile): ApproachCreateArgs {
  return { profileUrl: profile.url, recipient: profile.actor, profileRevision: profile.revision,
    displayName: "A chosen sender name", text: "Hello, I would like to ask about GSV.", idempotencyKey: "first-message" };
}

async function withSpaces(work: (sender: KernelContext, recipient: KernelContext, profile: PublicProfile) => Promise<void>): Promise<void> {
  await runWithRealKernelSql(async (_senderSql, senderStorage) => {
    await runWithRealKernelSql(async (_recipientSql, recipientStorage) => {
      const sender = spaceContext(senderStorage, "sender");
      const recipient = spaceContext(recipientStorage, "recipient");
      handleProfileUpdate({ expectedRevision: 0, draft: { alias: "person", displayName: "Published recipient", about: "Hello", contactPolicy: "requests", representation: "human" } }, recipient);
      await handleProfilePublish({ expectedRevision: 1 }, recipient);
      const profile = recipient.profiles.publication(OWNER.uid)!.profile;
      await processProfilePublication(OWNER.uid, recipient);
      await work(sender, recipient, profile);
    });
  });
}

function installTransport(sender: KernelContext, recipient: KernelContext, profile: PublicProfile, afterResponse?: (path: string) => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === profile.url) return Response.json(profile);
    const ctx = url.origin === "https://sender.example" ? sender : recipient;
    const response = await handleFederationHttpRequest(request, ctx);
    if (response.ok) {
      try { afterResponse?.(url.pathname); } catch (error) { await response.body?.cancel(); throw error; }
    }
    return response;
  });
}

function spaceContext(storage: DurableObjectStorage, name: string): KernelContext {
  const installationId = `inst_${crypto.randomUUID()}`;
  const context = {
    installationId, installationIdentity: { installationId, canonicalOrigin: `https://${name}.example`, handle: name },
    peer: testPeer({ kind: "human", account: OWNER, calls: ["approach.*", "profile.*", "contact.*"] }), callerOwnerUid: OWNER.uid, connection: {},
    profiles: new ProfileStore(storage), approaches: new ApproachStore(storage), federation: new FederationStore(storage), federationIdentity: new FederationIdentity(storage),
    conversations: new ConversationRegistry(storage.sql), responsibilities: new ResponsibilityStore(storage),
    env: { STORAGE: createInstallationStorage(env.STORAGE, installationId) },
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false, isAccountDisabled: () => false },
    coordinateFederationContact: async <T>(_id: string, operation: () => T | Promise<T>) => operation(),
    broadcastToUserUid: vi.fn(), scheduleProfilePublication: vi.fn(async () => {}), scheduleApproachMaintenance: vi.fn(async () => {}),
    reconcileResponsibilityWake: vi.fn(async () => {}),
  };
  // SAFETY: the handlers use the real owning stores; transport, account identity and wake scheduling are supplied above.
  return context as KernelContext;
}
