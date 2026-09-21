import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonValueSchema,
  type ConversationMessage,
  type FederationDeliveryEnvelope,
  type FederationDeliveryPayload,
  type FederationMessageDeliveryV2,
  type FederationDeliveryEnvelopeV2,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type {
  Conversation,
  ConversationAppendRequest,
} from "../conversation/do";
import * as nativeFs from "../drivers/native/fs";
import { getKernelByInstallationId } from "../installation/routing";
import * as utils from "../shared/utils";
import type { AuthStore } from "./auth-store";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { testPeer } from "../test-support/peers";
import * as federationCrypto from "./federation-crypto";
import type { Kernel } from "./do";
import {
  randomBase64Url,
  signContactEnvelope,
  sha256Base64Url,
} from "./federation-crypto";
import type { FederationContactRecord, FederationStore } from "./federation-store";
import type { ProcessRegistry } from "./processes";
import * as personalController from "./personal-controller";
import type { ResponsibilityStore } from "./responsibility-store";
import { syncFederationRequestResponsibility } from "./federation/requests";

const OWNER: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [100, 1000],
  username: "hank",
  home: "/home/hank",
  cwd: "/home/hank",
};
const SHIP_PID = "proc:test-ship";
const REMOTE_SHIP_ID = "ship:remote";
const REMOTE_SUBJECT_ID = "subject:remote";

type KernelInternals = {
  auth: AuthStore;
  federation: FederationStore;
  procs: ProcessRegistry;
  responsibilities: ResponsibilityStore;
  pendingFederationInbound: Map<string, Promise<unknown>>;
  coordinateFederationContact: <Value>(
    contactId: string,
    operation: () => Value | Promise<Value>,
  ) => Promise<Value>;
};

