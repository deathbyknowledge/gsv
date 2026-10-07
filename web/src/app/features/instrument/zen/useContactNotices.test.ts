import { GSVClient } from "@humansandmachines/gsv/client";
import { act } from "preact/test-utils";
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { createTestRoot } from "../../../testing/testHarness";
import { useContactNotices } from "./useContactNotices";

type Listener = Parameters<GSVClient["onSignal"]>[0];
type Payload = Parameters<Listener>[1];
const listeners = new Set<Listener>();
let readThrough: number;

beforeEach(() => {
  listeners.clear();
  readThrough = 0;
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: "wss://space.example/ws", username: "person", connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation((listener) => { listeners.add(listener); return () => listeners.delete(listener); });
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "conversation.view.get") return { data: { entry: { view: { readThroughSequence: readThrough } } } };
    throw new Error(`Unexpected request ${call}`);
  });
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/* a committed contact message as the kernel broadcasts it; `social` is left off for request-state lines and v1 peers */
function committed(sequence: number, overrides: { attention?: "notify" | "quiet"; social?: boolean; contactId?: string; id?: string } = {}): Payload {
  const contactId = overrides.contactId ?? "contact:ada";
  const base = {
    id: overrides.id ?? `${contactId}:${sequence}`, conversationId: `conversation:${contactId}`, sequence, text: `message ${sequence}`, createdAt: sequence,
    author: { kind: "contact", contactId, shipId: "ship:ada", subjectId: "subject:ada", displayName: "Ada Lovelace" },
  };
  const social = { reference: { actor: { shipId: "ship:ada", subjectId: "subject:ada" }, messageId: `origin:${sequence}` }, provenance: { kind: sequence % 2 ? "human" : "process" } };
  const message = overrides.social === false ? base : { ...base, social };
  return { message, directed: false, attention: overrides.attention ?? "notify" };
}

async function mounted(options = { enabled: true, mayReadView: true }) {
  const root = createTestRoot("contact notices");
  let current!: ReturnType<typeof useContactNotices>;
  function Harness() { current = useContactNotices(options); return null; }
  await root.render(h(GatewayProvider, null, h(Harness, null)));
  return { get current() { return current; }, unmount: () => root.unmount() };
}

async function emit(signal: string, payload: Payload) {
  await act(() => { for (const listener of listeners) listener(signal, payload); });
}

describe("contact notices in the ship chat", () => {
  it("shows a notice only for a contact message the kernel marks notify", async () => {
    const view = await mounted();
    try {
      await emit("message.committed", committed(1, { attention: "quiet" }));
      expect(view.current.notices).toEqual([]);
      await emit("message.committed", committed(2));
      expect(view.current.notices).toMatchObject([{ contactId: "contact:ada", displayName: "Ada Lovelace", messages: [{ sequence: 2, text: "message 2", byShip: true }], replied: false }]);
    } finally { await view.unmount(); }
  });

  it("skips request-state lines and v1 peers, which carry no social metadata", async () => {
    const view = await mounted();
    try {
      await emit("message.committed", committed(1, { social: false }));
      expect(view.current.notices).toEqual([]);
    } finally { await view.unmount(); }
  });

  it("keeps one notice per contact holding every waiting message in order, without double counting a repeat", async () => {
    const view = await mounted();
    try {
      await emit("message.committed", committed(1));
      await emit("message.committed", committed(1));
      await emit("message.committed", committed(2));
      await emit("message.committed", committed(1, { contactId: "contact:bob" }));
      expect(view.current.notices).toMatchObject([
        { contactId: "contact:ada", messages: [{ sequence: 1 }, { sequence: 2, byShip: true }] },
        { contactId: "contact:bob", messages: [{ sequence: 1 }] },
      ]);
    } finally { await view.unmount(); }
  });

  it("clears a notice once the conversation is read past its newest message elsewhere", async () => {
    const view = await mounted();
    try {
      await emit("message.committed", committed(3));
      readThrough = 2;
      await emit("conversation.changed", { conversationId: "conversation:contact:ada", latestSequence: 3, viewOnly: true });
      await vi.waitFor(() => expect(GSVClient.prototype.request).toHaveBeenCalledWith("conversation.view.get", expect.anything()));
      expect(view.current.notices).toHaveLength(1);
      readThrough = 3;
      await emit("conversation.changed", { conversationId: "conversation:contact:ada", latestSequence: 3, viewOnly: true });
      await vi.waitFor(() => expect(view.current.notices).toEqual([]));
    } finally { await view.unmount(); }
  });

  it("ignores reads when the person may not read view state", async () => {
    const view = await mounted({ enabled: true, mayReadView: false });
    try {
      await emit("message.committed", committed(1));
      await emit("conversation.changed", { conversationId: "conversation:contact:ada", latestSequence: 1, viewOnly: true });
      expect(GSVClient.prototype.request).not.toHaveBeenCalled();
      expect(view.current.notices).toHaveLength(1);
    } finally { await view.unmount(); }
  });

  it("keeps an answered notice through a read elsewhere, and starts a new batch when the contact writes again", async () => {
    const view = await mounted();
    try {
      await emit("message.committed", committed(1));
      await emit("message.committed", committed(2));
      await act(() => view.current.markReplied("contact:ada"));
      expect(view.current.notices).toMatchObject([{ messages: [{ sequence: 1 }, { sequence: 2 }], replied: true }]);
      readThrough = 2;
      await emit("conversation.changed", { conversationId: "conversation:contact:ada", latestSequence: 2, viewOnly: true });
      expect(GSVClient.prototype.request).not.toHaveBeenCalled();
      expect(view.current.notices).toMatchObject([{ replied: true }]);
      await emit("message.committed", committed(3));
      expect(view.current.notices).toMatchObject([{ messages: [{ sequence: 3 }], replied: false }]);
    } finally { await view.unmount(); }
  });

  it("stays silent when disabled", async () => {
    const view = await mounted({ enabled: false, mayReadView: true });
    try {
      expect(listeners.size).toBe(0);
      expect(view.current.notices).toEqual([]);
    } finally { await view.unmount(); }
  });
});
