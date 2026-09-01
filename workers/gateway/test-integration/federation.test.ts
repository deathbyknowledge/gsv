import {
  bodyFromBytes,
  bodyToBytes,
  GSVClient,
  type GsvBody,
} from "@humansandmachines/gsv";
import type {
  ContactRequestRecord,
  ContactSendArgs,
  ContactSendResult,
  ContactSummary,
  ConversationHistoryResult,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

const FIRST_USER = "federation-first";
const SECOND_USER = "federation-second";
const PASSWORD = "federation-integration-password";

describe("cross-GSV federation integration", () => {
  let firstHarness: TestHarness;
  let secondHarness: TestHarness;
  let firstOrigin: URL;
  let secondOrigin: URL;
  let first: GSVClient;
  let second: GSVClient;

  beforeAll(async () => {
    firstHarness = createGatewayTestHarness();
    secondHarness = createGatewayTestHarness();
    const [firstListener, secondListener] = await Promise.all([
      firstHarness.listen(),
      secondHarness.listen(),
    ]);
    firstOrigin = loopbackOrigin(firstListener.url);
    secondOrigin = loopbackOrigin(secondListener.url);

    await Promise.all([
      setup(firstOrigin, FIRST_USER, "first_ship"),
      setup(secondOrigin, SECOND_USER, "second_ship"),
    ]);
    first = connectedClient(firstOrigin, FIRST_USER, "federation-first-client");
    second = connectedClient(secondOrigin, SECOND_USER, "federation-second-client");
    await Promise.all([first.connect(), second.connect()]);
  });

  afterAll(async () => {
    first?.close();
    second?.close();
    await Promise.all([
      firstHarness?.close(),
      secondHarness?.close(),
    ]);
  });

  it("pairs two Ships and carries messages, requests, resources, and revocation", async () => {
    const [firstDiscovery, secondDiscovery] = await Promise.all([
      fetch(new URL("/.well-known/gsv/federation/v1/ship", firstOrigin)),
      fetch(new URL("/.well-known/gsv/federation/v1/ship", secondOrigin)),
    ]);
    expect(firstDiscovery.status).toBe(200);
    expect(secondDiscovery.status).toBe(200);
    const invalidAcceptance = await fetch(
      new URL("/_gsv/federation/v1/invites/accept", firstOrigin),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(invalidAcceptance.status).toBe(400);

    const cancelledInvite = await first.contact.invite.create({ expiresInSeconds: 300 });
    const pendingInvites = await first.contact.invite.list({});
    expect(pendingInvites.invites).toEqual([
      expect.objectContaining({
        inviteId: cancelledInvite.inviteId,
        state: "pending",
      }),
    ]);
    expect(pendingInvites.invites[0]).not.toHaveProperty("code");
    await first.contact.invite.cancel({ inviteId: cancelledInvite.inviteId });
    await expect(second.contact.invite.accept({ code: cancelledInvite.code }))
      .rejects.toThrow("410");
    expect(await first.contact.invite.list({ includeTerminal: true })).toEqual({
      invites: [expect.objectContaining({
        inviteId: cancelledInvite.inviteId,
        state: "cancelled",
      })],
    });

    const invite = await first.contact.invite.create({ expiresInSeconds: 300 });
    const [accepted, acceptanceReplay] = await Promise.all([
      second.contact.invite.accept({ code: invite.code }),
      second.contact.invite.accept({ code: invite.code }),
    ]);
    expect(acceptanceReplay.contact).toEqual(accepted.contact);
    const [initialInviterResponsibilities, initialAccepterResponsibilities] = await Promise.all([
      contactAddedResponsibilities(first),
      contactAddedResponsibilities(second),
    ]);
    expect(initialInviterResponsibilities).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          eventType: "contact.added",
          contactGeneration: accepted.contact.generation,
          displayName: SECOND_USER,
          inviteDirection: "outgoing",
          contentTrust: "untrusted",
        }),
      }),
    ]);
    expect(initialAccepterResponsibilities).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          eventType: "contact.added",
          contactGeneration: accepted.contact.generation,
          displayName: FIRST_USER,
          inviteDirection: "incoming",
          contentTrust: "untrusted",
        }),
      }),
    ]);
    const replacementInvite = await first.contact.invite.create({ expiresInSeconds: 300 });
    const replacement = await second.contact.invite.accept({ code: replacementInvite.code });
    expect(replacement.contact.generation).not.toBe(accepted.contact.generation);
    const [replacementInviterResponsibilities, replacementAccepterResponsibilities] =
      await Promise.all([
        contactAddedResponsibilities(first),
        contactAddedResponsibilities(second),
      ]);
    expect(replacementInviterResponsibilities).toHaveLength(2);
    expect(replacementInviterResponsibilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        details: expect.objectContaining({
          contactGeneration: replacement.contact.generation,
          inviteDirection: "outgoing",
        }),
      }),
    ]));
    expect(replacementAccepterResponsibilities).toHaveLength(2);
    expect(replacementAccepterResponsibilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        details: expect.objectContaining({
          contactGeneration: replacement.contact.generation,
          inviteDirection: "incoming",
        }),
      }),
    ]));
    await expect(second.contact.invite.accept({ code: invite.code }))
      .rejects.toThrow("pairing attempt was superseded");
    const currentContacts = await second.contact.list({});
    expect(currentContacts.contacts).toEqual([
      expect.objectContaining({ generation: replacement.contact.generation }),
    ]);
    const firstContact = await waitForContact(first);
    const secondContact = currentContacts.contacts[0];

    expect(firstContact.remoteOrigin).toBe(secondOrigin.origin);
    expect(secondContact.remoteOrigin).toBe(firstOrigin.origin);
    expect(firstContact.generation).toBe(secondContact.generation);

    const aliased = await first.contact.alias.set({
      contactId: firstContact.id,
      alias: "Second Ship",
    });
    expect(aliased.contact.localAlias).toBe("Second Ship");
    expect((await second.contact.list({})).contacts[0]).not.toHaveProperty("localAlias");

    const messageArgs: ContactSendArgs = {
      contactId: firstContact.id,
      text: "hello from the first Ship",
      idempotencyKey: "integration-message-first-to-second",
    };
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      first.contact.send(messageArgs),
      first.contact.send(messageArgs),
    ]);
    expect(concurrentSecond.deliveryId).toBe(concurrentFirst.deliveryId);
    const delivered = await waitForDelivery(first, messageArgs);
    await expect(first.contact.delivery.get({ deliveryId: delivered.deliveryId })).resolves
      .toEqual({
        delivery: expect.objectContaining({
          deliveryId: delivered.deliveryId,
          state: "delivered",
          conversationId: firstContact.conversationId,
        }),
      });
    const replay = await first.contact.send(messageArgs);
    expect(replay).toEqual(delivered);

    const [firstHistory, secondHistory] = await Promise.all([
      waitForMessage(first, firstContact.conversationId, messageArgs.text),
      waitForMessage(second, secondContact.conversationId, messageArgs.text),
    ]);
    expect(messagesWithText(firstHistory, messageArgs.text)).toHaveLength(1);
    expect(messagesWithText(secondHistory, messageArgs.text)).toHaveLength(1);
    expect(messagesWithText(secondHistory, messageArgs.text)[0]).toMatchObject({
      author: {
        kind: "contact",
        contactId: secondContact.id,
        displayName: FIRST_USER,
      },
      origin: {
        kind: "federation",
        contactId: secondContact.id,
        deliveryId: delivered.deliveryId,
      },
    });

    const outgoing = await first.contact.request.create({
      contactId: firstContact.id,
      kind: "review",
      title: "Review the federation plan",
      details: { document: "engineering/rfcs/0001-cross-gsv-federation.md" },
      idempotencyKey: "integration-request-first-to-second",
    });
    const incoming = await waitForRequest(second, {
      direction: "incoming",
      title: outgoing.request.title,
      state: "offered",
    });
    await second.contact.request.update({
      requestId: incoming.id,
      expectedRevision: incoming.revision,
      state: "accepted",
      details: { reviewer: "Second Ship" },
      idempotencyKey: "integration-request-second-accepts",
    });
    const acceptedAtFirst = await waitForRequest(first, {
      id: outgoing.request.id,
      state: "accepted",
    });
    expect(acceptedAtFirst.details).toEqual({ reviewer: "Second Ship" });

    const reverse = await second.contact.request.create({
      contactId: secondContact.id,
      kind: "question",
      title: "Can the first Ship receive requests too?",
      idempotencyKey: "integration-request-second-to-first",
    });
    const reverseIncoming = await waitForRequest(first, {
      direction: "incoming",
      title: reverse.request.title,
      state: "offered",
    });
    const reverseAccepted = await first.contact.request.update({
      requestId: reverseIncoming.id,
      state: "accepted",
      idempotencyKey: "integration-request-first-accepts",
    });
    await waitForRequest(second, { id: reverse.request.id, state: "accepted" });
    await first.contact.request.update({
      requestId: reverseIncoming.id,
      expectedRevision: reverseAccepted.request.revision,
      state: "completed",
      idempotencyKey: "integration-request-first-completes",
    });
    await waitForRequest(second, { id: reverse.request.id, state: "completed" });

    const resourceBytes = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      71, 83, 86, 45, 70, 69, 68, 69, 82, 65, 84, 73, 79, 78,
    ]);
    const resourcePath = "/tmp/federation-resource.png";
    await first.request("fs.transfer.receive", {
      path: resourcePath,
      contentType: "image/png",
    }, {
      body: bodyFromBytes(resourceBytes),
    });
    const readResponse = await first.request("fs.read", {
      path: resourcePath,
      representation: "resource",
    });
    const read = readResponse.data;
    if (!read.ok || !("resource" in read) || !read.resource) {
      throw new Error("fs.read returned no resource reference");
    }
    const resource: ResourceBlock = {
      type: "resource",
      ref: read.resource,
      mediaType: "image",
      filename: "federation-resource.png",
    };
    const resourceMessage = {
      contactId: firstContact.id,
      text: "resource for the second Ship",
      media: [resource],
      idempotencyKey: "integration-resource-first-to-second",
    } satisfies ContactSendArgs;
    const resourceDelivery = await waitForDelivery(first, resourceMessage);
    const resourceHistory = await waitForMessage(
      second,
      secondContact.conversationId,
      resourceMessage.text,
    );
    const receivedResource = messagesWithText(resourceHistory, resourceMessage.text)[0]?.media?.[0];
    if (!receivedResource || receivedResource.type !== "resource") {
      throw new Error("Contact message returned no resource reference");
    }
    expect(receivedResource.ref.target).toBe(secondContact.id);
    const responsibility = await poll(async () => {
      const listed = await second.r12y.list({ limit: 500 });
      return listed.responsibilities.find((record) => (
        record.details?.deliveryId === resourceDelivery.deliveryId
      )) ?? null;
    }, "federation responsibility");
    expect(responsibility.details).toMatchObject({
      eventType: "federation.message.received",
      conversationId: secondContact.conversationId,
      resourceCount: 1,
      contentTrust: "untrusted",
    });
    expect(responsibility.details).not.toHaveProperty("text");
    expect(responsibility.details).not.toHaveProperty("resources");
    const streamed = await second.request("fs.transfer.send", {
      target: receivedResource.ref.target,
      path: receivedResource.ref.path,
      revision: receivedResource.ref.revision,
    });
    expect(streamed.data).toMatchObject({
      ok: true,
      size: resourceBytes.byteLength,
      contentType: "image/png",
      revision: receivedResource.ref.revision,
    });
    await expect(readBody(streamed.body)).resolves.toEqual(resourceBytes);
    const readShared = await second.request("fs.read", {
      target: receivedResource.ref.target,
      path: receivedResource.ref.path,
    });
    expect(readShared.data).toMatchObject({
      ok: true,
      kind: "image",
      size: resourceBytes.byteLength,
      contentType: "image/png",
    });
    await expect(readBody(readShared.body)).resolves.toEqual(resourceBytes);

    await first.contact.revoke({ contactId: firstContact.id });
    const revoked = await waitForContact(second, undefined, true, secondContact.id, "revoked");
    expect(revoked.state).toBe("revoked");
    await expect(second.contact.send({
      contactId: secondContact.id,
      text: "this must not cross a revoked relationship",
      idempotencyKey: "integration-message-after-revoke",
    })).rejects.toThrow(/no longer active|not found/i);
    await expect(second.request("fs.transfer.send", {
      target: receivedResource.ref.target,
      path: receivedResource.ref.path,
      revision: receivedResource.ref.revision,
    })).rejects.toThrow(/no longer active|not found/i);
  });
});

