import type { ConversationMessage } from "@humansandmachines/gsv/protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import * as sharedUtils from "../shared/utils";
import { AdapterMessageRefStore } from "./adapter-message-refs";
import {
  QUOTE_LOOKUP_TIMEOUT_MS,
  QUOTE_TEXT_LIMIT,
  resolveAdapterQuote,
} from "./adapter-quotes";
import type { KernelContext } from "./context";

const SCOPE = {
  ownerUid: 1000,
  adapter: "whatsapp",
  accountId: "managed",
  surface: { kind: "dm" as const, id: "34600000000" },
};
let getConversationByIdMock: MockInstance<typeof sharedUtils.getConversationById>;

function canonical(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "msg:1",
    conversationId: "conv:ship",
    sequence: 7,
    author: { kind: "process", pid: "pid-1", uid: 1001 },
    text: "Which one do you want?",
    origin: { kind: "process", pid: "pid-1", runId: "run-1" },
    createdAt: 1,
    ...overrides,
  };
}

function quoteContext(options: {
  ref?: ReturnType<AdapterMessageRefStore["lookup"]>;
  store?: AdapterMessageRefStore;
  read?: () => Promise<ConversationMessage | null>;
  ownerUid?: number;
  kind?: "ship" | "work" | "group";
} = {}) {
  const read = vi.fn(options.read ?? (async () => canonical()));
  getConversationByIdMock.mockReturnValue(
    // SAFETY: the resolver uses only this method of the Conversation stub.
    { readMessage: read } as ReturnType<typeof sharedUtils.getConversationById>,
  );
  const lookup = vi.fn(() => options.ref === undefined
    ? { conversationId: "conv:ship", messageId: "msg:1", sequence: 7 }
    : options.ref);
  const ctx = {
    installationId: "inst_test",
    env: {},
    adapters: { messageRefs: options.store ?? { lookup } },
    conversations: {
      get: vi.fn(() => ({ id: "conv:ship", ownerUid: options.ownerUid ?? 1000, kind: options.kind ?? "ship" })),
    },
    procs: { get: vi.fn(() => null) },
  };
  // SAFETY: the fixture provides the Kernel context fields the resolver uses.
  return { ctx: ctx as KernelContext, read, lookup };
}

