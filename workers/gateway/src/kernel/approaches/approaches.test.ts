import { reset } from "cloudflare:test";
import {
  ACCEPT_MESSAGE_REQUEST, SEND_MESSAGE_REQUEST, WITHDRAW_MESSAGE_REQUEST,
  type ApproachCreateArgs, type ApproachSummary, type JsonValue, type ProfileContactPolicy, type PublicProfile,
} from "@humansandmachines/gsv/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as transport from "../../shared/utils";
import { getConversationById } from "../../shared/utils";
import { serviceAuthToken, TestShipNetwork, type TestDidAccount } from "../../test-support/ship-network";
import { loseNextAnswer, SPACE_OWNER_UID, testSpace, type TestSpace } from "../../test-support/ship-spaces";
import type { KernelContext } from "../context";
import type { ProcessRecord } from "../processes";
import { handleContactSend, processFederationDelivery } from "../federation";
import { handleContactBlockList, handleContactBlockSet } from "../federation/preferences";
import { handleProfileGet, handleProfilePublish, handleProfileUnpublish, handleProfileUpdate, readPublicProfile } from "../profiles";
import { handleApproachCreate, handleApproachDecide, handleApproachGet, handleApproachList, handleApproachRetry } from "./admission";
import { expireOverdueApproach, processApproachMaintenance } from "./runtime";

let network: TestShipNetwork;
let alice: TestSpace;
let bob: TestSpace;
let mallory: TestSpace;
/** Bob's profile as Alice's Ship reads it. */
let profile: PublicProfile;

beforeEach(async () => {
  network = new TestShipNetwork().install();
  [alice, bob, mallory] = [await testSpace(network, "alice"), await testSpace(network, "bob"), await testSpace(network, "mallory")];
  profile = await publishProfile(bob, "requests");
});

afterEach(async () => {
  // Maintenance alarms belong to this test's Kernels, not the next test's network.
  await reset();
  vi.restoreAllMocks();
});

