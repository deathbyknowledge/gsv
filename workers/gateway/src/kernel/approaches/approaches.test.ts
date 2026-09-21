import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApproachClaim, ApproachCreateArgs, PublicProfile } from "@humansandmachines/gsv/protocol";
import { runInDurableObject } from "cloudflare:test";
import type { Kernel } from "../do";
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
      const created = (await sender.run((ctx) => handleApproachCreate(input, ctx))).approach;
      expect(created.state).toBe("preparing");
      expect((await sender.run((ctx) => handleApproachCreate(input, ctx))).approach.id).toBe(created.id);
      expect(await sender.run((ctx) => ctx.federation.listInvites(OWNER.uid, true))).toEqual([]);
      expect(await sender.run((ctx) => ctx.federation.outstandingInviteCount(OWNER.uid))).toBe(0);
      await sender.run(processApproachMaintenance);
      const request = (await recipient.run((ctx) => ctx.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })))[0];
      expect(request).toMatchObject({ state: "pending", delivery: "received" });
      expect((await sender.run((ctx) => ctx.approaches.get(created.id)))?.summary.delivery).toBe("queued");
      expect(await recipient.run((ctx) => ctx.federation.contactCount())).toBe(0);
      expect((await recipient.run((ctx) => ctx.conversations.get(request.conversationId)))?.handlerPid).toBeUndefined();
      await sender.run((ctx) => handleApproachRetry({ approachId: created.id, expectedRevision: created.revision }, ctx));
      await sender.run(processApproachMaintenance);
      expect((await sender.run((ctx) => ctx.approaches.get(created.id)))?.summary.delivery).toBe("received");
      expect((await recipient.run((ctx) => ctx.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })))).toHaveLength(1);

      const pending = (await recipient.run((ctx) => ctx.approaches.get(request.id)))!;
      const remoteDocument = await recipient.run((ctx) => ctx.federationIdentity.ensure("https://recipient.example"));
      const remoteSubject = await recipient.run((ctx) => ctx.federation.subject(OWNER.uid));
      const leakedStatus = await sender.run(async (ctx) => {
        const response = await handleFederationHttpRequest(new Request("https://sender.example/_gsv/federation/v1/invites/accept", {
          method: "POST", body: JSON.stringify({ version: 1, token: pending.setupToken, document: remoteDocument, subject: remoteSubject }),
        }), ctx);
        await response.arrayBuffer();
        return response.status;
      });
      expect(leakedStatus).toBe(404);
      const decision = (await recipient.run((ctx) => handleApproachDecide({ approachId: request.id, expectedRevision: request.revision, decision: "accept" }, ctx))).approach;
      await recipient.run(processApproachMaintenance);
      const claimed = (await sender.run((ctx) => ctx.approaches.get(created.id)))!;
      expect(claimed.summary.state).toBe("accepting");
      expect(await sender.run((ctx) => ctx.approaches.pendingConnection(claimed.contactId, claimed.generation!))).toBe(true);
      expect(await recipient.run((ctx) => ctx.federation.contactCount())).toBe(0);
      const generation = claimed.generation;

      const later = Date.now() + 15 * 60_000;
      vi.spyOn(Date, "now").mockReturnValue(later);
      await recipient.run((ctx) => handleApproachRetry({ approachId: request.id, expectedRevision: decision.revision }, ctx));
      await recipient.run(processApproachMaintenance);
      await recipient.run(processApproachMaintenance);
      expect((await sender.run((ctx) => ctx.approaches.get(created.id)))?.summary.connection).toBe("connected");
      expect((await recipient.run((ctx) => ctx.approaches.get(request.id)))?.summary.connection).toBe("connected");
      expect((await sender.run((ctx) => ctx.approaches.get(created.id)))?.generation).toBe(generation);
      expect((await recipient.run((ctx) => ctx.approaches.get(request.id)))?.generation).toBe(generation);
      const peer = (await recipient.run((ctx) => ctx.approaches.get(request.id)))!;
      expect((await recipient.run((ctx) => ctx.federation.get(peer.contactId)))?.sharedSecret).toBe((await sender.run((ctx) => ctx.federation.get(claimed.contactId)))?.sharedSecret);
      expect((await recipient.run((ctx) => ctx.federation.get(peer.contactId)))?.preferences.saved).toBe(false);
      for (const [ctx, id] of [[sender, created.id], [recipient, request.id]] as const) {
        const saved = (await ctx.run((context) => context.approaches.get(id)))!;
        expect(saved.setupToken).toBeNull();
        const history = await getConversationById(ctx.installationId, saved.summary.conversationId).history();
        expect(history.messages.map((message) => message.text)).toEqual([input.text]);
        expect(history.messages[0].social?.provenance.kind).toBe("human");
        expect(JSON.stringify(history)).not.toContain(pending.setupToken);
      }
      expect(route).toHaveBeenCalled();
    });
  });

  it("requires direct human creation and key possession for the exact recipient, then fences a block", async () => {
    await withSpaces(async (sender, recipient, profile) => {
      installTransport(sender, recipient, profile);
      await expect(sender.run((ctx) => handleApproachCreate(sendIntent(profile), { ...ctx, processId: "proc:ship" }))).rejects.toThrow("signed-in human");
      const created = (await sender.run((ctx) => handleApproachCreate(sendIntent(profile), ctx))).approach;
      await sender.run(processApproachMaintenance);
      const incoming = (await recipient.run((ctx) => ctx.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })))[0];
      const owned = (await recipient.run((ctx) => ctx.approaches.get(incoming.id)))!;
      const document = await recipient.run(localShipDocumentV2);
      const unsigned = { version: 2, domain: "gsv-federation/2/approach-claim", document,
        reference: owned.summary.reference, recipient: owned.metadata.recipient, attemptId: "attempt:one", token: owned.setupToken! } satisfies Omit<ApproachClaim, "signature">;
      await expect(sender.run((ctx) => claimApproach({ ...unsigned, signature: document.signature }, ctx))).rejects.toThrow("authentication");
      const signed = await recipient.run((ctx) => signApproachValue(unsigned, ctx));
      await expect(sender.run((ctx) => claimApproach({ ...signed, recipient: { ...signed.recipient, subjectId: "another-person" } }, ctx))).rejects.toThrow("unavailable");
      await sender.run((ctx) => handleContactBlockSet({ actor: profile.actor, blocked: true }, ctx));
      await expect(sender.run((ctx) => claimApproach(signed, ctx))).rejects.toThrow("no longer available");
      await sender.run((ctx) => handleContactBlockSet({ actor: profile.actor, blocked: false }, ctx));
      await expect(sender.run((ctx) => claimApproach(signed, ctx))).rejects.toThrow("no longer available");
      expect(await sender.run((ctx) => ctx.federation.contactCount())).toBe(0);
      expect((await sender.run((ctx) => ctx.approaches.get(created.id)))?.summary.state).toBe("blocked");
    });
  });

  it("withdraws an unclaimed request, retains its first decision and never creates an active contact", async () => {
    await withSpaces(async (sender, recipient, profile) => {
      installTransport(sender, recipient, profile);
      const created = (await sender.run((ctx) => handleApproachCreate(sendIntent(profile), ctx))).approach;
      await sender.run(processApproachMaintenance);
      const incoming = (await recipient.run((ctx) => ctx.approaches.list(OWNER.uid, { direction: "incoming", limit: 10 })))[0];
      await sender.run((ctx) => handleApproachDecide({ approachId: created.id, expectedRevision: created.revision, decision: "withdraw" }, ctx));
      await sender.run(processApproachMaintenance);
      expect((await recipient.run((ctx) => ctx.approaches.get(incoming.id)))?.summary.state).toBe("withdrawn");
      await expect(recipient.run((ctx) => handleApproachDecide({ approachId: incoming.id, expectedRevision: incoming.revision, decision: "accept" }, ctx))).rejects.toThrow("changed");
      expect(await recipient.run((ctx) => ctx.federation.contactCount())).toBe(0);
    });
  });
});

