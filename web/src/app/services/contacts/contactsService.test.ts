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
    const client = contactClient({ listContacts, listRequests });

    const workspace = await loadContactsWorkspace(client);

    expect(workspace).toEqual({ contacts: [], requests: [] });
    expect(listContacts).toHaveBeenCalledWith({ includeRevoked: true });
    expect(listRequests).toHaveBeenCalledWith({ includeTerminal: true });
  });

  it("keeps revocation, aliases and request transitions explicit", async () => {
    const revoke = vi.fn<GSVClient["contact"]["revoke"]>();
    const setAlias = vi.fn<GSVClient["contact"]["alias"]["set"]>();
    const update = vi.fn<GSVClient["contact"]["request"]["update"]>();
    const client = contactClient({ revoke, setAlias, update });

    await mutateContactsWorkspace(client, { kind: "contact.revoke", contactId: "contact:flynn" });
    await mutateContactsWorkspace(client, {
      kind: "contact.alias.set",
      contactId: "contact:flynn",
      alias: "Flynn",
    });
    await mutateContactsWorkspace(client, {
      kind: "request.update",
      requestId: "request:one",
      expectedRevision: 2,
      state: "completed",
    });

    expect(revoke).toHaveBeenCalledWith({ contactId: "contact:flynn" });
    expect(setAlias).toHaveBeenCalledWith({ contactId: "contact:flynn", alias: "Flynn" });
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
    const intent = {
      idempotencyKey: "send:one",
      text: "Hello",
      media: [],
    };

    await loadContactConversation(client, "conv:contact");
    await sendContactMessage(client, "contact:flynn", intent);

    expect(history).toHaveBeenCalledWith({ conversationId: "conv:contact", limit: 100 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "contact:flynn",
      text: "Hello",
      idempotencyKey: "send:one",
    }));
  });

  it("does not admit a send after its composer has cancelled staging", async () => {
    const send = vi.fn<GSVClient["contact"]["send"]>();
    const controller = new AbortController();
    controller.abort(new Error("Composer closed"));
    await expect(sendContactMessage(contactClient({ send }), "contact:one", {
      idempotencyKey: "cancelled", text: "draft", media: [],
    }, controller.signal)).rejects.toThrow("Composer closed");
    expect(send).not.toHaveBeenCalled();
  });

  it("reuses one send identity and staging path across attachment retries", async () => {
    const request = vi.fn(async (
      call: string,
      args: { path?: string; contentType?: string },
    ) => {
      if (call === "fs.transfer.receive") {
        return { data: { ok: true as const, path: args.path!, bytesWritten: 3 } };
      }
      if (call === "fs.transfer.stat") {
        return {
          data: {
            ok: true as const,
            path: args.path!,
            size: 3,
            isFile: true,
            isDirectory: false,
            contentType: "image/png",
            revision: "revision:image",
          },
        };
      }
      return { data: { ok: true as const, path: args.path! } };
    });
    const send = vi.fn<GSVClient["contact"]["send"]>(async () => ({
      deliveryId: "delivery:one",
      conversationId: "conv:contact",
      state: "queued",
    }));
    const intent = {
      idempotencyKey: "send-stable",
      text: "See this",
      media: [{
        type: "image" as const,
        mimeType: "image/png",
        filename: "image.png",
        body: new Blob(["abc"]),
      }],
    };
    const client = contactClient({
      // SAFETY: The request fixture implements the three filesystem calls used by staged uploads.
      request: request as never,
      send,
    });

    await sendContactMessage(client, "contact:flynn", intent);
    await sendContactMessage(client, "contact:flynn", intent);

    const uploadPaths = request.mock.calls
      .filter(([call]) => call === "fs.transfer.receive")
      .map(([, args]) => args.path);
    expect(uploadPaths).toEqual([
      "~/.gsv/uploads/send-stable/0-image.png",
      "~/.gsv/uploads/send-stable/0-image.png",
    ]);
    expect(send.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({
        idempotencyKey: "send-stable",
        media: [expect.objectContaining({
          ref: expect.objectContaining({ path: uploadPaths[0], revision: "revision:image" }),
        })],
      }),
      expect.objectContaining({
        idempotencyKey: "send-stable",
        media: [expect.objectContaining({
          ref: expect.objectContaining({ path: uploadPaths[0], revision: "revision:image" }),
        })],
      }),
    ]);
  });
});

function contactClient(overrides: {
  listContacts?: GSVClient["contact"]["list"];
  listRequests?: GSVClient["contact"]["request"]["list"];
  revoke?: GSVClient["contact"]["revoke"];
  setAlias?: GSVClient["contact"]["alias"]["set"];
  update?: GSVClient["contact"]["request"]["update"];
  history?: GSVClient["conversation"]["history"];
  send?: GSVClient["contact"]["send"];
  request?: GSVClient["request"];
}) {
  return {
    request: overrides.request ?? vi.fn<GSVClient["request"]>(),
    contact: {
      list: overrides.listContacts ?? vi.fn(),
      revoke: overrides.revoke ?? vi.fn(),
      send: overrides.send ?? vi.fn(),
      alias: { set: overrides.setAlias ?? vi.fn() },
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
