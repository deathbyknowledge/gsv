import { describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";

import {
  loadContactConversation,
  loadContactsWorkspace,
  mutateContactsWorkspace,
  sendContactMessage,
} from "./contactsService";

describe("contactsService", () => {
  it("loads contacts and requests through the public contact namespace", async () => {
    const listContacts = vi.fn<GSVClient["contact"]["list"]>(async () => ({ contacts: [] }));
    const listRequests = vi.fn<GSVClient["contact"]["request"]["list"]>(async () => ({
      requests: [],
    }));
    const listInvites = vi.fn<GSVClient["contact"]["invite"]["list"]>(async () => ({
      invites: [],
    }));
    const client = contactClient({ listContacts, listInvites, listRequests });

    const workspace = await loadContactsWorkspace(client);

    expect(workspace).toEqual({ contacts: [], invites: [], requests: [] });
    expect(listContacts).toHaveBeenCalledWith({ includeRevoked: true });
    expect(listInvites).toHaveBeenCalledWith({ includeTerminal: true });
    expect(listRequests).toHaveBeenCalledWith({ includeTerminal: true });
  });

  it("keeps invite acceptance, revocation, and request transitions explicit", async () => {
    const accept = vi.fn<GSVClient["contact"]["invite"]["accept"]>();
    const cancel = vi.fn<GSVClient["contact"]["invite"]["cancel"]>();
    const revoke = vi.fn<GSVClient["contact"]["revoke"]>();
    const update = vi.fn<GSVClient["contact"]["request"]["update"]>();
    const client = contactClient({ accept, cancel, revoke, update });

    await mutateContactsWorkspace(client, { kind: "invite.accept", code: "pairing-code" });
    await mutateContactsWorkspace(client, { kind: "invite.cancel", inviteId: "invite:one" });
    await mutateContactsWorkspace(client, { kind: "contact.revoke", contactId: "contact:flynn" });
    await mutateContactsWorkspace(client, {
      kind: "request.update",
      requestId: "request:one",
      expectedRevision: 2,
      state: "completed",
    });

    expect(accept).toHaveBeenCalledWith({ code: "pairing-code" });
    expect(cancel).toHaveBeenCalledWith({ inviteId: "invite:one" });
    expect(revoke).toHaveBeenCalledWith({ contactId: "contact:flynn" });
    expect(update).toHaveBeenCalledWith({
      requestId: "request:one",
      expectedRevision: 2,
      state: "completed",
    });
  });

  it("loads and sends through the contact's canonical conversation", async () => {
    const history = vi.fn<GSVClient["conversation"]["history"]>(async () => ({
      conversation: {
        id: "conv:contact",
        kind: "contact",
        ownerUid: 1000,
        title: "Flynn",
        handlerPid: "proc:ship",
        latestSequence: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      messages: [],
      hasMore: false,
    }));
    const send = vi.fn<GSVClient["contact"]["send"]>(async () => ({
      deliveryId: "delivery:one",
      conversationId: "conv:contact",
      state: "queued",
    }));
    const client = contactClient({ history, send });

    await loadContactConversation(client, "conv:contact");
    await sendContactMessage(client, "contact:flynn", "Hello");

    expect(history).toHaveBeenCalledWith({ conversationId: "conv:contact", limit: 100 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "contact:flynn",
      text: "Hello",
      idempotencyKey: expect.any(String),
    }));
  });
});

function contactClient(overrides: {
  listContacts?: GSVClient["contact"]["list"];
  listRequests?: GSVClient["contact"]["request"]["list"];
  listInvites?: GSVClient["contact"]["invite"]["list"];
  accept?: GSVClient["contact"]["invite"]["accept"];
  cancel?: GSVClient["contact"]["invite"]["cancel"];
  revoke?: GSVClient["contact"]["revoke"];
  update?: GSVClient["contact"]["request"]["update"];
  history?: GSVClient["conversation"]["history"];
  send?: GSVClient["contact"]["send"];
}) {
  return {
    request: vi.fn<GSVClient["request"]>(),
    contact: {
      list: overrides.listContacts ?? vi.fn(),
      revoke: overrides.revoke ?? vi.fn(),
      send: overrides.send ?? vi.fn(),
      invite: {
        accept: overrides.accept ?? vi.fn(),
        cancel: overrides.cancel ?? vi.fn(),
        create: vi.fn(),
        list: overrides.listInvites ?? vi.fn(),
      },
      request: {
        list: overrides.listRequests ?? vi.fn(),
        update: overrides.update ?? vi.fn(),
      },
    },
    conversation: {
      history: overrides.history ?? vi.fn(),
    },
  } satisfies Parameters<typeof loadContactsWorkspace>[0];
}
