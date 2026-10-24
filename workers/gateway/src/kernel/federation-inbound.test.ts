import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVER,
  GET_ATTACHMENT,
  type ConversationMessage,
  type DeliverInput,
  type FederationDeliveryPayload,
  type FederationMessageDelivery,
  type OriginMessageRef,
  type ProcessIdentity,
  type SocialMessageProvenance,
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
import {
  randomPlcDid,
  serviceAuthToken,
  signedJwt,
  TestShipNetwork,
  tokenClaims,
  type TestDidAccount,
} from "../test-support/ship-network";
import type { Kernel } from "./do";
import type { FederationContactRecord, FederationStore } from "./federation-store";
import type { ProcessRegistry } from "./processes";
import * as personalController from "./personal-controller";
import type { ResponsibilityStore } from "./responsibility-store";
import { ResponsibilityRuntime } from "./responsibility-runtime";
import { ShipEventRuntime } from "./ship-event-runtime";
import { syncFederationRequestResponsibility } from "./federation/requests";
import { handleContactPreferencesUpdate } from "./federation/preferences";
import { handleContactSend } from "./federation";
import type { KernelContext } from "./context";

const OWNER: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [100, 1000],
  username: "hank",
  home: "/home/hank",
  cwd: "/home/hank",
};
const SHIP_PID = "proc:test-ship";

