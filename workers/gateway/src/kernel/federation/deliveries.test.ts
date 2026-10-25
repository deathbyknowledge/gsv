import { reset } from "cloudflare:test";
import { ACCEPT_INVITATION, ATTACHMENT_REVISION_HEADER, ATTACHMENT_SIZE_HEADER, type ContactSendArgs } from "@humansandmachines/gsv/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeFs from "../../drivers/native/fs";
import * as utils from "../../shared/utils";
import { TestShipNetwork } from "../../test-support/ship-network";
import { loseNextAnswer, SPACE_OWNER_UID, testSpace, type TestSpace } from "../../test-support/ship-spaces";
import type { KernelContext } from "../context";
import type { FederationContactRecord } from "../federation-store";
import {
  handleContactResourceRead,
  handleContactResourceSend,
  handleContactRevoke,
  handleContactSend,
  processFederationDelivery,
} from "../federation";
import { handleContactInviteAccept, handleContactInviteCreate } from "./invitations";

let network: TestShipNetwork;
let alice: TestSpace;
let bob: TestSpace;
let mallory: TestSpace;

beforeEach(async () => {
  network = new TestShipNetwork().install();
  [alice, bob, mallory] = [await testSpace(network, "alice"), await testSpace(network, "bob"), await testSpace(network, "mallory")];
  await connect(alice, bob);
});

afterEach(async () => {
  // Delivery alarms belong to this test's Kernels, not the next test's network.
  await reset();
  vi.restoreAllMocks();
});