describe("federation inbound boundary", () => {
  let kernel: DurableObjectStub<Kernel>;
  let installationId: string;
  let contact: FederationContactRecord;
  let recipientSubjectId: string;
  let sharedSecret: string;
  let messages: ConversationMessage[];
  let getConversationById: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installationId = `inst_federation_inbound_${crypto.randomUUID()}`;
    kernel = await getKernelByInstallationId(env.KERNEL, installationId);
    sharedSecret = randomBase64Url(32);
    messages = [];
    vi.spyOn(personalController, "ensurePersonalController")
      .mockResolvedValue(SHIP_PID);
    getConversationById = vi.spyOn(utils, "getConversationById")
      .mockImplementation((_installationId, conversationId) => fakeConversation(
        conversationId,
        messages,
      ));
    const state = await runInDurableObject(kernel, async (instance: Kernel) => {
      await instance.ensureInstallationIdentity({
        installationId,
        handle: "local",
        canonicalOrigin: "https://local.example",
      });
      const internal = kernelInternals(instance);
      internal.auth.addUser({
        username: OWNER.username,
        uid: OWNER.uid,
        gid: OWNER.gid,
        gecos: OWNER.username,
        home: OWNER.home,
        shell: "/bin/init",
      });
      internal.auth.addGroup({ name: "users", gid: 100, members: [OWNER.username] });
      internal.auth.addGroup({ name: OWNER.username, gid: OWNER.gid, members: [] });
      internal.procs.spawn(SHIP_PID, OWNER, {
        ownerUid: OWNER.uid,
        interactive: true,
        isPersonalController: true,
      });
      const subject = internal.federation.ensureSubject(OWNER.uid, OWNER.username, 1_000);
      const activated = internal.federation.activateContact({
        ownerUid: OWNER.uid,
        remoteShipId: REMOTE_SHIP_ID,
        remoteSubject: { id: REMOTE_SUBJECT_ID, displayName: "Remote" },
        remoteOrigin: "https://remote.example",
        remotePublicKey: { kty: "EC", crv: "P-256", x: "remote-x", y: "remote-y" },
        sharedSecret,
        generation: "generation:current",
        threadId: "thread:shared",
        now: 1_000,
      });
      return { contact: activated, recipientSubjectId: subject.id };
    });
    contact = state.contact;
    recipientSubjectId = state.recipientSubjectId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits v2 provenance and replays a version-bound receipt without waking Ship", async () => {
    getConversationById.mockRestore();
    const payload: FederationMessageDeliveryV2 = {
      kind: "message", messageId: "origin:v2", threadId: contact.threadId, text: "Written by my helper",
      social: {
        threadId: contact.threadId,
        reference: { actor: { shipId: REMOTE_SHIP_ID, subjectId: REMOTE_SUBJECT_ID }, messageId: "origin:v2" },
        provenance: { kind: "process", processId: "proc:remote-helper" },
      },
    };
    const envelope = await signedV2Envelope(payload, "delivery:v2");
    const response = await deliverV2(envelope);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ version: 2, domain: "gsv-federation/2/receipt", deliveryId: envelope.deliveryId });
    expect(await (await deliverV2(envelope)).json()).toEqual(receipt);
    const installationId = await runInDurableObject(kernel, (instance: Kernel) => instance.installationId);
    const conversation = utils.getConversationById(installationId, contact.conversationId);
    const history = await conversation.history();
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.social).toEqual(payload.social);
    expect(await conversation.resolveOrigin(payload.social.reference, contact.threadId))
      .toMatchObject({ messageId: history.messages[0]?.id, sequence: 1 });
    expect(vi.mocked(personalController.ensurePersonalController).mock.calls.filter((call) => call[1].installationId === installationId).length).toBe(0);

    const forged = await signedV2Envelope({ ...payload, social: {
      ...payload.social, reference: { ...payload.social.reference, actor: { shipId: "ship:someone-else", subjectId: REMOTE_SUBJECT_ID } },
    } }, "delivery:v2-forged");
    const rejected = await deliverV2(forged);
    expect(rejected.status).toBe(409);
    await rejected.arrayBuffer();
    expect((await conversation.history()).messages).toHaveLength(1);
  });

  it.each([
    ["incoming", "offered", "accepted"],
    ["incoming", "offered", "rejected"],
    ["incoming", "accepted", "active"],
    ["incoming", "active", "completed"],
    ["incoming", "accepted", "cancelled"],
    ["outgoing", "offered", "cancelled"],
  ] as const)("rejects a signed remote %s action from %s to %s without creating a conversation", async (direction, state, next) => {
    await runInDurableObject(kernel, (instance: Kernel) => {
      instance.federation.createRequest({
        id: "request:local", remoteId: direction === "incoming" ? "request:remote" : undefined,
        contactId: contact.id, contactGeneration: contact.generation, direction,
        kind: "task", title: "Participant-owned work", state, createdAtMs: 1_000, updatedAtMs: 1_000,
      });
    });
    const response = await deliver(await signedEnvelope({
      kind: "request.update", requestId: direction === "incoming" ? "request:remote" : "request:local",
      expectedRevision: 1, state: next,
    }, "delivery:wrong-role"));
    expect(response.status).toBe(409);
    await response.arrayBuffer();
    expect(getConversationById).not.toHaveBeenCalled();
    expect(vi.mocked(personalController.ensurePersonalController).mock.calls.filter((call) => call[1].installationId === installationId).length).toBe(0);
    expect(messages).toEqual([]);
    await runInDurableObject(kernel, (instance: Kernel) => {
      expect(instance.federation.request("request:local")).toMatchObject({ state, revision: 1 });
    });
  });

  it("coordinates concurrent duplicates and replays their signed receipt", async () => {
    const receivedAtMs = 50_000;
    vi.spyOn(Date, "now").mockReturnValue(receivedAtMs);
    const envelope = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:1",
      threadId: contact.threadId,
      text: "Hello from another Ship",
    }, "delivery:message");

    const [first, concurrent] = await Promise.all([
      deliver(envelope),
      deliver(envelope),
    ]);
    const replay = await deliver(envelope);
    expect(first.status).toBe(200);
    expect(concurrent.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await concurrent.json()).toEqual(await first.clone().json());
    expect(await replay.json()).toEqual(await first.json());
    expect(messages).toHaveLength(1);
    expect(vi.mocked(personalController.ensurePersonalController).mock.calls.filter((call) => call[1].installationId === installationId).length).toBe(0);
    await runInDurableObject(kernel, (instance: Kernel) => {
      expect(instance.conversations.get(contact.conversationId)?.handlerPid).toBeUndefined();
    });
    expect(messages[0]).toMatchObject({
      text: "Hello from another Ship",
      author: { kind: "contact", contactId: contact.id, displayName: "Remote" },
      origin: { kind: "federation", contactId: contact.id, deliveryId: "delivery:message" },
      createdAt: receivedAtMs,
    });
  });

  it("rejects new delivery after owner removal while preserving committed replay and another owner", async () => {
    const accepted = await signedEnvelope({ kind: "message", messageId: "remote:accepted", threadId: contact.threadId, text: "Already admitted" }, "delivery:accepted");
    const receipt = await (await deliver(accepted)).json();
    await runInDurableObject(kernel, removeOwner);
    expect((await deliver(accepted)).status).toBe(200);
    expect(await (await deliver(accepted)).json()).toEqual(receipt);
    const denied = await signedEnvelope({ kind: "message", messageId: "remote:denied", threadId: contact.threadId, text: "New work" }, "delivery:denied");
    expect((await deliver(denied)).status).toBe(404);
    expect(await runInDurableObject(kernel, (instance: Kernel) => instance.federation.inbox(contact.id, contact.generation, denied.deliveryId))).toBeNull();
    expect(messages).toHaveLength(1);
    const newRequest = await signedEnvelope({
      kind: "request",
      request: { id: "request:new", kind: "task", title: "New work", state: "offered", revision: 1 },
    }, "delivery:new-request");
    expect((await deliver(newRequest)).status).toBe(404);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      instance.federation.inbox(contact.id, contact.generation, newRequest.deliveryId)
    ))).toBeNull();

    const control = await runInDurableObject(kernel, (instance: Kernel) => {
      instance.auth.addUser({ username: "control", uid: 1001, gid: 1001, gecos: "Control", home: "/home/control", shell: "/bin/init" });
      const subject = instance.federation.ensureSubject(1001, "Control");
      return { subject, contact: instance.federation.activateContact({ ownerUid: 1001, remoteShipId: REMOTE_SHIP_ID,
        remoteSubject: contact.remoteSubject, remoteOrigin: contact.remoteOrigin, remotePublicKey: contact.remotePublicKey,
        sharedSecret, generation: "generation:control", threadId: "thread:control" }) };
    });
    contact = control.contact;
    recipientSubjectId = control.subject.id;
    expect((await deliver(await signedEnvelope({ kind: "message", messageId: "remote:control", threadId: contact.threadId, text: "Control work" }, "delivery:control"))).status).toBe(200);
    expect(messages).toHaveLength(2);
  });

  it("rechecks removal after a delivery waits for contact coordination", async () => {
    const envelope = await signedEnvelope({ kind: "message", messageId: "remote:held", threadId: contact.threadId, text: "Not admitted yet" }, "delivery:held");
    const status = await runInDurableObject(kernel, async (instance: Kernel) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ahead = instance.federationRuntime.coordinateFederationContact(contact.id, () => gate);
      const pending = instance.fetch(new Request("https://local.example/_gsv/federation/v1/deliver", { method: "POST", body: JSON.stringify(envelope) }));
      await vi.waitFor(() => expect(instance.federationRuntime.pendingFederationInbound.size).toBe(1));
      await removeOwner(instance);
      release();
      await ahead;
      const response = await pending;
      await response.arrayBuffer();
      expect(instance.federation.inbox(contact.id, contact.generation, envelope.deliveryId)).toBeNull();
      return response.status;
    });
    expect(status).toBe(404);
    expect(messages).toEqual([]);
  });

  it.each([false, true])("fences new invite claims while preserving accepted receipt replay=%s", async (acceptedBeforeRemoval) => {
    const remote = env.KERNEL.getByName(`inst_federation_remote_${crypto.randomUUID()}`);
    const document = await runInDurableObject(remote, (instance: Kernel) => instance.federationIdentity.ensure("https://remote-invite.example"));
    const token = randomBase64Url(32);
    const tokenHash = await sha256Base64Url(token);
    await runInDurableObject(kernel, async (instance: Kernel) => {
      const local = await instance.federationIdentity.ensure("https://local.example");
      instance.federation.createInvite({ ownerUid: OWNER.uid, tokenHash, issuingShipId: local.shipId,
        issuingOrigin: local.origin, expiresAtMs: Date.now() + 60_000 });
    });
    const accept = () => new Request("https://local.example/_gsv/federation/v1/invites/accept", { method: "POST", body: JSON.stringify({ version: 1, token, document, subject: { id: "subject:invite", displayName: "Remote invite" } }) });
    const receipt = acceptedBeforeRemoval ? await (await kernel.fetch(accept())).json() : null;
    const result = await runInDurableObject(kernel, async (instance: Kernel) => {
      const sign = instance.federationIdentity.sign.bind(instance.federationIdentity);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const signed = vi.spyOn(instance.federationIdentity, "sign").mockImplementation(async (value) => { const result = await sign(value); await gate; return result; });
      const pending = instance.fetch(accept());
      await vi.waitFor(() => expect(signed).toHaveBeenCalled());
      await removeOwner(instance);
      release();
      const response = await pending;
      return { status: response.status, body: await response.json(), invite: instance.federation.inviteByTokenHash(tokenHash)?.state };
    });
    expect(result.status).toBe(acceptedBeforeRemoval ? 200 : 410);
    expect(result.invite).toBe(acceptedBeforeRemoval ? "accepted" : "issued");
    if (acceptedBeforeRemoval) expect(result.body).toEqual(receipt);
  });

  it("rejects a new resource lease after removal during signature verification", async () => {
    const verify = federationCrypto.verifyContactEnvelope;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const verified = vi.spyOn(federationCrypto, "verifyContactEnvelope").mockImplementation(async (...args) => { const result = await verify(...args); await gate; return result; });
    const open = vi.spyOn(nativeFs, "handleFsTransferSend").mockImplementation(async () => resourceResponse(new ReadableStream({ start(controller) { controller.close(); } })));
    const status = await runInDurableObject(kernel, async (instance: Kernel) => {
      const resource = createLocalResourceGrant(instance.federation, contact);
      const pending = instance.fetch(await signedResourceRequest(resource.id));
      await vi.waitFor(() => expect(verified).toHaveBeenCalled());
      await removeOwner(instance);
      release();
      const response = await pending;
      await response.arrayBuffer();
      return response.status;
    });
    expect(status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects tampering and delivery-id reuse before committing another message", async () => {
    const envelope = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:1",
      threadId: contact.threadId,
      text: "Original",
    }, "delivery:message");
    expect((await deliver(envelope)).status).toBe(200);

    const tampered = { ...envelope, payload: { ...envelope.payload, text: "Tampered" } };
    expect((await deliver(tampered)).status).toBe(401);
    const reused = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:2",
      threadId: contact.threadId,
      text: "Changed with a valid signature",
    }, "delivery:message");
    expect((await deliver(reused)).status).toBe(409);
    expect(messages).toHaveLength(1);
  });

  it("rejects malformed resource identifiers before admitting inbox work", async () => {
    const envelope = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:invalid-resource",
      threadId: contact.threadId,
      text: "This must not consume inbox capacity",
      resources: [{
        id: "invalid",
        revision: "revision:remote",
        contentType: "image/png",
        size: 10,
      }],
    }, "delivery:invalid-resource");

    expect((await deliver(envelope)).status).toBe(400);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.pendingInboxCount(contact.id)
    ))).toBe(0);
    expect(messages).toEqual([]);
  });

  it("rejects incomplete messages before admitting inbox work", async () => {
    const empty = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:empty",
      threadId: contact.threadId,
      text: " \t ",
    }, "delivery:empty-message");

    expect((await deliver(empty)).status).toBe(400);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.pendingInboxCount(contact.id)
    ))).toBe(0);
    expect(messages).toEqual([]);
  });

  it("rejects oversized request details before admitting inbox work", async () => {
    const envelope = await signedEnvelope({
      kind: "request",
      request: {
        id: "request:oversized",
        kind: "task",
        title: "This must not consume inbox capacity",
        details: { text: "x".repeat(33 * 1024) },
        state: "offered",
        revision: 1,
      },
    }, "delivery:oversized-request");

    expect((await deliver(envelope)).status).toBe(400);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.pendingInboxCount(contact.id)
    ))).toBe(0);
  });

  it("rejects an old-generation delivery queued behind contact replacement", async () => {
    const envelope = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:old-generation",
      threadId: contact.threadId,
      text: "This must not cross the generation boundary",
    }, "delivery:old-generation");
    const result = await runInDurableObject(kernel, async (instance: Kernel) => {
      const internal = kernelInternals(instance);
      let releaseReplacement!: () => void;
      const replacementGate = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      const replacement = internal.federationRuntime.coordinateFederationContact(contact.id, async () => {
        await replacementGate;
        internal.federation.transaction(() => internal.federation.activateContact({
          ownerUid: OWNER.uid,
          remoteShipId: REMOTE_SHIP_ID,
          remoteSubject: { id: REMOTE_SUBJECT_ID, displayName: "Remote replacement" },
          remoteOrigin: "https://remote.example",
          remotePublicKey: { kty: "EC", crv: "P-256", x: "replacement-x", y: "replacement-y" },
          sharedSecret: randomBase64Url(32),
          generation: "generation:replacement",
          threadId: "thread:replacement",
          now: 2_000,
        }));
      });
      const delivery = instance.fetch(new Request(
        "https://local.example/_gsv/federation/v1/deliver",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        },
      ));
      await vi.waitFor(() => {
        expect(internal.federationRuntime.pendingFederationInbound.size).toBe(1);
      });
      releaseReplacement();
      await replacement;
      const response = await delivery;
      await response.arrayBuffer();
      return {
        status: response.status,
        generation: internal.federation.get(contact.id)?.generation,
        pendingInbox: internal.federation.pendingInboxCount(contact.id),
      };
    });
    expect(result).toEqual({
      status: 404,
      generation: "generation:replacement",
      pendingInbox: 0,
    });
    expect(messages).toEqual([]);
  });

  it("finishes a resource read admitted before owner removal", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const cancelSource = vi.fn();
    let source!: ReadableStream<Uint8Array>;
    const open = vi.spyOn(nativeFs, "handleFsTransferSend").mockImplementation(async () => {
      await openGate;
      return resourceResponse(source);
    });

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("private bytes"));
          controller.close();
        },
        cancel: cancelSource,
      });
      const resource = createLocalResourceGrant(instance.federation, contact);
      const pending = instance.fetch(await signedResourceRequest(resource.id));
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM federation_resource_reads",
      ).one().count).toBe(1);
      await removeOwner(instance);
      releaseOpen();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode("private bytes"));
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM federation_resource_reads",
      ).one().count).toBe(0);
    });
    expect(cancelSource).not.toHaveBeenCalled();
  });

  it("cancels a resource body when the contact is replaced while it opens", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const cancelSource = vi.fn();
    let source!: ReadableStream<Uint8Array>;
    const open = vi.spyOn(nativeFs, "handleFsTransferSend").mockImplementation(async () => {
      await openGate;
      return resourceResponse(source);
    });

    const result = await runInDurableObject(kernel, async (instance: Kernel) => {
      const internal = kernelInternals(instance);
      source = new ReadableStream<Uint8Array>({ cancel: cancelSource });
      const resource = createLocalResourceGrant(internal.federation, contact);
      const responsePending = instance.fetch(await signedResourceRequest(resource.id));
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      internal.federation.transaction(() => internal.federation.activateContact({
        ownerUid: OWNER.uid,
        remoteShipId: REMOTE_SHIP_ID,
        remoteSubject: { id: REMOTE_SUBJECT_ID, displayName: "Remote replacement" },
        remoteOrigin: "https://remote.example",
        remotePublicKey: { kty: "EC", crv: "P-256", x: "replacement-x", y: "replacement-y" },
        sharedSecret: randomBase64Url(32),
        generation: "generation:replacement",
        threadId: "thread:replacement",
        now: 2_000,
      }));
      releaseOpen();
      const response = await responsePending;
      await response.arrayBuffer();
      return response.status;
    });

    expect(result).toBe(404);
    expect(cancelSource).toHaveBeenCalledOnce();
  });

  it("cancels a resource stream before yielding a chunk after revocation", async () => {
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const cancelSource = vi.fn();
    let source!: ReadableStream<Uint8Array>;
    vi.spyOn(nativeFs, "handleFsTransferSend")
      .mockImplementation(async () => resourceResponse(source));

    await runInDurableObject(kernel, async (instance: Kernel) => {
      const internal = kernelInternals(instance);
      source = new ReadableStream<Uint8Array>({
        pull(controller) {
          sourceController = controller;
          return pullGate;
        },
        cancel: cancelSource,
      });
      const resource = createLocalResourceGrant(internal.federation, contact);
      const response = await instance.fetch(await signedResourceRequest(resource.id));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const reading = reader.read();
      await vi.waitFor(() => expect(sourceController).toBeDefined());
      internal.federation.transaction(() => {
        internal.federation.revoke(contact.id, OWNER.uid, 2_000);
      });
      sourceController.enqueue(new TextEncoder().encode("private bytes"));
      releasePull();

      await expect(reading).rejects.toThrow("authorization changed");
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    });

    expect(cancelSource).toHaveBeenCalledOnce();
  });

  it("recovers admitted request projections without a sender retry", async () => {
    // Keep the fixture's scheduled recovery ahead of workerd's real alarm clock;
    // this test explicitly invokes recovery after eviction.
    const localNow = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(localNow);
    await runInDurableObject(kernel, (instance: Kernel) => {
      kernelInternals(instance).federation.createRequest({
        id: "request:outgoing",
        contactId: contact.id,
        contactGeneration: contact.generation,
        direction: "outgoing",
        kind: "task",
        title: "Coordinate a task",
        state: "offered",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      });
    });
    let failNextAppend = true;
    getConversationById.mockImplementation((_installationId, conversationId) => (
      fakeConversation(conversationId, messages, () => {
        if (!failNextAppend) return;
        failNextAppend = false;
        throw new Error("Injected Conversation projection failure");
      })
    ));
    const envelope = await signedEnvelope({
      kind: "request.update",
      requestId: "request:outgoing",
      expectedRevision: 1,
      state: "accepted",
      details: { acceptedBy: "remote" },
    }, "delivery:request-update");

    const failedDelivery = await deliver(envelope);
    expect(failedDelivery.status).toBe(500);
    await failedDelivery.arrayBuffer();
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.request("request:outgoing")
    ))).toMatchObject({
      revision: 2,
      state: "accepted",
      details: { acceptedBy: "remote" },
      updatedAtMs: localNow,
    });

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      await removeOwner(instance);
      const recoveryTasks = state.storage.sql.exec<{ callback: string; payload: string }>(
        `SELECT callback, payload FROM cf_agents_schedules
         WHERE callback = 'onFederationInbox'`,
      ).toArray();
      expect(recoveryTasks).toEqual([
        expect.objectContaining({
          callback: "onFederationInbox",
          payload: JSON.stringify({
            contactId: contact.id,
            contactGeneration: contact.generation,
            deliveryId: envelope.deliveryId,
          }),
        }),
      ]);
      state.storage.sql.exec(
        "DELETE FROM cf_agents_schedules WHERE callback = 'onFederationInbox'",
      );
    });

    await evictDurableObject(kernel);
    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const recoveryTasks = state.storage.sql.exec<{ callback: string; payload: string }>(
        `SELECT callback, payload FROM cf_agents_schedules
         WHERE callback = 'onFederationInbox'`,
      ).toArray();
      expect(recoveryTasks).toEqual([
        expect.objectContaining({
          callback: "onFederationInbox",
          payload: JSON.stringify({
            contactId: contact.id,
            contactGeneration: contact.generation,
            deliveryId: envelope.deliveryId,
          }),
        }),
      ]);
      await instance.federationRuntime.onFederationInbox({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: envelope.deliveryId,
      });
      expect(kernelInternals(instance).federation.inbox(
        contact.id,
        contact.generation,
        envelope.deliveryId,
      )).toMatchObject({ state: "committed" });
      expect(kernelInternals(instance).federation.request("request:outgoing"))
        .toMatchObject({ revision: 2, state: "accepted", updatedAtMs: localNow });
    });
    expect(messages).toEqual([
      expect.objectContaining({
        text: "Request request:outgoing is now accepted.",
      }),
    ]);
  });

  it("denies unrelated, stale and invalid request updates after removal without admitting inbox work", async () => {
    await runInDurableObject(kernel, async (instance: Kernel) => {
      const other = instance.federation.activateContact({
        ownerUid: OWNER.uid,
        remoteShipId: "ship:other",
        remoteSubject: contact.remoteSubject,
        remoteOrigin: contact.remoteOrigin,
        remotePublicKey: contact.remotePublicKey,
        sharedSecret: randomBase64Url(32),
        generation: contact.generation,
        threadId: "thread:other",
      });
      for (const [id, contactId, generation] of [
        ["request:current", contact.id, contact.generation],
        ["request:other", other.id, other.generation],
        ["request:stale", contact.id, "generation:old"],
      ]) {
        instance.federation.createRequest({
          id, contactId, contactGeneration: generation,
          direction: "outgoing", kind: "task", title: "Already offered", state: "offered",
          createdAtMs: Date.now(), updatedAtMs: Date.now(),
        });
      }
      await removeOwner(instance);
    });
    const updates = [
      { requestId: "request:missing", expectedRevision: 1, state: "accepted" },
      { requestId: "request:other", expectedRevision: 1, state: "accepted" },
      { requestId: "request:stale", expectedRevision: 1, state: "accepted" },
      { requestId: "request:current", expectedRevision: 2, state: "accepted" },
      { requestId: "request:current", expectedRevision: 1, state: "completed" },
    ] as const;
    for (const [index, update] of updates.entries()) {
      const envelope = await signedEnvelope({ kind: "request.update", ...update }, `delivery:denied-update-${index}`);
      expect((await deliver(envelope)).status).toBe(404);
      expect(await runInDurableObject(kernel, (instance: Kernel) => (
        instance.federation.inbox(contact.id, contact.generation, envelope.deliveryId)
      ))).toBeNull();
    }
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      instance.federation.request("request:current")
    ))).toMatchObject({ state: "offered", revision: 1 });
    expect(messages).toEqual([]);
  });

  it("rejects invalid request transitions without consuming pending inbox capacity", async () => {
    await runInDurableObject(kernel, (instance: Kernel) => {
      kernelInternals(instance).federation.createRequest({
        id: "request:invalid-transition",
        contactId: contact.id,
        contactGeneration: contact.generation,
        direction: "outgoing",
        kind: "task",
        title: "Keep the state machine valid",
        state: "offered",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      });
    });
    const envelope = await signedEnvelope({
      kind: "request.update",
      requestId: "request:invalid-transition",
      expectedRevision: 1,
      state: "completed",
    }, "delivery:invalid-transition");

    expect((await deliver(envelope)).status).toBe(409);
    expect(await runInDurableObject(kernel, (instance: Kernel) => {
      const federation = kernelInternals(instance).federation;
      return {
        request: federation.request("request:invalid-transition"),
        inboxState: federation.inbox(
          contact.id,
          contact.generation,
          "delivery:invalid-transition",
        )?.state,
        pendingInbox: federation.pendingInboxCount(contact.id),
      };
    })).toMatchObject({
      request: { revision: 1, state: "offered" },
      inboxState: "rejected",
      pendingInbox: 0,
    });
  });

  it("rejects reused request identities without consuming pending inbox capacity", async () => {
    const original = await signedEnvelope({
      kind: "request",
      request: {
        id: "request:reused",
        kind: "task",
        title: "Original request",
        state: "offered",
        revision: 1,
      },
    }, "delivery:request-original");
    const changed = await signedEnvelope({
      kind: "request",
      request: {
        id: "request:reused",
        kind: "task",
        title: "Changed request",
        state: "offered",
        revision: 1,
      },
    }, "delivery:request-reused");

    expect((await deliver(original)).status).toBe(200);
    expect((await deliver(changed)).status).toBe(409);
    expect(await runInDurableObject(kernel, (instance: Kernel) => {
      const federation = kernelInternals(instance).federation;
      return {
        requests: federation.listRequests(OWNER.uid, contact.id, true),
        inboxState: federation.inbox(
          contact.id,
          contact.generation,
          "delivery:request-reused",
        )?.state,
        pendingInbox: federation.pendingInboxCount(contact.id),
      };
    })).toMatchObject({
      requests: [{ title: "Original request" }],
      inboxState: "rejected",
      pendingInbox: 0,
    });
  });

  it.each([false, true])("keeps one responsibility through the complete request lifecycle after removal=%s", async (removed) => {
    const requestId = "request:stable-responsibility";
    await seedOutgoingRequest(requestId, true);
    if (removed) await runInDurableObject(kernel, removeOwner);

    const states = ["accepted", "active", "completed"] as const;
    for (const [index, state] of states.entries()) {
      const update = await signedEnvelope({
        kind: "request.update",
        requestId,
        expectedRevision: index + 1,
        state,
      }, `delivery:request-lifecycle-${state}`);
      expect((await deliver(update)).status).toBe(200);
    }

    const result = await runInDurableObject(kernel, (instance: Kernel) => {
      const internal = kernelInternals(instance);
      const responsibilities = internal.responsibilities.list({
        ownerUid: OWNER.uid,
        includeTerminal: true,
      }).records.filter((record) => record.details?.requestId !== undefined);
      const responsibility = responsibilities[0];
      return {
        responsibilities,
        transitions: responsibility
          ? internal.responsibilities.changes(OWNER.uid, 0).transitions.filter(
              (transition) => transition.responsibilityId === responsibility.id,
            )
          : [],
      };
    });
    expect(result.responsibilities).toHaveLength(1);
    expect(result.responsibilities[0]).toMatchObject({
      state: "resolved",
      details: {
        eventType: "federation.request",
        state: "completed",
        revision: 4,
      },
      resolution: {
        requestState: "completed",
      },
    });
    expect(result.transitions.map((transition) => transition.afterState)).toEqual([
      "waiting",
      "active",
      "active",
      "resolved",
    ]);
  });

  it.each([false, true])("does not infer a local commitment from remote updates after removal=%s", async (removed) => {
    const requestId = "request:source-toggle";
    await seedOutgoingRequest(requestId, false);
    await runInDurableObject(kernel, async (instance: Kernel) => {
      expect(instance.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records).toEqual([]);
      if (removed) await removeOwner(instance);
    });

    for (const [index, state] of (["accepted", "active", "completed"] as const).entries()) {
      const envelope = await signedEnvelope({
        kind: "request.update",
        requestId,
        expectedRevision: index + 1,
        state,
      }, `delivery:source-toggle-${state}`);
      const response = await deliver(envelope);
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(await (await deliver(envelope)).json()).toEqual(receipt);
      await runInDurableObject(kernel, (instance: Kernel) => {
        expect(instance.federation.requestForRemoteUpdate(contact.id, contact.generation, requestId))
          .toMatchObject({ state, revision: index + 2 });
        expect(instance.federation.inbox(contact.id, contact.generation, envelope.deliveryId))
          .toMatchObject({ state: "committed" });
        const responsibilities = instance.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records;
        expect(responsibilities).toHaveLength(0);
      });
    }
    expect(messages).toHaveLength(3);
  });

  it("stores incoming contact text without admitting Ship work", async () => {
    const text = "Private instructions that belong only in Contact history";
    const envelope = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:private",
      threadId: contact.threadId,
      text,
    }, "delivery:private");

    expect((await deliver(envelope)).status).toBe(200);
    expect(messages).toEqual([expect.objectContaining({ text })]);
    const responsibility = await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).responsibilities.list({
        ownerUid: OWNER.uid,
        includeTerminal: true,
      }).records[0]
    ));
    expect(responsibility).toBeUndefined();
    expect(vi.mocked(personalController.ensurePersonalController).mock.calls.filter((call) => call[1].installationId === installationId).length).toBe(0);
  });

  it.each([false, true])("cancels the request responsibility on revocation after removal=%s", async (removed) => {
    await seedOutgoingRequest("request:revoked-responsibility", true);
    if (removed) await runInDurableObject(kernel, removeOwner);

    const revocation = await signedEnvelope({
      kind: "contact.revoked",
      generation: contact.generation,
    }, "delivery:revoke-request-responsibility");
    expect((await deliver(revocation)).status).toBe(200);

    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const internal = kernelInternals(instance);
      const responsibilities = internal.responsibilities.list({
        ownerUid: OWNER.uid,
        includeTerminal: true,
      }).records;
      const requestResponsibility = responsibilities.find(
        (record) => record.details?.eventType === "federation.request",
      );
      return {
        request: internal.federation.listRequests(OWNER.uid, contact.id, true)[0],
        responsibility: requestResponsibility,
        newRevocationResponsibilities: responsibilities.filter(
          (record) => record.details?.eventType === "federation.contact.revoked",
        ).length,
        transitions: internal.responsibilities.changes(OWNER.uid, 0).transitions.filter(
          (transition) => transition.responsibilityId === requestResponsibility?.id,
        ),
      };
    });
    expect(state.newRevocationResponsibilities).toBe(0);
    expect(state.request).toMatchObject({ state: "cancelled", revision: 2 });
    expect(state.responsibility).toMatchObject({
      state: "cancelled",
      resolution: {
        reason: "contact-revoked",
        contactId: contact.id,
        requestId: state.request?.id,
      },
    });
    expect(state.transitions).toEqual([
      expect.objectContaining({ kind: "created", afterState: "waiting" }),
      expect.objectContaining({ kind: "cancelled", afterState: "cancelled" }),
    ]);
  });

  it("replays a revocation receipt after the contact has become inactive", async () => {
    const revocation = await signedEnvelope({
      kind: "contact.revoked",
      generation: contact.generation,
    }, "delivery:revoke");
    const first = await deliver(revocation);
    const replay = await deliver(revocation);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.get(contact.id)?.state
    ))).toBe("revoked");

    const duplicate = await signedEnvelope({
      kind: "contact.revoked",
      generation: contact.generation,
    }, "delivery:revoke-duplicate");
    expect((await deliver(duplicate)).status).toBe(404);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.inbox(
        contact.id,
        contact.generation,
        duplicate.deliveryId,
      )
    ))).toBeNull();

    const lateMessage = await signedEnvelope({
      kind: "message",
      messageId: "remote-message:late",
      threadId: contact.threadId,
      text: "Too late",
    }, "delivery:late");
    expect((await deliver(lateMessage)).status).toBe(404);
  });

  it("rejects a mismatched revocation before admitting inbox work", async () => {
    const revocation = await signedEnvelope({
      kind: "contact.revoked",
      generation: "generation:wrong",
    }, "delivery:revoke-wrong-generation");

    expect((await deliver(revocation)).status).toBe(409);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.inbox(
        contact.id,
        contact.generation,
        revocation.deliveryId,
      )
    ))).toBeNull();
  });

  it("uses local receipt time when a contact is revoked", async () => {
    const localNow = 50_000;
    vi.spyOn(Date, "now").mockReturnValue(localNow);
    await runInDurableObject(kernel, (instance: Kernel) => {
      kernelInternals(instance).federation.enqueue({
        deliveryId: "delivery:pending",
        ownerUid: OWNER.uid,
        contactId: contact.id,
        contactGeneration: contact.generation,
        idempotencyKey: "pending-before-revocation",
        fingerprint: "pending-fingerprint",
        payload: {
          kind: "message",
          messageId: "local-message:pending",
          threadId: contact.threadId,
          text: "Pending",
        },
        now: 1_000,
      });
    });
    const revocation = await signedEnvelope({
      kind: "contact.revoked",
      generation: contact.generation,
    }, "delivery:revoke-local-time");

    expect((await deliver(revocation)).status).toBe(200);
    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = kernelInternals(instance).federation;
      return {
        contact: store.get(contact.id),
        pending: store.outbox("delivery:pending"),
      };
    });
    expect(state.contact).toMatchObject({
      state: "revoked",
      revokedAtMs: localNow,
    });
    expect(state.pending).toMatchObject({
      state: "terminal",
      updatedAtMs: localNow,
    });
  });

  async function signedEnvelope(
    payload: FederationDeliveryPayload,
    deliveryId: string,
  ): Promise<FederationDeliveryEnvelope> {
    const unsigned = {
      version: 1 as const,
      deliveryId,
      senderShipId: REMOTE_SHIP_ID,
      senderSubjectId: REMOTE_SUBJECT_ID,
      recipientSubjectId,
      generation: contact.generation,
      timestampMs: Date.now(),
      nonce: randomBase64Url(18),
      payload,
    };
    return {
      ...unsigned,
      signature: await signContactEnvelope(
        sharedSecret,
        jsonValueSchema.parse(unsigned),
      ),
    };
  }

  async function seedOutgoingRequest(requestId: string, tracked: boolean): Promise<void> {
    await runInDurableObject(kernel, (instance: Kernel) => {
      const now = Date.now();
      const request = instance.federation.createRequest({
        id: requestId, contactId: contact.id, contactGeneration: contact.generation,
        direction: "outgoing", kind: "task", title: "Track work performed by the remote participant",
        state: "offered", exchange: { state: "acknowledged", source: "local" }, createdAtMs: now, updatedAtMs: now,
      });
      if (tracked) syncFederationRequestResponsibility({
        request, contact, conversationId: contact.conversationId, remoteInput: false, createAllowed: true, now,
      }, instance.buildKernelContext({}));
    });
  }

  async function signedV2Envelope(payload: FederationMessageDeliveryV2, deliveryId: string): Promise<FederationDeliveryEnvelopeV2> {
    const unsigned = {
      version: 2 as const, domain: "gsv-federation/2/delivery" as const, deliveryId,
      senderShipId: REMOTE_SHIP_ID, senderSubjectId: REMOTE_SUBJECT_ID, recipientSubjectId,
      generation: contact.generation, timestampMs: Date.now(), nonce: randomBase64Url(18), payload,
    };
    return { ...unsigned, signature: await signContactEnvelope(sharedSecret, jsonValueSchema.parse(unsigned)) };
  }

  async function deliverV2(envelope: FederationDeliveryEnvelopeV2): Promise<Response> {
    return kernel.fetch(new Request("https://local.example/_gsv/federation/v2/deliver", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
    }));
  }

  async function deliver(envelope: FederationDeliveryEnvelope): Promise<Response> {
    return await kernel.fetch(new Request("https://local.example/_gsv/federation/v1/deliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
  }

  async function signedResourceRequest(resourceId: string): Promise<Request> {
    const path = `/_gsv/federation/v1/resources/${encodeURIComponent(resourceId)}`;
    const timestampMs = Date.now();
    const nonce = randomBase64Url(18);
    const fields = {
      version: 1,
      method: "GET",
      path,
      senderShipId: REMOTE_SHIP_ID,
      senderSubjectId: REMOTE_SUBJECT_ID,
      recipientSubjectId,
      generation: contact.generation,
      timestampMs,
      nonce,
    };
    return new Request(`https://local.example${path}`, {
      headers: {
        "x-gsv-sender-ship": REMOTE_SHIP_ID,
        "x-gsv-sender-subject": REMOTE_SUBJECT_ID,
        "x-gsv-recipient-subject": recipientSubjectId,
        "x-gsv-contact-generation": contact.generation,
        "x-gsv-timestamp": String(timestampMs),
        "x-gsv-nonce": nonce,
        "x-gsv-signature": await signContactEnvelope(
          sharedSecret,
          jsonValueSchema.parse(fields),
        ),
      },
    });
  }
});

