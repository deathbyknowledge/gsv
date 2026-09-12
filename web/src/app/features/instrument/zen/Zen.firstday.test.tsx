import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import type { ConversationMessage, ConversationSendArgs, ConversationSendResult, ConversationSummary } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, ComponentProps, ComponentType } from "preact";
import { act } from "preact/test-utils";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { SessionProvider } from "../../../services/session/SessionProvider";
import { createSessionService } from "../../../services/session/sessionService";
import { TerminalProvider } from "../../../services/terminal/TerminalProvider";
import { TerminalSessions } from "../../../services/terminal/terminalSessions";
import { chatConversationHistoryKey } from "../../../services/chat/hooks/useChatConversation";
import { collectNodes, collectText, createTestRoot, deferred } from "../../../testing/testHarness";
import { FirstDay } from "../firstday/FirstDay";
import { PromptLine } from "../shared/PromptLine";
import { Zen } from "./Zen";
import { ZenText } from "./ZenText";

let storage: Map<string, string>;
let messages: ConversationMessage[];
let hasMore: boolean;
let ownerUid: number;
let gateway: string;
let shipPid: string;
const signals = new Set<Parameters<GSVClient["onSignal"]>[0]>();
const statuses = new Set<Parameters<GSVClient["onStatus"]>[0]>();
const send = vi.fn<(args: ConversationSendArgs) => Promise<ConversationSendResult>>();
const sendArgs = z.object({ conversationId: z.string(), text: z.string(), selectedTarget: z.string().optional(), idempotencyKey: z.string() });

function conversation(pid = shipPid): ConversationSummary {
  return { id: "canonical-ship", kind: "ship", ownerUid, title: null, handlerPid: pid,
    latestSequence: messages.length, createdAt: 1, updatedAt: 1 };
}
function message(kind: "user" | "process", text = "Your machine is online.", sequence = 1): ConversationMessage {
  return { id: `${kind}-${sequence}`, conversationId: "canonical-ship", sequence,
    author: kind === "user" ? { kind, uid: ownerUid } : { kind, pid: shipPid, uid: 1001 },
    text, origin: { kind: "client", clientId: "web" }, createdAt: sequence };
}
function status(state: GsvClientStatus["state"]): GsvClientStatus {
  return { state, url: gateway, username: "hank", connectionId: null, message: null };
}

