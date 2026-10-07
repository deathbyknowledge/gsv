import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { ContactNoticeMoment, noticeName, preview, repliedThrough, replyIntentFor } from "./ContactNotice";
import type { ContactNotice, ContactNoticeMessage } from "./useContactNotices";

function message(sequence: number, text: string, byShip = false): ContactNoticeMessage {
  return { messageId: `message:${sequence}`, sequence, text, createdAt: sequence, byShip, media: [], reference: { actor: { shipId: "ship:ada", subjectId: "subject:ada" }, messageId: `origin:${sequence}` } };
}
const notice: ContactNotice = {
  contactId: "contact:ada", conversationId: "conversation:ada", displayName: "Ada Lovelace",
  messages: [message(1, "hey — free to look at the release notes before i send them out?")], replied: false,
};
const contact: ContactSummary = {
  id: notice.contactId, ownerUid: 1000, state: "active", generation: "generation:one", remoteShipId: "ship:ada",
  remoteSubject: { id: "subject:ada", displayName: "Ada Lovelace" }, remoteOrigin: "https://ada.example",
  conversationId: notice.conversationId, localAlias: "Ada", createdAtMs: 1, updatedAtMs: 1,
};

function buttons(tree: ReturnType<typeof ContactNoticeMoment>) {
  return collectNodes(tree).filter((node) => node.type === "button");
}
/* the harness joins text fragments with spaces; read the moment the way a person does */
function text(tree: ReturnType<typeof ContactNoticeMoment>) {
  return collectText(tree).replace(/\s+/g, " ").trim();
}

describe("the contact notice", () => {
  it("shows the sender like any other, the start of the message, and offers show and go to chat", () => {
    const onShow = vi.fn();
    const onGoToChat = vi.fn();
    const tree = ContactNoticeMoment({ notice, contact: undefined, open: false, onShow, onGoToChat });
    expect(text(tree)).toBe("Ada Lovelace PERSON hey — free to look at the release… show message go to chat");
    const [show, goToChat] = buttons(tree);
    void show.props.onClick?.();
    void goToChat.props.onClick?.();
    expect(onShow).toHaveBeenCalledOnce();
    expect(onGoToChat).toHaveBeenCalledOnce();
  });

  it("counts waiting messages, badges the newest sender, prefers the alias, and steps show aside while open", () => {
    const three = { ...notice, messages: [message(1, "first"), message(2, "second"), message(3, "ok, sent it", true)] };
    const closed = ContactNoticeMoment({ notice: three, contact, open: false, onShow: vi.fn(), onGoToChat: vi.fn() });
    expect(text(closed)).toBe("Ada GSV ok, sent it show 3 messages go to chat");
    expect(collectNodes(closed).some((node) => node.props.class === "sender-dot")).toBe(true);
    const opened = ContactNoticeMoment({ notice: three, contact, open: true, onShow: vi.fn(), onGoToChat: vi.fn() });
    expect(text(opened)).toBe("Ada GSV ok, sent it go to chat");
  });

  it("keeps go to chat after a reply and says it was answered", () => {
    const tree = ContactNoticeMoment({ notice: { ...notice, replied: true }, contact: undefined, open: false, onShow: vi.fn(), onGoToChat: vi.fn() });
    expect(text(tree)).toBe("Ada Lovelace PERSON hey — free to look at the release… (replied) go to chat");
    expect(buttons(tree)).toHaveLength(1);
  });

  it("names a message with no text by what it carries", () => {
    const attachment = { ...notice, messages: [{ ...message(1, ""), media: [{ type: "resource", path: "/tmp/build.zip" }] }] };
    const tree = ContactNoticeMoment({ notice: attachment, contact: undefined, open: false, onShow: vi.fn(), onGoToChat: vi.fn() });
    expect(text(tree)).toBe("Ada Lovelace PERSON (an attachment) show message go to chat");
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
    expect(repliedThrough(grown, first)).toBe(1);
    const changed = replyIntentFor(first, grown, "yes, and tau too");
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changed.replyTo).toMatchObject({ messageId: "origin:2" });
    expect(repliedThrough(grown, changed)).toBe(2);
  });

  it("falls back to the name the peer sent when the contact is not loaded", () => {
    expect(noticeName(notice, undefined)).toBe("Ada Lovelace");
    expect(noticeName(notice, contact)).toBe("Ada");
  });
});
