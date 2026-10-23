import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import type { ConversationMessage, ConversationSendArgs, ConversationSendResult, ConversationSummary, ProcContextState, ProcHilArgs, ProcHistoryRecord, SysTargetSummary } from "@humansandmachines/gsv/protocol";
import { resourceBlockSchema } from "@humansandmachines/gsv/protocol";
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
import { BrowserVoiceControls } from "../../../services/platform/BrowserVoiceControls";
import { NativeInputProvider, type NativeInput } from "../../../services/platform/PlatformProvider";
import { Zen } from "./Zen";
import { BrowserRequests } from "../browser/BrowserControl";
import { ChatPanels } from "./ChatPanels";
import { ZenText } from "./ZenText";
import { ThinkingMark } from "./ThinkingMark";
import { WakingUp } from "./WakingUp";
import { ApprovalCard } from "../shared/ApprovalCard";
import { ConversationSearch } from "../shared/ConversationSearch";
import { ZenDraftPaste } from "./ZenMedia";
import { FeedbackNote } from "./ZenNotes";

let storage: Map<string, string>;
let messages: ConversationMessage[];
let targets: SysTargetSummary[];
let targetsReady: Promise<void> | null;
let hasMore: boolean;
let historyUnavailable: boolean;
let ownerUid: number;
let gateway: string;
let shipPid: string;
let activeRunId: string | null;
let runContext: ProcContextState | null;
let processRecords: ProcHistoryRecord[];
const signals = new Set<Parameters<GSVClient["onSignal"]>[0]>();
const statuses = new Set<Parameters<GSVClient["onStatus"]>[0]>();
const send = vi.fn<(args: ConversationSendArgs) => Promise<ConversationSendResult>>();
const sendArgs = z.strictObject({ conversationId: z.string(), text: z.string(), media: z.array(resourceBlockSchema).optional(), selectedTarget: z.string().optional(), idempotencyKey: z.string() });

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
  targets = [];
  targetsReady = null;
  hasMore = false;
  historyUnavailable = false;
  ownerUid = 1000;
  gateway = "wss://space.example/ws";
  shipPid = "ship";
  activeRunId = null;
  runContext = null;
  processRecords = [];
  signals.clear();
  statuses.clear();
  send.mockReset();
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
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
    if (call === "sys.target.list") { await targetsReady; return { data: { targets } }; }
    if (call === "sys.config.get") return { data: { entries: [] } };
    if (call === "account.list") return { data: { accounts: [] } };
    if (call === "conversation.forProcess") return { data: { conversation: conversation(z.object({ pid: z.string() }).parse(args).pid) } };
    if (call === "conversation.history") {
      if (historyUnavailable) throw new Error("history unavailable");
      return { data: { conversation: conversation(), messages, hasMore } };
    }
    if (call === "proc.history") return { data: { ok: true, pid: z.object({ pid: z.string() }).parse(args).pid,
      format: 2, records: processRecords, messages: [], messageCount: processRecords.length, cursor: "epoch:1", hasMore: false,
      activeRunId, context: runContext, contextRevision: runContext?.revision ?? 0,
      historyRevision: 1, historyGeneration: 1, historyResetRevision: 0 } };
    if (call === "proc.observe" || call === "proc.unobserve") return { data: { ok: true, pid: shipPid } };
    if (call === "proc.hil") return { data: { ok: true, pid: shipPid, ...args, resumed: true } };
    if (call === "conversation.send") return { data: await send(sendArgs.parse(args)) };
    if (call === "shell.exec") return { data: { status: "completed", output: "/home/algo\n", stderr: "", exitCode: 0 } };
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountedZen(pid?: string, initialTarget?: string, native = false, searchRequested = false, welcomeOpen = false) {
  const root = createTestRoot("Zen entry");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let tree: ComponentChildren;
  const draftChange = vi.fn();
  const onFleet = vi.fn();
  const input: NativeInput = {
    subscribe: () => { throw new Error("Zen entry tests inspect controls without mounting them"); },
    acknowledge: async () => {}, command: async () => {},
  };
  const searchHandled = vi.fn();
  function Harness() { tree = Zen({ pid, initialTarget, onFleet, onDraftChange: draftChange, searchRequested, onSearchRequestHandled: searchHandled, welcomeOpen }); return null; }
  const render = () => root.render(<GatewayProvider><SessionProvider createService={(client) => {
    const service = createSessionService(client);
    return { ...service, start: async () => {}, subscribe: () => () => {},
      snapshot: () => ({ ...service.snapshot(), url: gateway, username: "hank" }) };
  }}><TerminalProvider><QueryClientProvider client={cache}>
    {native ? <NativeInputProvider input={input}><Harness /></NativeInputProvider> : <Harness />}
  </QueryClientProvider></TerminalProvider></SessionProvider></GatewayProvider>);
  await render();
  await vi.waitFor(() => expect(collectNodes(tree).some((entry) => entry.type === PromptLine && entry.props.disabled === false)).toBe(true));
  await render();
  const props = <P,>(component: ComponentType<P>): P => {
    const node = collectNodes(tree).find((entry) => entry.type === component);
    if (!node) throw new Error(`Missing ${component.name}`);
    // SAFETY: The VNode was selected by the exact component whose props type P describes.
    return node.props as P;
  };
  return { render, props, onFleet, searchHandled, text: () => collectText(tree), dirty: () => draftChange.mock.lastCall?.[0] === true,
    nodes: () => collectNodes(tree),
    async unmount() { await root.unmount(); cache.clear(); },
    async refreshHistory() { await act(async () => { await cache.invalidateQueries({ queryKey: chatConversationHistoryKey("canonical-ship") }); }); },
  };
}

