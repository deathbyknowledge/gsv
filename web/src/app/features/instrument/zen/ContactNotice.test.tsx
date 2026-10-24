import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { ContactNoticePanel, noticeName, preview, replyIntentFor, type ContactNotice, type ContactNoticeMessage } from "./ContactNotice";

let root: ReturnType<typeof createTestRoot> | undefined;
afterEach(async () => { await root?.unmount(); root = undefined; vi.unstubAllGlobals(); });

function message(sequence: number, text: string, byShip = false): ContactNoticeMessage {
  return { id: `message:${sequence}`, conversationId: "conversation:ada", sequence, text, createdAt: sequence, media: [],
    author: { kind: "contact", contactId: "contact:ada", displayName: "Ada Lovelace" },
    origin: { kind: "federation", contactId: "contact:ada", deliveryId: `delivery:${sequence}` },
    social: { threadId: "thread:ada", reference: { did: "did:plc:adaaaaaaaaaaaaaaaaaaaaaa", messageId: `origin:${sequence}` }, provenance: byShip ? { kind: "process", processId: "proc:ada" } : { kind: "human" } } };
}
const notice: ContactNotice = {
  contactId: "contact:ada", conversationId: "conversation:ada", displayName: "Ada Lovelace",
  messages: [message(1, "hey — free to look at the release notes before i send them out?")],
};
const contact: ContactSummary = {
  id: notice.contactId, ownerUid: 1000, state: "active", generation: "generation:one", remoteDid: "did:plc:adaaaaaaaaaaaaaaaaaaaaaa",
  remoteName: "Ada Lovelace", remoteHandle: "ada.example",
  conversationId: notice.conversationId, localAlias: "Ada", createdAtMs: 1, updatedAtMs: 1,
};

/* the panel reads the interface language, so it renders inside a test root */
async function panel(props: Parameters<typeof ContactNoticePanel>[0]): Promise<ReturnType<typeof ContactNoticePanel>> {
  let tree: ReturnType<typeof ContactNoticePanel> | undefined;
  function Harness() { tree = ContactNoticePanel(props); return null; }
  vi.stubGlobal("document", {});
  root = createTestRoot("Contact notice");
  await root.render(<Harness />);
  if (!tree) throw new Error("The contact notice did not render");
  return tree;
}

function buttons(tree: ReturnType<typeof ContactNoticePanel>) {
  return collectNodes(tree).filter((node) => node.type === "button");
}
/* the harness joins text fragments with spaces; read the moment the way a person does */
function text(tree: ReturnType<typeof ContactNoticePanel>) {
  return collectText(tree).replace(/\s+/g, " ").trim();
}

describe("the contact notice", () => {
  it("keeps sender provenance and explicit close and full conversation actions in the panel", async () => {
    const onClose = vi.fn();
    const onGoToChat = vi.fn();
    const tree = await panel({ id: "people-panel", name: "Ada", notice, onClose, onGoToChat, children: "Waiting message" });
    expect(text(tree)).toBe("Ada PERSON close Waiting message 1 message open conversation ↗");
    expect(tree.props["aria-label"]).toBe("Messages from Ada");
    const [close, goToChat] = buttons(tree);
    void close.props.onClick?.();
    void goToChat.props.onClick?.();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onGoToChat).toHaveBeenCalledOnce();
  });

  it("counts waiting messages and identifies when the contact's Ship wrote the latest", async () => {
    const three = { ...notice, messages: [message(1, "first"), message(2, "second"), message(3, "ok, sent it", true)] };
    const tree = await panel({ id: "people-panel", name: "Ada", notice: three, onClose: vi.fn(), onGoToChat: vi.fn() });
    expect(text(tree)).toBe("Ada Ship close 3 messages open conversation ↗");
    expect(collectNodes(tree).some((node) => node.props.class === "sender-dot")).toBe(true);
  });

  it("clips a preview to its first words", () => {
    expect(preview("one two three")).toBe("one two three");
    expect(preview("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight…");
    expect(preview("   ")).toBe("(an empty message)");
    expect(preview("", 1)).toBe("(an attachment)");
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
