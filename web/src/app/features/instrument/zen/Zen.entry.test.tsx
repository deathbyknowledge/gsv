import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import type { ConversationMessage, ConversationSendArgs, ConversationSendResult, ConversationSummary, ProcContextState } from "@humansandmachines/gsv/protocol";
import { conversationSendMessageId } from "@humansandmachines/gsv/protocol/stable-id";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, ComponentProps, ComponentType } from "preact";
import { act } from "preact/test-utils";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { SessionProvider } from "../../../services/session/SessionProvider";
import { createSessionService } from "../../../services/session/sessionService";
import { TerminalProvider } from "../../../services/terminal/TerminalProvider";
import { chatConversationHistoryKey } from "../../../services/chat/hooks/useChatConversation";
import { collectNodes, collectText, createTestRoot, deferred } from "../../../testing/testHarness";
import { PromptLine, type PromptLineHandle } from "../shared/PromptLine";
import { NativeVoiceControls } from "../../../services/platform/NativeVoiceControls";
import { Zen } from "./Zen";
import { ZenText } from "./ZenText";

let storage: Map<string, string>;
let messages: ConversationMessage[];
let hasMore: boolean;
let ownerUid: number;
let gateway: string;
let shipPid: string;
let activeRunId: string | null;
let runContext: ProcContextState | null;
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
  activeRunId = null;
  runContext = null;
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
    if (call === "sys.config.get") return { data: { entries: [] } };
    if (call === "account.list") return { data: { accounts: [] } };
    if (call === "conversation.forProcess") return { data: { conversation: conversation(z.object({ pid: z.string() }).parse(args).pid) } };
    if (call === "conversation.history") return { data: { conversation: conversation(), messages, hasMore } };
    if (call === "proc.history") return { data: { ok: true, pid: z.object({ pid: z.string() }).parse(args).pid,
      format: 2, records: [], messages: [], messageCount: 0, cursor: "epoch:1", hasMore: false,
      activeRunId, context: runContext, contextRevision: runContext?.revision ?? 0,
      historyRevision: 1, historyGeneration: 1, historyResetRevision: 0 } };
    if (call === "proc.observe" || call === "proc.unobserve") return { data: { ok: true, pid: shipPid } };
    if (call === "conversation.send") return { data: await send(sendArgs.parse(args)) };
    if (call === "shell.exec") return { data: { status: "completed", output: "/home/algo\n", stderr: "", exitCode: 0 } };
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountedZen(pid?: string, initialTarget?: string) {
  const root = createTestRoot("Zen entry");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let tree: ComponentChildren;
  const draftChange = vi.fn();
  const onFleet = vi.fn();
  function Harness() { tree = Zen({ pid, initialTarget, onFleet, onDraftChange: draftChange }); return null; }
  const render = () => root.render(<GatewayProvider><SessionProvider createService={(client) => {
    const service = createSessionService(client);
    return { ...service, start: async () => {}, subscribe: () => () => {},
      snapshot: () => ({ ...service.snapshot(), url: gateway, username: "hank" }) };
  }}><TerminalProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></TerminalProvider></SessionProvider></GatewayProvider>);
  await render();
  await vi.waitFor(() => expect(collectNodes(tree).some((entry) => entry.type === PromptLine && entry.props.disabled === false)).toBe(true));
  await render();
  const props = <P,>(component: ComponentType<P>): P => {
    const node = collectNodes(tree).find((entry) => entry.type === component);
    if (!node) throw new Error(`Missing ${component.name}`);
    // SAFETY: The VNode was selected by the exact component whose props type P describes.
    return node.props as P;
  };
  return { render, props, onFleet, text: () => collectText(tree), dirty: () => draftChange.mock.lastCall?.[0] === true,
    nodes: () => collectNodes(tree),
    async unmount() { await root.unmount(); cache.clear(); },
    async refreshHistory() { await act(async () => { await cache.invalidateQueries({ queryKey: chatConversationHistoryKey("canonical-ship") }); }); },
  };
}

