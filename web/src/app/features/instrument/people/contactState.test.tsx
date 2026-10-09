import { GSVClient } from "@humansandmachines/gsv/client";
import type { ConversationInboxEntry, ConversationMessage } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { createTestRoot } from "../../../testing/testHarness";
import { syncContactDetailSignal } from "../wire/contactSync";
import { replyIntentFor } from "../zen/ContactNotice";
import { conversationNotice, peopleConversations } from "./peopleActivityModel";
import { useContactHistory } from "./useContactHistory";
import { useContactReplies } from "./useContactReplies";
import { usePeopleActivity } from "./usePeopleActivity";

const viewer: ConsoleAccount = { uid: 1000, username: "person", displayName: "Person", relation: "self", runnable: false, gecos: "", capabilities: ["*"] };
const conversation = { id: "conversation:ada", ownerUid: 1000, title: "Ada", kind: "contact" as const, createdAt: 1, updatedAt: 41, latestSequence: 41 };
const contact = { id: "contact:ada", conversationId: conversation.id, ownerUid: 1000, state: "active", remoteSubject: { displayName: "Ada" } };
let messages: ConversationMessage[];
let readThrough: number;
let failRead: boolean;

function message(sequence: number): ConversationMessage {
  return { id: `message:${sequence}`, conversationId: conversation.id, sequence, text: `Message ${sequence}`, createdAt: sequence,
    author: { kind: "contact", contactId: contact.id, shipId: "ship:ada", subjectId: "subject:ada", displayName: "Ada" },
    origin: { kind: "federation", contactId: contact.id, deliveryId: `delivery:${sequence}` },
    social: { threadId: "thread:ada", reference: { actor: { shipId: "ship:ada", subjectId: "subject:ada" }, messageId: `remote:${sequence}` }, provenance: { kind: "human" } } };
}

function entry(): ConversationInboxEntry {
  const latest = messages[messages.length - 1];
  return { conversation: { ...conversation, latestSequence: latest.sequence }, contactId: contact.id,
    view: { readThroughSequence: readThrough, revision: readThrough, archived: false },
    latestIncomingSequence: latest.sequence, unread: latest.sequence > readThrough, preview: { ...latest, attachmentCount: 0 } };
}

beforeEach(() => {
  messages = [message(41)]; readThrough = 40; failRead = false;
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: "wss://space.example/ws", username: "person", connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "conversation.history") return { data: { conversation, messages: [...messages], hasMore: false } };
    if (call === "conversation.inbox") return { data: { entries: entry().unread ? [entry()] : [] } };
    if (call === "contact.list") return { data: { contacts: [contact] } };
    if (call === "approach.list") return { data: { approaches: [] } };
    if (call === "conversation.view.update") {
      if (failRead) throw new Error("Read position unavailable");
      readThrough = Math.max(readThrough, z.object({ readThroughSequence: z.number() }).parse(args).readThroughSequence);
      return { data: { entry: entry() } };
    }
    throw new Error(`Unexpected request ${call}`);
  });
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type ContactState = { people: ReturnType<typeof useContactHistory>; zen: ReturnType<typeof useContactHistory>; activity: ReturnType<typeof usePeopleActivity>; replies: ReturnType<typeof useContactReplies> };

async function mounted() {
  const root = createTestRoot("shared contact state");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  let current!: ContactState;
  function Harness() {
    current = { people: useContactHistory(conversation.id, true), zen: useContactHistory(conversation.id, true), activity: usePeopleActivity(viewer), replies: useContactReplies(viewer) };
    return null;
  }
  await root.render(<QueryClientProvider client={cache}><GatewayProvider><Harness /></GatewayProvider></QueryClientProvider>);
  await vi.waitFor(() => expect(current.activity.conversations).toHaveLength(1));
  return { get current() { return current; }, cache, async unmount() { await root.unmount(); cache.clear(); } };
}

describe("shared contact state", () => {
  it("shares history across People and Zen and leaves a message arriving during a reply unread", async () => {
    const view = await mounted();
    try {
      expect(view.current.people.data).toBe(view.current.zen.data);
      expect(vi.mocked(GSVClient.prototype.request).mock.calls.filter(([call]) => call === "conversation.history")).toHaveLength(1);
      const [item] = peopleConversations(view.current.activity, view.current.replies.drafts);
      const intent = replyIntentFor(null, conversationNotice(item, messages)!, "Reply to 41");
      await act(() => view.current.replies.setDraft(contact.id, { text: intent.text, intent, readThroughSequence: 40 }));
      messages = [...messages, message(42)];
      await act(() => syncContactDetailSignal(view.cache, "conversation.changed", { conversationId: conversation.id }));
      await vi.waitFor(() => expect(view.current.zen.data?.pages[0].messages).toHaveLength(2));
      expect(view.current.people.data).toBe(view.current.zen.data);
      await act(() => { view.current.replies.clearSentDraft(contact.id, intent); view.current.replies.markRead(conversation.id, intent.throughSequence); });
      await vi.waitFor(() => expect(readThrough).toBe(41));
      await act(() => syncContactDetailSignal(view.cache, "conversation.changed", { conversationId: conversation.id, viewOnly: true }));
      await vi.waitFor(() => expect(view.current.activity.conversations[0]?.view.readThroughSequence).toBe(41));
      const [waiting] = peopleConversations(view.current.activity, view.current.replies.drafts);
      expect(conversationNotice(waiting, view.current.zen.data!.pages[0].messages)?.messages.map((value) => value.sequence)).toEqual([42]);
      expect(view.current.replies.drafts.size).toBe(0);
    } finally { await view.unmount(); }
  });

  it("keeps a newer draft through a delayed send and a read in another surface", async () => {
    const view = await mounted();
    try {
      const [item] = peopleConversations(view.current.activity, view.current.replies.drafts);
      const intent = replyIntentFor(null, conversationNotice(item, messages)!, "First reply");
      await act(() => view.current.replies.setDraft(contact.id, { text: "A newer reply", intent, readThroughSequence: 40 }));
      await act(() => view.current.replies.clearSentDraft(contact.id, intent));
      readThrough = 41;
      await act(() => syncContactDetailSignal(view.cache, "conversation.changed", { conversationId: conversation.id, viewOnly: true }));
      await vi.waitFor(() => expect(view.current.activity.conversations).toHaveLength(0));
      expect(peopleConversations(view.current.activity, view.current.replies.drafts)[0]).toMatchObject({ contactId: contact.id, draft: true, text: "A newer reply" });
      const newer = { ...intent, idempotencyKey: "send:newer" };
      await act(() => view.current.replies.setDraft(contact.id, { text: intent.text, intent: newer, readThroughSequence: 40 }));
      await act(() => view.current.replies.clearSentDraft(contact.id, intent));
      expect(view.current.replies.dirty).toBe(true);
      await act(() => view.current.replies.clearSentDraft(contact.id, newer));
      expect(peopleConversations(view.current.activity, view.current.replies.drafts)).toEqual([]);
    } finally { await view.unmount(); }
  });

  it("retains authoritative unread state and exposes a failed read update after a successful reply", async () => {
    const view = await mounted();
    try {
      failRead = true;
      await act(() => view.current.replies.markRead(conversation.id, 41));
      await vi.waitFor(() => expect(view.current.replies.readError?.message).toBe("Read position unavailable"));
      expect(view.current.activity.conversations[0]?.unread).toBe(true);
      expect(vi.mocked(GSVClient.prototype.request).mock.calls.some(([call]) => call === "contact.send")).toBe(false);
    } finally { await view.unmount(); }
  });
});
