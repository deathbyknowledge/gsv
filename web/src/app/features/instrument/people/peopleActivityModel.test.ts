import type { ContactSummary, ConversationInboxEntry, ConversationMessage } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { conversationNotice, peopleConversations } from "./peopleActivityModel";
import type { PeopleActivity } from "./usePeopleActivity";

const contact: ContactSummary = {
  id: "contact:ada", ownerUid: 1000, state: "active", generation: "one", remoteShipId: "ship:ada",
  remoteSubject: { id: "subject:ada", displayName: "Ada Lovelace" }, remoteOrigin: "https://ada.example",
  conversationId: "conversation:ada", localAlias: "Ada", createdAtMs: 1, updatedAtMs: 1,
};
function message(sequence: number): ConversationMessage {
  return { id: `message:${sequence}`, sequence, conversationId: contact.conversationId, text: `Message ${sequence}`, createdAt: sequence,
    author: { kind: "contact", contactId: contact.id, shipId: "ship:ada", subjectId: "subject:ada", displayName: "Ada" },
    social: { threadId: "thread:ada", reference: { actor: { shipId: "ship:ada", subjectId: "subject:ada" }, messageId: `remote:${sequence}` }, provenance: { kind: "human" } },
    origin: { kind: "federation", contactId: contact.id, deliveryId: `delivery:${sequence}` } };
}
function activity(sequence = 2): PeopleActivity {
  const entry: ConversationInboxEntry = { contactId: contact.id,
    conversation: { id: contact.conversationId, ownerUid: 1000, title: "Ada", latestSequence: sequence, createdAt: 1, updatedAt: sequence, kind: "contact" },
    view: { readThroughSequence: 1, archived: false, revision: 1 }, unread: true, latestIncomingSequence: sequence,
    preview: { ...message(sequence), attachmentCount: 0 } };
  return { conversations: [entry], requests: [], contacts: [contact], hasMore: false, error: null };
}

describe("People activity above the Ship prompt", () => {
  it("uses the inbox preview and local alias without a separate notice", () => {
    const items = peopleConversations(activity(3), new Map());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Ada", text: "Message 3", draft: false });
  });

  it("follows the inbox read position while preserving a later incoming message", () => {
    const read = activity(2);
    read.conversations[0].view.readThroughSequence = 2;
    read.conversations[0].unread = false;
    expect(peopleConversations(read, new Map())).toEqual([]);
    const later = activity(3);
    later.conversations[0].view.readThroughSequence = 2;
    const items = peopleConversations(later, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Message 3");
  });

  it("identifies outgoing Ship messages while an earlier contact message remains unread", () => {
    const current = activity(3);
    current.conversations[0].latestIncomingSequence = 2;
    current.conversations[0].preview!.author = { kind: "process", pid: "proc:ship", uid: 1001 };
    expect(peopleConversations(current, new Map())[0]).toMatchObject({ name: "Ada", text: "Your Ship: Message 3" });
    current.conversations[0].preview!.author = { kind: "user", uid: 1000 };
    expect(peopleConversations(current, new Map())[0].text).toBe("You: Message 3");
    current.conversations[0].preview = { ...message(4), attachmentCount: 0, provenance: { kind: "process", processId: "proc:ada" } };
    expect(peopleConversations(current, new Map())[0].text).toBe("Their Ship: Message 4");
  });

  it("keeps an unfinished draft reachable after a read elsewhere or an ended connection", () => {
    const quiet = { ...activity(), contacts: [{ ...contact, state: "revoked" as const }] };
    expect(peopleConversations(quiet, new Map())).toEqual([]);
    const drafts = new Map([[contact.id, { text: "Still writing", intent: null, readThroughSequence: 1 }]]);
    const items = peopleConversations({ ...quiet, conversations: [] }, drafts);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ draft: true, text: "Still writing" });
  });

  it("reads exact reply references without adding old read history to a held draft", () => {
    const [item] = peopleConversations(activity(3), new Map());
    const recovered = conversationNotice(item, [message(1), message(2), message(3)]);
    expect(recovered?.messages.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(recovered?.messages[1].social.reference).toEqual(message(3).social!.reference);
    const drafts = new Map([[contact.id, { text: "Still writing", intent: null, readThroughSequence: 1 }]]);
    const [held] = peopleConversations({ ...activity(3), conversations: [] }, drafts);
    expect(conversationNotice(held, [message(1), message(2), message(3)])?.messages.map((entry) => entry.sequence)).toEqual([2, 3]);
  });
});
