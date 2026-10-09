import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { ContactNoticePanel, noticeName, preview, replyIntentFor, type ContactNotice, type ContactNoticeMessage } from "./ContactNotice";

function message(sequence: number, text: string, byShip = false): ContactNoticeMessage {
  return { id: `message:${sequence}`, conversationId: "conversation:ada", sequence, text, createdAt: sequence, media: [],
    author: { kind: "contact", contactId: "contact:ada", shipId: "ship:ada", subjectId: "subject:ada", displayName: "Ada Lovelace" },
    origin: { kind: "federation", contactId: "contact:ada", deliveryId: `delivery:${sequence}` },
    social: { threadId: "thread:ada", reference: { actor: { shipId: "ship:ada", subjectId: "subject:ada" }, messageId: `origin:${sequence}` }, provenance: byShip ? { kind: "process", processId: "proc:ada" } : { kind: "human" } } };
}
const notice: ContactNotice = {
  contactId: "contact:ada", conversationId: "conversation:ada", displayName: "Ada Lovelace",
  messages: [message(1, "hey — free to look at the release notes before i send them out?")],
};
const contact: ContactSummary = {
  id: notice.contactId, ownerUid: 1000, state: "active", generation: "generation:one", remoteShipId: "ship:ada",
  remoteSubject: { id: "subject:ada", displayName: "Ada Lovelace" }, remoteOrigin: "https://ada.example",
  conversationId: notice.conversationId, localAlias: "Ada", createdAtMs: 1, updatedAtMs: 1,
};

function buttons(tree: ReturnType<typeof ContactNoticePanel>) {
  return collectNodes(tree).filter((node) => node.type === "button");
}
/* the harness joins text fragments with spaces; read the moment the way a person does */
function text(tree: ReturnType<typeof ContactNoticePanel>) {
  return collectText(tree).replace(/\s+/g, " ").trim();
}

describe("the contact notice", () => {
  it("keeps sender provenance and explicit close and full conversation actions in the panel", () => {
    const onClose = vi.fn();
    const onGoToChat = vi.fn();
    const tree = ContactNoticePanel({ id: "people-panel", name: "Ada", notice, onClose, onGoToChat, children: "Waiting message" });
    expect(text(tree)).toBe("Ada PERSON close Waiting message 1 message open conversation ↗");
    expect(tree.props["aria-label"]).toBe("Messages from Ada");
    const [close, goToChat] = buttons(tree);
    void close.props.onClick?.();
    void goToChat.props.onClick?.();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onGoToChat).toHaveBeenCalledOnce();
  });

  it("counts waiting messages and identifies when the contact's Ship wrote the latest", () => {
    const three = { ...notice, messages: [message(1, "first"), message(2, "second"), message(3, "ok, sent it", true)] };
    const tree = ContactNoticePanel({ id: "people-panel", name: "Ada", notice: three, onClose: vi.fn(), onGoToChat: vi.fn() });
    expect(text(tree)).toBe("Ada GSV close 3 messages open conversation ↗");
    expect(collectNodes(tree).some((node) => node.props.class === "sender-dot")).toBe(true);
  });

  it("clips a preview to its first words", () => {
    expect(preview("one two three")).toBe("one two three");
    expect(preview("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight…");
    expect(preview("   ")).toBe("(an empty message)");
    expect(preview("", 2)).toBe("(2 attachments)");
  });

  it("keeps a retry's submitted intent when the contact writes meanwhile, and answers the newest message otherwise", () => {
    const first = replyIntentFor(null, notice, "yes, go ahead");
    expect(first).toMatchObject({ contactId: notice.contactId, text: "yes, go ahead", replyTo: { messageId: "origin:1" } });
    const grown = { ...notice, messages: [...notice.messages, message(2, "also — can you cc tau?")] };
    expect(replyIntentFor(first, grown, "yes, go ahead")).toBe(first);
    expect(first.throughSequence).toBe(1);
    expect(replyIntentFor(first, { ...grown, messages: [message(60, "The original has left the recent page")] }, "yes, go ahead")).toBe(first);
    const changed = replyIntentFor(first, grown, "yes, and tau too");
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changed.replyTo).toMatchObject({ messageId: "origin:2" });
    expect(changed.throughSequence).toBe(2);
  });

  it("falls back to the name the peer sent when the contact is not loaded", () => {
    expect(noticeName(notice, undefined)).toBe("Ada Lovelace");
    expect(noticeName(notice, contact)).toBe("Ada");
  });
});
