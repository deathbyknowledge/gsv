import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type {
  ConversationHistoryResult,
  ConversationSummary,
} from "@humansandmachines/gsv/protocol";
import { act } from "preact/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  createTestRoot,
  deferred,
} from "../../gsv-console/messengers/messengerTestHarness";

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
