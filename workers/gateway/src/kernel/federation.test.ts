import type {
  ContactRequestRecord,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import * as conversationHandlers from "./conversation-handlers";
import type { KernelContext } from "./context";
import {
  canonicalJson,
  sha256Base64Url,
} from "./federation-crypto";
import type {
  FederationContactRecord,
  FederationMessagePreparation,
  FederationOutboxRecord,
} from "./federation-store";
import {
  handleContactAliasSet,
  handleContactNoticeDismiss,
  handleContactRequestCreate,
  handleContactRequestUpdate,
  handleContactSend,
} from "./federation";
import * as personalController from "./personal-controller";
import { contactHandlingChoice } from "./federation/authority";
import { handleContactInviteAccept, handleContactInviteCancel, handleContactInviteCreate } from "./federation/invitations";

const OWNER: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [100, 1000],
  username: "hank",
  home: "/home/hank",
  cwd: "/home/hank",
};
const LOCAL_DID = "did:plc:localaaaaaaaaaaaaaaaaaaa";

describe("federation outbound boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires the owner's handling choice and preference authority from their canonical Ship", async () => {
    const limited = focusedContext({});
    const ship = focusedContext({ processId: "proc:ship", peer: testPeer({ account: OWNER, calls: ["*"] }),
      procs: focusedFixture({ get: () => ({ isPersonalController: true, ownerUid: OWNER.uid }) }) });
    await expect(handleContactInviteCreate({ shipHandlesMessages: true }, limited)).rejects.toThrow("contact.preferences.update");
    await expect(handleContactInviteAccept({ code: "unused", shipHandlesMessages: true }, limited)).rejects.toThrow("contact.preferences.update");
    expect(contactHandlingChoice(true, ship)).toBe(true);
    expect(contactHandlingChoice(false, ship)).toBe(false);
    await expect(handleContactInviteCreate({}, ship)).rejects.toThrow("Ask the owner");
    await expect(handleContactInviteAccept({ code: "unused" }, ship)).rejects.toThrow("Ask the owner");
    expect(() => contactHandlingChoice(true, { ...ship, peer: limited.peer })).toThrow("contact.preferences.update");
    const crew = { ...ship, procs: focusedFixture<KernelContext["procs"]>({ get: () => ({ isPersonalController: false, ownerUid: OWNER.uid }) }) };
    await expect(handleContactInviteCreate({ shipHandlesMessages: true }, crew)).rejects.toThrow("signed-in human or their Ship");
    await expect(handleContactInviteAccept({ code: "unused", shipHandlesMessages: true }, crew)).rejects.toThrow("signed-in human or their Ship");
  });

  it.each([
    ["outgoing", "offered", "accepted"],
    ["outgoing", "offered", "rejected"],
    ["outgoing", "accepted", "active"],
    ["outgoing", "active", "completed"],
    ["outgoing", "accepted", "cancelled"],
    ["incoming", "offered", "cancelled"],
  ] as const)("rejects a local %s request action from %s to %s before retaining work", async (direction, state, next) => {
    const contact = activeContact();
    const request: ContactRequestRecord = {
      id: "request:role", remoteId: "request:remote", contactId: contact.id,
      contactGeneration: contact.generation, direction, kind: "task", title: "Participant-owned work",
      state, revision: 1, createdAtMs: 1_000, updatedAtMs: 1_000,
    };
    const enqueue = vi.fn();
    const updateRequest = vi.fn();
    const ctx = focusedContext({
      federation: focusedFixture({
        prune: vi.fn(), outboxByIdempotency: () => null, get: () => contact,
        request: () => request, enqueue, updateRequest,
      }),
    });
    await expect(handleContactRequestUpdate({ requestId: request.id, state: next }, ctx))
      .rejects.toThrow("This participant cannot change");
    expect(enqueue).not.toHaveBeenCalled();
    expect(updateRequest).not.toHaveBeenCalled();
  });

  it("lets only the signed-in human dismiss their own social upgrade notice", () => {
    const dismissAttentionNotice = vi.fn(() => true);
    const broadcastToUserUid = vi.fn();
    const ctx = focusedContext({ federation: focusedFixture({ dismissAttentionNotice }), broadcastToUserUid });
    expect(() => handleContactNoticeDismiss({ ...ctx, processId: "proc:ship" })).toThrow("requires a signed-in human");
    expect(dismissAttentionNotice).not.toHaveBeenCalled();
    expect(handleContactNoticeDismiss(ctx)).toEqual({});
    expect(dismissAttentionNotice).toHaveBeenCalledExactlyOnceWith(OWNER.uid);
    expect(broadcastToUserUid).toHaveBeenCalledExactlyOnceWith(OWNER.uid, "contact.changed");
  });

  it("notifies the owner after a saved alias change, but not for a no-op or failed write", () => {
    let contact = activeContact();
    const broadcastToUserUid = vi.fn();
    const setAlias = vi.fn((_id: string, _uid: number, alias: string | null) => {
      contact = { ...contact, localAlias: alias ?? undefined };
      return contact;
    });
    const setTitle = vi.fn();
    const ctx = focusedContext({
      federation: focusedFixture({ get: () => contact, setAlias }),
      conversations: focusedFixture({ setTitle }),
      broadcastToUserUid,
    });
    broadcastToUserUid.mockImplementation(() => {
      expect(contact.localAlias).toBe("My friend");
      expect(setTitle).toHaveBeenCalled();
    });
    handleContactAliasSet({ contactId: contact.id, alias: "My friend" }, ctx);
    expect(broadcastToUserUid).toHaveBeenCalledExactlyOnceWith(OWNER.uid, "contact.changed");
    handleContactAliasSet({ contactId: contact.id, alias: "My friend" }, ctx);
    setAlias.mockImplementation(() => { throw new Error("write failed"); });
    expect(() => handleContactAliasSet({ contactId: contact.id, alias: "New name" }, ctx)).toThrow("write failed");
    expect(broadcastToUserUid).toHaveBeenCalledOnce();
  });

  it("notifies invitation cancellation once, after the saved transition", () => {
    let state: "issued" | "cancelled" = "issued";
    const broadcastToUserUid = vi.fn();
    const ctx = focusedContext({
      federation: focusedFixture({
        invite: () => ({ state }),
        cancelInvite: () => {
          state = "cancelled";
          return { inviteId: "invite:test", state, createdAtMs: 0, cancelledAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 };
        },
      }),
      broadcastToUserUid,
    });
    broadcastToUserUid.mockImplementation(() => expect(state).toBe("cancelled"));
    handleContactInviteCancel({ inviteId: "invite:test" }, ctx);
    handleContactInviteCancel({ inviteId: "invite:test" }, ctx);
    expect(broadcastToUserUid).toHaveBeenCalledExactlyOnceWith(OWNER.uid, "contact.invite.changed");
  });

  it("reports a terminal idempotent delivery as failed", async () => {
    const contact = activeContact();
    const text = "This delivery already exhausted its retries";
    const idempotencyKey = "terminal-delivery";
    const fingerprint = await sha256Base64Url(canonicalJson({
      operation: "contact.send",
      contactId: contact.id,
      text,
      media: [],
    }));
    const record: FederationOutboxRecord = {
      ...pendingDelivery(contact),
      idempotencyKey,
      fingerprint,
      state: "terminal",
      attemptCount: 12,
      lastError: "Remote Ship is unavailable",
    };
    const scheduleFederationDelivery = vi.fn(async () => {});
    const ctx = focusedContext({
      federation: focusedFixture({
        prune: vi.fn(),
        get: vi.fn(() => contact),
        outboxByIdempotency: vi.fn(() => record),
      }),
      scheduleFederationDelivery,
    });

    await expect(handleContactSend({
      contactId: contact.id,
      text,
      idempotencyKey,
    }, ctx)).resolves.toEqual({
      deliveryId: record.deliveryId,
      conversationId: contact.conversationId,
      state: "failed",
    });
    expect(scheduleFederationDelivery).not.toHaveBeenCalled();
  });

  it("persists media intent before retention and never grants it across generations", async () => {
    const contact = activeContact();
    let current = contact;
    let outbox: FederationOutboxRecord | null = null;
    let releaseRetention!: () => void;
    const retentionGate = new Promise<void>((resolve) => {
      releaseRetention = resolve;
    });
    const media = [{
      type: "resource" as const,
      ref: {
        type: "file" as const,
        target: "gsv",
        path: "/home/hank/archive/image.png",
        revision: "revision:image",
        contentType: "image/png",
        size: 10,
      },
    }];
    const retain = vi.spyOn(conversationHandlers, "retainConversationResources")
      .mockImplementation(async (_resources, _pid, _ctx, batchId) => {
        expect(batchId).toBe(outbox?.deliveryId);
        await retentionGate;
        return media;
      });
    vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
    const createGrant = vi.fn();
    const prepareMessage = vi.fn((input: {
      deliveryId: string;
      ownerUid: number;
      contactId: string;
      contactGeneration: string;
      idempotencyKey: string;
      fingerprint: string;
      preparation: FederationMessagePreparation;
      now: number;
    }) => {
      outbox = {
        deliveryId: input.deliveryId,
        ownerUid: input.ownerUid,
        contactId: input.contactId,
        contactGeneration: input.contactGeneration,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        state: "preparing",
        preparation: input.preparation,
        attemptCount: 0,
        nextAttemptAtMs: input.now,
        createdAtMs: input.now,
        updatedAtMs: input.now,
      };
      return { record: outbox, created: true };
    });
    const markOutboxFailed = vi.fn(() => {
      if (!outbox || outbox.state !== "preparing") return false;
      outbox = {
        ...outbox,
        state: "preparation_failed",
        lastError: "Contact is no longer active",
      };
      return true;
    });
    const scheduleFederationDelivery = vi.fn(async () => {});
    const ctx = focusedContext({
      procs: focusedFixture({ get: vi.fn(() => ({})) }),
      federation: focusedFixture({
        prune: vi.fn(),
        get: vi.fn(() => current),
        outboxByIdempotency: vi.fn(() => null),
        outbox: vi.fn(() => outbox),
        pendingOutboxCount: vi.fn(() => 0),
        retainedOutboxCount: vi.fn(() => 0),
        activeGrantCount: vi.fn(() => 0),
        preparingResourceCount: vi.fn(() => 0),
        consumeRateLimits: vi.fn(() => null),
        transaction: runTransaction,
        createGrant,
        prepareMessage,
        markOutboxFailed,
      }),
      scheduleFederationDelivery,
    });

    const sending = handleContactSend({
      contactId: contact.id,
      text: "See the attached image",
      media,
      idempotencyKey: "generation-race",
    }, ctx);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    expect(prepareMessage).toHaveBeenCalledOnce();
    expect(scheduleFederationDelivery).toHaveBeenCalledOnce();
    current = {
      ...contact,
      generation: "generation:replacement",
      threadId: "thread:replacement",
      updatedAtMs: 2_000,
    };
    releaseRetention();

    await expect(sending).resolves.toMatchObject({ state: "failed" });
    expect(createGrant).not.toHaveBeenCalled();
    expect(markOutboxFailed).toHaveBeenCalledOnce();
  });

  it("rejects contact media from a process outside the handler's lineage at send time", async () => {
    const contact = activeContact();
    vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
    const prepareMessage = vi.fn();
    const isDescendant = vi.fn(() => false);
    const ctx = focusedContext({
      processId: "proc:stranger",
      procs: focusedFixture({
        get: vi.fn(() => ({ ownerUid: OWNER.uid, uid: OWNER.uid, gid: OWNER.gid, home: OWNER.home })),
        isDescendant,
      }),
      federation: focusedFixture({
        prune: vi.fn(),
        get: vi.fn(() => contact),
        outboxByIdempotency: vi.fn(() => null),
        pendingOutboxCount: vi.fn(() => 0),
        retainedOutboxCount: vi.fn(() => 0),
        activeGrantCount: vi.fn(() => 0),
        preparingResourceCount: vi.fn(() => 0),
        consumeRateLimits: vi.fn(() => null),
        transaction: runTransaction,
        prepareMessage,
      }),
      scheduleFederationDelivery: vi.fn(async () => {}),
    });

    await expect(handleContactSend({
      contactId: contact.id,
      text: "bill attached",
      media: [{
        type: "resource",
        ref: {
          type: "file",
          target: "gsv",
          path: "/home/hank/archive/bill.pdf",
          revision: "revision:bill",
          contentType: "application/pdf",
          size: 10,
        },
      }],
      idempotencyKey: "stranger-media",
    }, ctx)).rejects.toThrow(/handler process or one of its subprocesses/);

    expect(isDescendant).toHaveBeenCalledWith("proc:stranger", "proc:ship");
    expect(prepareMessage).not.toHaveBeenCalled();
  });

  it("admits contact media from a subprocess of the handler", async () => {
    const contact = activeContact();
    const media = [{
      type: "resource" as const,
      ref: {
        type: "file" as const,
        target: "gsv",
        path: "/home/hank/archive/bill.pdf",
        revision: "revision:bill",
        contentType: "application/pdf",
        size: 10,
      },
    }];
    vi.spyOn(conversationHandlers, "retainConversationResources").mockResolvedValue(media);
    vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
    let outbox: FederationOutboxRecord | null = null;
    const prepareMessage = vi.fn((input: {
      deliveryId: string;
      ownerUid: number;
      contactId: string;
      contactGeneration: string;
      idempotencyKey: string;
      fingerprint: string;
      preparation: FederationMessagePreparation;
      now: number;
    }) => {
      outbox = {
        deliveryId: input.deliveryId,
        ownerUid: input.ownerUid,
        contactId: input.contactId,
        contactGeneration: input.contactGeneration,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        state: "preparing",
        preparation: input.preparation,
        attemptCount: 0,
        nextAttemptAtMs: input.now,
        createdAtMs: input.now,
        updatedAtMs: input.now,
      };
      return { record: outbox, created: true };
    });
    const isDescendant = vi.fn(() => true);
    const ctx = focusedContext({
      processId: "proc:child",
      procs: focusedFixture({
        get: vi.fn(() => ({ ownerUid: OWNER.uid, uid: OWNER.uid, gid: OWNER.gid, home: OWNER.home })),
        isDescendant,
      }),
      federation: focusedFixture({
        prune: vi.fn(),
        get: vi.fn(() => contact),
        outboxByIdempotency: vi.fn(() => null),
        outbox: vi.fn(() => outbox),
        pendingOutboxCount: vi.fn(() => 0),
        retainedOutboxCount: vi.fn(() => 0),
        activeGrantCount: vi.fn(() => 0),
        preparingResourceCount: vi.fn(() => 0),
        consumeRateLimits: vi.fn(() => null),
        transaction: runTransaction,
        createGrant: vi.fn(),
        prepareMessage,
        markOutboxFailed: vi.fn(() => false),
      }),
      scheduleFederationDelivery: vi.fn(async () => {}),
    });

    await handleContactSend({
      contactId: contact.id,
      text: "bill attached",
      media,
      idempotencyKey: "child-media",
    }, ctx);

    expect(isDescendant).toHaveBeenCalledWith("proc:child", "proc:ship");
    expect(prepareMessage).toHaveBeenCalledOnce();
    expect(prepareMessage.mock.calls[0][0].preparation).toMatchObject({
      localMessage: { processId: "proc:child", author: { kind: "process", pid: "proc:child" } },
    });
  });

  it("does not create a request across a contact generation change", async () => {
    const contact = activeContact();
    let current = contact;
    const createRequest = vi.fn();
    const enqueue = vi.fn();
    const scheduleFederationDelivery = vi.fn(async () => {});
    const ctx = focusedContext({
      federation: focusedFixture({
        prune: vi.fn(),
        get: vi.fn(() => current),
        outboxByIdempotency: vi.fn(() => {
          current = {
            ...contact,
            generation: "generation:replacement",
            threadId: "thread:replacement",
            updatedAtMs: 2_000,
          };
          return null;
        }),
        pendingOutboxCount: vi.fn(() => 0),
        retainedOutboxCount: vi.fn(() => 0),
        requestCount: vi.fn(() => 0),
        transaction: runTransaction,
        createRequest,
        enqueue,
      }),
      scheduleFederationDelivery,
    });

    await expect(handleContactRequestCreate({
      contactId: contact.id,
      kind: "task",
      title: "Do not cross the generation boundary",
      idempotencyKey: "request-generation-race",
    }, ctx)).rejects.toThrow("generation changed");
    expect(createRequest).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(scheduleFederationDelivery).not.toHaveBeenCalled();
  });

});

