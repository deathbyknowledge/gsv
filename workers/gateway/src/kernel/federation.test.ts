import type {
  FederationDeliveryReceipt,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import {
  federationDeliveryEnvelopeSchema,
  jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import * as conversationHandlers from "./conversation-handlers";
import type { KernelContext } from "./context";
import {
  base64UrlEncode,
  canonicalJson,
  randomBase64Url,
  sha256Base64Url,
  signContactEnvelope,
} from "./federation-crypto";
import type {
  FederationContactRecord,
  FederationMessagePreparation,
  FederationOutboxRecord,
} from "./federation-store";
import {
  handleContactInviteAccept,
  handleContactRequestCreate,
  handleContactResourceRead,
  handleContactResourceSend,
  handleContactSend,
  processFederationDelivery,
} from "./federation";
import * as personalController from "./personal-controller";

const OWNER: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [100, 1000],
  username: "hank",
  home: "/home/hank",
  cwd: "/home/hank",
};

describe("federation outbound boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts invite discovery without contacting the acceptance endpoint", async () => {
    const controller = new AbortController();
    const remoteOrigin = "https://remote.example";
    const code = inviteCode(remoteOrigin);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Federation fetch has no cancellation signal"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );
    const ctx = focusedContext({
      requestSignal: controller.signal,
      federation: focusedFixture({
        prune: vi.fn(),
        pairingAttempt: vi.fn(() => null),
      }),
    });

    const acceptance = handleContactInviteAccept({ code }, ctx);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error("Pairing cancelled"));

    await expect(acceptance).rejects.toThrow("Pairing cancelled");
    expect(fetchMock).toHaveBeenCalledWith(
      `${remoteOrigin}/.well-known/gsv/federation/v1/ship`,
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses local delivery completion time", async () => {
    const now = 50_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const contact = activeContact();
    const record = pendingDelivery(contact);
    const markDeliverySucceeded = vi.fn(() => true);
    const markContactDelivered = vi.fn(() => true);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = federationDeliveryEnvelopeSchema.parse(JSON.parse(String(init?.body)));
      const unsigned = {
        version: 1 as const,
        deliveryId: body.deliveryId,
      };
      const receipt: FederationDeliveryReceipt = {
        ...unsigned,
        signature: await signContactEnvelope(
          contact.sharedSecret,
          jsonValueSchema.parse(unsigned),
        ),
      };
      return Response.json(receipt);
    });
    const ctx = focusedContext({
      federation: focusedFixture({
        outbox: vi.fn(() => record),
        get: vi.fn(() => contact),
        ensureSubject: vi.fn(() => ({ id: "subject:local", displayName: OWNER.username })),
        transaction: runTransaction,
        markDeliverySucceeded,
        markContactDelivered,
      }),
      federationIdentity: focusedFixture({
        ensure: vi.fn(async () => ({
          version: 1,
          shipId: "ship:local",
          origin: "https://local.example",
          publicKey: { kty: "EC", crv: "P-256", x: "local-x", y: "local-y" },
          protocols: ["gsv-federation/1"],
          issuedAtMs: now,
          signature: "local-signature",
        })),
      }),
    });

    await processFederationDelivery(record.deliveryId, ctx);

    expect(markDeliverySucceeded).toHaveBeenCalledWith(
      record.deliveryId,
      record.contactGeneration,
      now,
    );
    expect(markContactDelivered).toHaveBeenCalledWith(
      contact.id,
      record.contactGeneration,
      now,
    );
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

  it("does not start a delivery after its contact generation changes", async () => {
    const contact = activeContact();
    const record = pendingDelivery(contact);
    let current = contact;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const ctx = focusedContext({
      federation: focusedFixture({
        outbox: vi.fn(() => record),
        get: vi.fn(() => current),
      }),
      federationIdentity: focusedFixture({
        ensure: vi.fn(async () => {
          current = {
            ...contact,
            generation: "generation:replacement",
            threadId: "thread:replacement",
            updatedAtMs: 2_000,
          };
          return {
            version: 1,
            shipId: "ship:local",
            origin: "https://local.example",
            publicKey: { kty: "EC", crv: "P-256", x: "local-x", y: "local-y" },
            protocols: ["gsv-federation/1"],
            issuedAtMs: Date.now(),
            signature: "local-signature",
          };
        }),
      }),
    });

    await processFederationDelivery(record.deliveryId, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
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
        ensureSubject: vi.fn(() => ({ id: "subject:local", displayName: OWNER.username })),
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
        ensureSubject: vi.fn(() => ({ id: "subject:local", displayName: OWNER.username })),
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
        ensureSubject: vi.fn(() => ({ id: "subject:local", displayName: OWNER.username })),
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

  it("cancels a remote resource body when the contact changes during fetch", async () => {
    const contact = activeContact();
    let current = contact;
    const cancelSource = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelSource });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      current = {
        ...contact,
        state: "revoked",
        revokedAtMs: 2_000,
        updatedAtMs: 2_000,
      };
      return await remoteResourceResponse(contact, source, init);
    });

    await expect(handleContactResourceSend({
      path: "/resources/resource:remote",
      target: contact.id,
    }, focusedResourceContext(() => current), "resource-read"))
      .rejects.toThrow("generation changed");
    expect(cancelSource).toHaveBeenCalledOnce();
  });

  it("cancels a remote resource stream before yielding a chunk after revocation", async () => {
    const contact = activeContact();
    let current = contact;
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const cancelSource = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        sourceController = controller;
        return pullGate;
      },
      cancel: cancelSource,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => (
      await remoteResourceResponse(contact, source, init)
    ));
    const response = await handleContactResourceSend({
      path: "/resources/resource:remote",
      target: contact.id,
    }, focusedResourceContext(() => current), "resource-read");
    if (!response.body) throw new Error("Resource response has no body");
    const reader = response.body.stream.getReader();
    const reading = reader.read();
    await vi.waitFor(() => expect(sourceController).toBeDefined());
    current = {
      ...contact,
      state: "revoked",
      revokedAtMs: 2_000,
      updatedAtMs: 2_000,
    };
    sourceController.enqueue(new TextEncoder().encode("private bytes"));
    releasePull();

    await expect(reading).rejects.toThrow("authorization changed");
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    expect(cancelSource).toHaveBeenCalledOnce();
  });

  it("reads an authorized Contact resource through the ordinary Read contract", async () => {
    const contact = activeContact();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello contact"));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => (
      await remoteResourceResponse(contact, source, init, "text/plain")
    ));

    const response = await handleContactResourceRead({
      target: contact.id,
      path: "/resources/resource:remote",
      limit: 10,
    }, focusedResourceContext(() => contact), "resource-read");

    expect(response.data).toMatchObject({
      ok: true,
      kind: "text",
      path: "/resources/resource:remote",
      contentType: "text/plain",
      size: 13,
    });
    expect(await new Response(response.body?.stream).text()).toBe("hello contact");
  });
});