describe("deliveries between Ships", () => {
  it("delivers a message under its sender's DID, and a reply that quotes it", async () => {
    expect(await send(alice, bob, { text: "Are you free on Friday?" })).toBe("delivered");
    const [question] = await conversation(bob, alice);
    expect(question).toMatchObject({
      text: "Are you free on Friday?",
      author: { kind: "contact", displayName: "Alice" },
      social: { reference: { did: alice.account.did }, provenance: { kind: "human" } },
    });

    expect(await send(bob, alice, { text: "Friday works", replyTo: question?.social?.reference })).toBe("delivered");
    const [asked, answer] = await conversation(alice, bob);
    expect(answer).toMatchObject({
      text: "Friday works",
      author: { kind: "contact", displayName: "Bob" },
      social: { reference: { did: bob.account.did }, replyTo: asked?.social?.reference },
    });
  });

  it("keeps a message for later when it reaches a Ship still accepting the connection", async () => {
    // Alice's Ship records Mallory's acceptance before Mallory's does, and its answer is lost.
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    loseNextAnswer(network, alice, ACCEPT_INVITATION);
    await expect(mallory.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: false }, ctx))).rejects.toThrow("Network connection lost");
    expect(await send(alice, mallory, { text: "Welcome aboard" })).toBe("pending");
    // Mallory's Ship accepts again and hears of the same connection, and the message arrives when Alice's Ship tries again.
    await mallory.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: false }, ctx));
    await deliverPending(alice);
    expect((await conversation(mallory, alice)).map((message) => message.text)).toEqual(["Welcome aboard"]);
  });

  it("ends the connection on both sides when one person removes the other", async () => {
    await alice.run(async (ctx) => void await handleContactRevoke({ contactId: contactFor(ctx, bob).id }, held(ctx)));
    await deliverPending(alice);
    expect(await bob.run((ctx) => contactFor(ctx, alice).state)).toBe("revoked");
  });

  it("doesn't deliver a message once its contact is replaced while the message is saved", async () => {
    const deliveryId = await alice.run(async (ctx) => {
      const { deliveryId } = await handleContactSend({ contactId: contactFor(ctx, bob).id, text: "For the old connection", idempotencyKey: "replaced" }, held(ctx));
      const open = utils.getConversationById;
      vi.spyOn(utils, "getConversationById").mockImplementationOnce((installationId, conversationId) => {
        // Alice and Bob connect again while her Ship saves its copy of the message.
        ctx.federation.transaction(() => ctx.federation.activateContact({
          ownerUid: SPACE_OWNER_UID,
          remoteDid: bob.account.did,
          remoteName: "Bob",
          generation: "generation:replacement",
          threadId: "thread:replacement",
        }));
        return open(installationId, conversationId);
      });
      await processFederationDelivery(deliveryId, held(ctx));
      return deliveryId;
    });
    expect(await bob.run((ctx) => {
      const contact = contactFor(ctx, alice);
      return ctx.federation.inbox(contact.id, contact.generation, deliveryId);
    })).toBeNull();
  });

  it("lets a contact read an attachment, and no one else, while they're connected", async () => {
    await connect(alice, mallory);
    vi.spyOn(nativeFs, "handleFsTransferSend").mockImplementation(async () => noteFile("hello contact"));
    const resourceId = await alice.run((ctx) => grantNote(ctx, contactFor(ctx, bob)).id);
    const read = (reader: TestSpace) => reader.run(async (ctx) => {
      const { data, body } = await handleContactResourceRead({ target: contactFor(ctx, alice).id, path: `/resources/${resourceId}`, limit: 100 }, ctx, "read");
      return { data, text: body ? await new Response(body.stream).text() : null };
    });
    expect(await read(bob)).toMatchObject({ data: { ok: true, kind: "text", contentType: "text/plain", size: 13 }, text: "hello contact" });
    const refused = { data: { ok: false, error: "Remote resource request failed (404)" }, text: null };
    expect(await read(mallory)).toEqual(refused);
    // Alice's Ship refuses Bob as soon as she removes him, before his Ship hears of it.
    await alice.run(async (ctx) => void await handleContactRevoke({ contactId: contactFor(ctx, bob).id }, held(ctx)));
    expect(await read(bob)).toEqual(refused);
  });

  it("cancels an attachment's body when the contact ends while it's fetched", async () => {
    await bob.run(async (ctx) => {
      const contact = contactFor(ctx, alice);
      const cancelled = vi.fn();
      network.hosts.set(alice.hostname, () => {
        // Bob removes Alice while her Ship answers.
        ctx.federation.revoke(contact.id, SPACE_OWNER_UID);
        return attachment(new ReadableStream({ cancel: cancelled }));
      });
      await expect(handleContactResourceSend({ path: "/resources/resource:remote", target: contact.id }, ctx, "read"))
        .rejects.toThrow("generation changed");
      expect(cancelled).toHaveBeenCalledOnce();
    });
  });

  it("cancels an attachment's stream before passing on a chunk once the contact ends", async () => {
    await bob.run(async (ctx) => {
      const contact = contactFor(ctx, alice);
      const cancelled = vi.fn();
      const pulled = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      const released = Promise.withResolvers<void>();
      network.hosts.set(alice.hostname, () => attachment(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled.resolve(controller);
          return released.promise;
        },
        cancel: cancelled,
      })));
      const response = await handleContactResourceSend({ path: "/resources/resource:remote", target: contact.id }, ctx, "read");
      if (!response.body) throw new Error("The attachment has no body");
      const reader = response.body.stream.getReader();
      const reading = reader.read();
      const source = await pulled.promise;
      ctx.federation.revoke(contact.id, SPACE_OWNER_UID);
      source.enqueue(new TextEncoder().encode("private bytes"));
      released.resolve();
      await expect(reading).rejects.toThrow("authorization changed");
      await reader.cancel().catch(() => {});
      expect(cancelled).toHaveBeenCalledOnce();
    });
  });
});