function sendIntent(profile: PublicProfile): ApproachCreateArgs {
  return { profileUrl: profile.url, recipient: profile.actor, profileRevision: profile.revision,
    displayName: "A chosen sender name", text: "Hello, I would like to ask about GSV.", idempotencyKey: "first-message" };
}

type TestSpace = { installationId: string; run<T>(work: (ctx: KernelContext) => T | Promise<T>): Promise<T> };

function testSpace(name: string): TestSpace {
  const installationId = `inst_${crypto.randomUUID()}`;
  const stub = env.KERNEL.getByName(installationId);
  return { installationId, run: <T>(work: (ctx: KernelContext) => T | Promise<T>) =>
    runInDurableObject(stub, (_instance: Kernel, state) => work(spaceContext(state.storage, name, installationId))) };
}

async function withSpaces(work: (sender: TestSpace, recipient: TestSpace, profile: PublicProfile) => Promise<void>): Promise<void> {
  const sender = testSpace("sender");
  const recipient = testSpace("recipient");
  const profile = await recipient.run(async (ctx) => {
    handleProfileUpdate({ expectedRevision: 0, draft: { alias: "person", displayName: "Published recipient", about: "Hello", contactPolicy: "requests", representation: "human" } }, ctx);
    await handleProfilePublish({ expectedRevision: 1 }, ctx);
    const publication = ctx.profiles.publication(OWNER.uid)!.profile;
    await processProfilePublication(OWNER.uid, ctx);
    return publication;
  });
  await work(sender, recipient, profile);
}

function installTransport(sender: TestSpace, recipient: TestSpace, profile: PublicProfile, afterResponse?: (path: string) => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === profile.url) return Response.json(profile);
    const destination = url.origin === "https://sender.example" ? sender : recipient;
    const requestBody = await request.text();
    const method = request.method;
    const result = await destination.run(async (ctx) => {
      const response = await handleFederationHttpRequest(new Request(url.href, { method, ...(method === "POST" ? { body: requestBody } : undefined) }), ctx);
      return { status: response.status, body: await response.text(), headers: [...response.headers] };
    });
    if (result.status >= 200 && result.status < 300) afterResponse?.(url.pathname);
    return new Response(result.body, { status: result.status, headers: result.headers });
  });
}

function spaceContext(storage: DurableObjectStorage, name: string, installationId: string): KernelContext {
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
