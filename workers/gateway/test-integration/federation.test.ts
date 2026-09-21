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
  JsonValue,
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

    for (const [harness, origin] of [[firstHarness, firstOrigin], [secondHarness, secondOrigin]] as const) {
      const response = await harness.getWorker("gsv-test-dependencies").fetch(
        "http://gsv-test-dependencies/__test/default-origin", { method: "POST", body: origin.origin },
      );
      expect(response.status).toBe(204);
    }

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

  it("publishes one approved profile and resolves it from an independently routed space", async () => {
    expect((await first.profile.get({})).profile.published).toBeUndefined();
    const draft = { alias: "public-first", displayName: "First person", about: "Published biography", contactPolicy: "requests" as const, representation: "human" as const };
    await first.profile.update({ expectedRevision: 0, draft });
    const url = new URL("/@public-first", firstOrigin).href;
    const privatePage = await fetch(url);
    expect(privatePage.status).toBe(404);
    await privatePage.arrayBuffer();
    await first.profile.publish({ expectedRevision: 1 });
    await expect.poll(async () => (await first.profile.get({})).profile.published?.revision).toBe(1);
    const remote = await second.profile.resolve({ url });
    expect(remote.profile).toMatchObject({ alias: draft.alias, about: draft.about, origin: firstOrigin.origin, revision: 1 });
    expect(remote.profile).not.toHaveProperty("ownerUid");
    expect(remote.profile).not.toHaveProperty("username");
    expect((await second.profile.get({})).profile.published).toBeUndefined();
    const subjectUrl = new URL(`/_gsv/federation/v2/subjects/${encodeURIComponent(remote.profile.actor.subjectId)}`, firstOrigin);
    const document = await fetch(subjectUrl);
    expect(await document.json()).toEqual(remote.profile);
    await first.profile.update({ expectedRevision: 1, draft: { ...draft, about: "Unpublished revision" } });
    expect((await second.profile.resolve({ url })).profile.about).toBe(draft.about);
    await first.profile.unpublish({ expectedRevision: 2 });
    await expect(second.profile.resolve({ url })).rejects.toThrow("404");
    const unavailableSubject = await fetch(subjectUrl);
    expect(unavailableSubject.status).toBe(404);
    await unavailableSubject.arrayBuffer();
  });

  it("pairs two Ships and carries messages, requests, resources, and revocation", async () => {
    const firstRequestSignals: (JsonValue | undefined)[] = [];
    const secondRequestSignals: (JsonValue | undefined)[] = [];
    first.onSignal((signal, payload) => { if (signal === "contact.request.changed") firstRequestSignals.push(payload); });
    second.onSignal((signal, payload) => { if (signal === "contact.request.changed") secondRequestSignals.push(payload); });
    const firstSignals: { signal: string; payload: JsonValue | undefined }[] = [];
    const secondSignals: typeof firstSignals = [];
    for (const [client, events] of [[first, firstSignals], [second, secondSignals]] as const) {
      client.onSignal((signal, payload) => {
        if (signal === "contact.changed" || signal === "contact.invite.changed") events.push({ signal, payload });
      });
    }
    const checkSignals = async (events: typeof firstSignals, contacts: number, invites: number) => {
      await expect.poll(() => events.filter((event) => event.signal === "contact.changed").length).toBe(contacts);
      await expect.poll(() => events.filter((event) => event.signal === "contact.invite.changed").length).toBe(invites);
      expect(events.every((event) => event.payload === undefined)).toBe(true);
    };
    const [firstDiscovery, secondDiscovery] = await Promise.all([
      fetch(new URL("/.well-known/gsv/federation/v1/ship", firstOrigin)),
      fetch(new URL("/.well-known/gsv/federation/v1/ship", secondOrigin)),
    ]);
    expect(firstDiscovery.status).toBe(200);
    expect(secondDiscovery.status).toBe(200);
    const versionedDiscovery = await fetch(new URL("/.well-known/gsv/federation/v2/ship", firstOrigin), { method: "POST" });
    expect(versionedDiscovery.status).toBe(200);
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
    await checkSignals(firstSignals, 0, 1);
    const pendingInvites = await first.contact.invite.list({});
    expect(pendingInvites.invites).toEqual([
      expect.objectContaining({
        inviteId: cancelledInvite.inviteId,
        state: "pending",
      }),
    ]);
    expect(pendingInvites.invites[0]).not.toHaveProperty("code");
    await first.contact.invite.cancel({ inviteId: cancelledInvite.inviteId });
    await checkSignals(firstSignals, 0, 2);
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
    await checkSignals(firstSignals, 1, 4);
    await checkSignals(secondSignals, 1, 0);
    const [initialInviterResponsibilities, initialAccepterResponsibilities] = await Promise.all([
      contactAddedResponsibilities(first),
      contactAddedResponsibilities(second),
    ]);
    expect(initialInviterResponsibilities).toEqual([]);
    expect(initialAccepterResponsibilities).toEqual([]);
    const replacementInvite = await first.contact.invite.create({ expiresInSeconds: 300 });
    const replacement = await second.contact.invite.accept({ code: replacementInvite.code });
    expect(replacement.contact.generation).not.toBe(accepted.contact.generation);
    const [replacementInviterResponsibilities, replacementAccepterResponsibilities] =
      await Promise.all([
        contactAddedResponsibilities(first),
        contactAddedResponsibilities(second),
      ]);
    expect(replacementInviterResponsibilities).toEqual([]);
    expect(replacementAccepterResponsibilities).toEqual([]);
    await expect(second.contact.invite.accept({ code: invite.code }))
      .rejects.toThrow("pairing attempt was superseded");
    const currentContacts = await second.contact.list({});
    await checkSignals(firstSignals, 2, 6);
    await checkSignals(secondSignals, 2, 0);
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
    await checkSignals(firstSignals, 3, 6);
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
    const firstMessageMetadata = messagesWithText(firstHistory, messageArgs.text)[0]?.social;
    expect(firstMessageMetadata?.provenance).toEqual({ kind: "human" });
    expect(messagesWithText(secondHistory, messageArgs.text)[0]?.social).toEqual(firstMessageMetadata);
    expect(firstHistory.conversation.handlerPid).toBeUndefined();
    expect(secondHistory.conversation.handlerPid).toBeUndefined();
    const searched = await second.conversation.search({ conversationId: secondContact.conversationId, query: "hello first" });
    expect(searched.matches.map((match) => match.messageId)).toEqual([messagesWithText(secondHistory, messageArgs.text)[0].id]);
    expect(searched.coverage.state).toBe("complete");
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

    if (!firstMessageMetadata) throw new Error("V2 message is missing its origin reference");
    const replyArgs: ContactSendArgs = {
      contactId: secondContact.id,
      text: "Reply from the second Ship",
      replyTo: firstMessageMetadata.reference,
      idempotencyKey: "integration-reply-second-to-first",
    };
    await waitForDelivery(second, replyArgs);
    const replyHistory = await waitForMessage(first, firstContact.conversationId, replyArgs.text);
    expect(messagesWithText(replyHistory, replyArgs.text)[0]?.social).toMatchObject({
      provenance: { kind: "human" },
      replyTo: firstMessageMetadata.reference,
    });
    await expect(second.contact.send({
      ...replyArgs,
      replyTo: { ...firstMessageMetadata.reference, messageId: "message:outside-this-conversation" },
      idempotencyKey: "integration-invalid-reply",
    })).rejects.toThrow("Reply must reference a message in this contact conversation");

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
    await second.contact.request.act({
      requestId: incoming.id,
      expectedRevision: incoming.revision,
      action: "accept",
      note: "Reviewed by the second Ship",
      idempotencyKey: "integration-request-second-accepts",
    });
    const acceptedAtFirst = await waitForRequest(first, {
      id: outgoing.request.id,
      state: "accepted",
    });
    expect(acceptedAtFirst.details).toEqual({ document: "engineering/rfcs/0001-cross-gsv-federation.md" });
    expect(acceptedAtFirst.work?.performer[0]).toMatchObject({ action: "accept", note: "Reviewed by the second Ship" });

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
    const reverseAccepted = await first.contact.request.act({
      requestId: reverseIncoming.id,
      expectedRevision: reverseIncoming.revision,
      action: "accept",
      idempotencyKey: "integration-request-first-accepts",
    });
    await waitForRequest(second, { id: reverse.request.id, state: "accepted" });
    await waitForRequest(first, { id: reverseIncoming.id, state: "accepted", exchange: { state: "acknowledged" } });
    await first.contact.request.act({
      requestId: reverseIncoming.id,
      expectedRevision: reverseAccepted.request.revision,
      action: "complete",
      idempotencyKey: "integration-request-first-completes",
    });
    await waitForRequest(second, { id: reverse.request.id, state: "completed" });
    await waitForRequest(first, { id: reverseIncoming.id, state: "completed", exchange: { state: "acknowledged" } });

    await expect.poll(() => firstRequestSignals.length).toBeGreaterThanOrEqual(5);
    await expect.poll(() => secondRequestSignals.length).toBeGreaterThanOrEqual(5);
    for (const signal of firstRequestSignals) expect(signal).toMatchObject({ contactId: firstContact.id });
    for (const signal of secondRequestSignals) expect(signal).toMatchObject({ contactId: secondContact.id });
    const completed = await waitForRequest(second, { id: reverse.request.id, state: "completed" });
    await second.contact.request.act({ requestId: completed.id, expectedRevision: completed.revision, action: "acknowledge", idempotencyKey: "integration-acknowledge-result" });
    await expect.poll(async () => (await first.contact.request.list({ contactId: firstContact.id, includeTerminal: true })).requests.find((request) => request.id === reverseIncoming.id)?.work?.requester.at(-1)?.action).toBe("acknowledge");
    const firstRequestSignalCount = firstRequestSignals.length;
    await expect(first.contact.request.act({
      requestId: reverseIncoming.id,
      expectedRevision: 1,
      action: "start",
    })).rejects.toThrow("Work request changed");
    expect(firstRequestSignals).toHaveLength(firstRequestSignalCount);

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
    const responsibilities = await second.r12y.list({ limit: 500 });
    expect(responsibilities.responsibilities.some((record) => record.details?.deliveryId === resourceDelivery.deliveryId)).toBe(false);
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
    await checkSignals(firstSignals, 4, 6);
    await checkSignals(secondSignals, 3, 0);
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

    const reconnectInvite = await first.contact.invite.create({ expiresInSeconds: 300 });
    const reconnected = (await second.contact.invite.accept({ code: reconnectInvite.code })).contact;
    expect(reconnected.conversationId).toBe(secondContact.conversationId);
    const preferences = await second.contact.preferences.update({
      contactId: reconnected.id, expectedRevision: reconnected.preferences!.revision,
      patch: { saved: false, muted: true },
    });
    expect(preferences.contact).toMatchObject({ state: "active", preferences: { saved: false, muted: true } });
    const actor = { shipId: reconnected.remoteShipId, subjectId: reconnected.remoteSubject.id };
    await second.contact.block.set({ actor, blocked: true });
    expect((await second.contact.block.list({})).blocks).toEqual([expect.objectContaining({ actor })]);
    expect((await second.contact.list({ includeRevoked: true })).contacts[0]).toMatchObject({ state: "revoked", blocked: true });
    const blockedInvite = await first.contact.invite.create({ expiresInSeconds: 300 });
    await expect(second.contact.invite.accept({ code: blockedInvite.code })).rejects.toThrow("pairing is unavailable");
    await second.contact.block.set({ actor, blocked: false });
    expect((await second.contact.list({ includeRevoked: true })).contacts[0]?.state).toBe("revoked");
    expect(messagesWithText(await second.conversation.history({ conversationId: secondContact.conversationId }), messageArgs.text)).toHaveLength(1);
  });
  it("opens a published profile, requests a conversation, and preserves the first message through acceptance", async () => {
    for (const client of [first, second]) {
      const contacts = (await client.contact.list({ includeRevoked: true })).contacts;
      for (const contact of contacts.filter((entry) => entry.state === "active")) await client.contact.revoke({ contactId: contact.id });
    }
    const initial = (await second.profile.get({})).profile;
    const draft = { alias: "public-second", displayName: "Second person", about: "Message me about GSV", contactPolicy: "requests" as const, representation: "human" as const };
    const saved = (await second.profile.update({ expectedRevision: initial.revision, draft })).profile;
    await second.profile.publish({ expectedRevision: saved.revision });
    await expect.poll(async () => (await second.profile.get({})).profile.published?.revision, { timeout: 20_000 }).toBe(saved.revision);
    const profile = (await first.profile.resolve({ url: new URL("/@public-second", secondOrigin).href })).profile;
    const input = { profileUrl: profile.url, recipient: profile.actor, profileRevision: profile.revision,
      displayName: "First person", text: "An intentional first-contact message", idempotencyKey: "integration-approach" };
    const sent = (await first.approach.create(input)).approach;
    expect((await first.approach.create(input)).approach.id).toBe(sent.id);
    await expect.poll(async () => (await second.approach.list({ direction: "incoming" })).approaches[0]?.state, { timeout: 20_000 }).toBe("pending");
    const received = (await second.approach.list({ direction: "incoming" })).approaches[0];
    const before = await second.conversation.history({ conversationId: received.conversationId });
    expect(messagesWithText(before, input.text)).toHaveLength(1);
    expect(before.messages.find((message) => message.text === input.text)?.social?.provenance.kind).toBe("human");
    expect(before.conversation.handlerPid).toBeUndefined();
    await second.approach.decide({ approachId: received.id, expectedRevision: received.revision, decision: "accept" });
    await expect.poll(async () => (await first.approach.get({ approachId: sent.id })).approach.connection, { timeout: 20_000 }).toBe("connected");
    const connected = (await second.approach.get({ approachId: received.id })).approach;
    expect(connected.contactId).toBeDefined();
    expect(connected.conversationId).toBe(received.conversationId);
    expect(messagesWithText(await second.conversation.history({ conversationId: received.conversationId }), input.text)).toHaveLength(1);
    const reply = await second.contact.send({ contactId: connected.contactId!, text: "Welcome to the conversation", idempotencyKey: "integration-approach-reply" });
    await expect.poll(async () => (await second.contact.delivery.get({ deliveryId: reply.deliveryId })).delivery?.state, { timeout: 20_000 }).toBe("delivered");
    expect(messagesWithText(await first.conversation.history({ conversationId: sent.conversationId }), "Welcome to the conversation")).toHaveLength(1);
  });
});

function loopbackOrigin(value: URL): URL {
  const url = new URL(value);
  url.hostname = "localhost";
  return url;
}

async function setup(origin: URL, username: string, agentName: string): Promise<void> {
  const client = new GSVClient();
  await client.requestOnce(webSocketUrl(origin), "sys.setup", { onboardingToken: "integration-onboarding-default",
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
  expected: Partial<Pick<ContactRequestRecord, "id" | "direction" | "title" | "state" | "exchange">>,
): Promise<ContactRequestRecord> {
  return await poll(async () => {
    const result = await client.contact.request.list({ includeTerminal: true });
    return result.requests.find((request) => (
      (!expected.id || request.id === expected.id)
      && (!expected.direction || request.direction === expected.direction)
      && (!expected.title || request.title === expected.title)
      && (!expected.state || request.state === expected.state)
      && (!expected.exchange || request.exchange?.state === expected.exchange.state)
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
