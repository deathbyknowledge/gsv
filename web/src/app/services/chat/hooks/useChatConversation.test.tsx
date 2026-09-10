import type { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type {
  ConversationHistoryResult,
  ConversationSummary,
  ConversationMessage,
} from "@humansandmachines/gsv/protocol";
import { act } from "preact/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  createTestRoot,
  deferred,
} from "../../../testing/testHarness";

import {
  type ChatConversationRuntimeGateway,
  useChatConversationRuntime,
} from "./useChatConversation";

type HookResult = ReturnType<typeof useChatConversationRuntime>;
type ObservedHook = { current?: HookResult };

function conversation(id: string, handlerPid: string): ConversationSummary {
  return {
    id,
    kind: "work",
    ownerUid: 1000,
    title: null,
    handlerPid,
    latestSequence: 2,
    createdAt: 1,
    updatedAt: 2,
  };
}

function history(
  conversationValue: ConversationSummary,
  sequence: number,
  text: string,
  hasMore: boolean,
): ConversationHistoryResult {
  return {
    conversation: conversationValue,
    messages: [{
      id: `${conversationValue.id}:${sequence}`,
      conversationId: conversationValue.id,
      sequence,
      author: { kind: "user", uid: 1000 },
      text,
      origin: { kind: "client", clientId: "web" },
      createdAt: sequence,
    }],
    hasMore,
  };
}

describe("chat conversation pagination", () => {
  it("retains older pages and the exhausted cursor through disconnect and tail refresh", async () => {
    vi.stubGlobal("document", {});
    const summary = conversation("conversation:retained", "proc:retained");
    const observed: ObservedHook = {};
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createTestRoot("Retained conversation history");
    const gateway: ChatConversationRuntimeGateway = {
      client: {
        conversation: {
          forProcess: async () => ({ conversation: summary }),
          history: async ({ beforeSequence }: { beforeSequence?: number }) => beforeSequence === undefined
            ? history(summary, 2, "latest", true) : history(summary, 1, "older", false),
        },
        onSignal: () => () => undefined,
      },
      connected: true,
    };
    function Harness() {
      observed.current = useChatConversationRuntime({ processId: summary.handlerPid }, gateway);
      return null;
    }
    const render = () => root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    try {
      await render();
      await vi.waitFor(() => expect(observed.current?.rows.map((row) => row.text)).toEqual(["latest"]));
      await act(async () => { await observed.current?.loadOlder(); });
      expect(observed.current?.rows.map((row) => row.text)).toEqual(["older", "latest"]);
      expect(observed.current?.hasMore).toBe(false);
      gateway.connected = false;
      await render();
      expect(observed.current?.loaded).toBe(true);
      expect(observed.current?.rows.map((row) => row.text)).toEqual(["older", "latest"]);
      gateway.connected = true;
      await render();
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["conversation", "history", summary.id] }); });
      expect(observed.current?.rows.map((row) => row.text)).toEqual(["older", "latest"]);
      expect(observed.current?.hasMore).toBe(false);
    } finally {
      await root.unmount();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });

  it("does not merge an older page after the selected conversation changes", async () => {
    vi.stubGlobal("document", {});
    const first = conversation("conversation:first", "proc:first");
    const second = conversation("conversation:second", "proc:second");
    const olderFirst = deferred<ConversationHistoryResult>();
    const observed: ObservedHook = {};
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createTestRoot("Chat conversation pagination harness");

    const forProcess = vi.fn(async ({ pid }: { pid: string }) => ({
      conversation: pid === "proc:first" ? first : second,
    }));
    const getHistory = vi.fn(
      async ({ conversationId, beforeSequence }: {
        conversationId: string;
        beforeSequence?: number;
        limit?: number;
      }) => {
        if (conversationId === first.id && beforeSequence !== undefined) {
          return olderFirst.promise;
        }
        return conversationId === first.id
          ? history(first, 2, "first current", true)
          : history(second, 2, "second current", false);
      },
    );
    const gateway = {
      client: {
        conversation: { forProcess, history: getHistory },
        onSignal: () => () => undefined,
      },
      connected: true,
    } satisfies ChatConversationRuntimeGateway;

    function Harness({ processId }: { processId: string }) {
      observed.current = useChatConversationRuntime({ processId }, gateway);
      return null;
    }

    const renderProcess = (processId: string) => root.render(
      <QueryClientProvider client={queryClient}>
        <Harness processId={processId} />
      </QueryClientProvider>,
    );
    const current = (): HookResult => {
      if (!observed.current) throw new Error("Chat conversation hook did not render");
      return observed.current;
    };

    try {
      await renderProcess("proc:first");
      await vi.waitFor(() => {
        expect(current().conversation?.id).toBe(first.id);
        expect(current().rows.map((row) => row.text)).toEqual(["first current"]);
        expect(current().hasMore).toBe(true);
        expect(current().loadingOlder).toBe(false);
      });
      await act(async () => {
        await Promise.resolve();
      });

      let pagination!: Promise<void>;
      await act(() => {
        pagination = current().loadOlder();
      });
      await vi.waitFor(() => {
        expect(getHistory).toHaveBeenCalledWith({
          conversationId: first.id,
          beforeSequence: 2,
          limit: 50,
        });
      });

      await renderProcess("proc:second");
      await vi.waitFor(() => {
        expect(current().conversation?.id).toBe(second.id);
        expect(current().rows.map((row) => row.text)).toEqual(["second current"]);
      });

      await act(async () => {
        olderFirst.resolve(history(first, 1, "stale first page", false));
        await pagination;
      });

      expect(current().conversation?.id).toBe(second.id);
      expect(current().rows.map((row) => row.text)).toEqual(["second current"]);
    } finally {
      await root.unmount();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
});

describe("live conversation attachments", () => {
  it("keeps resource blocks on committed signals and reconciles the sender receipt once", async () => {
    vi.stubGlobal("document", {});
    const summary = conversation("conv:media", "proc:media");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createTestRoot("Live conversation media");
    const observed: ObservedHook = {};
    let listener: Parameters<GSVClient["onSignal"]>[0] | undefined;
    const message: ConversationMessage = {
      id: "message:media", conversationId: summary.id, sequence: 1, author: { kind: "user", uid: 1000 },
      text: "", createdAt: 1, origin: { kind: "client", clientId: "web" },
      media: [{ type: "resource", mediaType: "image", filename: "image.png", ref: { type: "file", target: "gsv", path: "/home/test/image.png", revision: "content-one", contentType: "image/png", size: 3 } }],
    };
    const gateway: ChatConversationRuntimeGateway = {
      client: {
        conversation: { forProcess: async () => ({ conversation: summary }), history: async () => ({ conversation: summary, messages: [], hasMore: false }) },
        onSignal: (next) => { listener = next; return () => { listener = undefined; }; },
      }, connected: true,
    };
    function Harness() { observed.current = useChatConversationRuntime({ processId: summary.handlerPid }, gateway); return null; }
    try {
      await root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
      await vi.waitFor(() => { expect(observed.current?.loaded).toBe(true); expect(listener).toBeDefined(); });
      await act(() => { listener?.("message.committed", { message, directed: true }); });
      await vi.waitFor(() => expect(observed.current?.rows[0]?.media).toEqual(message.media));
      await act(() => { observed.current?.acceptMessage(message); });
      expect(observed.current?.rows).toHaveLength(1);
      expect(observed.current?.rows[0].delivery).toBe("directed");
    } finally { await root.unmount(); queryClient.clear(); vi.unstubAllGlobals(); }
  });
});