describe("Zen conversation entry", () => {
  it.each([
    ["create a routine", "Help me create a routine."],
    ["connect a computer", "Help me connect a computer to my Ship."],
    ["start a browser", "Start a browser for me."],
  ])("stages %s as editable text and sends only the edited message", async (label, request) => {
    const zen = await mountedZen();
    try {
      const setValue = vi.fn();
      zen.props(BrowserVoiceControls).prompt.current = {
        focus: vi.fn(), setValue,
        selection: () => ({ value: "$30 is my daily budget", start: 0, end: 0 }),
      };
      const option = zen.nodes().find((node) => node.type === "button" && node.props.role === "menuitem" && collectText(node).includes(label))!;
      await act(() => option.props.onClick!());
      expect(send).not.toHaveBeenCalled();
      expect(setValue).toHaveBeenCalledWith(`${request}\n\n$30 is my daily budget`);
      expect(zen.props(PromptLine).allowEmpty).toBe(false);
      const text = "Actually, just explain the options.\n\n$30 is my daily budget";
      const committed = message("user", text);
      send.mockResolvedValueOnce({ message: committed, handlerPid: shipPid, runId: "run:request" });
      await act(() => { zen.props(PromptLine).onSubmit(text); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith({
        conversationId: "canonical-ship", text, selectedTarget: "gsv", idempotencyKey: expect.any(String),
      }));
      await act(() => { for (const listener of signals) listener("message.committed", { message: committed, directed: true }); });
      expect(zen.props(ZenText).text).toBe(text);
      await act(() => zen.props(PromptLine).onHistory?.(-1));
      expect(setValue).toHaveBeenLastCalledWith(text);
      messages = [committed];
      await zen.refreshHistory();
      expect(zen.props(ZenText).text).toBe(text);
    } finally { await zen.unmount(); }
  });

  it("keeps contextual references in the editable draft without hidden send state", async () => {
    const zen = await mountedZen();
    try {
      const setValue = vi.fn();
      zen.props(BrowserVoiceControls).prompt.current = {
        focus: vi.fn(), setValue, selection: () => ({ value: "My existing draft", start: 0, end: 0 }),
      };
      await act(() => zen.props(PromptLine).onFiles?.([new File(["note"], "note.txt", { type: "text/plain" })]));
      for (const text of [
        'Help me with the responsibility "A task" (r12y:1).',
        'Help me with the routine "Morning" (routine:1).',
        "Help me with Ada's Ship profile: https://ada.gsv.space/profile",
        "Use this file as context: @gsv /home/ada/notes.txt",
      ]) {
        await act(() => zen.props(ChatPanels).onAsk(text));
        expect(setValue).toHaveBeenLastCalledWith(`${text}\n\nMy existing draft`);
        expect(zen.props(PromptLine).allowEmpty).toBe(true);
        expect(zen.dirty()).toBe(true);
      }
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it.each([false, true])("selects browser recording or native dictation for the active platform: native=%s", async (native) => {
    const zen = await mountedZen("helper", undefined, native);
    try {
      expect(zen.nodes().some((node) => node.type === NativeVoiceControls)).toBe(native);
      expect(zen.nodes().some((node) => node.type === BrowserVoiceControls)).toBe(!native);
      if (!native) {
        expect(zen.props(BrowserVoiceControls).pid).toBe("helper");
        expect(zen.props(BrowserVoiceControls).enabled).toBe(true);
      }
    } finally { await zen.unmount(); }
  });

  it.each([false, true])("keeps voice input scoped to the default place while targets load: native=%s", async (native) => {
    const pendingTargets = deferred<void>();
    targetsReady = pendingTargets.promise;
    targets = [{ targetId: "laptop", label: "Laptop", online: true, implements: ["shell.exec"], platform: "linux",
      ownerUid: 1000, ownerUsername: "hank", description: "", version: "0.6.2", lastSeenAt: 1 }];
    const zen = await mountedZen(undefined, undefined, native);
    const voice = () => native ? zen.props(NativeVoiceControls) : zen.props(BrowserVoiceControls);
    try {
      expect(voice().enabled).toBe(true);
      expect(zen.props(PromptLine).place.id).toBe("gsv");
      const initialScope = voice().scope;
      const placeButton = (name: string) => zen.nodes().find((node) => node.type === "button"
        && node.props["aria-label"] === `Use ${name} for the next message or command`);

      expect(placeButton("Laptop")).toBeUndefined();
      await act(async () => { pendingTargets.resolve(); });
      await vi.waitFor(() => expect(placeButton("Laptop")).toBeDefined());
      expect(voice().enabled).toBe(true);
      expect(voice().scope).toBe(initialScope);

      await act(() => { placeButton("Laptop")!.props.onClick!(); });
      expect(zen.props(PromptLine).place.id).toBe("laptop");
      expect(voice().scope).not.toBe(initialScope);
      await act(() => { placeButton("Ship’s home")!.props.onClick!(); });
      expect(voice().scope).toBe(initialScope);
    } finally { await zen.unmount(); }
  });

  it.each([undefined, "helper"])("keeps browser requests on Ship after its process loads, with selection %s", async pid => {
    const zen = await mountedZen(pid);
    try {
      expect(zen.nodes().some(node => node.type === BrowserRequests)).toBe(pid === undefined);
    } finally { await zen.unmount(); }
  });

  it("opens conversation search requested from the header", async () => {
    const zen = await mountedZen(undefined, undefined, false, true);
    try {
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.type === ConversationSearch)).toBe(true));
      expect(zen.searchHandled).toHaveBeenCalledOnce();
    } finally { await zen.unmount(); }
  });

  it.each([false, true])("sends the exact Ship approval with an explicit remember choice: %s", async (remember) => {
    activeRunId = "shell-run";
    const zen = await mountedZen();
    try {
      await act(() => {
        for (const listener of signals) listener("proc.run.hil.requested", {
          pid: shipPid, requestId: "shell-approval", runId: activeRunId, callId: "shell-call",
          toolName: "Shell", syscall: "shell.exec", target: "laptop",
          args: { target: "laptop", input: "pwd" }, createdAt: 2,
        });
      });
      await vi.waitFor(() => expect(zen.props(ApprovalCard).request.requestId).toBe("shell-approval"));
      await act(() => zen.props(ApprovalCard).onDecide("approve", remember));
      const expected: ProcHilArgs = { pid: shipPid, requestId: "shell-approval", decision: "approve" };
      if (remember) expected.remember = true;
      expect(GSVClient.prototype.request).toHaveBeenCalledWith("proc.hil", expected);
    } finally { await zen.unmount(); }
  });

  async function requestShellApproval(zen: Awaited<ReturnType<typeof mountedZen>>) {
    await act(() => {
      for (const listener of signals) listener("proc.run.hil.requested", {
        pid: shipPid, requestId: "shell-approval", runId: activeRunId, callId: "shell-call",
        toolName: "Shell", syscall: "shell.exec", target: "laptop",
        args: { target: "laptop", input: "pwd" }, createdAt: 2,
      });
    });
    await vi.waitFor(() => expect(zen.props(ApprovalCard).request.requestId).toBe("shell-approval"));
  }

  it.each([["yes", "approve"], ["no", "deny"]] as const)("answers a pending approval when %s is typed instead of messaging Ship", async (text, decision) => {
    activeRunId = "shell-run";
    const zen = await mountedZen();
    try {
      await requestShellApproval(zen);
      await act(() => { expect(zen.props(PromptLine).onSubmit(text)).toBe(true); });
      const expected: ProcHilArgs = { pid: shipPid, requestId: "shell-approval", decision };
      await vi.waitFor(() => expect(GSVClient.prototype.request).toHaveBeenCalledWith("proc.hil", expected));
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("sends any other reply to a pending approval to Ship as a message", async () => {
    activeRunId = "shell-run";
    send.mockResolvedValueOnce({ message: message("user", "yes but first show me the file"), handlerPid: shipPid, runId: "shell-run" });
    const zen = await mountedZen();
    try {
      await requestShellApproval(zen);
      await act(() => { expect(zen.props(PromptLine).onSubmit("yes but first show me the file")).toBe(true); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "yes but first show me the file" })));
      expect(GSVClient.prototype.request).not.toHaveBeenCalledWith("proc.hil", expect.anything());
    } finally { await zen.unmount(); }
  });

  it("holds a lone misspelt answer in the prompt instead of replacing the request", async () => {
    activeRunId = "shell-run";
    const zen = await mountedZen();
    try {
      await requestShellApproval(zen);
      await act(() => { expect(zen.props(PromptLine).onSubmit("nno")).toBe(false); });
      expect(send).not.toHaveBeenCalled();
      expect(GSVClient.prototype.request).not.toHaveBeenCalledWith("proc.hil", expect.anything());
      expect(zen.props(FeedbackNote).note).toEqual({ kind: "notice", message: "chat.notice.approvalUnclear" });
      expect(zen.props(ApprovalCard).request.requestId).toBe("shell-approval");
      await act(() => { expect(zen.props(PromptLine).onSubmit("no")).toBe(true); });
      await vi.waitFor(() => expect(GSVClient.prototype.request).toHaveBeenCalledWith("proc.hil", expect.objectContaining({ decision: "deny" })));
      expect(zen.nodes().some((node) => node.type === FeedbackNote)).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("invites a typed answer in the composer only while an approval is pending", async () => {
    activeRunId = "shell-run";
    const zen = await mountedZen();
    try {
      expect(zen.props(PromptLine).placeholder).toBe("Message your Ship");
      await requestShellApproval(zen);
      expect(zen.props(PromptLine).placeholder).toBe("yes or no, or write back");
    } finally { await zen.unmount(); }
  });

  // Regression coverage for the former interaction:
  /* an approval takes the keys: the prompt lets go so y and n reach the decision */
  it.each([false, true])("shows a mail approval without interrupting a draft, with a newer event: %s", async (newerEvent) => {
    activeRunId = "mail-run";
    if (newerEvent) processRecords = [
      { id: 1, messageId: 1, index: 0, generation: 1, runId: activeRunId, createdAt: 1, source: "typed",
        kind: "call", payload: { callId: "send-mail", tool: "Shell", syscall: "shell.exec", target: "gsv",
          args: { input: "mail send --to recipient@example.invalid --message Hello" }, runId: activeRunId } },
      { id: 2, messageId: 2, index: 0, generation: 1, runId: activeRunId, createdAt: 2, source: "typed",
        kind: "event", payload: { kind: "legacy", payload: { text: "A newer runtime event" }, severity: "info", audience: "person" } },
    ];
    const zen = await mountedZen();
    try {
      const input: PromptLineHandle = {
        disabled: false, chip: null, focus: vi.fn(), setValue: vi.fn(),
        selection: () => ({ value: "Keep typing", start: 5, end: 5 }),
        append: vi.fn(), blur: vi.fn(), submit: vi.fn(),
      };
      zen.props(BrowserVoiceControls).prompt.current = input;
      await act(() => {
        zen.props(PromptLine).onFocusChange?.(true);
        zen.props(PromptLine).onInput?.("Keep typing");
      });
      await act(() => {
        for (const listener of signals) listener("proc.run.hil.requested", {
          pid: shipPid, requestId: "mail-approval", runId: "mail-run", callId: "nested-mail",
          toolName: "mail.send", syscall: "mail.send", target: "gsv",
          args: { to: "recipient@example.invalid", subject: "Hello", text: "A message" }, createdAt: 2,
        });
      });
      await vi.waitFor(() => expect(zen.props(ApprovalCard).request.requestId).toBe("mail-approval"));
      const approval = zen.nodes().find((node) => node.props.class === "zen-moment is-approval");
      expect(collectNodes(approval).some((node) => node.type === ApprovalCard)).toBe(true);
      expect(input.blur).not.toHaveBeenCalled();
      expect(input.focus).not.toHaveBeenCalled();
      expect(input.setValue).not.toHaveBeenCalled();
      expect(zen.dirty()).toBe(true);
      expect(zen.props(PromptLine).disabled).toBe(false);
    } finally { await zen.unmount(); }
  });

  it.each([undefined, "laptop"])("defaults to gsv with an online machine, unless target %s was explicitly selected", async (initialTarget) => {
    targets = [{ targetId: "laptop", label: "Laptop", online: true, implements: ["shell.exec"], platform: "linux",
      ownerUid: 1000, ownerUsername: "hank", description: "", version: "0.6.2", lastSeenAt: 1 }];
    send.mockReturnValue(deferred<ConversationSendResult>().promise);
    const zen = await mountedZen(undefined, initialTarget);
    try {
      expect(zen.props(PromptLine).place.id).toBe(initialTarget ?? "gsv");
      await act(() => { zen.props(PromptLine).onSubmit("Check the selected place"); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ selectedTarget: initialTarget ?? "gsv" })));
    } finally { await zen.unmount(); }
  });

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
      zen.props(BrowserVoiceControls).prompt.current = input;
      await act(() => { prompt().onInput?.("Keep this draft"); });
      const cloud = () => zen.nodes().find((node) => node.type === "button"
        && node.props["aria-label"] === "Use Ship’s home for the next message or command")!;
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

  it("closes the places menu when its trigger is tapped again, even where a tap does not focus the button", async () => {
    const zen = await mountedZen(undefined, "laptop");
    try {
      const trigger = () => zen.nodes().find((node) => node.type === "button" && node.props.class === "zen-place-trigger")!;
      const menu = () => zen.nodes().find((node) => node.type === "div" && node.props.id === "zen-places")!;
      /* the harness mounts no DOM: Node is stubbed for the instanceof check, the trigger ref stays null,
         and "outside" stands in for focus landing anywhere else */
      class FakeNode {}
      vi.stubGlobal("Node", FakeNode);
      const inside = new FakeNode();
      const outside = new FakeNode();
      // SAFETY: the handler reads only relatedTarget and currentTarget.contains.
      const blur = (relatedTarget: object | null) => menu().props.onfocusout!({ relatedTarget, currentTarget: { contains: (node: unknown) => node === inside } } as unknown as FocusEvent);
      await act(() => { trigger().props.onClick!(); });
      expect(menu().props.hidden).toBe(false);

      // Safari: pointerdown on the trigger, the focused menu item blurs with focus going nowhere, then the click lands.
      await act(() => { trigger().props.onPointerDown!(); });
      await act(() => { blur(outside); });
      expect(menu().props.hidden).toBe(false);
      await act(() => { trigger().props.onClick!(); });
      expect(menu().props.hidden).toBe(true);

      // Keyboard: focus leaving the menu without a press on the trigger still closes it.
      await act(() => { trigger().props.onClick!(); });
      expect(menu().props.hidden).toBe(false);
      await act(() => { blur(outside); });
      expect(menu().props.hidden).toBe(true);

      // Focus moving between items inside the menu keeps it open.
      await act(() => { trigger().props.onClick!(); });
      await act(() => { blur(inside); });
      expect(menu().props.hidden).toBe(false);
      await act(() => { trigger().props.onClick!(); });
      expect(menu().props.hidden).toBe(true);
    } finally { await zen.unmount(); }
  });

  it("offers to connect a place while the cloud is the only one, and stays in Zen", async () => {
    const zen = await mountedZen();
    try {
      const cloud = () => zen.nodes().find((node) => node.type === "button"
        && node.props["aria-label"] === "Use Ship’s home for the next message or command")!;
      const connect = () => zen.nodes().find((node) => node.type === "button" && node.props.class === "zen-connect-place")!;
      expect(cloud().props.class).toBe("zen-place is-alone");
      expect(connect()).toBeDefined();
      expect(zen.props(ChatPanels).context).toBeNull();

      await act(() => { connect().props.onClick!(); });
      expect(zen.props(ChatPanels).context).toEqual({ kind: "connect" });
      expect(zen.props(ChatPanels).targets).toEqual([]);

      await act(() => { zen.props(ChatPanels).onClose(); });
      expect(zen.props(ChatPanels).context).toBeNull();
      expect(zen.props(PromptLine).place.id).toBe("gsv");

      await act(() => { connect().props.onClick!(); });
      await act(() => { zen.props(ChatPanels).onConnected("laptop"); });
      expect(zen.props(ChatPanels).context).toBeNull();
      expect(zen.props(PromptLine).place.id).toBe("laptop");
      expect(zen.onFleet).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("keeps the selected place styling once another place is connected", async () => {
    targets = [{ targetId: "laptop", label: "Laptop", online: true, implements: ["shell.exec"], platform: "linux",
      ownerUid: 1000, ownerUsername: "hank", description: "", version: "0.6.2", lastSeenAt: 1 }];
    const zen = await mountedZen();
    try {
      const cloud = zen.nodes().find((node) => node.type === "button"
        && node.props["aria-label"] === "Use Ship’s home for the next message or command")!;
      expect(cloud.props.class).toBe("zen-place is-selected");
      expect(zen.nodes().some((node) => node.props.class === "zen-connect-place")).toBe(false);
      expect(zen.props(ChatPanels).context).toBeNull();
    } finally { await zen.unmount(); }
  });

  it.each([
    { target: "gsv", status: "completed", queuedCount: 0 },
    { target: "laptop", status: "aborted", queuedCount: 1 },
  ])("keeps routine run status out of the composer through $status", async ({ target, status, queuedCount }) => {
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
    const expectQuietComposer = () => {
      expect(text()).not.toContain("Ship’s home is ready");
      expect(text()).not.toContain("previous-model");
      expect(text()).not.toContain("active-model");
      expect(text()).not.toContain("attempting");
      expect(text().includes("laptop is offline · view connection")).toBe(target === "laptop");
    };
    try {
      expectQuietComposer();
      await act(() => { zen.props(PromptLine).onSubmit("Keep working"); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.props["aria-label"] === "Sending message")).toBe(false));

      activeRunId = "active-run";
      await act(() => { for (const listener of signals) listener("proc.run.started", { pid: shipPid, runId: activeRunId }); });
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(true));
      expectQuietComposer();

      runContext = { ...runContext, revision: 2, runId: activeRunId, model: "active-model", updatedAt: 2 };
      await act(() => { for (const listener of signals) listener("proc.changed", { pid: shipPid, changes: ["context"], context: runContext }); });
      await zen.render();
      expectQuietComposer();

      activeRunId = null;
      await act(() => { for (const listener of signals) listener("proc.run.finished", { pid: shipPid, runId: "active-run", status, queuedCount }); });
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(false));
      expectQuietComposer();
    } finally { await zen.unmount(); }
  });

  it.each(["connecting", "disconnected"] as const)("keeps drafting available while %s and waits for an explicit send after reconnect", async (state) => {
    send.mockReturnValue(deferred<ConversationSendResult>().promise);
    const zen = await mountedZen();
    try {
      const prompt = () => zen.props(PromptLine);
      const sendButton = () => zen.nodes().find((node) => node.type === "button" && node.props.class === "zen-submit");
      await act(() => { prompt().onInput?.("Keep this draft"); });
      expect(zen.text()).not.toContain("Reconnecting...");
      await act(() => { for (const listener of statuses) listener(status(state)); });
      expect(zen.text()).toContain("Reconnecting...");
      expect(prompt().disabled).toBe(false);
      expect(sendButton()?.props.disabled).toBe(true);
      await act(() => {
        prompt().onInput?.("Keep this draft and keep writing");
        expect(prompt().onSubmit("Keep this draft and keep writing")).toBe(false);
        expect(prompt().onSubmit("$ pwd")).toBe(false);
      });
      expect(zen.dirty()).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(vi.mocked(GSVClient.prototype.request).mock.calls.some(([call]) => call === "shell.exec")).toBe(false);

      await act(() => { for (const listener of statuses) listener(status("connected")); });
      expect(zen.text()).not.toContain("Reconnecting...");
      expect(prompt().disabled).toBe(false);
      expect(sendButton()?.props.disabled).toBe(false);
      expect(zen.dirty()).toBe(true);
      expect(send).not.toHaveBeenCalled();
      await act(() => { expect(prompt().onSubmit("Keep this draft and keep writing")).toBe(true); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "Keep this draft and keep writing" })));
    } finally { await zen.unmount(); }
  });

  it.each(["$ pwd", "!pwd"])("routes a finalized native %s prompt to the terminal without sending it to Ship", async (text) => {
    const zen = await mountedZen(undefined, undefined, true);
    try {
      await act(() => { expect(zen.props(NativeVoiceControls).send(text)).toBe(true); });
      await vi.waitFor(() => expect(vi.mocked(GSVClient.prototype.request).mock.calls.some(([call, args]) =>
        call === "shell.exec" && z.object({ input: z.literal("pwd") }).safeParse(args).success,
      )).toBe(true));
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("switches the place for a native @ prompt and reports an unknown place without sending either to Ship", async () => {
    const zen = await mountedZen(undefined, "laptop", true);
    try {
      await vi.waitFor(() => expect(zen.props(PromptLine).place.id).toBe("laptop"));
      await act(() => { expect(zen.props(NativeVoiceControls).send("@cloud")).toBe(true); });
      expect(zen.props(PromptLine).place.id).toBe("gsv");
      await act(() => { zen.props(NativeVoiceControls).send("@missing"); });
      expect(zen.props(FeedbackNote).note).toEqual({ kind: "notice", message: "chat.notice.noPlace", values: { name: "missing" } });
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });

  it("rejects native commands with attachments instead of submitting a chat message", async () => {
    const zen = await mountedZen(undefined, undefined, true);
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

  it("folds a long paste into a chip and sends it after the typed words", async () => {
    send.mockResolvedValueOnce({ message: message("user", "joined"), handlerPid: shipPid, runId: "paste" });
    const log = Array.from({ length: 12 }, (_, index) => `error ${index}`).join("\n");
    const zen = await mountedZen();
    try {
      const pastes = () => zen.nodes().filter((node) => node.type === ZenDraftPaste);
      await act(() => { expect(zen.props(PromptLine).onPasteText?.("a short paste")).toBe(false); });
      // A long paste that is itself a command stays inline so it runs directly, even into an empty prompt.
      await act(() => { expect(zen.props(PromptLine).onPasteText?.(`$ ${"x".repeat(500)}`)).toBe(false); });
      expect(pastes()).toHaveLength(0);
      await act(() => { expect(zen.props(PromptLine).onPasteText?.("z".repeat(500))).toBe(true); });
      await act(() => { expect(zen.props(PromptLine).onPasteText?.(log)).toBe(true); });
      expect(pastes()).toHaveLength(2);
      expect(zen.props(PromptLine).allowEmpty).toBe(true);
      expect(zen.dirty()).toBe(true);
      await act(() => { expect(zen.props(PromptLine).onSubmit("$ pwd")).toBe(false); });
      expect(zen.props(FeedbackNote).note).toEqual({ kind: "notice", message: "chat.notice.commandExtras" });
      await act(() => { zen.props(ZenDraftPaste).onRemove?.(); });
      expect(pastes()).toHaveLength(1);
      expect(zen.props(ZenDraftPaste).paste.text).toBe(log);
      await act(() => { expect(zen.props(PromptLine).onSubmit("What failed?")).toBe(true); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send.mock.calls[0]?.[0].text).toBe(`What failed?\n\n${log}`);
      expect(pastes()).toHaveLength(0);
      expect(zen.props(PromptLine).allowEmpty).toBe(false);
      expect(vi.mocked(GSVClient.prototype.request).mock.calls.some(([call]) => call === "shell.exec")).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("edits a pasted chip in place and sends the edited text", async () => {
    send.mockResolvedValueOnce({ message: message("user", "edited"), handlerPid: shipPid, runId: "edited-paste" });
    const zen = await mountedZen();
    try {
      const pastes = () => zen.nodes().filter((node) => node.type === ZenDraftPaste);
      await act(() => { expect(zen.props(PromptLine).onPasteText?.("w".repeat(500))).toBe(true); });
      await act(() => { zen.props(ZenDraftPaste).onChange?.("   \n  "); });
      expect(pastes()).toHaveLength(0);
      await act(() => { expect(zen.props(PromptLine).onPasteText?.("q".repeat(500))).toBe(true); });
      // An edited paste stays a chip however short it gets.
      const edited = "Dear Sam,\nthanks — see you Tuesday.";
      await act(() => { zen.props(ZenDraftPaste).onChange?.(edited); });
      expect(pastes()).toHaveLength(1);
      expect(zen.props(ZenDraftPaste).paste.text).toBe(edited);
      expect(zen.props(ZenDraftPaste).paste.characters).toBe(Array.from(edited).length);
      await act(() => { expect(zen.props(PromptLine).onSubmit("Send this?")).toBe(true); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send.mock.calls[0]?.[0].text).toBe(`Send this?\n\n${edited}`);
      expect(pastes()).toHaveLength(0);
    } finally { await zen.unmount(); }
  });

  it("sends ordinary native text through the conversation outbox", async () => {
    send.mockResolvedValueOnce({ message: message("user", "Hello from voice"), handlerPid: shipPid, runId: "voice" });
    const zen = await mountedZen(undefined, undefined, true);
    try {
      await act(() => { expect(zen.props(NativeVoiceControls).send("Hello from voice")).toBe(true); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send.mock.calls[0]?.[0].text).toBe("Hello from voice");
    } finally { await zen.unmount(); }
  });

  it("keeps the composer available without inventing a welcome or activity", async () => {
    const zen = await mountedZen();
    try {
      expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(false);
      expect(zen.text()).not.toContain("I am the Ship. Who are you?");
      expect(zen.nodes().filter((node) => node.type === ZenText)).toHaveLength(0);
      expect(zen.props<ComponentProps<typeof PromptLine>>(PromptLine).disabled).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect([...storage.values()]).toEqual([]);
    } finally { await zen.unmount(); }
  });

  it("shows Ship waking up from the empty chat through its first run until the first message lands", async () => {
    const zen = await mountedZen();
    const waking = () => zen.nodes().filter((node) => node.type === WakingUp).length;
    try {
      await vi.waitFor(() => expect(waking()).toBe(1));
      expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(false);

      activeRunId = "welcome-run";
      await act(() => { for (const listener of signals) listener("proc.run.started", { pid: shipPid, runId: activeRunId }); });
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(true));
      expect(waking()).toBe(1);

      const greeting = message("process", "Hi, I'm Ship.");
      await act(() => {
        messages = [greeting];
        for (const listener of signals) listener("message.committed", { message: greeting, directed: false });
      });
      await vi.waitFor(() => expect(zen.props(ZenText).text).toBe(greeting.text));
      expect(waking()).toBe(0);

      activeRunId = "later-run";
      await act(() => { for (const listener of signals) listener("proc.run.started", { pid: shipPid, runId: activeRunId }); });
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(true));
      expect(waking()).toBe(0);
    } finally { await zen.unmount(); }
  });

  it("does not say Ship is waking while the welcome card still stands", async () => {
    const zen = await mountedZen(undefined, undefined, false, false, true);
    try {
      await vi.waitFor(() => expect(zen.props(PromptLine).disabled).toBe(false));
      expect(zen.nodes().some((node) => node.type === WakingUp)).toBe(false);
      activeRunId = "welcome-run";
      await act(() => { for (const listener of signals) listener("proc.run.started", { pid: shipPid, runId: activeRunId }); });
      await vi.waitFor(() => expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(true));
      expect(zen.nodes().some((node) => node.type === WakingUp)).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("does not call a conversation whose history failed to load a waking Ship", async () => {
    historyUnavailable = true;
    const zen = await mountedZen();
    try {
      await vi.waitFor(() => expect(zen.text()).toContain("Could not load your conversation: history unavailable"));
      expect(zen.nodes().some((node) => node.type === WakingUp)).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("does not call an older conversation a waking Ship", async () => {
    messages = [message("user", "Are you there?")];
    hasMore = true;
    const zen = await mountedZen();
    try {
      await vi.waitFor(() => expect(zen.props(ZenText).text).toBe("Are you there?"));
      expect(zen.nodes().some((node) => node.type === WakingUp)).toBe(false);
    } finally { await zen.unmount(); }
  });

  it("renders a canonical translated welcome and retains it after reload", async () => {
    activeRunId = "welcome-run";
    const zen = await mountedZen();
    const greeting = message("process", "Hola, soy Ship. ¿De qué quieres que me encargue?");
    try {
      expect(zen.props(PromptLine).disabled).toBe(false);
      expect(send).not.toHaveBeenCalled();
      await act(() => {
        messages = [greeting];
        for (const listener of signals) listener("message.committed", { message: greeting, directed: false });
      });
      await vi.waitFor(() => expect(zen.props(ZenText).text).toBe(greeting.text));
    } finally { await zen.unmount(); }
    activeRunId = null;
    const reopened = await mountedZen();
    try {
      await vi.waitFor(() => expect(reopened.props(ZenText).text).toBe(greeting.text));
      expect(reopened.nodes().filter((node) => node.type === ZenText)).toHaveLength(1);
      expect([...storage.values()]).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    } finally { await reopened.unmount(); }
  });

  it("shows existing messages immediately, including messages from Ship", async () => {
    messages = [message("process", "Your machine is online.")];
    const zen = await mountedZen();
    try {
      await vi.waitFor(() => expect(zen.props(ZenText).text).toBe("Your machine is online."));
      // History was not watched arriving, so a long message from it folds.
      expect(zen.props(ZenText).opened).toBe(false);
      expect(zen.text()).not.toContain("I am the Ship. Who are you?");
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
      expect(zen.nodes().some((node) => node.type === ThinkingMark)).toBe(false);
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
      expect(zen.text()).not.toContain("I am the Ship. Who are you?");
      expect(zen.nodes().some((node) => node.type === WakingUp)).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally { await zen.unmount(); }
  });
});