function activeContact(): FederationContactRecord {
  return {
    preferences: { saved: true, muted: false, shipHandlesMessages: false, revision: 1 },
    blocked: false,
    id: "contact:remote",
    ownerUid: OWNER.uid,
    state: "active",
    generation: "generation:remote",
    remoteDid: "did:plc:remoteaaaaaaaaaaaaaaaaaa",
    remoteName: "Remote",
    conversationId: "conversation:remote",
    threadId: "thread:remote",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function pendingDelivery(contact: FederationContactRecord): FederationOutboxRecord {
  return {
    retryable: false,
    retryEpoch: 0,
    deliveryId: "delivery:remote",
    ownerUid: OWNER.uid,
    contactId: contact.id,
    contactGeneration: contact.generation,
    idempotencyKey: "delivery-idempotency",
    fingerprint: "delivery-fingerprint",
    payload: {
      kind: "message",
      messageId: "message:remote",
      threadId: contact.threadId,
      text: "Hello",
      social: {
        threadId: contact.threadId,
        reference: { did: LOCAL_DID, messageId: "message:remote" },
        provenance: { kind: "human" },
      },
    },
    state: "pending",
    attemptCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function focusedContext(overrides: Partial<KernelContext>): KernelContext {
  const base = {
    env: {},
    installationId: "installation:test",
    installationIdentity: {
      installationId: "installation:test",
      handle: "test",
      canonicalOrigin: "https://local.example",
    },
    peer: testPeer({ kind: "human", account: OWNER, calls: [] }),
    callerOwnerUid: OWNER.uid,
    connection: {},
    auth: {
      getPasswdByUid: () => ({ ...OWNER, gecos: OWNER.username, shell: "/bin/init" }),
      getShadowByUsername: () => ({ username: OWNER.username, hash: "unlocked" }),
      isPersonalAgentUid: () => false,
    },
    procs: {},
    coordinateFederationContact: async <T>(_id: string, operation: () => T | Promise<T>) => operation(),
    broadcastToUserUid: vi.fn(),
    approaches: focusedFixture({ pendingConnection: () => false }),
    shipIdentity: focusedFixture({ current: () => LOCAL_DID }),
    ...overrides,
  };
  // SAFETY: each test exercises only the KernelContext members supplied by its focused fixture.
  return base as KernelContext;
}

function focusedFixture<T extends object>(value: Partial<T>): T {
  // SAFETY: focused tests invoke only the explicitly supplied members.
  return value as T;
}

function runTransaction<Value>(operation: () => Value): Value {
  return operation();
}