type KernelInternals = {
  ctx: DurableObjectState;
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
  let network: TestShipNetwork;
  let remote: TestDidAccount;
  let localDid: string;
  let kernel: DurableObjectStub<Kernel>;
  let contact: FederationContactRecord;
  let messages: ConversationMessage[];
  let getConversationById: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    network = new TestShipNetwork().install();
    remote = await network.account("remote.ship.test");
    localDid = (await network.account("local.example")).did;
    const installationId = `inst_federation_inbound_${crypto.randomUUID()}`;
    kernel = await getKernelByInstallationId(env.KERNEL, installationId);
    messages = [];
    vi.spyOn(personalController, "ensurePersonalController")
      .mockResolvedValue(SHIP_PID);
    getConversationById = vi.spyOn(utils, "getConversationById")
      .mockImplementation((_installationId, conversationId) => fakeConversation(
        conversationId,
        messages,
      ));
    contact = await runInDurableObject(kernel, async (instance: Kernel) => {
      await instance.ensureInstallationIdentity({
        installationId,
        handle: "local",
        canonicalOrigin: "https://local.example",
      });
      instance.shipIdentity.remember(localDid);
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
      return internal.federation.activateContact({
        ownerUid: OWNER.uid,
        remoteDid: remote.did,
        remoteName: "Remote",
        generation: "generation:current",
        threadId: "thread:shared",
        now: 1_000,
      });
    });
  });

  afterEach(async () => {
    // Responsibility alarms belong to this test's Kernel, not the next test's mocks.
    await reset();
    await vi.dynamicImportSettled();
    vi.restoreAllMocks();
  });

  it("commits a message under its author's DID and answers a repeat without waking Ship", async () => {
    getConversationById.mockRestore();
    const payload = message("origin:one", "Written by my helper", { kind: "process", processId: "proc:remote-helper" });
    const input = delivery(payload, "delivery:one");
    for (const response of [await deliver(input), await deliver(input)]) {
      expect([response.status, await response.json()]).toEqual([200, { state: "received" }]);
    }
    const installationId = await runInDurableObject(kernel, (instance: Kernel) => instance.installationId);
    const conversation = utils.getConversationById(installationId, contact.conversationId);
    const history = await conversation.history();
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.social).toEqual(payload.social);
    expect(await conversation.resolveOrigin(payload.social.reference, contact.threadId))
      .toMatchObject({ messageId: history.messages[0]?.id, sequence: 1 });
    expect(personalController.ensurePersonalController).not.toHaveBeenCalled();

    // The calling Ship's DID names the author, so a message can't claim another's.
    const forged = message("origin:forged", "Written by someone else");
    forged.social.reference.did = randomPlcDid();
    const rejected = await deliver(delivery(forged, "delivery:forged"));
    expect([rejected.status, (await rejected.json<{ message: string }>()).message])
      .toEqual([409, "Message origin does not match this relationship"]);
    expect((await conversation.history()).messages).toHaveLength(1);
  });

  it("takes a reply that quotes either person in the conversation, and no one else", async () => {
    const reply = (messageId: string, replyTo: OriginMessageRef) => {
      const payload = message(messageId, "A reply");
      payload.social.replyTo = replyTo;
      return delivery(payload, `delivery:${messageId}`);
    };
    expect((await deliver(reply("reply:ours", { did: localDid, messageId: "local:asked" }))).status).toBe(200);
    expect((await deliver(reply("reply:theirs", { did: remote.did, messageId: "origin:said" }))).status).toBe(200);
    const outside = await deliver(reply("reply:outside", { did: randomPlcDid(), messageId: "origin:elsewhere" }));
    expect([outside.status, (await outside.json<{ message: string }>()).message])
      .toEqual([409, "Reply origin is outside this relationship"]);
    expect(messages.map(({ social }) => social?.replyTo?.messageId)).toEqual(["local:asked", "origin:said"]);
  });

  it.each([
    ["incoming", "offered", "accepted"],
    ["incoming", "offered", "rejected"],
    ["incoming", "accepted", "active"],
    ["incoming", "active", "completed"],
    ["incoming", "accepted", "cancelled"],
    ["outgoing", "offered", "cancelled"],
  ] as const)("rejects a remote %s action from %s to %s without creating a conversation", async (direction, state, next) => {
    await runInDurableObject(kernel, (instance: Kernel) => {
      instance.federation.createRequest({
        id: "request:local", remoteId: direction === "incoming" ? "request:remote" : undefined,
        contactId: contact.id, contactGeneration: contact.generation, direction,
        kind: "task", title: "Participant-owned work", state, createdAtMs: 1_000, updatedAtMs: 1_000,
      });
    });
    const response = await deliver(delivery({
      kind: "request.update", requestId: direction === "incoming" ? "request:remote" : "request:local",
      expectedRevision: 1, state: next,
    }, "delivery:wrong-role"));
    expect(response.status).toBe(409);
    await response.arrayBuffer();
    expect(getConversationById).not.toHaveBeenCalled();
    expect(personalController.ensurePersonalController).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    await runInDurableObject(kernel, (instance: Kernel) => {
      expect(instance.federation.request("request:local")).toMatchObject({ state, revision: 1 });
    });
  });

  it("coordinates concurrent duplicates and answers every repeat", async () => {
    const receivedAtMs = 50_000;
    vi.spyOn(Date, "now").mockReturnValue(receivedAtMs);
    const input = delivery(message("remote-message:1", "Hello from another Ship"), "delivery:message");

    const [first, concurrent] = await Promise.all([
      deliver(input),
      deliver(input),
    ]);
    const replay = await deliver(input);
    for (const response of [first, concurrent, replay]) {
      expect([response.status, await response.json()]).toEqual([200, { state: "received" }]);
    }
    expect(messages).toHaveLength(1);
    expect(personalController.ensurePersonalController).not.toHaveBeenCalled();
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

  it("rejects new delivery after owner removal while answering a committed repeat", async () => {
    const accepted = delivery(message("remote:accepted", "Already admitted"), "delivery:accepted");
    expect((await deliver(accepted)).status).toBe(200);
    await runInDurableObject(kernel, removeOwner);
    const repeat = await deliver(accepted);
    expect([repeat.status, await repeat.json()]).toEqual([200, { state: "received" }]);
    const denied = delivery(message("remote:denied", "New work"), "delivery:denied");
    expect((await deliver(denied)).status).toBe(404);
    expect(await runInDurableObject(kernel, (instance: Kernel) => instance.federation.inbox(contact.id, contact.generation, denied.deliveryId))).toBeNull();
    expect(messages).toHaveLength(1);
    const newRequest = delivery({
      kind: "request",
      request: { id: "request:new", kind: "task", title: "New work", state: "offered", revision: 1 },
    }, "delivery:new-request");
    expect((await deliver(newRequest)).status).toBe(404);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      instance.federation.inbox(contact.id, contact.generation, newRequest.deliveryId)
    ))).toBeNull();
  });

  it("rechecks removal after a delivery waits for contact coordination", async () => {
    const input = delivery(message("remote:held", "Not admitted yet"), "delivery:held");
    const status = await runInDurableObject(kernel, async (instance: Kernel) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ahead = instance.federationRuntime.coordinateFederationContact(contact.id, () => gate);
      const pending = instance.fetch(await deliveryRequest(input));
      await vi.waitFor(() => expect(instance.federationRuntime.pendingFederationInbound.size).toBe(1));
      await removeOwner(instance);
      release();
      await ahead;
      const response = await pending;
      await response.arrayBuffer();
      expect(instance.federation.inbox(contact.id, contact.generation, input.deliveryId)).toBeNull();
      return response.status;
    });
    expect(status).toBe(404);
    expect(messages).toEqual([]);
  });

  it("rejects a new attachment read after removal while the caller's DID is looked up", async () => {
    const open = vi.spyOn(nativeFs, "handleFsTransferSend").mockImplementation(async () => resourceResponse(new ReadableStream({ start(controller) { controller.close(); } })));
    const status = await runInDurableObject(kernel, async (instance: Kernel) => {
      const resource = createLocalResourceGrant(instance.federation, contact);
      const lookingUp = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const directory = network.plc.handle.bind(network.plc);
      vi.spyOn(network.plc, "handle").mockImplementation(async (request) => {
        lookingUp.resolve();
        await release.promise;
        return await directory(request);
      });
      const pending = instance.fetch(await attachmentRequest(resource.id));
      await lookingUp.promise;
      await removeOwner(instance);
      release.resolve();
      const response = await pending;
      await response.arrayBuffer();
      return response.status;
    });
    expect(status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a forged or misdirected token, a stranger, and delivery-id reuse before committing another message", async () => {
    const mallory = await network.account("mallory.ship.test");
    const input = delivery(message("remote-message:1", "Original"), "delivery:message");
    expect((await deliver(input)).status).toBe(200);

    const changed = delivery(message("remote-message:2", "Changed"), "delivery:changed");
    // Only the contact's own key, addressed to this Ship for this method, delivers as the contact.
    for (const token of [
      await signedJwt({ typ: "JWT", alg: "ES256K" }, tokenClaims(remote, { did: localDid }, DELIVER), mallory),
      await serviceAuthToken(remote, { did: localDid }, GET_ATTACHMENT),
      await serviceAuthToken(remote, mallory, DELIVER),
    ]) {
      const refused = await deliver(changed, remote, token);
      expect(refused.status).toBe(401);
      await refused.arrayBuffer();
    }
    // A Ship that isn't a contact learns nothing about this Ship's contacts.
    const stranger = await deliver(changed, mallory);
    expect([stranger.status, (await stranger.json<{ error: string }>()).error]).toEqual([404, "NotFound"]);
    const reused = await deliver(delivery(message("remote-message:2", "Changed with a valid token"), "delivery:message"));
    expect([reused.status, (await reused.json<{ message: string }>()).message]).toEqual([409, "Federation delivery id was reused"]);
    expect(messages).toHaveLength(1);
  });

  it("rejects malformed resource identifiers before admitting inbox work", async () => {
    const input = delivery({
      ...message("remote-message:invalid-resource", "This must not consume inbox capacity"),
      resources: [{
        id: "invalid",
        revision: "revision:remote",
        contentType: "image/png",
        size: 10,
      }],
    }, "delivery:invalid-resource");

    expect((await deliver(input)).status).toBe(400);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.pendingInboxCount(contact.id)
    ))).toBe(0);
    expect(messages).toEqual([]);
  });

  it("rejects incomplete messages before admitting inbox work", async () => {
    const empty = delivery(message("remote-message:empty", " \t "), "delivery:empty-message");

    expect((await deliver(empty)).status).toBe(400);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.pendingInboxCount(contact.id)
    ))).toBe(0);
    expect(messages).toEqual([]);
  });

  it("rejects oversized request details before admitting inbox work", async () => {
    const input = delivery({
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

    expect((await deliver(input)).status).toBe(400);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.pendingInboxCount(contact.id)
    ))).toBe(0);
  });

  it("rejects an old-generation delivery queued behind contact replacement", async () => {
    const input = delivery(
      message("remote-message:old-generation", "This must not cross the generation boundary"),
      "delivery:old-generation",
    );
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
          remoteDid: remote.did,
          remoteName: "Remote replacement",
          generation: "generation:replacement",
          threadId: "thread:replacement",
          now: 2_000,
        }));
      });
      const pending = instance.fetch(await deliveryRequest(input));
      await vi.waitFor(() => {
        expect(internal.federationRuntime.pendingFederationInbound.size).toBe(1);
      });
      releaseReplacement();
      await replacement;
      const response = await pending;
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
      const pending = instance.fetch(await attachmentRequest(resource.id));
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
      const responsePending = instance.fetch(await attachmentRequest(resource.id));
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      internal.federation.transaction(() => internal.federation.activateContact({
        ownerUid: OWNER.uid,
        remoteDid: remote.did,
        remoteName: "Remote replacement",
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
      const response = await instance.fetch(await attachmentRequest(resource.id));
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
    const localNow = 50_000;
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
    const input = delivery({
      kind: "request.update",
      requestId: "request:outgoing",
      expectedRevision: 1,
      state: "accepted",
      details: { acceptedBy: "remote" },
    }, "delivery:request-update");

    const failedDelivery = await deliver(input);
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
      console.info("inbound recovery fixture: removing owner");
      await removeOwner(instance);
      console.info("inbound recovery fixture: owner removed");
      console.info("inbound recovery fixture: inspecting schedules");
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
            deliveryId: input.deliveryId,
          }),
        }),
      ]);
      state.storage.sql.exec(
        "DELETE FROM cf_agents_schedules WHERE callback = 'onFederationInbox'",
      );
    });

    console.info("inbound recovery fixture: evicting Kernel");
    await evictDurableObject(kernel);
    console.info("inbound recovery fixture: Kernel evicted");
    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      console.info("inbound recovery fixture: inspecting schedules");
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
            deliveryId: input.deliveryId,
          }),
        }),
      ]);
      await instance.federationRuntime.onFederationInbox({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: input.deliveryId,
      });
      expect(kernelInternals(instance).federation.inbox(
        contact.id,
        contact.generation,
        input.deliveryId,
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
        remoteDid: randomPlcDid(),
        remoteName: "Other",
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
      const input = delivery({ kind: "request.update", ...update }, `delivery:denied-update-${index}`);
      expect((await deliver(input)).status).toBe(404);
      expect(await runInDurableObject(kernel, (instance: Kernel) => (
        instance.federation.inbox(contact.id, contact.generation, input.deliveryId)
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
    const input = delivery({
      kind: "request.update",
      requestId: "request:invalid-transition",
      expectedRevision: 1,
      state: "completed",
    }, "delivery:invalid-transition");

    expect((await deliver(input)).status).toBe(409);
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
    const original = delivery({
      kind: "request",
      request: {
        id: "request:reused",
        kind: "task",
        title: "Original request",
        state: "offered",
        revision: 1,
      },
    }, "delivery:request-original");
    const changed = delivery({
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
      const update = delivery({
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
      const input = delivery({
        kind: "request.update",
        requestId,
        expectedRevision: index + 1,
        state,
      }, `delivery:source-toggle-${state}`);
      const response = await deliver(input);
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(await (await deliver(input)).json()).toEqual(receipt);
      await runInDurableObject(kernel, (instance: Kernel) => {
        expect(instance.federation.requestForRemoteUpdate(contact.id, contact.generation, requestId))
          .toMatchObject({ state, revision: index + 2 });
        expect(instance.federation.inbox(contact.id, contact.generation, input.deliveryId))
          .toMatchObject({ state: "committed" });
        const responsibilities = instance.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records;
        expect(responsibilities).toHaveLength(0);
      });
    }
    expect(messages).toHaveLength(3);
  });

  it("stores incoming contact text without admitting Ship work", async () => {
    const text = "Private instructions that belong only in Contact history";
    const input = delivery(message("remote-message:private", text), "delivery:private");

    expect((await deliver(input)).status).toBe(200);
    expect(messages).toEqual([expect.objectContaining({ text })]);
    const responsibility = await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).responsibilities.list({
        ownerUid: OWNER.uid,
        includeTerminal: true,
      }).records[0]
    ));
    expect(responsibility).toBeUndefined();
    expect(personalController.ensurePersonalController).not.toHaveBeenCalled();
  });

  it("recovers Ship event delivery after committing contact attention without repeating the handoff", async () => {
    await runInDurableObject(kernel, async (instance: Kernel) => {
      instance.auth.setShadow(makeShadowEntry(OWNER.username, await hashPassword("federation-fixture-password")));
      instance.federation.updatePreferences(OWNER.uid, {
        contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true },
      });
    });
    const wake = vi.spyOn(ShipEventRuntime.prototype, "queue")
      .mockRejectedValueOnce(new Error("Injected scheduler failure"));
    const input = delivery(message("message:handoff", "Continue our conversation"), "delivery:handoff");
    const failed = await deliver(input);
    expect(failed.status).toBe(500);
    await failed.arrayBuffer();
    const committed = await runInDurableObject(kernel, (instance: Kernel) => {
      const records = instance.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records;
      expect(records).toHaveLength(1);
      expect(instance.federation.inbox(contact.id, contact.generation, input.deliveryId)?.state).toBe("received");
      return records[0]!;
    });
    expect(wake).toHaveBeenCalledOnce();
    wake.mockRestore();
    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      await instance.federationRuntime.onFederationInbox({
        contactId: contact.id, contactGeneration: contact.generation, deliveryId: input.deliveryId,
      });
      expect(instance.federation.inbox(contact.id, contact.generation, input.deliveryId)?.state).toBe("committed");
      expect(instance.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records).toEqual([committed]);
      expect(state.storage.sql.exec("SELECT event_id FROM ship_events").toArray()).toEqual([{ event_id: `contact.message:${messages[0]?.id}` }]);
      expect(state.storage.sql.exec("SELECT 1 FROM cf_agents_schedules WHERE callback = 'onShipEvents'").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT 1 FROM cf_agents_schedules WHERE callback = 'onResponsibilityWake'").toArray()).toHaveLength(0);
    });
    expect(messages).toHaveLength(1);
    const replay = await deliver(input);
    expect(replay.status).toBe(200);
    await replay.arrayBuffer();
    expect(messages).toHaveLength(1);
  });

  it("finishes an earlier inbound message before enabling Ship replies", async () => {
    const enteredAppend = Promise.withResolvers<void>();
    const releaseAppend = Promise.withResolvers<void>();
    getConversationById.mockImplementation((_installationId, conversationId) => fakeConversation(conversationId, messages, async () => {
      enteredAppend.resolve();
      await releaseAppend.promise;
    }));
    vi.spyOn(ResponsibilityRuntime.prototype, "reconcileResponsibilityWake").mockResolvedValue();
    const earlier = delivery(message("message:earlier", "Already arriving"), "delivery:earlier");
    await runInDurableObject(kernel, async (instance: Kernel) => {
      instance.auth.setShadow(makeShadowEntry(OWNER.username, await hashPassword("federation-fixture-password")));
      const ctx = instance.buildKernelContext({ peer: testPeer({ account: OWNER, calls: ["contact.*"] }) });
      // SAFETY: this handler only checks that a direct human connection exists.
      ctx.connection = {} as KernelContext["connection"];
      const pending = instance.fetch(await deliveryRequest(earlier));
      await enteredAppend.promise;
      const enabling = handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      try {
        expect(instance.federation.get(contact.id)?.preferences.shipHandlesMessages).toBe(false);
      } finally { releaseAppend.resolve(); }
      const response = await pending;
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      await enabling;
      expect(instance.federation.get(contact.id)?.preferences.shipHandlesMessages).toBe(true);
      expect(instance.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records).toEqual([]);
    });
    const later = await deliver(delivery(message("message:later", "Arriving after enabling"), "delivery:later"));
    expect(later.status).toBe(200);
    await later.arrayBuffer();
    const replay = await deliver(earlier);
    expect(replay.status).toBe(200);
    await replay.arrayBuffer();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const records = instance.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ details: { contactId: contact.id } });
      expect(instance.shipEvents.next(OWNER.uid)?.event).toMatchObject({ messageId: messages[1]?.id, responsibilityId: records[0]!.id });
    });
    expect(messages).toHaveLength(2);
  });

  it("binds a task reply only after an earlier inbound message finishes", async () => {
    const enteredAppend = Promise.withResolvers<void>();
    const releaseAppend = Promise.withResolvers<void>();
    getConversationById.mockImplementation((_installationId, conversationId) => fakeConversation(conversationId, messages, async () => {
      enteredAppend.resolve();
      await releaseAppend.promise;
    }));
    vi.spyOn(ResponsibilityRuntime.prototype, "reconcileResponsibilityWake").mockResolvedValue();
    const earlier = delivery(message("message:earlier", "Arriving before the question"), "delivery:earlier");
    const workId = await runInDurableObject(kernel, async (instance: Kernel) => {
      instance.auth.setShadow(makeShadowEntry(OWNER.username, await hashPassword("federation-fixture-password")));
      const actor = { kind: "human", uid: OWNER.uid } as const;
      const work = instance.responsibilities.create({ ownerUid: OWNER.uid, title: "Arrange Friday's visit", assignee: { kind: "ship" },
        source: actor, actor, state: "waiting", blocker: "Awaiting the contact", priority: "normal", observedByShip: true, now: Date.now() }).record;
      const ctx = instance.buildKernelContext({ peer: testPeer({ account: OWNER, calls: ["contact.*", "r12y.*"] }) });
      // SAFETY: this handler only checks that a direct human connection exists.
      ctx.connection = {} as KernelContext["connection"];
      ctx.scheduleFederationDelivery = vi.fn(async () => {});
      const pending = instance.fetch(await deliveryRequest(earlier));
      await enteredAppend.promise;
      const waitingForAdmission = Promise.withResolvers<void>();
      const coordinate = ctx.coordinateFederationContact.bind(ctx);
      vi.spyOn(ctx, "coordinateFederationContact").mockImplementation((id, operation) => {
        waitingForAdmission.resolve();
        return coordinate(id, operation);
      });
      const sending = handleContactSend({ contactId: contact.id, text: "Does Friday work?", responsibilityId: work.id,
        idempotencyKey: "task-question" }, ctx);
      try { await Promise.race([waitingForAdmission.promise, sending]); }
      finally { releaseAppend.resolve(); }
      const response = await pending;
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(await sending).toMatchObject({ state: "queued" });
      expect(instance.responsibilities.get(OWNER.uid, work.id)).toEqual(work);
      return work.id;
    });
    const later = await deliver(delivery(message("message:later", "Friday works"), "delivery:later"));
    expect(later.status).toBe(200);
    await later.arrayBuffer();
    const updated = await runInDurableObject(kernel, (instance: Kernel) => instance.responsibilities.get(OWNER.uid, workId));
    expect(updated).toMatchObject({ state: "open" });
    expect(await runInDurableObject(kernel, (instance: Kernel) => instance.shipEvents.next(OWNER.uid)?.event))
      .toMatchObject({ messageId: messages[1]?.id, responsibilityId: workId });
    const replay = await deliver(earlier);
    expect(replay.status).toBe(200);
    await replay.arrayBuffer();
    expect(await runInDurableObject(kernel, (instance: Kernel) => instance.responsibilities.get(OWNER.uid, workId))).toEqual(updated);
    expect(messages).toHaveLength(2);
  });

  it.each([false, true])("cancels the request responsibility on revocation after removal=%s", async (removed) => {
    await seedOutgoingRequest("request:revoked-responsibility", true);
    if (removed) await runInDurableObject(kernel, removeOwner);

    const revocation = delivery({ kind: "contact.revoked" }, "delivery:revoke-request-responsibility");
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

  it("answers a repeated revocation after the contact has become inactive", async () => {
    const revocation = delivery({ kind: "contact.revoked" }, "delivery:revoke");
    for (const response of [await deliver(revocation), await deliver(revocation)]) {
      expect([response.status, await response.json()]).toEqual([200, { state: "received" }]);
    }
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.get(contact.id)?.state
    ))).toBe("revoked");

    const duplicate = delivery({ kind: "contact.revoked" }, "delivery:revoke-duplicate");
    expect((await deliver(duplicate)).status).toBe(404);
    expect(await runInDurableObject(kernel, (instance: Kernel) => (
      kernelInternals(instance).federation.inbox(
        contact.id,
        contact.generation,
        duplicate.deliveryId,
      )
    ))).toBeNull();

    const lateMessage = delivery(message("remote-message:late", "Too late"), "delivery:late");
    expect((await deliver(lateMessage)).status).toBe(404);
  });

  it("rejects a revocation for another connection before admitting inbox work", async () => {
    const revocation = { ...delivery({ kind: "contact.revoked" }, "delivery:revoke-wrong-generation"), generation: "generation:wrong" };

    expect((await deliver(revocation)).status).toBe(404);
    expect(await runInDurableObject(kernel, (instance: Kernel) => {
      const federation = kernelInternals(instance).federation;
      return {
        state: federation.get(contact.id)?.state,
        inbox: federation.inbox(contact.id, contact.generation, revocation.deliveryId),
      };
    })).toEqual({ state: "active", inbox: null });
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
          social: {
            threadId: contact.threadId,
            reference: { did: localDid, messageId: "local-message:pending" },
            provenance: { kind: "human" },
          },
        },
        now: 1_000,
      });
    });
    const revocation = delivery({ kind: "contact.revoked" }, "delivery:revoke-local-time");

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

  /** A delivery for the contact's current connection. */
  function delivery(payload: FederationDeliveryPayload, deliveryId: string): DeliverInput {
    return { deliveryId, generation: contact.generation, payload };
  }

  /** A message the remote person wrote, named by their Ship's DID. */
  function message(
    messageId: string,
    text: string,
    provenance: SocialMessageProvenance = { kind: "human" },
  ): FederationMessageDelivery {
    return {
      kind: "message",
      messageId,
      threadId: contact.threadId,
      text,
      social: { threadId: contact.threadId, reference: { did: remote.did, messageId }, provenance },
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

  /** `space.ship.deliver` from `caller`'s Ship, with a fresh service-auth token unless one is given. */
  async function deliveryRequest(input: DeliverInput, caller = remote, token?: string): Promise<Request> {
    return new Request(`https://local.example/xrpc/${DELIVER}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token ?? await serviceAuthToken(caller, { did: localDid }, DELIVER)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  }

  async function deliver(input: DeliverInput, caller = remote, token?: string): Promise<Response> {
    return await kernel.fetch(await deliveryRequest(input, caller, token));
  }

  /** `space.ship.getAttachment` from the contact's Ship. */
  async function attachmentRequest(resourceId: string): Promise<Request> {
    return new Request(`https://local.example/xrpc/${GET_ATTACHMENT}?id=${encodeURIComponent(resourceId)}`, {
      headers: { authorization: `Bearer ${await serviceAuthToken(remote, { did: localDid }, GET_ATTACHMENT)}` },
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
  beforeAppend?: () => void | Promise<void>,
): DurableObjectStub<Conversation> {
  const stub = {
    initialize: () => {},
    resolveOrigin: (reference: OriginMessageRef, threadId: string) => {
      const found = messages.find(({ social }) => social?.threadId === threadId
        && social.reference.did === reference.did && social.reference.messageId === reference.messageId);
      return found ? { messageId: found.id, sequence: found.sequence } : null;
    },
    append: async (input: ConversationAppendRequest) => {
      await beforeAppend?.();
      const existing = messages.find((message) => message.id === input.messageId);
      if (existing) return { message: existing, created: false };
      const message: ConversationMessage = {
        id: input.messageId,
        conversationId,
        sequence: messages.length + 1,
        author: input.author,
        text: input.text,
        ...(input.social ? { social: input.social } : undefined),
        ...(input.media?.length ? { media: input.media } : undefined),
        origin: input.origin,
        createdAt: input.createdAt,
      };
      messages.push(message);
      return { message, created: true };
    },
  };
  // SAFETY: the federation inbound test exercises only Conversation.initialize and append.
  // Each inbound message also asks resolveOrigin whether its origin already arrived.
  return stub as typeof stub & DurableObjectStub<Conversation>;
}

function kernelInternals(instance: Kernel): KernelInternals {
  // SAFETY: this test intentionally exercises Kernel-owned stores through the asserted private fixture shape.
  return instance as Kernel & KernelInternals;
}

async function removeOwner(instance: Kernel): Promise<void> {
  const internal = kernelInternals(instance);
  internal.ctx.storage.sql.exec("INSERT INTO account_access (uid, disabled_at) VALUES (?, ?)", OWNER.uid, Date.now());
  internal.auth.invalidateCredentials(OWNER.uid, "test account disabled");
}
