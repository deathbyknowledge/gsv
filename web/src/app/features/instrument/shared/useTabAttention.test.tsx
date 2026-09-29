import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import type { ConversationMessage } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { createTestRoot } from "../../../testing/testHarness";
import { useTabAttention } from "./useTabAttention";

const SHIP_PID = "ship";
const HELPER_PID = "helper";
const OWNER_UID = 1000;
const AGENT_UID = 1001;
const signals = new Set<Parameters<GSVClient["onSignal"]>[0]>();
/** The slice of `document` the hook touches; the tab stays hidden so every Ship message counts. */
type HiddenTab = { title: string; visibilityState: DocumentVisibilityState; hasFocus: () => boolean; querySelectorAll: () => never[]; addEventListener: () => void; removeEventListener: () => void };
let page: HiddenTab;

function status(state: GsvClientStatus["state"]): GsvClientStatus {
  return { state, url: "wss://space.example/ws", username: "hank", connectionId: null, message: null };
}

/** A `proc.list` record; the Kernel marks exactly one process as the personal one. */
function listedProcess(pid: string, personal: boolean) {
  return { pid, uid: OWNER_UID, username: "algo", label: pid, personal, interactive: true, parentPid: null,
    state: "idle", activeRunId: null, queuedCount: 0, createdAt: 1, lastActiveAt: 1, cwd: "/home/algo" };
}

/** A `message.committed` payload as the Kernel broadcasts it: a process author is the conversation's handler. */
function committed(author: ConversationMessage["author"], id: string, conversationId: string) {
  const message: ConversationMessage = { id, conversationId, sequence: 1, author, text: "Done.",
    origin: { kind: "client", clientId: "web" }, createdAt: 1 };
  return { message, directed: false };
}

beforeEach(() => {
  signals.clear();
  page = { title: "GSV", visibilityState: "hidden", hasFocus: () => false, querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.spyOn(GSVClient.prototype, "getStatus").mockImplementation(() => status("connected"));
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation((listener) => { signals.add(listener); return () => { signals.delete(listener); }; });
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "proc.list") return { data: { processes: [listedProcess(HELPER_PID, false), listedProcess(SHIP_PID, true)] } };
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mounted() {
  const root = createTestRoot("Tab attention");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  function Harness() { useTabAttention(); return null; }
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  /* the hook listens to the wire only once it knows which process is Ship */
  await vi.waitFor(() => expect(signals.size).toBe(1));
  return {
    async commit(payload: ReturnType<typeof committed>) {
      await act(() => { for (const listener of signals) listener("message.committed", payload); });
    },
    async unmount() { await root.unmount(); cache.clear(); },
  };
}

describe("tab attention on the wire", () => {
  it("leaves the tab alone when a helper process commits into its own work conversation", async () => {
    const tab = await mounted();
    try {
      await tab.commit(committed({ kind: "process", pid: HELPER_PID, uid: AGENT_UID }, "helper-1", "work:helper"));
      await tab.commit(committed({ kind: "process", pid: HELPER_PID, uid: AGENT_UID }, "helper-2", "work:helper"));
      expect(page.title).toBe("GSV");
    } finally {
      await tab.unmount();
    }
  });

  it("counts a Ship message, and not the person's own", async () => {
    const tab = await mounted();
    try {
      await tab.commit(committed({ kind: "user", uid: OWNER_UID }, "user-1", "canonical-ship"));
      expect(page.title).toBe("GSV");
      await tab.commit(committed({ kind: "process", pid: SHIP_PID, uid: AGENT_UID }, "ship-1", "canonical-ship"));
      expect(page.title).toBe("(1) GSV");
      await tab.commit(committed({ kind: "process", pid: HELPER_PID, uid: AGENT_UID }, "helper-1", "work:helper"));
      expect(page.title).toBe("(1) GSV");
    } finally {
      await tab.unmount();
    }
  });
});
