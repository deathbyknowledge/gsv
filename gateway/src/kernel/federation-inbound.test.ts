import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonValueSchema,
  type ConversationMessage,
  type FederationDeliveryEnvelope,
  type FederationDeliveryPayload,
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
import type { Kernel } from "./do";
import {
  randomBase64Url,
  signContactEnvelope,
} from "./federation-crypto";
import type { FederationContactRecord, FederationStore } from "./federation-store";
import type { ProcessRegistry } from "./processes";
import * as personalController from "./personal-controller";
import type { ResponsibilityStore } from "./responsibility-store";
import type { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";

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
  responsibilitySources: ResponsibilitySourcePolicyStore;
  pendingFederationInbound: Map<string, Promise<unknown>>;
  coordinateFederationContact: <Value>(
    contactId: string,
    operation: () => Value | Promise<Value>,
  ) => Promise<Value>;
};

describe("federation inbound boundary", () => {
  let kernel: DurableObjectStub<Kernel>;
  let contact: FederationContactRecord;
  let recipientSubjectId: string;
  let sharedSecret: string;
  let messages: ConversationMessage[];
  let getConversationById: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const installationId = `inst_federation_inbound_${crypto.randomUUID()}`;
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
      internal.responsibilitySources.set(OWNER.uid, "federation.received", false);
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
    expect(messages[0]).toMatchObject({
      text: "Hello from another Ship",
      author: { kind: "contact", contactId: contact.id, displayName: "Remote" },
      origin: { kind: "federation", contactId: contact.id, deliveryId: "delivery:message" },
      createdAt: receivedAtMs,
    });
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
      const replacement = internal.coordinateFederationContact(contact.id, async () => {
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
        expect(internal.pendingFederationInbound.size).toBe(1);
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

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
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
      await instance.onFederationInbox({
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

  it("keeps one responsibility through the complete request lifecycle", async () => {
    await runInDurableObject(kernel, (instance: Kernel) => {
      kernelInternals(instance).responsibilitySources.set(
        OWNER.uid,
        "federation.received",
        true,
      );
    });
    const requestId = "request:stable-responsibility";
    const offered = await signedEnvelope({
      kind: "request",
      request: {
        id: requestId,
        kind: "task",
        title: "Keep one responsibility",
        state: "offered",
        revision: 1,
      },
    }, "delivery:request-lifecycle-offered");
    expect((await deliver(offered)).status).toBe(200);

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
      "open",
      "active",
      "active",
      "resolved",
    ]);
  });

  it("keeps exact contact content in Conversation history rather than responsibility details", async () => {
    await runInDurableObject(kernel, (instance: Kernel) => {
      kernelInternals(instance).responsibilitySources.set(
        OWNER.uid,
        "federation.received",
        true,
      );
    });
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
    expect(responsibility?.details).toMatchObject({
      eventType: "federation.message.received",
      contactId: contact.id,
      conversationId: contact.conversationId,
      deliveryId: "delivery:private",
      resourceCount: 0,
      contentTrust: "untrusted",
    });
    expect(responsibility?.title).toMatch(/^Review contact message .* with the owner$/);
    expect(responsibility?.details).not.toHaveProperty("text");
    expect(responsibility?.details).not.toHaveProperty("resources");
    expect(JSON.stringify(responsibility)).not.toContain(text);
  });

  it("cancels the request responsibility when contact revocation terminalizes the request", async () => {
    await runInDurableObject(kernel, (instance: Kernel) => {
      kernelInternals(instance).responsibilitySources.set(
        OWNER.uid,
        "federation.received",
        true,
      );
    });
    const requestDelivery = await signedEnvelope({
      kind: "request",
      request: {
        id: "request:revoked-responsibility",
        kind: "task",
        title: "Work that becomes impossible after revocation",
        state: "offered",
        revision: 1,
      },
    }, "delivery:request-before-revoke");
    expect((await deliver(requestDelivery)).status).toBe(200);

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
        transitions: internal.responsibilities.changes(OWNER.uid, 0).transitions.filter(
          (transition) => transition.responsibilityId === requestResponsibility?.id,
        ),
      };
    });
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
      expect.objectContaining({ kind: "created", afterState: "open" }),
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
