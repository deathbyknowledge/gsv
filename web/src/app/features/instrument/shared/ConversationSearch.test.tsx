import { GSVClient } from "@humansandmachines/gsv/client";
import type { ConversationMessage, ConversationSearchHit, ConversationSummary } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, ComponentProps, RefObject } from "preact";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, createTestRoot, deferred } from "../../../testing/testHarness";
import { ZenText } from "../zen/ZenText";
import { ConversationExcerpt } from "./ConversationSearch";

const author = { kind: "user", uid: 1000 } as const;
const conversation: ConversationSummary = { id: "ship", kind: "ship", ownerUid: 1000, title: null, handlerPid: "ship", latestSequence: 3, createdAt: 1, updatedAt: 1 };
const hit: ConversationSearchHit = { id: "message-2", sequence: 2, author, createdAt: 2, snippet: "Message 2" };

function message(sequence: number): ConversationMessage {
  return { id: `message-${sequence}`, conversationId: "ship", sequence, author, text: `Message ${sequence}`, origin: { kind: "client", clientId: "web" }, createdAt: sequence };
}

let historyReady: Promise<void>;

beforeEach(() => {
  historyReady = Promise.resolve();
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("window", {
    location: { protocol: "https:", host: "space.example" },
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(GSVClient.prototype, "getStatus").mockImplementation(() => ({ state: "connected", url: "wss://space.example/ws", username: "hank", connectionId: null, message: null }));
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call !== "conversation.history") throw new Error(`Unexpected request ${call}`);
    await historyReady;
    const { afterSequence } = z.object({ afterSequence: z.number().optional() }).parse(args);
    return { data: { conversation, messages: afterSequence === undefined ? [message(1), message(2)] : [message(3)], hasMore: false } };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mountExcerpt() {
  const root = createTestRoot("Conversation excerpt");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree: ComponentChildren;
  function Harness() {
    tree = ConversationExcerpt({ conversationId: "ship", hit, date: new Intl.DateTimeFormat("en") });
    return null;
  }
  const nodes = () => collectNodes(tree);
  return {
    render: () => root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>),
    nodes,
    /** The props each message passes to ZenText, in listing order. */
    texts<P = ComponentProps<typeof ZenText>>() {
      // SAFETY: These VNodes were selected by the exact component whose props type P describes.
      return nodes().filter((node) => node.type === ZenText).map((node) => node.props as P);
    },
    async unmount() { await root.unmount(); cache.clear(); },
  };
}

describe("conversation search excerpt", () => {
  it("starts only the matched message open, so its fold cannot hide what was searched for", async () => {
    const excerpt = mountExcerpt();
    try {
      await excerpt.render();
      await vi.waitFor(() => expect(excerpt.texts()).toHaveLength(3));
      expect(excerpt.texts().map(({ text, opened }) => [text, opened ?? false])).toEqual([
        ["Message 1", false],
        ["Message 2", true],
        ["Message 3", false],
      ]);
    } finally {
      await excerpt.unmount();
    }
  });

  it.each([[200, "center"], [900, "start"]])("places a %ipx match in a 600px panel once earlier messages have folded", async (height, block) => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    const ready = deferred<void>();
    historyReady = ready.promise;
    const scrollIntoView = vi.fn();
    const excerpt = mountExcerpt();
    try {
      await excerpt.render();
      const panel = excerpt.nodes().find((node) => node.props.class === "zen-search-excerpt")!;
      // SAFETY: The panel carries the excerpt's body ref; this harness renders no DOM to attach it.
      (panel.ref as RefObject<unknown>).current = {
        clientHeight: 600,
        querySelectorAll: () => [{ dataset: { messageId: "message-2" }, offsetHeight: height, scrollIntoView }],
      };
      ready.resolve();
      await vi.waitFor(() => expect(excerpt.texts()).toHaveLength(3));
      await excerpt.render();
      // Each ZenText folds after this commit, which moves everything below it.
      expect(scrollIntoView).not.toHaveBeenCalled();
      frames.forEach((frame) => frame(0));
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block });
    } finally {
      await excerpt.unmount();
    }
  });
});
