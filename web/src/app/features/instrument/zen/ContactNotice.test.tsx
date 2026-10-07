import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { ContactNoticeMoment, noticeName } from "./ContactNotice";
import type { ContactNotice } from "./useContactNotices";

const notice: ContactNotice = {
  contactId: "contact:ada", conversationId: "conversation:ada", displayName: "Ada Lovelace",
  messageId: "message:1", sequence: 1, text: "hey — free to look at the release notes?", createdAt: 1,
  byShip: false, reference: { actor: { shipId: "ship:ada", subjectId: "subject:ada" }, messageId: "origin:1" }, count: 1, replied: false,
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
  it("shows the sender like any other, how many messages, and offers reply and go to chat", () => {
    const onReply = vi.fn();
    const onGoToChat = vi.fn();
    const tree = ContactNoticeMoment({ notice, contact: undefined, open: false, onReply, onGoToChat });
    expect(text(tree)).toBe("Ada Lovelace PERSON Sent 1 message reply go to chat");
    const [reply, goToChat] = buttons(tree);
    void reply.props.onClick?.();
    void goToChat.props.onClick?.();
    expect(onReply).toHaveBeenCalledOnce();
    expect(onGoToChat).toHaveBeenCalledOnce();
  });

  it("counts messages, marks the contact's GSV, prefers the alias, and steps reply aside while the box is open", () => {
    const tree = ContactNoticeMoment({ notice: { ...notice, byShip: true, count: 3 }, contact, open: true, onReply: vi.fn(), onGoToChat: vi.fn() });
    expect(text(tree)).toBe("Ada GSV Sent 3 messages go to chat");
    expect(collectNodes(tree).some((node) => node.props.class === "sender-dot")).toBe(true);
  });

  it("keeps go to chat after a reply and says it was answered", () => {
    const tree = ContactNoticeMoment({ notice: { ...notice, replied: true }, contact: undefined, open: false, onReply: vi.fn(), onGoToChat: vi.fn() });
    expect(text(tree)).toBe("Ada Lovelace PERSON Sent 1 message (replied) go to chat");
    expect(buttons(tree)).toHaveLength(1);
  });

  it("falls back to the name the peer sent when the contact is not loaded", () => {
    expect(noticeName(notice, undefined)).toBe("Ada Lovelace");
    expect(noticeName(notice, contact)).toBe("Ada");
  });
});
