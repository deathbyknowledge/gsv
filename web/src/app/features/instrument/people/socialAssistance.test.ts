import { describe, expect, it } from "vitest";
import type { ContactSummary, ConversationMessage, ResourceBlock } from "@humansandmachines/gsv/protocol";
import { assistancePlan, reviewedAttachments, selectedMessageCopies } from "./socialAssistance";

const contact: ContactSummary = { id: "contact:one", ownerUid: 1000, state: "active", generation: "generation:one", remoteShipId: "ship:one",
  remoteSubject: { id: "subject:one", displayName: "Sam" }, remoteOrigin: "https://sam.example", conversationId: "conversation:one", createdAtMs: 1, updatedAtMs: 1 };
const file: ResourceBlock = { type: "resource", filename: "Selected file.txt", transcription: "Private derived content", ref: { type: "file", target: contact.id, path: "/resources/file", revision: "revision:one", size: 10, contentType: "text/plain" } };
const message: ConversationMessage = { id: "message:one", conversationId: contact.conversationId, sequence: 1, text: "A selected message", media: [file], createdAt: 10,
  author: { kind: "contact", contactId: contact.id, shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id, displayName: "Sam" },
  origin: { kind: "federation", contactId: contact.id, deliveryId: "delivery:one" } };
const options = { request: "Help me prepare a reply", notes: "", attachments: new Set<string>(), entireThread: false, hours: 24, generations: 32 };

describe("reviewed social assistance", () => {
  it("starts fresh with only selected text and no implicit thread, attachment or sending grant", () => {
    const plan = assistancePlan(contact, [message], options, 1000);
    expect(plan.spawn.parentPid).toBeUndefined();
    expect(plan.spawn.prompt).toBeUndefined();
    expect(plan.spawn.scope).toMatchObject({ conversations: [{ conversationId: contact.conversationId, contactId: contact.id, generation: contact.generation, read: false, send: false }], resources: [], budgets: { processes: 1, generations: 32, messages: 0 } });
    const selected = plan.spawn.scope!.materials.find((material) => material.name === "exchange.json")!;
    expect(selectedMessageCopies(selected.text)).toEqual([expect.objectContaining({ text: message.text, authorLabel: "Sam" })]);
    expect(selected.text).not.toContain(file.transcription);
    expect(plan.spawn.scope!.materials.find((material) => material.name === "request.txt")?.text).toBe(plan.input);
  });

  it("binds explicit broader reads and checked files to the current conversation generation", () => {
    const plan = assistancePlan(contact, [message], { ...options, entireThread: true, attachments: new Set([`${message.id}:0`]) });
    expect(plan.spawn.scope!.conversations[0]).toMatchObject({ read: true, send: false, generation: contact.generation });
    expect(plan.spawn.scope!.resources).toEqual([file.ref]);
    expect(() => assistancePlan(contact, [{ ...message, conversationId: "conversation:other" }], options)).toThrow("this conversation");
    expect(() => assistancePlan(contact, [message], { ...options, attachments: new Set(["not-selected"]) })).toThrow("changed");
  });

  it("requires selection again before a reply forwards attachments and drops derived transcription", () => {
    expect(reviewedAttachments([file], new Set())).toEqual([]);
    const result = reviewedAttachments([file], new Set([0]));
    expect(result[0].ref).toEqual(file.ref);
    expect(result[0]).not.toHaveProperty("transcription");
    expect(() => assistancePlan(contact, [{ ...message, media: [{ ...file, ref: { ...file.ref, target: "gsv" } }] }], { ...options, attachments: new Set([`${message.id}:0`]) })).toThrow("immutable attachments");
  });
});