function loopbackOrigin(value: URL): URL {
  const url = new URL(value);
  url.hostname = "localhost";
  return url;
}

async function setup(origin: URL, username: string, agentName: string): Promise<void> {
  const client = new GSVClient();
  await client.requestOnce(webSocketUrl(origin), "sys.setup", {
    username,
    password: PASSWORD,
    agentName,
    timezone: "Europe/Amsterdam",
  });
}

function connectedClient(origin: URL, username: string, id: string): GSVClient {
  return new GSVClient({
    url: webSocketUrl(origin),
    username,
    password: PASSWORD,
    peer: { id, version: "1.0.0", platform: "integration" },
  });
}

async function waitForContact(
  client: GSVClient,
  remoteShipId?: string,
  includeRevoked = false,
  contactId?: string,
  state?: ContactSummary["state"],
): Promise<ContactSummary> {
  return await poll(async () => {
    const contacts = await client.contact.list({ includeRevoked });
    return contacts.contacts.find((contact) => (
      (!remoteShipId || contact.remoteShipId === remoteShipId)
      && (!contactId || contact.id === contactId)
      && (!state || contact.state === state)
    )) ?? null;
  }, "contact");
}

async function waitForDelivery(
  client: GSVClient,
  args: ContactSendArgs,
): Promise<ContactSendResult> {
  return await poll(async () => {
    const result = await client.contact.send(args);
    return result.state === "delivered" ? result : null;
  }, "federation delivery");
}