describe("a contact whose Ship is gone", () => {
  it("ends once the Ship's space is deleted and its DID tombstoned, failing what waited and keeping the conversation", async () => {
    expect(await send(alice, bob, { text: "See you on Friday" })).toBe("delivered");
    // Bob's space is deleted: his address serves nothing, then erasure tombstones his DID.
    network.hosts.set(bob.hostname, () => new Response("Not Found", { status: 404 }));
    await network.deactivate(bob.account);
    const waiting = await queue(alice, bob, "Are you still coming?");
    expect(await send(alice, bob, { text: "Hello?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("revoked");
    expect(await alice.run((ctx) => ctx.federation.outbox(waiting))).toMatchObject({ state: "terminal", lastError: "Contact was revoked" });
    // Nothing is sent to a Ship that is gone, and the conversation stays.
    expect(await alice.run((ctx) => ctx.federation.recoverableOutbox(100))).toEqual([]);
    expect((await conversation(alice, bob)).map((message) => message.text)).toContain("See you on Friday");
  });

  it("ends once the directory reports its DID deactivated", async () => {
    await network.deactivate(bob.account);
    // A daily refresh found the tombstone and dropped the copy Alice's Ship kept.
    await alice.run((ctx) => ctx.didDocuments.delete(bob.account.did));
    expect(await send(alice, bob, { text: "Hello?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("revoked");
  });

  it("ends once another Ship holds its address and refuses a call addressed to it", async () => {
    // An operator resets Bob's space: his address serves a new Ship with its own DID, and his old DID still names the address.
    const successor = await testSpace(network, "bob");
    expect(successor.account.did).not.toBe(bob.account.did);
    expect(await send(alice, bob, { text: "Hello?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("revoked");
  });

  it.each<[string, string | null]>([
    ["serves its Ship elsewhere", "https://elsewhere.ship.test"],
    ["isn't a Ship", null],
  ])("keeps the contact when its address misroutes a call and names another account that %s", async (_holder, endpoint) => {
    // Bob's host refuses one token by mistake, and its hostname is also the handle of an account that serves no Ship there.
    const { ship: _ship, ...services } = bob.account.services;
    const other = await network.account(bob.hostname, endpoint ? { ...services, ship: { type: "ShipService", endpoint } } : services);
    network.hosts.set(bob.hostname, (request) => new URL(request.url).pathname === "/.well-known/atproto-did"
      ? new Response(other.did)
      : Response.json({ error: "BadJwtAudience", message: "The token is addressed to another service" }, { status: 401 }));
    expect(await send(alice, bob, { text: "Hello?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("active");
  });

  it("keeps the contact while the directory can't be reached, and ends it once the directory answers", async () => {
    await testSpace(network, "bob");
    network.plcReachable = false;
    expect(await send(alice, bob, { text: "Hello?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("active");
    network.plcReachable = true;
    expect(await send(alice, bob, { text: "Anyone there?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("revoked");
  });

  it("keeps the contact when its Ship moved before another took the old address, and reaches the new one", async () => {
    const serveBob = network.hosts.get(bob.hostname);
    if (!serveBob) throw new Error("Bob's Ship has no host");
    network.hosts.set("bob-moved.ship.test", serveBob);
    await network.setServices(bob.account, { ...bob.account.services, ship: { type: "ShipService", endpoint: "https://bob-moved.ship.test" } });
    await testSpace(network, "bob");
    // Alice's Ship calls the address it knew; the refusal sends it to the directory, which names the new one.
    expect(await send(alice, bob, { text: "Hello?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("active");
    expect(await send(alice, bob, { text: "Found you" })).toBe("delivered");
  });

  it("keeps the contact when its DID no longer names a Ship service", async () => {
    // Bob takes his account elsewhere; the DID is still his, and he can make it a Ship again.
    const { ship: _ship, ...services } = bob.account.services;
    await network.setServices(bob.account, services);
    network.hosts.set(bob.hostname, () => new Response("Not Found", { status: 404 }));
    expect(await send(alice, bob, { text: "Hello?" })).toBe("terminal");
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("active");
  });

  it.each<[string, () => Response]>([
    ["a timeout", () => { throw new DOMException("The operation timed out", "TimeoutError"); }],
    ["a server error", () => Response.json({ error: "InternalServerError", message: "Try again" }, { status: 500 })],
    ["a rate limit", () => Response.json({ error: "RateLimitExceeded", message: "Slow down" }, { status: 429 })],
  ])("keeps the contact and tries again after %s", async (_failure, answer) => {
    network.hosts.set(bob.hostname, answer);
    const deliveryId = await queue(alice, bob, "Hello?");
    const retries: string[] = [];
    await alice.run((ctx) => processFederationDelivery(deliveryId, held(ctx, retries)));
    expect(await alice.run((ctx) => ctx.federation.outbox(deliveryId))).toMatchObject({ state: "pending", attemptCount: 1 });
    expect(retries).toEqual([deliveryId]);
    expect(await alice.run((ctx) => contactFor(ctx, bob).state)).toBe("active");
  });
});

/** Connects two spaces' people through an invitation. */
async function connect(inviter: TestSpace, acceptor: TestSpace): Promise<void> {
  const { code } = await inviter.run((ctx) => handleContactInviteCreate({}, ctx));
  await acceptor.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: false }, ctx));
}

function contactFor(ctx: KernelContext, other: TestSpace): FederationContactRecord {
  const contact = ctx.federation.getByRemote(SPACE_OWNER_UID, other.account.did);
  if (!contact) throw new Error(`There's no contact for ${other.name}`);
  return contact;
}

/** The space's context with its delivery alarms held, so the test delivers when it chooses; `retries` names what they would retry. */
function held(ctx: KernelContext, retries: string[] = []): KernelContext {
  return { ...ctx, scheduleFederationDelivery: async (deliveryId) => void retries.push(deliveryId) };
}

/** Sends a message to a contact and delivers it, returning its delivery's state. */
async function send(from: TestSpace, to: TestSpace, args: Omit<ContactSendArgs, "contactId" | "idempotencyKey">): Promise<string | undefined> {
  return await from.run(async (ctx) => {
    const { deliveryId } = await handleContactSend({ contactId: contactFor(ctx, to).id, idempotencyKey: crypto.randomUUID(), ...args }, held(ctx));
    await processFederationDelivery(deliveryId, held(ctx));
    return ctx.federation.outbox(deliveryId)?.state;
  });
}

/** Queues a message to a contact without delivering it, returning its delivery. */
async function queue(from: TestSpace, to: TestSpace, text: string): Promise<string> {
  return await from.run(async (ctx) => (await handleContactSend({ contactId: contactFor(ctx, to).id, text, idempotencyKey: crypto.randomUUID() }, held(ctx))).deliveryId);
}

/** Delivers everything a space has waiting, as its delivery alarms would. */
async function deliverPending(space: TestSpace): Promise<void> {
  await space.run(async (ctx) => {
    for (const { deliveryId } of ctx.federation.recoverableOutbox(100)) await processFederationDelivery(deliveryId, held(ctx));
  });
}

/** A space's conversation with a contact, as its person sees it. */
async function conversation(space: TestSpace, other: TestSpace) {
  return await space.run(async (ctx) => (await utils.getConversationById(ctx.installationId, contactFor(ctx, other).conversationId).history()).messages);
}

function grantNote(ctx: KernelContext, contact: FederationContactRecord) {
  const descriptor = { revision: "revision:note", contentType: "text/plain", size: 13 };
  return ctx.federation.createGrant({
    contactId: contact.id,
    contactGeneration: contact.generation,
    source: { type: "resource", ref: { type: "file", target: "gsv", path: "/home/alice/note.txt", ...descriptor } },
    sourceUid: SPACE_OWNER_UID,
    descriptor,
  });
}

/** The granted note, as the space's filesystem opens it. */
function noteFile(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    type: "res" as const,
    id: "note-open",
    ok: true as const,
    data: { ok: true as const, path: "/home/alice/note.txt", size: bytes.byteLength, contentType: "text/plain", revision: "revision:note" },
    body: { stream: new Blob([bytes]).stream(), length: bytes.byteLength },
  };
}

/** An attachment as the other Ship answers `space.ship.getAttachment`. */
function attachment(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: { "content-type": "application/octet-stream", [ATTACHMENT_SIZE_HEADER]: "13", [ATTACHMENT_REVISION_HEADER]: "revision:remote" },
  });
}
