import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { ContactNoticeRow, noticeName } from "./ContactNotice";
import type { ContactNotice } from "./useContactNotices";

const notice: ContactNotice = {
  contactId: "contact:ada", conversationId: "conversation:ada", displayName: "Ada Lovelace",
  messageId: "message:1", sequence: 1, text: "hey — free to look at the release notes?", createdAt: 1,
  byShip: false, reference: { actor: { shipId: "ship:ada", subjectId: "subject:ada" }, messageId: "origin:1" }, count: 1,
};
const contact: ContactSummary = {
  id: notice.contactId, ownerUid: 1000, state: "active", generation: "generation:one", remoteShipId: "ship:ada",
  remoteSubject: { id: "subject:ada", displayName: "Ada Lovelace" }, remoteOrigin: "https://ada.example",
  conversationId: notice.conversationId, localAlias: "Ada", createdAtMs: 1, updatedAtMs: 1,
};

function buttons(tree: ReturnType<typeof ContactNoticeRow>) {
  return collectNodes(tree).filter((node) => node.type === "button");
}
/* the harness joins text fragments with spaces; read the row the way a person does */
function text(tree: ReturnType<typeof ContactNoticeRow>) {
  return collectText(tree).replace(/\s+/g, " ").trim();
}

describe("the contact notice row", () => {
  it("names the person with their badge and offers show and go to chat", () => {
    const onShow = vi.fn();
    const onGoToChat = vi.fn();
    const tree = ContactNoticeRow({ notice, contact: undefined, onShow, onGoToChat });
    expect(text(tree)).toBe("new message from Ada Lovelace PERSON show go to chat");
    const [show, goToChat] = buttons(tree);
    void show.props.onClick?.();
    void goToChat.props.onClick?.();
    expect(onShow).toHaveBeenCalledOnce();
    expect(onGoToChat).toHaveBeenCalledOnce();
  });

  it("counts several messages, marks the contact's GSV, and prefers the local alias", () => {
    const tree = ContactNoticeRow({ notice: { ...notice, byShip: true, count: 3 }, contact, onShow: vi.fn(), onGoToChat: vi.fn() });
    expect(text(tree)).toBe("3 new messages from Ada GSV show go to chat");
    expect(collectNodes(tree).some((node) => node.props.class === "sender-dot")).toBe(true);
  });

  it("falls back to the name the peer sent when the contact is not loaded", () => {
    expect(noticeName(notice, undefined)).toBe("Ada Lovelace");
    expect(noticeName(notice, contact)).toBe("Ada");
  });
});