function activeContact(): FederationContactRecord {
  return {
    id: "contact:remote",
    ownerUid: OWNER.uid,
    state: "active",
    generation: "generation:remote",
    remoteShipId: "ship:remote",
    remoteSubject: { id: "subject:remote", displayName: "Remote" },
    remoteOrigin: "https://remote.example",
    remotePublicKey: { kty: "EC", crv: "P-256", x: "remote-x", y: "remote-y" },
    sharedSecret: randomBase64Url(32),
    conversationId: "conversation:remote",
    threadId: "thread:remote",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function pendingDelivery(contact: FederationContactRecord): FederationOutboxRecord {
  return {
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
    },
    state: "pending",
    attemptCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function inviteCode(origin: string): string {
  const value = {
    version: 1,
    origin,
    shipId: "ship:remote",
    subject: { id: "subject:remote", displayName: "Remote" },
    token: randomBase64Url(32),
    expiresAtMs: Date.now() + 60_000,
  };
  return `gsv-contact-v1:${base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))}`;
}

function focusedContext(overrides: Partial<KernelContext>): KernelContext {
  const base = {
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
    ...overrides,
  };
  // SAFETY: each test exercises only the KernelContext members supplied by its focused fixture.
  return base as KernelContext;
}

function focusedResourceContext(
  getContact: () => FederationContactRecord,
): KernelContext {
  return focusedContext({
    federation: focusedFixture({
      get: vi.fn(getContact),
      ensureSubject: vi.fn(() => ({ id: "subject:local", displayName: OWNER.username })),
    }),
    federationIdentity: focusedFixture({
      ensure: vi.fn(async () => ({
        version: 1,
        shipId: "ship:local",
        origin: "https://local.example",
        publicKey: { kty: "EC", crv: "P-256", x: "local-x", y: "local-y" },
        protocols: ["gsv-federation/1"],
        issuedAtMs: Date.now(),
        signature: "local-signature",
      })),
    }),
  });
}

async function remoteResourceResponse(
  contact: FederationContactRecord,
  body: ReadableStream<Uint8Array>,
  init: RequestInit | undefined,
  contentType = "application/octet-stream",
): Promise<Response> {
  const nonce = new Headers(init?.headers).get("x-gsv-nonce");
  if (!nonce) throw new Error("Resource request has no nonce");
  const fields = {
    version: 1,
    resourceId: "resource:remote",
    requestNonce: nonce,
    size: 13,
    revision: "revision:remote",
    contentType,
  };
  return new Response(body, {
    headers: {
      "content-type": fields.contentType,
      "x-gsv-resource-size": String(fields.size),
      "x-gsv-resource-revision": fields.revision,
      "x-gsv-resource-signature": await signContactEnvelope(
        contact.sharedSecret,
        jsonValueSchema.parse(fields),
      ),
    },
  });
}

function focusedFixture<T extends object>(value: Partial<T>): T {
  // SAFETY: focused tests invoke only the explicitly supplied members.
  return value as T;
}

function runTransaction<Value>(operation: () => Value): Value {
  return operation();
}