beforeEach(() => {
  storage = new Map();
  messages = [];
  hasMore = false;
  ownerUid = 1000;
  gateway = "wss://space.example/ws";
  shipPid = "ship";
  signals.clear();
  statuses.clear();
  send.mockReset();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    location: { protocol: "https:", host: "space.example" },
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  vi.spyOn(GSVClient.prototype, "getStatus").mockImplementation(() => status("connected"));
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation((listener) => { statuses.add(listener); return () => { statuses.delete(listener); }; });
  vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation((listener) => { signals.add(listener); return () => { signals.delete(listener); }; });
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "proc.list") return { data: { processes: [{ pid: shipPid, uid: ownerUid, username: "algo", label: "ship",
      personal: true, interactive: true, parentPid: null, state: "idle", activeRunId: null, queuedCount: 0,
      createdAt: 1, lastActiveAt: 1, cwd: "/home/algo" }] } };
    if (call === "sys.target.list") return { data: { targets: [] } };
    if (call === "conversation.forProcess") return { data: { conversation: conversation(z.object({ pid: z.string() }).parse(args).pid) } };
    if (call === "conversation.history") return { data: { conversation: conversation(), messages, hasMore } };
    if (call === "proc.history") return { data: { ok: true, pid: z.object({ pid: z.string() }).parse(args).pid,
      format: 2, records: [], messages: [], messageCount: 0, cursor: "epoch:1", hasMore: false,
      historyRevision: 1, historyGeneration: 1, historyResetRevision: 0 } };
    if (call === "proc.observe" || call === "proc.unobserve") return { data: { ok: true, pid: shipPid } };
    if (call === "conversation.send") return { data: await send(sendArgs.parse(args)) };
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountedZen(pid?: string) {
  const root = createTestRoot("Zen first day");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let tree: ComponentChildren;
  function Harness() { tree = Zen({ pid, onFleet: () => {} }); return null; }
  const render = () => root.render(<GatewayProvider><SessionProvider createService={(client) => {
    const service = createSessionService(client);
    return { ...service, start: async () => {}, subscribe: () => () => {},
      snapshot: () => ({ ...service.snapshot(), url: gateway, username: "hank" }) };
  }}><TerminalProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></TerminalProvider></SessionProvider></GatewayProvider>);
  await render();
  const firstDay = () => collectNodes(tree).some((entry) => entry.type === FirstDay);
  await vi.waitFor(() => expect(firstDay() || collectText(tree).includes("setup") || collectText(tree).includes("This helper")).toBe(true));
  await render();
  const props = <P,>(component: ComponentType<P>): P => {
    const node = collectNodes(tree).find((entry) => entry.type === component);
    if (!node) throw new Error(`Missing ${component.name}`);
    // SAFETY: The VNode was selected by the exact component whose props type P describes.
    return node.props as P;
  };
  return { render, firstDay, props, text: () => collectText(tree),
    async unmount() { await root.unmount(); cache.clear(); },
    async refreshHistory() { await act(async () => { await cache.invalidateQueries({ queryKey: chatConversationHistoryKey("canonical-ship") }); }); },
    setup: () => collectNodes(tree).find((entry) => entry.type === "button" && collectText(entry) === "setup")?.props.onClick?.(),
  };
}

describe("Zen first-day ownership", () => {
  it("keeps setup through a machine reply, more pages, reconnect and refresh", async () => {
    let zen = await mountedZen();
    try {
      expect(zen.firstDay()).toBe(true);
      expect([...storage.values()]).toEqual(["setup"]);
      const reply = message("process");
      await act(() => { for (const listener of signals) listener("message.committed", { message: { ...reply, author: { kind: "process", pid: shipPid, uid: 1001 } }, directed: true }); });
      expect(zen.firstDay()).toBe(true);
      expect(zen.props(FirstDay).onConversation).toBeTypeOf("function");
      messages = Array.from({ length: 50 }, (_, index) => message("process", "Background activity", index + 1));
      hasMore = true;
      await zen.refreshHistory();
      await act(() => { for (const listener of statuses) listener(status("disconnected")); });
      await act(() => { for (const listener of statuses) listener(status("connected")); });
      expect(zen.firstDay()).toBe(true);
      await zen.unmount();
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(true);
    } finally { await zen.unmount(); }
  });

  it("opens the conversation for a human message committed by another client and remembers it beyond the loaded page", async () => {
    let zen = await mountedZen();
    try {
      expect(zen.firstDay()).toBe(true);
      const remote = message("user", "Hello from my other browser");
      await act(() => { for (const listener of signals) listener("message.committed", { message: { ...remote, author: { kind: "user", uid: ownerUid } }, directed: false }); });
      await vi.waitFor(() => expect(zen.firstDay()).toBe(false));
      expect(zen.props(ZenText).text).toBe(remote.text);
      expect(send).not.toHaveBeenCalled();
      expect([...storage.values()]).toEqual(["conversation"]);
      await zen.unmount();
      messages = Array.from({ length: 50 }, (_, index) => message("process", "Later background activity", index + 2));
      hasMore = true;
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("finishes persisted initial setup when human history arrives while this browser is closed", async () => {
    let zen = await mountedZen();
    try {
      expect(zen.firstDay()).toBe(true);
      await zen.unmount();
      messages = [message("user", "Hello from my phone")];
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(false);
      expect(zen.props(ZenText).text).toBe("Hello from my phone");
      expect([...storage.values()]).toEqual(["conversation"]);
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("keeps an explicit return to setup through synchronized human messages and reload", async () => {
    messages = [message("user", "My first question")];
    let zen = await mountedZen();
    try {
      expect(zen.firstDay()).toBe(false);
      await act(() => { zen.setup(); });
      expect(zen.firstDay()).toBe(true);
      const remote = message("user", "A follow-up from my other browser", 2);
      await act(() => { for (const listener of signals) listener("message.committed", { message: { ...remote, author: { kind: "user", uid: ownerUid } }, directed: false }); });
      expect(zen.firstDay()).toBe(true);
      await zen.unmount();
      messages = [...messages, remote];
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(true);
      await act(() => { zen.props(FirstDay).onConversation?.(); });
      expect(zen.firstDay()).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("remembers intentional leave/resume across reload and Process replacement, scoped to owner and gateway", async () => {
    messages = [message("process")];
    let zen = await mountedZen();
    try {
      await act(() => { zen.props(FirstDay).onConversation?.(); });
      expect(zen.firstDay()).toBe(false);
      await zen.unmount();
      shipPid = "replacement";
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(false);
      await act(() => { zen.setup(); });
      expect(zen.firstDay()).toBe(true);
      await zen.unmount();
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(true);
      await act(() => { zen.props(FirstDay).onConversation?.(); });
      await zen.unmount();
      ownerUid = 2000;
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(true);
      await act(() => { zen.props(FirstDay).onConversation?.(); });
      await zen.unmount();
      gateway = "wss://another-space.example/ws";
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(true);
    } finally { await zen.unmount(); }
  });

  it("keeps existing or paginated conversations in chat and never shows setup for helpers", async () => {
    messages = [message("process")];
    hasMore = true;
    let zen = await mountedZen();
    try {
      expect(zen.firstDay()).toBe(false);
      expect(zen.text()).toContain("setup");
      await zen.unmount();
      hasMore = false;
      messages = [message("user", "Hello")];
      zen = await mountedZen();
      expect(zen.firstDay()).toBe(false);
      await zen.unmount();
      messages = [];
      zen = await mountedZen("helper");
      expect(zen.firstDay()).toBe(false);
      expect(zen.text()).not.toContain("setup");
    } finally { await zen.unmount(); }
  });

  it("sends the visible welcome request through ordinary conversation.send and exits only after acceptance", async () => {
    const accepted = deferred<ConversationSendResult>();
    send.mockReturnValue(accepted.promise);
    const zen = await mountedZen();
    try {
      await act(() => { zen.props(FirstDay).onMeet(); });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "canonical-ship",
        text: "Hi! Introduce yourself and help me get started with GSV.", idempotencyKey: expect.any(String) }));
      expect(zen.firstDay()).toBe(true);
      expect(zen.props(FirstDay).meetDisabled).toBe(true);
      expect([...storage.values()]).toEqual(["setup"]);
      await act(async () => { accepted.resolve({ message: message("user", "Hi! Introduce yourself and help me get started with GSV."), handlerPid: shipPid, runId: "welcome" }); await accepted.promise; });
      await vi.waitFor(() => expect(zen.firstDay()).toBe(false));
      expect(zen.props(ZenText).text).toBe("Hi! Introduce yourself and help me get started with GSV.");
      expect([...storage.values()]).toEqual(["conversation"]);
    } finally { await zen.unmount(); }
  });

  it("retains setup after a failed send and protects a draft from the welcome action", async () => {
    send.mockRejectedValue(new Error("The message did not go through."));
    const zen = await mountedZen();
    try {
      await act(async () => { zen.props(FirstDay).onMeet(); });
      await vi.waitFor(() => expect(zen.text()).toContain("The message did not go through."));
      expect(zen.firstDay()).toBe(true);
      expect([...storage.values()]).toEqual(["setup"]);
      expect(zen.text()).toContain("The message did not go through.");
      const prompt = () => zen.props<ComponentProps<typeof PromptLine>>(PromptLine);
      await act(() => { prompt().onInput?.("My unsent question"); });
      expect(zen.props(FirstDay).meetDisabled).toBe(true);
      expect(zen.props(FirstDay).hasDraft).toBe(true);
      await act(() => { zen.props(FirstDay).onMeet(); });
      expect(send).toHaveBeenCalledTimes(1);
      send.mockResolvedValue({ message: message("user", "My unsent question"), handlerPid: shipPid, runId: "typed" });
      await act(async () => { await prompt().onSubmit("My unsent question"); });
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: "My unsent question" }));
      expect(zen.firstDay()).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("protects attachments and text typed while the welcome send is pending", async () => {
    const accepted = deferred<ConversationSendResult>();
    send.mockReturnValue(accepted.promise);
    const zen = await mountedZen();
    try {
      await act(() => { zen.props<ComponentProps<typeof PromptLine>>(PromptLine).onFiles?.([new File(["draft"], "draft.txt", { type: "text/plain" })]); });
      expect(zen.props(FirstDay).meetDisabled).toBe(true);
      await act(() => { zen.props(FirstDay).onMeet(); });
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
    const fresh = await mountedZen();
    try {
      await act(() => { fresh.props(FirstDay).onMeet(); });
      await act(() => { fresh.props<ComponentProps<typeof PromptLine>>(PromptLine).onInput?.("My next question"); });
      await act(async () => { accepted.resolve({ message: message("user", "Welcome request"), handlerPid: shipPid, runId: "welcome" }); await accepted.promise; });
      await vi.waitFor(() => expect(fresh.firstDay()).toBe(false));
      await act(() => { fresh.setup(); });
      expect(fresh.props(FirstDay).hasDraft).toBe(true);
      expect(fresh.props(FirstDay).meetDisabled).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await fresh.unmount(); }
  });

  it("leaves setup for an intentional direct command after its start succeeds", async () => {
    const start = vi.spyOn(TerminalSessions.prototype, "start");
    const zen = await mountedZen();
    try {
      start.mockImplementationOnce(() => { throw new Error("Could not save the command."); });
      await act(async () => { await zen.props<ComponentProps<typeof PromptLine>>(PromptLine).onSubmit("$ pwd"); });
      expect(zen.firstDay()).toBe(true);
      start.mockReturnValue("terminal-session");
      await act(async () => { await zen.props<ComponentProps<typeof PromptLine>>(PromptLine).onSubmit("$ pwd"); });
      expect(zen.firstDay()).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });
});