describe("message requests", () => {
  it.each([false, true])("connects two people once a request is accepted, through lost answers (sender's Ship handles messages=%s)", async (shipHandlesMessages) => {
    const input = { ...request(profile), shipHandlesMessages };
    const created = (await alice.run((ctx) => handleApproachCreate(input, held(ctx)))).approach;
    expect(created).toMatchObject({ state: "preparing", direction: "outgoing", peerDid: bob.account.did, peerHandle: "bob.ship.test", displayName: "Bob Builder" });
    expect((await alice.run((ctx) => handleApproachCreate(input, held(ctx)))).approach.id).toBe(created.id);
    await expect(alice.run((ctx) => handleApproachCreate({ ...input, shipHandlesMessages: !shipHandlesMessages }, held(ctx)))).rejects.toThrow("different content");

    // Bob's Ship takes the request in, but its answer never reaches Alice's.
    loseNextAnswer(network, bob, SEND_MESSAGE_REQUEST);
    await alice.run((ctx) => processApproachMaintenance(held(ctx)));
    const [received] = await incomingRequests(bob);
    expect(received).toMatchObject({
      state: "pending", delivery: "received", requestId: created.requestId,
      peerDid: alice.account.did, peerHandle: "alice.ship.test", displayName: "Alice in the open",
    });
    expect((await alice.run((ctx) => ctx.approaches.get(created.id)))?.summary.delivery).toBe("queued");
    expect(await bob.run((ctx) => ctx.federation.contactCount())).toBe(0);
    // Sending again reaches the same request.
    await alice.run((ctx) => handleApproachRetry({ approachId: created.id, expectedRevision: created.revision }, held(ctx)));
    await alice.run((ctx) => processApproachMaintenance(held(ctx)));
    expect((await alice.run((ctx) => ctx.approaches.get(created.id)))?.summary.delivery).toBe("received");
    expect(await incomingRequests(bob)).toEqual([received]);

    // Bob accepts. Alice's Ship makes the connection, and its answer is lost too.
    const accepting = (await bob.run((ctx) => handleApproachDecide({
      approachId: received.id, expectedRevision: received.revision, decision: "accept", shipHandlesMessages: !shipHandlesMessages,
    }, held(ctx)))).approach;
    expect(accepting).toMatchObject({ state: "accepting", connection: "connecting" });
    loseNextAnswer(network, alice, ACCEPT_MESSAGE_REQUEST);
    await bob.run((ctx) => processApproachMaintenance(held(ctx)));
    const sent = (await alice.run((ctx) => ctx.approaches.get(created.id)))!;
    expect(sent.summary).toMatchObject({ state: "accepted", connection: "connected" });
    expect((await bob.run((ctx) => ctx.approaches.get(received.id)))?.summary).toMatchObject({ state: "accepting", connection: "connecting" });
    expect(await bob.run((ctx) => ctx.federation.getByRemote(SPACE_OWNER_UID, alice.account.did))).toBeNull();
    // Bob's Ship asks again and hears of the same connection.
    await bob.run((ctx) => handleApproachRetry({ approachId: received.id, expectedRevision: accepting.revision }, held(ctx)));
    await bob.run((ctx) => processApproachMaintenance(held(ctx)));
    const accepted = (await bob.run((ctx) => ctx.approaches.get(received.id)))!;
    expect(accepted.summary).toMatchObject({ state: "accepted", connection: "connected" });
    expect(accepted.generation).toBe(sent.generation);

    expect(await alice.run((ctx) => ctx.federation.getByRemote(SPACE_OWNER_UID, bob.account.did))).toMatchObject({
      state: "active", remoteName: "Bob Builder", remoteHandle: "bob.ship.test", generation: sent.generation, threadId: sent.threadId,
      preferences: { saved: false, shipHandlesMessages },
    });
    expect(await bob.run((ctx) => ctx.federation.getByRemote(SPACE_OWNER_UID, alice.account.did))).toMatchObject({
      state: "active", remoteName: "Alice in the open", remoteHandle: "alice.ship.test", generation: sent.generation, threadId: sent.threadId,
      preferences: { saved: false, shipHandlesMessages: !shipHandlesMessages },
    });
    // Each side keeps the first message, named as its sender's Ship names it.
    expect(accepted.messageId).toBe(sent.messageId);
    for (const [space, record] of [[alice, sent], [bob, accepted]] as const) {
      const history = await getConversationById(space.installationId, record.summary.conversationId).history();
      expect(history.messages).toMatchObject([{
        text: input.text,
        social: { reference: { did: alice.account.did, messageId: sent.messageId }, threadId: sent.threadId, provenance: { kind: "human" } },
      }]);
    }
  });

  it("keeps a message for later when it reaches a Ship still accepting the request", async () => {
    await sendRequest();
    const [received] = await incomingRequests(bob);
    const accepting = (await bob.run((ctx) => handleApproachDecide({
      approachId: received.id, expectedRevision: received.revision, decision: "accept", shipHandlesMessages: false,
    }, held(ctx)))).approach;
    // Alice's Ship makes the connection before Bob's does, and its answer is lost.
    loseNextAnswer(network, alice, ACCEPT_MESSAGE_REQUEST);
    await bob.run((ctx) => processApproachMaintenance(held(ctx)));
    const deliveryId = await alice.run(async (ctx) => {
      const contact = ctx.federation.getByRemote(SPACE_OWNER_UID, bob.account.did)!;
      const { deliveryId } = await handleContactSend({ contactId: contact.id, idempotencyKey: "thanks", text: "Thanks for accepting" }, held(ctx));
      await processFederationDelivery(deliveryId, held(ctx));
      return deliveryId;
    });
    expect((await alice.run((ctx) => ctx.federation.outbox(deliveryId)))?.state).toBe("pending");
    // Bob's Ship asks again and hears of the same connection, and the message arrives when Alice's Ship tries again.
    await bob.run((ctx) => handleApproachRetry({ approachId: received.id, expectedRevision: accepting.revision }, held(ctx)));
    await bob.run((ctx) => processApproachMaintenance(held(ctx)));
    await alice.run((ctx) => processFederationDelivery(deliveryId, held(ctx)));
    expect((await alice.run((ctx) => ctx.federation.outbox(deliveryId)))?.state).toBe("delivered");
  });

  it("lets the owner's canonical Ship send a request and read it back, but not other processes", async () => {
    const procs = { get: (pid: string): Pick<ProcessRecord, "isPersonalController" | "ownerUid"> | null => ({ isPersonalController: pid === "proc:ship", ownerUid: SPACE_OWNER_UID }) };
    // SAFETY: the authority check reads only the calling process's controller flag and owner from the registry.
    const asProcess = (ctx: KernelContext, processId: string) => ({ ...held(ctx), processId, procs } as KernelContext);
    await expect(alice.run((ctx) => handleApproachCreate(request(profile), asProcess(ctx, "proc:crew")))).rejects.toThrow("signed-in human or their Ship");
    const sent = (await alice.run((ctx) => handleApproachCreate({ ...request(profile), shipHandlesMessages: false }, asProcess(ctx, "proc:ship")))).approach;
    expect((await alice.run((ctx) => handleApproachGet({ approachId: sent.id }, asProcess(ctx, "proc:ship")))).approach.id).toBe(sent.id);
    expect((await alice.run((ctx) => handleApproachList({ direction: "outgoing" }, asProcess(ctx, "proc:ship")))).approaches.map((entry) => entry.id)).toEqual([sent.id]);
    await expect(alice.run((ctx) => handleApproachList({ direction: "incoming" }, asProcess(ctx, "proc:ship")))).rejects.toThrow("signed-in human");
    await alice.run((ctx) => processApproachMaintenance(held(ctx)));
    const [received] = await incomingRequests(bob);
    await expect(bob.run((ctx) => handleApproachGet({ approachId: received.id }, asProcess(ctx, "proc:ship")))).rejects.toThrow("signed-in human");
    await expect(bob.run((ctx) => handleApproachRetry({ approachId: received.id, expectedRevision: received.revision }, asProcess(ctx, "proc:ship")))).rejects.toThrow("signed-in human");
    await expect(alice.run((ctx) => handleApproachDecide({ approachId: sent.id, expectedRevision: sent.revision, decision: "withdraw" }, asProcess(ctx, "proc:ship")))).rejects.toThrow("signed-in human");
    await alice.run((ctx) => handleApproachDecide({ approachId: sent.id, expectedRevision: sent.revision, decision: "withdraw" }, held(ctx)));
  });

  it("asks the owner before their Ship sends a message request, naming who it goes to, and sends nothing when refused", async () => {
    const procs = { get: (pid: string): Pick<ProcessRecord, "isPersonalController" | "ownerUid"> | null => ({ isPersonalController: pid === "proc:ship", ownerUid: SPACE_OWNER_UID }) };
    // SAFETY: the authority check reads only the calling process's controller flag and owner; the tool owner names the Ship's run.
    const asShipTool = (ctx: KernelContext) => ({ ...held(ctx), processId: "proc:ship", procs, toolOwner: { runId: "run", requestId: "shell" } } as KernelContext);
    const authorize = vi.spyOn(transport, "sendFrameToProcess").mockResolvedValue({ type: "res", id: "approval", ok: true, data: { approved: false } });
    await expect(alice.run((ctx) => handleApproachCreate({ ...request(profile), shipHandlesMessages: false }, asShipTool(ctx)))).rejects.toThrow("not approved");
    expect(authorize).toHaveBeenCalledWith(alice.installationId, "proc:ship", expect.objectContaining({
      call: "proc.tool.authorize",
      args: expect.objectContaining({
        syscall: "approach.create", defaultAction: "ask",
        args: expect.objectContaining({ recipient: "bob.ship.test", did: bob.account.did }),
      }),
    }));
    expect(await alice.run((ctx) => ctx.approaches.list(SPACE_OWNER_UID, { direction: "outgoing", limit: 10 }))).toEqual([]);
    authorize.mockResolvedValue({ type: "res", id: "approval", ok: true, data: { approved: true } });
    const sent = (await alice.run((ctx) => handleApproachCreate({ ...request(profile), shipHandlesMessages: false }, asShipTool(ctx)))).approach;
    expect((await alice.run((ctx) => ctx.approaches.list(SPACE_OWNER_UID, { direction: "outgoing", limit: 10 }))).map((entry) => entry.id)).toEqual([sent.id]);
  });

  it("asks before a direct Ship syscall sends a message request, deriving the run that owns it", async () => {
    const procs = { get: (pid: string): Pick<ProcessRecord, "isPersonalController" | "ownerUid"> | null => ({ isPersonalController: pid === "proc:ship", ownerUid: SPACE_OWNER_UID }) };
    // SAFETY: a direct process syscall carries the process, run and request ids but no tool owner.
    const asShipSyscall = (ctx: KernelContext) => ({ ...held(ctx), processId: "proc:ship", processRunId: "run:direct", requestId: "req:direct", procs } as KernelContext);
    const authorize = vi.spyOn(transport, "sendFrameToProcess").mockResolvedValue({ type: "res", id: "approval", ok: true, data: { approved: false } });
    await expect(alice.run((ctx) => handleApproachCreate({ ...request(profile), shipHandlesMessages: false }, asShipSyscall(ctx)))).rejects.toThrow("not approved");
    expect(authorize).toHaveBeenCalledWith(alice.installationId, "proc:ship", expect.objectContaining({
      call: "proc.tool.authorize",
      args: expect.objectContaining({ runId: "run:direct", requestId: "req:direct", syscall: "approach.create", defaultAction: "ask" }),
    }));
    expect(await alice.run((ctx) => ctx.approaches.list(SPACE_OWNER_UID, { direction: "outgoing", limit: 10 }))).toEqual([]);
  });

  it("checks the profile again once the owner approves, since it can change while they decide", async () => {
    const procs = { get: (pid: string): Pick<ProcessRecord, "isPersonalController" | "ownerUid"> | null => ({ isPersonalController: pid === "proc:ship", ownerUid: SPACE_OWNER_UID }) };
    // SAFETY: the authority check reads only the calling process's controller flag and owner; the tool owner names the Ship's run.
    const asShipTool = (ctx: KernelContext) => ({ ...held(ctx), processId: "proc:ship", procs, toolOwner: { runId: "run", requestId: "shell" } } as KernelContext);
    vi.spyOn(transport, "sendFrameToProcess").mockImplementation(async () => {
      await publishProfile(bob, "requests", "Hello again");
      return { type: "res", id: "approval", ok: true, data: { approved: true } };
    });
    await expect(alice.run((ctx) => handleApproachCreate({ ...request(profile), shipHandlesMessages: false }, asShipTool(ctx)))).rejects.toThrow("This profile changed; review it again before sending");
    expect(await alice.run((ctx) => ctx.approaches.list(SPACE_OWNER_UID, { direction: "outgoing", limit: 10 }))).toEqual([]);
  });

  it("sends a request only to the version of the profile its sender read, while it takes requests", async () => {
    const changed = await publishProfile(bob, "requests", "Hello again");
    expect(changed.cid).not.toBe(profile.cid);
    await expect(alice.run((ctx) => handleApproachCreate(request(profile), held(ctx)))).rejects.toThrow("This profile changed; review it again before sending");
    const closed = await publishProfile(bob, "invitation");
    await expect(alice.run((ctx) => handleApproachCreate(request(closed), held(ctx)))).rejects.toThrow("This person is not receiving new message requests");
    expect(await alice.run((ctx) => ctx.approaches.list(SPACE_OWNER_UID, { direction: "outgoing", limit: 10 }))).toEqual([]);
  });

  it.each(["changed", "unpublished"] as const)("refuses a request once the profile its sender read has %s", async (change) => {
    const { approach } = await alice.run((ctx) => handleApproachCreate(request(profile), held(ctx)));
    if (change === "changed") await publishProfile(bob, "requests", "Hello again");
    else await bob.run(async (ctx) => void await handleProfileUnpublish({ expectedRevision: handleProfileGet(ctx).profile.revision }, ctx));
    await alice.run((ctx) => processApproachMaintenance(held(ctx)));
    expect((await alice.run((ctx) => ctx.approaches.get(approach.id)))?.summary.delivery).toBe("failed");
    expect(await incomingRequests(bob)).toEqual([]);
  });

  it("answers a sender its person blocked as a closed profile would", async () => {
    await bob.run((ctx) => handleContactBlockSet({ did: alice.account.did, blocked: true }, ctx));
    const content = {
      requestId: "request:blocked", profileCid: profile.cid, name: "Alice", messageId: "msg:blocked",
      text: "Hello?", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    };
    const blocked = await callShipMethod(alice.account, bob, SEND_MESSAGE_REQUEST, content);
    // A CID, but not of the profile Bob's Ship publishes now.
    const stale = "bafyreihf2w4xce4657vtnvxnxgjy7isgoqgjbwraanrgjb7lfvozmrvoyy";
    const closed = await callShipMethod(mallory.account, bob, SEND_MESSAGE_REQUEST, { ...content, profileCid: stale });
    expect(closed.status).toBe(404);
    expect([blocked.status, await blocked.json()]).toEqual([closed.status, await closed.json()]);
    expect(await incomingRequests(bob)).toEqual([]);
  });

  it("reads a message request without the fields a later version adds, rather than refusing it", async () => {
    const content = {
      requestId: "request:later", profileCid: profile.cid, name: "Alice", messageId: "msg:later",
      text: "Hello from a later Ship", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    };
    const later = await callShipMethod(alice.account, bob, SEND_MESSAGE_REQUEST, { ...content, pronouns: "she/her" });
    expect([later.status, await later.json()]).toEqual([200, { state: "received" }]);
    // Read without the field, it's the request sent again, so it's answered as a repeat rather than a replay.
    const again = await callShipMethod(alice.account, bob, SEND_MESSAGE_REQUEST, content);
    expect([again.status, await again.json()]).toEqual([200, { state: "received" }]);
    expect((await incomingRequests(bob)).map((request) => request.peerDid)).toEqual([alice.account.did]);
  });

  it("lets only the person a request went to accept it, and a block ends it", async () => {
    const sent = await sendRequest();
    const forged = await callShipMethod(mallory.account, alice, ACCEPT_MESSAGE_REQUEST, { requestId: sent.requestId, name: "Bob" });
    expect([forged.status, (await forged.json<{ error: string }>()).error]).toEqual([404, "NotFound"]);
    await alice.run((ctx) => handleContactBlockSet({ did: bob.account.did, blocked: true }, ctx));
    expect((await callShipMethod(bob.account, alice, ACCEPT_MESSAGE_REQUEST, { requestId: sent.requestId, name: "Bob" })).status).toBe(410);
    await alice.run((ctx) => handleContactBlockSet({ did: bob.account.did, blocked: false }, ctx));
    expect((await callShipMethod(bob.account, alice, ACCEPT_MESSAGE_REQUEST, { requestId: sent.requestId, name: "Bob" })).status).toBe(410);
    expect(await alice.run((ctx) => ctx.federation.contactCount())).toBe(0);
    expect((await alice.run((ctx) => ctx.approaches.get(sent.id)))?.summary.state).toBe("blocked");
  });

  it("lets only its sender withdraw a request, which then can't be accepted", async () => {
    const sent = await sendRequest();
    const [received] = await incomingRequests(bob);
    const forged = await callShipMethod(mallory.account, bob, WITHDRAW_MESSAGE_REQUEST, { requestId: sent.requestId });
    expect(forged.status).toBe(404);
    expect((await bob.run((ctx) => ctx.approaches.get(received.id)))?.summary.state).toBe("pending");
    await alice.run((ctx) => handleApproachDecide({ approachId: sent.id, expectedRevision: sent.revision, decision: "withdraw" }, held(ctx)));
    await alice.run((ctx) => processApproachMaintenance(held(ctx)));
    expect((await bob.run((ctx) => ctx.approaches.get(received.id)))?.summary.state).toBe("withdrawn");
    await expect(bob.run((ctx) => handleApproachDecide({ approachId: received.id, expectedRevision: received.revision, decision: "accept" }, held(ctx)))).rejects.toThrow("changed");
    expect(await bob.run((ctx) => ctx.federation.contactCount())).toBe(0);
  });

  it("expires one overdue request directly, so a replacement isn't refused by its pending row", async () => {
    const { approach } = await alice.run((ctx) => handleApproachCreate(request(profile), held(ctx)));
    const record = (await alice.run((ctx) => ctx.approaches.get(approach.id)))!;
    await alice.run((ctx) => expireOverdueApproach(record, ctx));
    expect((await alice.run((ctx) => ctx.approaches.get(approach.id)))?.summary.state).not.toBe("expired");
    const clock = vi.spyOn(Date, "now").mockReturnValue(approach.expiresAtMs + 1);
    await alice.run((ctx) => expireOverdueApproach(record, ctx));
    expect((await alice.run((ctx) => ctx.approaches.get(approach.id)))?.summary.state).toBe("expired");
    expect(await alice.run((ctx) => ctx.approaches.unresolved(SPACE_OWNER_UID, bob.account.did))).toBeNull();
    clock.mockRestore();
  });

  it("keeps a named entry to unblock after an unaccepted request is cleaned up", async () => {
    const { approach } = await alice.run((ctx) => handleApproachCreate(request(profile), held(ctx)));
    await alice.run((ctx) => handleContactBlockSet({ did: bob.account.did, blocked: true }, ctx));
    await alice.run((ctx) => {
      ctx.approaches.removeSettled(approach.id, Date.now() + 9 * 24 * 60 * 60_000);
      expect(ctx.approaches.get(approach.id)).toBeNull();
      expect(handleContactBlockList({}, ctx).blocks).toEqual([expect.objectContaining({ did: bob.account.did, displayName: "Bob Builder" })]);
    });
    await alice.run((ctx) => handleContactBlockSet({ did: bob.account.did, blocked: false }, ctx));
    expect(await alice.run((ctx) => handleContactBlockList({}, ctx).blocks)).toEqual([]);
  });
});