async function waitForMessage(
  client: GSVClient,
  conversationId: string,
  text: string,
): Promise<ConversationHistoryResult> {
  return await poll(async () => {
    const history = await client.conversation.history({ conversationId, limit: 100 });
    return history.messages.some((message) => message.text === text) ? history : null;
  }, `message ${JSON.stringify(text)}`);
}

function messagesWithText(history: ConversationHistoryResult, text: string) {
  return history.messages.filter((message) => message.text === text);
}

async function waitForRequest(
  client: GSVClient,
  expected: Partial<Pick<ContactRequestRecord, "id" | "direction" | "title" | "state">>,
): Promise<ContactRequestRecord> {
  return await poll(async () => {
    const result = await client.contact.request.list({ includeTerminal: true });
    return result.requests.find((request) => (
      (!expected.id || request.id === expected.id)
      && (!expected.direction || request.direction === expected.direction)
      && (!expected.title || request.title === expected.title)
      && (!expected.state || request.state === expected.state)
    )) ?? null;
  }, `contact request ${JSON.stringify(expected)}`);
}

async function contactAddedResponsibilities(client: GSVClient) {
  const listed = await client.r12y.list({ includeTerminal: true, limit: 500 });
  return listed.responsibilities.filter((responsibility) => (
    responsibility.source.kind === "event"
    && responsibility.source.eventType === "contact.added"
  ));
}

async function readBody(body: GsvBody | undefined): Promise<Uint8Array> {
  if (!body) throw new Error("fs.transfer.send returned no body");
  return await bodyToBytes(body);
}

async function poll<T>(
  read: () => Promise<T | null>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
