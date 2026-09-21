import { describe, expect, it } from "vitest";
import type { ContactSummary, ConversationMessage } from "@humansandmachines/gsv/protocol";
import { introductionReview, isIntroductionConsent } from "./introductions";

describe("deliberate introduction drafts", () => {
  it("asks first without copying private aliases or selected conversation content", () => {
    const person = contact("person");
    const recipient = contact("recipient");
    const result = introductionReview({ plan: { kind: "offer", person }, selected: recipient, name: "Agreed name", recipientName: "", context: "A brief reason", consentConfirmed: false });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].args).toMatchObject({ contactId: recipient.id, expectedGeneration: recipient.generation });
    expect(result.parts[0].args.text).toContain("Would you like an introduction to Agreed name?");
    expect(result.parts[0].args.text).not.toContain("private-alias");
    expect(result.parts[0].args).not.toHaveProperty("media");
  });

  it("keeps two recipient-bound send intents and only replies to the approving conversation", () => {
    const person = contact("person");
    const recipient = contact("recipient");
    const consent = reply(recipient);
    const input = { plan: { kind: "forward" as const, recipient, consent }, selected: person, name: "Sam", recipientName: "Bob", context: "Selected explanation", consentConfirmed: true };
    expect(() => introductionReview({ ...input, consentConfirmed: false })).toThrow("confirm");
    const result = introductionReview(input);
    expect(result.parts.map((part) => part.recipient.id)).toEqual([recipient.id, person.id]);
    expect(result.parts[0].args.replyTo).toEqual(consent.social?.reference);
    expect(result.parts[1].args.replyTo).toBeUndefined();
    expect(result.parts[0].args.idempotencyKey).not.toBe(result.parts[1].args.idempotencyKey);
    for (const part of result.parts) {
      expect(part.args.text).toContain("Selected explanation");
      expect(part.args.text).not.toContain(consent.text);
      expect(part.args.text).not.toContain("private-alias");
      expect(part.args).not.toHaveProperty("media");
    }
  });

  it("refuses a process-generated or unrelated response as the selected human consent", () => {
    const recipient = contact("recipient");
    const consent = reply(recipient);
    expect(isIntroductionConsent(consent, recipient)).toBe(true);
    expect(isIntroductionConsent(consent, contact("another"))).toBe(false);
    expect(isIntroductionConsent({ ...consent, social: { ...consent.social!, provenance: { kind: "process", processId: "proc:remote" } } }, recipient)).toBe(false);
    expect(isIntroductionConsent({ ...consent, social: undefined }, recipient)).toBe(false);
  });
});

function contact(id: string): ContactSummary {
  return { id, ownerUid: 1000, state: "active", generation: `generation:${id}`, remoteShipId: `ship:${id}`, remoteSubject: { id: `subject:${id}`, displayName: "Private peer label" },
    remoteOrigin: `https://${id}.example`, localAlias: `private-alias:${id}`, conversationId: `conversation:${id}`, createdAtMs: 1, updatedAtMs: 1 };
}

function reply(contact: ContactSummary): ConversationMessage {
  return { id: "reply", conversationId: contact.conversationId, sequence: 1, text: "Yes, and here is some private context for you alone.", createdAt: Date.now(),
    author: { kind: "contact", contactId: contact.id, shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id, displayName: "Private peer label" },
    origin: { kind: "federation", contactId: contact.id, deliveryId: "delivery:reply" },
    social: { threadId: "thread", reference: { actor: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, messageId: "original" }, provenance: { kind: "human" } } };
}