function request(read: PublicProfile): ApproachCreateArgs {
  return { did: read.did, profileCid: read.cid, displayName: "Alice in the open", text: "Hello, I'd like to ask about your boat.", idempotencyKey: "first-message" };
}

/** Publishes the space's profile with a contact policy, and reads it back as Alice's Ship would. */
async function publishProfile(space: TestSpace, contactPolicy: ProfileContactPolicy, about = "Hello"): Promise<PublicProfile> {
  await space.run(async (ctx) => {
    const { revision } = handleProfileGet(ctx).profile;
    handleProfileUpdate({ expectedRevision: revision, draft: { displayName: "Bob Builder", about, contactPolicy } }, ctx);
    await handleProfilePublish({ expectedRevision: revision + 1 }, ctx);
  });
  return await alice.run((ctx) => readPublicProfile(space.account.did, ctx));
}

/** Alice sends Bob a request, and her Ship delivers it. */
async function sendRequest(): Promise<ApproachSummary> {
  const { approach } = await alice.run((ctx) => handleApproachCreate(request(profile), held(ctx)));
  await alice.run((ctx) => processApproachMaintenance(held(ctx)));
  return approach;
}

async function incomingRequests(space: TestSpace): Promise<ApproachSummary[]> {
  return (await space.run((ctx) => handleApproachList({ direction: "incoming" }, ctx))).approaches;
}

/** The space's context with its alarms held, so the test runs maintenance and deliveries when it chooses. */
function held(ctx: KernelContext): KernelContext {
  return { ...ctx, scheduleApproachMaintenance: async () => {}, scheduleFederationDelivery: async () => {} };
}

/** Calls a Ship method on a space as `caller`, the way another Ship would. */
async function callShipMethod(caller: TestDidAccount, to: TestSpace, nsid: string, input: JsonValue): Promise<Response> {
  return await fetch(`https://${to.hostname}/xrpc/${nsid}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await serviceAuthToken(caller, to.account, nsid)}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
