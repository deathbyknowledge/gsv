import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import type { ConversationSendArgs, ConversationSendResult } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../gateway/GatewayProvider";
import { consoleConfigQueryKey } from "../system/useConsoleData";
import { createTestRoot, deferred } from "../../testing/testHarness";
import { NativeInputProvider, type NativeInput, type NativeSnapshot, type NativeUpdate } from "./PlatformProvider";
import { NativeSpeechProvider, useNativeSpeech, type NativeSpeechDriver, type SpeechEvent } from "./NativeSpeech";
import { NativeVoiceSession, useComposerVoice, useNativeVoiceSession } from "./NativeVoiceSession";

const roots: ReturnType<typeof createTestRoot>[] = [];
const statuses = new Set<Parameters<GSVClient["onStatus"]>[0]>();
const signals = new Set<Parameters<GSVClient["onSignal"]>[0]>();
const unload = new Set<EventListener>();
const send = vi.fn<(args: ConversationSendArgs) => Promise<ConversationSendResult>>();
let connected = true;
let responseLanguage = "en";
const status = (): GsvClientStatus => ({ state: connected ? "connected" : "disconnected", url: "wss://example.test/ws", username: "owner", connectionId: "one", message: null });
beforeEach(() => {
  connected = true; responseLanguage = "en"; statuses.clear(); signals.clear(); unload.clear(); send.mockReset();
  vi.stubGlobal("document", {}); vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {
    location: { search: "", protocol: "https:", host: "example.test" },
    setTimeout: () => 1, clearTimeout: () => {},
    addEventListener: (type: string, listener: EventListener) => { if (type === "beforeunload") unload.add(listener); },
    removeEventListener: (type: string, listener: EventListener) => { if (type === "beforeunload") unload.delete(listener); },
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "gsv.desktop.voice.v1"
    ? JSON.stringify({ enabled: true, mode: "toggle", replies: "voice", language: "en", talk: "Ctrl+Alt+Space", stop: "Ctrl+Alt+Escape" }) : null, setItem: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockImplementation(status);
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation((listener) => { statuses.add(listener); return () => { statuses.delete(listener); }; });
  vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation((listener) => { signals.add(listener); return () => { signals.delete(listener); }; });
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "conversation.ship") return { data: { conversation: { id: "personal-conversation", kind: "ship", handlerPid: "personal-ship", ownerUid: 1000, title: null, latestSequence: 0, createdAt: 1, updatedAt: 1 } } };
    if (call === "sys.config.get") {
      expect(args).toEqual({ key: "users/1000/locale/language" });
      return { data: { entries: responseLanguage ? [{ key: "users/1000/locale/language", value: responseLanguage }] : [] } };
    }
    if (call === "conversation.send") {
      // SAFETY: the typed conversation namespace supplies these arguments; this branch selects that exact syscall.
      return { data: await send(args as ConversationSendArgs) };
    }
    throw new Error(`Unexpected request: ${call}`);
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mount(desktop = true) {
  let inputUpdate!: (update: NativeUpdate) => void;
  let speechEvent!: (event: SpeechEvent) => void;
  let revision = 0, eventId = 0, requestId = 0;
  let snapshot: NativeSnapshot = { lease: "session", voice: null, devices: [], devices_revision: 0, devices_loading: false, notice: null, events: [] };
  const dispose = vi.fn();
  const input: NativeInput = {
    subscribe: vi.fn((receive) => { inputUpdate = receive; return { initial: Promise.resolve(snapshot), dispose }; }),
    acknowledge: vi.fn(async () => {}), command: vi.fn(async () => {}),
  };
  const speech: NativeSpeechDriver = {
    subscribe(receive) { speechEvent = receive; return { initial: Promise.resolve({ phase: "idle", id: null, error: null }), dispose() {} }; },
    command: vi.fn(async () => {}), configure: vi.fn(async () => {}), editShortcuts: vi.fn(async () => {}),
  };
  let session!: ReturnType<typeof useNativeVoiceSession>;
  let voice!: ReturnType<typeof useComposerVoice>;
  let preferences!: ReturnType<typeof useNativeSpeech>;
  let typed = "Unsent text with an attachment";
  const localSend = vi.fn(() => true);
  const prompt = { current: { commands: true, selection: () => ({ value: typed, start: typed.length, end: typed.length }), setValue: (text: string) => { typed = text; } } };
  function ReadSession() { session = useNativeVoiceSession(); preferences = useNativeSpeech(); return null; }
  function Composer({ page }: { page: string }) {
    voice = useComposerVoice({ prompt, scope: page === "helper" ? "helper-process" : "ship", enabled: page === "chat" || page === "helper", send: localSend });
    return null;
  }
  const dirty = vi.fn();
  const root = createTestRoot("desktop voice session"); roots.push(root);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const render = (page = "memory", signedIn = true) => root.render(<GatewayProvider><QueryClientProvider client={cache}>
    {desktop ? <NativeInputProvider input={input}><NativeSpeechProvider driver={speech} active={signedIn}>
      {signedIn && <NativeVoiceSession onDirtyChange={dirty}><ReadSession /><Composer page={page} /></NativeVoiceSession>}
    </NativeSpeechProvider></NativeInputProvider> : <NativeVoiceSession onDirtyChange={dirty}><ReadSession /></NativeVoiceSession>}
  </QueryClientProvider></GatewayProvider>);
  await render();
  if (desktop) await vi.waitFor(() => expect(cache.getQueryData([...consoleConfigQueryKey, "language", 1000])).toBe(responseLanguage));
  const native = (patch: Partial<NativeSnapshot>) => act(() => {
    snapshot = { ...snapshot, ...patch };
    inputUpdate({ revision: ++revision, sent_at_ms: Date.now(), snapshot });
  });
  const shortcut = (action: "press" | "release" | "cancel" = "press") => act(() => speechEvent({ kind: "shortcut", action, sent_at_ms: Date.now() }));
  const start = async (text = "Hello Ship") => {
    await shortcut();
    await vi.waitFor(() => expect(input.command).toHaveBeenCalledWith("session", { kind: "start", device_id: null }));
    await native({ voice: { request_id: ++requestId, segment_id: 0, revision: 1, text, phase: "listening", progress: null, muted: false, pending: null },
      events: [{ id: ++eventId, request_id: requestId, segment_id: 0, kind: "started", text: "", action: null }] });
  };
  const finish = async (text = "Hello Ship") => {
    await shortcut();
    await vi.waitFor(() => expect(input.command).toHaveBeenCalledWith("session", { kind: "finish", request_id: requestId }));
    await native({ voice: null, events: [{ id: ++eventId, request_id: requestId, segment_id: 0, kind: "final", text, action: "send" }] });
  };
  const reply = (conversationId = "personal-conversation", id = "reply") => act(() => {
    for (const listener of signals) listener("message.committed", { message: { id, conversationId, sequence: 2,
      author: { kind: "process", pid: "personal-ship", uid: 1001 }, text: "**Ready.** Keep playing.", origin: { kind: "process", pid: "personal-ship", runId: "run" }, createdAt: 2 }, directed: true });
  });
  const connection = (value: boolean) => act(() => { connected = value; for (const listener of statuses) listener(status()); });
  const ack = (args: ConversationSendArgs): ConversationSendResult => ({ handlerPid: "personal-ship", runId: "run", message: { id: "sent", conversationId: args.conversationId, sequence: 1,
    author: { kind: "user", uid: 1000 }, text: args.text, createdAt: 1, origin: { kind: "client" } } });
  send.mockImplementation(async (args) => ack(args));
  return { input, speech, dispose, render, native, shortcut, start, finish, reply, connection, ack, localSend, dirty, cache, typed: () => typed,
    session: () => session!, voice: () => voice, preferences: () => preferences!, unmount: () => root.unmount() };
}

describe("desktop handsfree session", () => {
  it.each(["shortcut", "composer"])("waits for playback cancellation and refuses capture on failure through %s", async (entry) => {
    const app = await mount();
    await app.render("chat");
    const trigger = () => entry === "shortcut" ? app.shortcut() : act(() => app.voice().start());
    const failed = deferred<void>();
    vi.mocked(app.speech.command).mockImplementationOnce(() => failed.promise.then(() => { throw new Error("Playback cancellation failed"); }));
    await trigger();
    expect(app.session().input.capturing).toBe(true);
    expect(app.input.command).not.toHaveBeenCalledWith("session", { kind: "start", device_id: null });
    await act(() => failed.resolve());
    await vi.waitFor(() => expect(app.session().input.capturing).toBe(false));
    expect(app.session().input.error).toContain("Could not stop playback");
    expect(app.input.command).not.toHaveBeenCalledWith("session", { kind: "start", device_id: null });
    const stopped = deferred<void>();
    vi.mocked(app.speech.command).mockImplementationOnce(() => stopped.promise);
    await trigger();
    expect(app.input.command).not.toHaveBeenCalledWith("session", { kind: "start", device_id: null });
    await act(() => stopped.resolve());
    await vi.waitFor(() => expect(app.input.command).toHaveBeenCalledWith("session", { kind: "start", device_id: null }));
    expect(app.typed()).toBe("Unsent text with an attachment");
  });

  it("uses the owner's language, follows preference saves across pages, and preserves local shortcuts", async () => {
    responseLanguage = "es-MX";
    const app = await mount();
    expect(app.session().language).toBe("es");
    expect(app.preferences().preferences).toMatchObject({ enabled: true, talk: "Ctrl+Alt+Space", stop: "Ctrl+Alt+Escape" });
    expect(app.preferences().preferences).not.toHaveProperty("language");
    await act(() => app.preferences().setPreferences({ replies: "all" }));
    await app.reply();
    expect(app.speech.command).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "speak", language: "es" }));

    await app.render("fleet");
    responseLanguage = "en-GB";
    await act(() => app.cache.invalidateQueries({ queryKey: consoleConfigQueryKey }));
    await vi.waitFor(() => expect(app.session().language).toBe("en"));
    await app.reply("personal-conversation", "english-reply");
    expect(app.speech.command).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "speak", language: "en" }));

    responseLanguage = "fr";
    await act(() => app.cache.invalidateQueries({ queryKey: consoleConfigQueryKey }));
    await vi.waitFor(() => expect(app.session().language).toBeNull());
    expect(app.session().languageUnsupported).toBe(true);
    expect(app.session().languageError).toBeNull();
    await app.reply("personal-conversation", "french-reply");
    expect(vi.mocked(app.speech.command).mock.calls.filter(([command]) => command.kind === "speak")).toHaveLength(2);

    responseLanguage = "";
    vi.stubGlobal("navigator", { language: "es-ES" });
    await act(() => app.cache.invalidateQueries({ queryKey: consoleConfigQueryKey }));
    await vi.waitFor(() => expect(app.session().language).toBe("es"));
    expect(app.session().languageUnsupported).toBe(false);
    expect(app.session().languageError).toBeNull();
    vi.stubGlobal("navigator", { language: "C" });
    await app.render("memory");
    expect(app.session().language).toBe("en");
  });

  it("starts before visiting Chat, survives navigation, sends only to Ship, and reads replies while another page is open", async () => {
    const app = await mount();
    await app.start("$ describe this command");
    expect(app.session().text).toBe("$ describe this command");
    await app.render("settings"); await app.render("helper");
    expect(app.input.subscribe).toHaveBeenCalledOnce();
    expect(app.dispose).not.toHaveBeenCalled();
    expect(app.input.command).not.toHaveBeenCalledWith("session", { kind: "cancel" });
    expect(app.typed()).toBe("Unsent text with an attachment");
    await app.finish("$ describe this command");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0]).toEqual({ conversationId: "personal-conversation", text: "$ describe this command", selectedTarget: undefined, idempotencyKey: expect.any(String) });
    expect(app.localSend).not.toHaveBeenCalled();
    await app.render("people"); await app.reply(); await app.reply(); await app.reply("contact-conversation");
    expect(vi.mocked(app.speech.command).mock.calls.filter(([command]) => command.kind === "speak")).toHaveLength(1);
  });

  it("keeps failed sends across navigation and retries the same message identity", async () => {
    const app = await mount();
    send.mockRejectedValueOnce(new Error("Connection interrupted after sending"));
    await app.start(); await app.finish();
    await vi.waitFor(() => expect(app.session().outbox.messages[0]?.status).toBe("failed"));
    expect(app.session().text).toBe("");
    await app.render("fleet");
    expect(app.session().outbox.messages[0].error).toBe("Connection interrupted after sending");
    await act(() => { app.session().outbox.retry(app.session().outbox.messages[0]); });
    await vi.waitFor(() => expect(app.session().outbox.messages).toHaveLength(0));
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  });

  it("cancels on disconnect, keeps the voice draft, ignores late completion, and guards quitting", async () => {
    const app = await mount();
    await app.start("Keep this voice draft");
    await app.connection(false);
    expect(app.input.command).toHaveBeenLastCalledWith("session", { kind: "cancel" });
    await app.native({ voice: null, events: [{ id: 2, request_id: 1, segment_id: 0, kind: "final", action: "send", text: "Late completion" }] });
    expect(send).not.toHaveBeenCalled();
    expect(app.session().text).toBe("Keep this voice draft");
    const event = new Event("beforeunload", { cancelable: true });
    for (const listener of unload) listener(event);
    expect(event.defaultPrevented).toBe(true);
    await app.connection(true); await app.render("settings");
    expect(app.session().text).toBe("Keep this voice draft");
    await act(() => app.session().send());
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0].text).toBe("Keep this voice draft");
  });

  it("keeps local dictation separate and fences a pending local start when its view closes", async () => {
    const app = await mount();
    await app.render("chat");
    const stoppedSpeech = deferred<void>();
    vi.mocked(app.speech.command).mockImplementationOnce(() => stoppedSpeech.promise);
    await act(() => app.voice().start());
    await app.render("memory");
    await act(() => stoppedSpeech.resolve());
    expect(app.input.command).not.toHaveBeenCalledWith("session", { kind: "start", device_id: null });
    expect(app.typed()).toBe("Unsent text with an attachment");
    await app.start();
    await app.render("chat");
    expect(app.voice().blocked).toBe(true);
    await act(() => app.voice().onInput("Editing the Chat draft"));
    expect(app.session().text).toBe("Hello Ship");
    expect(app.session().input.capturing).toBe(true);
  });

  it("keeps a cancelled handsfree draft while local dictation owns the microphone", async () => {
    const app = await mount();
    await app.start("A separate draft"); await app.shortcut("cancel");
    await app.native({ voice: null, events: [] });
    await app.render("chat");
    await act(() => app.voice().start());
    await app.native({ voice: { request_id: 2, segment_id: 0, revision: 1, text: "local words", phase: "listening", progress: null, muted: false, pending: null },
      events: [{ id: 2, request_id: 2, segment_id: 0, kind: "started", action: null, text: "" }] });
    expect(app.typed()).toBe("Unsent text with an attachment local words");
    expect(app.session().text).toBe("A separate draft");
    await act(() => app.session().discard());
    expect(app.voice().capturing).toBe(true);
    expect(app.session().text).toBe("");
  });

  it("disables shortcuts without losing drafts and releases the session on sign-out", async () => {
    const app = await mount();
    await app.start();
    await act(() => app.preferences().setPreferences({ enabled: false }));
    expect(app.input.command).toHaveBeenLastCalledWith("session", { kind: "cancel" });
    expect(app.session().text).toBe("Hello Ship");
    vi.mocked(app.input.command).mockClear();
    await app.shortcut();
    expect(app.input.command).not.toHaveBeenCalled();
    await app.render("memory", false);
    expect(app.dispose).toHaveBeenCalledOnce();
    await app.native({ voice: null, events: [{ id: 99, request_id: 1, segment_id: 0, kind: "final", action: "send", text: "stale" }] });
    expect(send).not.toHaveBeenCalled();
    expect(unload.size).toBe(0);
  });

  it("leaves the web session without native voice owners or Ship discovery", async () => {
    const app = await mount(false);
    expect(app.session()).toBe(null);
    expect(app.input.subscribe).not.toHaveBeenCalled();
    expect(GSVClient.prototype.request).not.toHaveBeenCalled();
  });
});