function createLocalResourceGrant(
  store: FederationStore,
  contact: FederationContactRecord,
) {
  return store.createGrant({
    contactId: contact.id,
    contactGeneration: contact.generation,
    source: {
      type: "resource",
      ref: {
        type: "file",
        target: "gsv",
        path: "/home/hank/archive/private.bin",
        revision: "revision:private",
        contentType: "application/octet-stream",
        size: 13,
      },
    },
    sourceUid: OWNER.uid,
    descriptor: {
      revision: "revision:private",
      contentType: "application/octet-stream",
      size: 13,
    },
    now: 1_000,
  });
}

function resourceResponse(stream: ReadableStream<Uint8Array>) {
  return {
    type: "res" as const,
    id: "resource-open",
    ok: true as const,
    data: {
      ok: true as const,
      path: "/home/hank/archive/private.bin",
      size: 13,
      contentType: "application/octet-stream",
      revision: "revision:private",
    },
    body: { stream, length: 13 },
  };
}

function fakeConversation(
  conversationId: string,
  messages: ConversationMessage[],
  beforeAppend?: () => void,
): DurableObjectStub<Conversation> {
  const stub = {
    initialize: () => {},
    append: async (input: ConversationAppendRequest) => {
      beforeAppend?.();
      const existing = messages.find((message) => message.id === input.messageId);
      if (existing) return { message: existing, created: false };
      const message: ConversationMessage = {
        id: input.messageId,
        conversationId,
        sequence: messages.length + 1,
        author: input.author,
        text: input.text,
        ...(input.media?.length ? { media: input.media } : undefined),
        origin: input.origin,
        createdAt: input.createdAt,
      };
      messages.push(message);
      return { message, created: true };
    },
  };
  // SAFETY: the federation inbound test exercises only Conversation.initialize and append.
  return stub as typeof stub & DurableObjectStub<Conversation>;
}

function kernelInternals(instance: Kernel): KernelInternals {
  // SAFETY: this test intentionally exercises Kernel-owned stores through the asserted private fixture shape.
  return instance as Kernel & KernelInternals;
}

async function removeOwner(instance: Kernel): Promise<void> {
  instance.auth.setShadow(makeShadowEntry(OWNER.username, await hashPassword("federation-fixture-password")));
  await instance.people.remove(OWNER.uid, instance.buildKernelContext({ peer: testPeer({ account: {
    uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root",
  }, calls: ["*"] }) }));
}