describe("Zen conversation entry", () => {
  it("selects the next send's place and returns focus without discarding the draft", async () => {
    send.mockReturnValue(deferred<ConversationSendResult>().promise);
    const zen = await mountedZen(undefined, "laptop");
    try {
      const prompt = () => zen.props(PromptLine);
      const focus = vi.fn();
      const setValue = vi.fn();
      const input: PromptLineHandle = {
        disabled: false, chip: null, focus, setValue,
        selection: () => ({ value: "Keep this draft", start: 15, end: 15 }),
        append: vi.fn(), blur: vi.fn(), submit: vi.fn(),
      };
      zen.props(NativeVoiceControls).prompt.current = input;
      await act(() => { prompt().onInput?.("Keep this draft"); });
      const cloud = () => zen.nodes().find((node) => node.type === "button"
        && node.props["aria-label"] === "Use your cloud for the next message or command")!;
      await act(() => { cloud().props.onClick!(); });
      expect(focus).toHaveBeenCalledOnce();
      expect(setValue).not.toHaveBeenCalled();
      expect(prompt().place.id).toBe("gsv");
      expect(prompt().showPlace).toBe(false);
      expect(zen.dirty()).toBe(true);
      expect(zen.onFleet).not.toHaveBeenCalled();
      await act(() => { prompt().onSubmit("Keep this draft"); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
        text: "Keep this draft", selectedTarget: "gsv",
      })));
    } finally { await zen.unmount(); }
  });

  it.each([
    { target: "gsv", readiness: "your cloud ready", status: "completed", queuedCount: 0 },
    { target: "laptop", readiness: "laptop offline", status: "aborted", queuedCount: 1 },
  ])("shows run feedback before streaming and clears it when $status", async ({ target, readiness, status, queuedCount }) => {
    runContext = {
      revision: 1, runId: "previous-run", provider: "openai", model: "previous-model",
      contextWindowTokens: 1000, maxOutputTokens: 100, estimatedInputTokens: 100,
      inputTokens: 100, confirmedInputTokens: 100, estimatedTrailingInputTokens: 0,
      inputBudgetTokens: 900, remainingInputTokens: 800, availableInputTokens: 900,
      pressure: 0.1, level: "ok", source: "estimate", updatedAt: 1,
    };
    send.mockResolvedValueOnce({ message: message("user", "Keep working"), handlerPid: shipPid, runId: "active-run" });
    const zen = await mountedZen(undefined, target);
    const text = () => zen.text().replace(/\s+/g, " ");
    try {
      expect(text()).not.toContain(readiness);
      expect(text()).not.toContain("attempting");
      await act(() => { zen.props(PromptLine).onSubmit("Keep working"); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.props["aria-label"] === "Sending message")).toBe(false));

      activeRunId = "active-run";
      await act(() => { for (const listener of signals) listener("proc.run.started", { pid: shipPid, runId: activeRunId }); });
      await vi.waitFor(() => expect(text()).toContain(readiness));
      expect(text()).not.toContain("previous-model");

      runContext = { ...runContext, revision: 2, runId: activeRunId, model: "active-model", updatedAt: 2 };
      await act(() => { for (const listener of signals) listener("proc.changed", { pid: shipPid, changes: ["context"], context: runContext }); });
      await vi.waitFor(() => expect(text()).toContain("attempting active-model"));
      expect(text()).toContain(readiness);

      activeRunId = null;
      await act(() => { for (const listener of signals) listener("proc.run.finished", { pid: shipPid, runId: "active-run", status, queuedCount }); });
      await vi.waitFor(() => expect(text()).not.toContain(readiness));
      expect(text()).not.toContain("attempting");
    } finally { await zen.unmount(); }
  });

  it.each(["$ pwd", "!pwd"])("routes a finalized native %s prompt to the terminal without sending it to Ship", async (text) => {
    const zen = await mountedZen();
    try {
      await act(() => { expect(zen.props(NativeVoiceControls).send(text)).toBe(true); });
      await vi.waitFor(() => expect(vi.mocked(GSVClient.prototype.request).mock.calls.some(([call, args]) =>
        call === "shell.exec" && z.object({ input: z.literal("pwd") }).safeParse(args).success,
      )).toBe(true));
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("switches the place for a native @ prompt and reports an unknown place without sending either to Ship", async () => {
    const zen = await mountedZen(undefined, "laptop");
    try {
      await vi.waitFor(() => expect(zen.props(PromptLine).place.id).toBe("laptop"));
      await act(() => { expect(zen.props(NativeVoiceControls).send("@cloud")).toBe(true); });
      expect(zen.props(PromptLine).place.id).toBe("gsv");
      await act(() => { zen.props(NativeVoiceControls).send("@missing"); });
      expect(zen.text()).toContain("No place called missing.");
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("rejects native commands with attachments instead of submitting a chat message", async () => {
    const zen = await mountedZen();
    try {
      await act(() => { zen.props(PromptLine).onFiles?.([new File(["fixture"], "note.txt", { type: "text/plain" })]); });
      for (const text of ["$ pwd", "$", "!"]) {
        await act(() => { expect(zen.props(NativeVoiceControls).send(text)).toBe(false); });
      }
      expect(zen.props(PromptLine).allowEmpty).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(vi.mocked(GSVClient.prototype.request).mock.calls.some(([call]) => call === "shell.exec")).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("sends ordinary native text through the conversation outbox", async () => {
    send.mockResolvedValueOnce({ message: message("user", "Hello from voice"), handlerPid: shipPid, runId: "voice" });
    const zen = await mountedZen();
    try {
      await act(() => { expect(zen.props(NativeVoiceControls).send("Hello from voice")).toBe(true); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send.mock.calls[0]?.[0].text).toBe("Hello from voice");
    } finally { await zen.unmount(); }
  });

  it("opens a fresh Ship at the ordinary composer without sending a message", async () => {
    const zen = await mountedZen();
    try {
      await vi.waitFor(() => expect(zen.text()).toContain("What would you like to do?"));
      expect(zen.props<ComponentProps<typeof PromptLine>>(PromptLine).disabled).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect([...storage.values()]).toEqual([]);
    } finally { await zen.unmount(); }
  });

  it("shows existing messages immediately, including messages from Ship", async () => {
    messages = [message("process", "Your machine is online.")];
    const zen = await mountedZen();
    try {
      await vi.waitFor(() => expect(zen.props(ZenText).text).toBe("Your machine is online."));
      expect(zen.text()).not.toContain("What would you like to do?");
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("synchronizes another client's message without consuming the current draft", async () => {
    const zen = await mountedZen();
    try {
      await act(() => { zen.props<ComponentProps<typeof PromptLine>>(PromptLine).onInput?.("My unsent question"); });
      const remote = message("user", "Hello from my phone");
      await act(() => { for (const listener of signals) listener("message.committed", { message: { ...remote, author: { kind: "user", uid: ownerUid } }, directed: false }); });
      await vi.waitFor(() => expect(zen.props(ZenText).text).toBe(remote.text));
      expect(zen.dirty()).toBe(true);
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("shows the first question before acknowledgement and reconciles an early commit exactly once", async () => {
    const accepted = deferred<ConversationSendResult>();
    send.mockReturnValue(accepted.promise);
    const zen = await mountedZen();
    try {
      const prompt = () => zen.props<ComponentProps<typeof PromptLine>>(PromptLine);
      await act(() => { expect(prompt().onSubmit("Help me plan my week")).toBe(true); });
      expect(zen.props(ZenText).text).toBe("Help me plan my week");
      expect(zen.nodes().some((node) => node.props["aria-label"] === "Sending message")).toBe(true);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "canonical-ship",
        text: "Help me plan my week", idempotencyKey: expect.any(String) }));
      await act(() => { prompt().onInput?.("My next question"); });
      const committed = { ...message("user", "Help me plan my week"),
        id: await conversationSendMessageId("canonical-ship", send.mock.calls[0]![0].idempotencyKey!) };
      await act(() => { for (const listener of signals) listener("message.committed", { message: committed, directed: false }); });
      expect(zen.nodes().filter((node) => node.type === ZenText)).toHaveLength(1);
      expect(zen.nodes().some((node) => node.props["aria-label"] === "Sending message")).toBe(true);
      await act(async () => { accepted.resolve({ message: committed, handlerPid: shipPid, runId: "first-question" }); await accepted.promise; });
      await vi.waitFor(() => expect(zen.props(ZenText).text).toBe("Help me plan my week"));
      expect(zen.dirty()).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(zen.nodes().filter((node) => node.type === ZenText)).toHaveLength(1);
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.props["aria-label"] === "Sending message")).toBe(false));
    } finally { await zen.unmount(); }
  });

  it("keeps a failed first message available to retry", async () => {
    send.mockRejectedValueOnce(new Error("The message did not go through."));
    const zen = await mountedZen();
    try {
      const prompt = () => zen.props<ComponentProps<typeof PromptLine>>(PromptLine);
      await act(() => { prompt().onInput?.("My first question"); });
      await act(() => { expect(prompt().onSubmit("My first question")).toBe(true); prompt().onInput?.(""); });
      await vi.waitFor(() => expect(zen.text()).toContain("The message did not go through."));
      expect(zen.props(ZenText).text).toBe("My first question");
      expect(zen.dirty()).toBe(true);
      await act(() => { prompt().onInput?.("A different draft"); });
      send.mockResolvedValueOnce({ message: message("user", "My first question"), handlerPid: shipPid, runId: "retry" });
      const retry = zen.nodes().find((node) => node.type === "button" && collectText(node) === "retry");
      expect(retry).toBeDefined();
      await act(() => { retry!.props.onClick?.(); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.props["aria-label"] === "Sending message")).toBe(false));
      expect(send.mock.calls[1]?.[0].idempotencyKey).toBe(send.mock.calls[0]?.[0].idempotencyKey);
      expect(zen.props(ZenText).text).toBe("My first question");
      expect(zen.dirty()).toBe(true);
      expect(zen.nodes().filter((node) => node.type === ZenText)).toHaveLength(1);
    } finally { await zen.unmount(); }
  });

  it("keeps an identical message from another client separate from a pending send", async () => {
    const accepted = deferred<ConversationSendResult>();
    send.mockReturnValue(accepted.promise);
    const zen = await mountedZen();
    try {
      await act(() => { zen.props(PromptLine).onSubmit("Continue"); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const remote = { ...message("user", "Continue"), createdAt: Date.now(), origin: { kind: "client" as const, clientId: "phone" } };
      await act(() => { for (const listener of signals) listener("message.committed", { message: remote, directed: false }); });
      expect(zen.nodes().filter((node) => node.type === ZenText)).toHaveLength(2);
      const local = { ...message("user", "Continue", 2),
        id: await conversationSendMessageId("canonical-ship", send.mock.calls[0]![0].idempotencyKey!) };
      await act(async () => { accepted.resolve({ message: local, handlerPid: shipPid, runId: "local" }); await accepted.promise; });
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.props["aria-label"] === "Sending message")).toBe(false));
      expect(zen.nodes().filter((node) => node.type === ZenText)).toHaveLength(2);
    } finally { await zen.unmount(); }
  });

  it("keeps helper conversations on their own empty state", async () => {
    const zen = await mountedZen("helper");
    try {
      await vi.waitFor(() => expect(zen.text()).toContain("This helper has no messages yet."));
      expect(zen.text()).not.toContain("What would you like to do?");
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });
});
