import { GSVClient } from "@humansandmachines/gsv/client";
import { originMessageRefSchema, type ContactSendResult, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot, deferred } from "../../../testing/testHarness";
import { useContactDrafts } from "./useContactDrafts";

const send = vi.fn<GSVClient["contact"]["send"]>();
const sendArgsSchema = z.object({ contactId: z.string(), text: z.string(), idempotencyKey: z.optional(z.string()), replyTo: z.optional(originMessageRefSchema) });
beforeEach(() => {
  send.mockReset();
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: "wss://space.example/ws", username: "person", connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "contact.send") return { data: await send(sendArgsSchema.parse(args)) };
    throw new Error(`Unexpected request ${call}`);
  });
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const contact: ContactSummary = {
  id: "contact:one", ownerUid: 1000, state: "active", generation: "generation:one", remoteShipId: "ship:one",
  remoteSubject: { id: "subject:one", displayName: "Person" }, remoteOrigin: "https://person.example",
  conversationId: "conversation:one", createdAtMs: 1, updatedAtMs: 1,
};
const accepted: ContactSendResult = { deliveryId: "delivery:one", conversationId: contact.conversationId, state: "queued" };

async function mounted() {
  const root = createTestRoot("contact drafts");
  let current!: ReturnType<typeof useContactDrafts>;
  function Harness() { current = useContactDrafts(); return null; }
  await root.render(<GatewayProvider><Harness /></GatewayProvider>);
  return { get current() { return current; }, unmount: () => root.unmount() };
}

describe("optimistic human contact sends", () => {
  it("moves the message out of the prompt immediately and preserves the next draft through acknowledgement", async () => {
    const ack = deferred<ContactSendResult>();
    send.mockReturnValue(ack.promise);
    const view = await mounted();
    try {
      await act(() => view.current.update(contact.id, { text: "First message" }));
      let sending!: Promise<void>;
      await act(() => { sending = view.current.send(contact); });
      expect(view.current.drafts.get(contact.id)).toMatchObject({ text: "", pending: true, sent: [{ state: "sending", intent: { text: "First message" } }] });
      await act(() => view.current.update(contact.id, { text: "The next thought" }));
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await act(async () => { ack.resolve(accepted); await sending; });
      const draft = view.current.drafts.get(contact.id)!;
      expect(draft.text).toBe("The next thought");
      expect(draft.sent[0]).toMatchObject({ state: "queued", deliveryId: accepted.deliveryId });
      await act(() => view.current.observed(contact.id, [draft.sent[0].messageId!]));
      expect(view.current.drafts.get(contact.id)?.sent).toEqual([]);
      expect(view.current.drafts.get(contact.id)?.text).toBe("The next thought");
    } finally { await view.unmount(); }
  });

  it("retries an uncertain send with its original text, recipient and reply while another draft is open", async () => {
    send.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(accepted);
    const view = await mounted();
    try {
      const reference = { actor: { shipId: "ship:one", subjectId: "subject:one" }, messageId: "message:original" };
      await act(() => view.current.update(contact.id, { text: "A reply", reply: { reference, author: "Person", preview: "Original" } }));
      await act(async () => { await view.current.send(contact); });
      const pending = view.current.drafts.get(contact.id)!.sent[0];
      expect(pending.state).toBe("unconfirmed");
      await act(() => view.current.update(contact.id, { text: "Unrelated new draft", reply: null }));
      await act(async () => { await view.current.send(contact, pending.intent.idempotencyKey); });
      expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
      expect(send.mock.calls[1][0].replyTo).toEqual(reference);
      expect(view.current.drafts.get(contact.id)?.text).toBe("Unrelated new draft");
      expect(view.current.drafts.get(contact.id)?.sent).toHaveLength(1);
    } finally { await view.unmount(); }
  });

  it("requires a fresh human decision after the contact generation changes", async () => {
    send.mockRejectedValue(new Error("Connection lost"));
    const view = await mounted();
    try {
      await act(() => view.current.update(contact.id, { text: "Hello" }));
      await act(async () => { await view.current.send(contact); });
      const id = view.current.drafts.get(contact.id)!.sent[0].intent.idempotencyKey;
      await act(async () => { await view.current.send({ ...contact, generation: "generation:new" }, id); });
      expect(send).toHaveBeenCalledOnce();
      expect(view.current.drafts.get(contact.id)!.sent[0].error).toContain("connection changed");
    } finally { await view.unmount(); }
  });
});