describe("resolveAdapterQuote", () => {
  beforeEach(() => {
    getConversationByIdMock = vi.spyOn(sharedUtils, "getConversationById");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("names Ship as the author of a process message in the Ship conversation", async () => {
    const { ctx, read } = quoteContext();
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.out")).resolves.toEqual({
      state: "resolved", author: "ship", text: "Which one do you want?",
    });
    expect(read).toHaveBeenCalledWith({ sequence: 7, messageId: "msg:1" });
  });

  it("names the person as the author of their own earlier message", async () => {
    const { ctx } = quoteContext({ read: async () => canonical({ author: { kind: "user", uid: 1000 } }) });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.in")).resolves.toMatchObject({ state: "resolved", author: "person" });
  });

  it("does not call a helper's message Ship's", async () => {
    const { ctx } = quoteContext({ kind: "work" });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.out")).resolves.toMatchObject({ state: "resolved", author: "agent" });
  });

  it("tells the model which part the person quoted of a split message", async () => {
    const { ctx } = quoteContext({
      ref: { conversationId: "conv:ship", messageId: "msg:1", sequence: 7, part: { index: 2, count: 5 } },
    });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.part")).resolves.toMatchObject({ part: { index: 2, count: 5 } });
  });

  it("caps long text without splitting a character and marks the cut", async () => {
    const text = "😀".repeat(QUOTE_TEXT_LIMIT + 10);
    const { ctx } = quoteContext({ read: async () => canonical({ text }) });
    const quote = await resolveAdapterQuote(ctx, SCOPE, "wamid.out");
    if (quote.state !== "resolved") throw new Error("expected a quote");
    expect([...quote.text]).toHaveLength(QUOTE_TEXT_LIMIT + 1);
    expect(quote.text.endsWith("😀…")).toBe(true);
    expect(quote.text.isWellFormed()).toBe(true);
  });

  it("shows the quoted part of a long split message rather than its opening", async () => {
    const paragraphs = Array.from({ length: 5 }, (_, index) => `${"x".repeat(900)} paragraph-${index}`);
    const text = paragraphs.join("\n\n");
    const { ctx } = quoteContext({
      read: async () => canonical({ text }),
      ref: { conversationId: "conv:ship", messageId: "msg:1", sequence: 7, part: { index: 3, count: 5 } },
    });
    const quote = await resolveAdapterQuote(ctx, SCOPE, "wamid.part");
    if (quote.state !== "resolved") throw new Error("expected a quote");
    expect(quote.text.startsWith("…")).toBe(true);
    expect(quote.text).toContain("paragraph-3");
    expect(quote.text).not.toContain("paragraph-0");
  });

  it("describes a media-only message without its bytes", async () => {
    const { ctx } = quoteContext({
      read: async () => canonical({
        author: { kind: "user", uid: 1000 },
        text: "",
        media: [{
          type: "resource",
          ref: { type: "file", target: "gsv", path: "/x/photo.jpg", revision: "r", contentType: "image/jpeg", size: 3 },
          mediaType: "image",
          filename: "pho\nto.jpg",
        }, {
          type: "resource",
          ref: { type: "file", target: "gsv", path: "/x/voice.ogg", revision: "r", contentType: "audio/ogg", size: 3 },
          mediaType: "audio",
          transcription: "t".repeat(1_000),
        }],
      }),
    });
    const quote = await resolveAdapterQuote(ctx, SCOPE, "wamid.in");
    if (quote.state !== "resolved") throw new Error("expected a quote");
    expect(quote.text).toBe("");
    expect(quote.media?.[0]).toEqual({ type: "image", filename: "pho to.jpg" });
    expect(quote.media?.[1]?.type).toBe("audio");
    expect(quote.media?.[1]?.transcription?.length).toBeLessThan(400);
    expect(JSON.stringify(quote)).not.toContain("/x/photo.jpg");
  });

  it("is unavailable without reading any Conversation when the id is unknown", async () => {
    const { ctx, read } = quoteContext({ ref: null });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.old")).resolves.toEqual({ state: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("never pulls text from a message another surface recorded under the same provider id", async () => {
    await runWithRealKernelSql(async (sql) => {
      const store = new AdapterMessageRefStore(sql);
      store.record(
        { ...SCOPE, surface: { kind: "dm", id: "someone-else" } },
        { conversationId: "conv:ship", messageId: "msg:1", sequence: 7 },
        ["shared-id"],
      );
      const { ctx, read } = quoteContext({ store });
      await expect(resolveAdapterQuote(ctx, SCOPE, "shared-id")).resolves.toEqual({ state: "unavailable" });
      expect(read).not.toHaveBeenCalled();
    });
  });

  it("refuses a reference whose conversation belongs to someone else", async () => {
    const { ctx, read } = quoteContext({ ownerUid: 1001 });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.out")).resolves.toEqual({ state: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("is unavailable when the message no longer exists", async () => {
    const { ctx } = quoteContext({ read: async () => null });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.out")).resolves.toEqual({ state: "unavailable" });
  });

  it("does not treat a contact's message as something this surface can quote", async () => {
    const { ctx } = quoteContext({
      read: async () => canonical({ author: { kind: "contact", contactId: "c", displayName: "Ana" } }),
    });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.out")).resolves.toEqual({ state: "unavailable" });
  });

  it("is unavailable, never a throw, when the Conversation read fails", async () => {
    const { ctx } = quoteContext({ read: async () => { throw new Error("archive missing"); } });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.out")).resolves.toEqual({ state: "unavailable" });
  });

  it("is unavailable, never a throw, when the map itself fails", async () => {
    const { ctx } = quoteContext();
    vi.mocked(ctx.adapters.messageRefs.lookup).mockImplementation(() => { throw new Error("sql"); });
    await expect(resolveAdapterQuote(ctx, SCOPE, "wamid.out")).resolves.toEqual({ state: "unavailable" });
  });

  it("stops waiting for a Conversation that does not answer", async () => {
    vi.useFakeTimers();
    const { ctx } = quoteContext({ read: () => new Promise(() => undefined) });
    const pending = resolveAdapterQuote(ctx, SCOPE, "wamid.out");
    await vi.advanceTimersByTimeAsync(QUOTE_LOOKUP_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ state: "unavailable" });
  });
});
