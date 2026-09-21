import { describe, expect, it } from "vitest";
import type { ConversationMessage, ResourceBlock } from "@humansandmachines/gsv/protocol";
import { reportEvidence } from "./reportEvidence";

const resource: ResourceBlock = { type: "resource", ref: { type: "file", target: "gsv", path: "/home/private/archive/file", revision: "revision:one", contentType: "image/png", size: 100 }, filename: "screenshot.png", transcription: "Private derived notes" };
const message: ConversationMessage = {
  id: "message:one", conversationId: "conversation:private", sequence: 1, createdAt: 1,
  text: "The selected message", author: { kind: "contact", contactId: "contact:source", shipId: "ship:source", subjectId: "subject:source", displayName: "Sender" },
  media: [resource], origin: { kind: "federation", contactId: "contact:source", deliveryId: "delivery:private" },
  social: { threadId: "thread:private", reference: { actor: { shipId: "ship:source", subjectId: "subject:source" }, messageId: "origin:one" }, provenance: { kind: "human" } },
};

describe("selected report evidence", () => {
  it("includes only the selected copies and explicitly checked files, without exporting local metadata", () => {
    const textOnly = reportEvidence("contact:moderator", [message], "Please help", new Set());
    expect(textOnly.text).toContain("The selected message");
    expect(textOnly.text).toContain("Message: origin:one");
    expect(textOnly.text).not.toContain("Private derived notes");
    expect(textOnly.text).not.toContain("/home/private");
    expect(textOnly.text).not.toContain("conversation:private");
    expect(textOnly.media).toBeUndefined();
    const withFile = reportEvidence("contact:moderator", [message], "", new Set(["message:one:0"]));
    expect(withFile.media).toEqual([{ type: "resource", ref: resource.ref, filename: "screenshot.png" }]);
    expect(withFile.idempotencyKey).not.toBe(textOnly.idempotencyKey);
    expect(withFile.contactId).toBe("contact:moderator");
  });

  it("refuses to hide truncation, include unselected resources or exceed the message budget", () => {
    expect(() => reportEvidence("contact:moderator", [], "", new Set())).toThrow("Select");
    expect(() => reportEvidence("contact:moderator", [message], "", new Set(["not-selected:0"]))).toThrow("changed");
    expect(() => reportEvidence("contact:moderator", [{ ...message, text: "🐱".repeat(9000) }], "", new Set())).toThrow("too long");
    const large = { ...message, media: [{ ...resource, ref: { ...resource.ref, size: 49 * 1024 * 1024 } }] };
    expect(() => reportEvidence("contact:moderator", [large], "", new Set(["message:one:0"]))).toThrow("48 MiB");
  });
});
