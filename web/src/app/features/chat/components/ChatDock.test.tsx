import { toChildArray, type ComponentChildren, type VNode } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAgentData } from "../domain/agent";

const mocks = vi.hoisted(() => ({
  forkMutate: vi.fn(),
  rows: [{
    id: "root-message",
    messageId: 7,
    role: "user",
    text: "Inspect the runtime",
    time: "10:00",
    timestamp: 1,
  }],
}));

vi.mock("preact/hooks", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(value: T | (() => T)) => [
    typeof value === "function" ? (value as () => T)() : value,
    vi.fn(),
  ],
}));

vi.mock("../hooks", () => {
  const mutation = () => ({
    error: null,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  });
  return {
    useAbortChatProcess: mutation,
    useChatAmbientTranscription: () => ({
      active: false,
      dictationActive: false,
      dictationTitle: "Start dictation",
      dictationUnavailable: true,
      errorNonce: 0,
      liveActive: false,
      liveTitle: "Start conversation",
      liveUnavailable: true,
      note: "",
      state: "idle",
      toggleDictation: vi.fn(),
      toggleLive: vi.fn(),
    }),
    useChatHistorySegments: () => ({ data: [] }),
    useChatConversation: () => ({
      appendOptimistic: vi.fn(),
      conversation: null,
      hasMore: false,
      historyError: null,
      historyLoading: false,
      loadOlder: vi.fn(),
      loadingOlder: false,
      rows: mocks.rows,
    }),
    useChatProcessAiConfig: () => ({
      data: null,
      error: null,
      isError: false,
      isLoading: false,
    }),
    useChatReplySpeech: () => ({
      cancelSpeech: vi.fn(),
      isSpeaking: false,
      setSpeakReplies: vi.fn(),
      speakReplies: false,
      speechStatus: "idle",
    }),
    useChatRuntime: () => ({
      appendOptimisticUserMessage: vi.fn(),
      hasOlderHistory: false,
      history: {
        error: null,
        isError: false,
        isLoading: false,
      },
      loadOlderHistory: vi.fn(),
      loadingOlderHistory: false,
      runtime: {
        activeRunId: null,
        context: null,
        messageCount: mocks.rows.length,
        pendingHil: null,
        rows: mocks.rows,
        runState: "idle",
      },
    }),
    useCompactChatHistory: mutation,
    useDecideChatHil: mutation,
    useDraggableMinimizedChat: () => ({
      dragging: false,
      launcherRef: { current: null },
      onClick: vi.fn(),
      onKeyDown: vi.fn(),
      onLostPointerCapture: vi.fn(),
      onPointerCancel: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      style: {},
    }),
    useForkChatProcess: () => ({
      ...mutation(),
      mutate: mocks.forkMutate,
    }),
    useSendChatMessage: mutation,
    useSetChatProcessAiConfig: mutation,
    useSpawnChatProcess: mutation,
  };
});

vi.mock("../hooks/useChatFeedback", () => ({
  useChatFeedback: () => ({
    begin: vi.fn(),
    clear: vi.fn(),
    entries: [],
    reset: vi.fn(),
    resolve: vi.fn(),
    update: vi.fn(),
  }),
}));

import { ChatDock, requestChatBranch } from "./ChatDock";
import { ChatTranscript } from "./ChatTranscript";

function findComponent<T>(
  value: ComponentChildren,
  type: unknown,
): VNode<T> | null {
  for (const child of toChildArray(value)) {
    if (!child || typeof child !== "object" || !("props" in child)) {
      continue;
    }
    const node = child as VNode<{ children?: ComponentChildren }>;
    if (node.type === type) {
      return node as unknown as VNode<T>;
    }
    const nested = findComponent<T>(node.props.children, type);
    if (nested) {
      return nested;
    }
  }
  return null;
}

beforeEach(() => {
  mocks.forkMutate.mockReset();
});

describe("ChatDock Work branching", () => {
  it("exposes no branch affordance or proc.fork call for admin history", () => {
    const admin: ChatAgentData = {
      canStartWork: false,
      name: "Administration",
      processId: "root-work",
      role: "NO PERSONAL INTELLIGENCE",
      status: "idle",
      statusLabel: "idle",
    };
    const dock = ChatDock({
      agent: admin,
      onBackToPersonal: vi.fn(),
      onResizeStart: vi.fn(),
      onToggleMax: vi.fn(),
      onToggleOpen: vi.fn(),
      open: true,
      width: 420,
    });
    const transcript = findComponent<{
      messages: unknown[];
      onBranch?: (point: { throughMessageId: number } | { throughRunId: string }) => void;
    }>(dock, ChatTranscript);

    expect(transcript?.props.messages).toHaveLength(1);
    expect(transcript?.props.onBranch).toBeUndefined();
    expect(requestChatBranch({
      canStartNewTask: false,
      branch: { throughMessageId: 7 },
      forkPending: false,
      hasActiveProcess: true,
      mutate: mocks.forkMutate,
      processId: "root-work",
    })).toBe(false);
    expect(mocks.forkMutate).not.toHaveBeenCalled();
  });

  it("branches canonical conversation messages through their process run", () => {
    expect(requestChatBranch({
      canStartNewTask: true,
      branch: { throughRunId: "run:conversation-message" },
      forkPending: false,
      hasActiveProcess: true,
      mutate: mocks.forkMutate,
      processId: "proc:personal",
    })).toBe(true);
    expect(mocks.forkMutate).toHaveBeenCalledWith({
      pid: "proc:personal",
      throughRunId: "run:conversation-message",
    });
  });
});
