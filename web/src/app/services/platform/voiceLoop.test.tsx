import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { createTestRoot } from "../../testing/testHarness";
import { NativeInputProvider, type NativeInput, type NativeSnapshot, type NativeUpdate } from "./PlatformProvider";
import { NativeSpeechProvider, useNativeSpeech, type NativeSpeechDriver, type SpeechEvent } from "./NativeSpeech";
import { useNativeVoice } from "./useNativeVoice";
import { useSpokenReplies } from "./useSpokenReplies";

const roots: ReturnType<typeof createTestRoot>[] = [];
beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setTimeout: () => 1, clearTimeout: () => {} });
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "gsv.desktop.voice.v1" ? JSON.stringify({ enabled: true, mode: "toggle", replies: "voice", language: "en", talk: "Ctrl+Alt+Space", stop: "Ctrl+Alt+Escape" }) : null, setItem: vi.fn() });
});
afterEach(async () => { for (const root of roots.splice(0)) await root.unmount(); vi.unstubAllGlobals(); });

async function mount() {
  let receiveSpeech!: (event: SpeechEvent) => void;
  let receiveInput!: (event: NativeUpdate) => void;
  let receiveSignal!: Parameters<GSVClient["onSignal"]>[0];
  const initial: NativeSnapshot = { lease: "one", voice: null, events: [], devices: [], devices_loading: false, devices_revision: 0, notice: null };
  const speech: NativeSpeechDriver = {
    subscribe(receive) { receiveSpeech = receive; return { initial: Promise.resolve({ phase: "idle", id: null, error: null }), dispose() {} }; },
    command: vi.fn(async () => {}), configure: vi.fn(async () => {}), editShortcuts: vi.fn(async () => {}),
  };
  const input: NativeInput = {
    subscribe(receive) { receiveInput = receive; return { initial: Promise.resolve(initial), dispose() {} }; },
    command: vi.fn(async () => {}), acknowledge: vi.fn(async () => {}),
  };
  const client: Pick<GSVClient, "onSignal"> = { onSignal: (receive) => { receiveSignal = receive; return () => {}; } };
  let value = "";
  const prompt = { current: { selection: () => ({ value, start: value.length, end: value.length }), setValue: (next: string) => { value = next; }, commands: true } };
  const send = vi.fn(() => true);
  let preferences!: NonNullable<ReturnType<typeof useNativeSpeech>>;
  function Probe({ connected }: { connected: boolean }) {
    preferences = useNativeSpeech()!;
    useNativeVoice({ prompt, scope: "ship", enabled: connected, global: true, send });
    useSpokenReplies(client, "ship-conversation", connected, "en");
    return null;
  }
  const root = createTestRoot("desktop voice loop"); roots.push(root);
  const render = (connected = true) => root.render(<NativeSpeechProvider driver={speech} active={connected}><NativeInputProvider input={input}><Probe connected={connected} /></NativeInputProvider></NativeSpeechProvider>);
  await render();
  const shortcut = (action: "press" | "release" | "cancel") => act(() => receiveSpeech({ kind: "shortcut", action, sent_at_ms: Date.now() }));
  const speechStatus = (phase: string, error: string | null = null) => act(() => receiveSpeech({ kind: "status", status: { phase, id: null, error } }));
  const native = (snapshot: Partial<NativeSnapshot>, revision: number) => act(() => receiveInput({ revision, sent_at_ms: Date.now(), snapshot: { ...initial, ...snapshot } }));
  const started = () => native({ voice: { request_id: 4, segment_id: 0, revision: 1, text: "Hello Ship", phase: "listening", progress: null, muted: false, pending: null },
    events: [{ id: 1, request_id: 4, segment_id: 0, kind: "started", action: null, text: "" }] }, 1);
  const reply = (id = "reply-1", conversationId = "ship-conversation", kind = "process") => act(() => receiveSignal("message.committed", { message: {
    id, conversationId, sequence: 1, author: kind === "process" ? { kind, pid: "ship", uid: 2 } : { kind: "user", uid: 1 },
    text: "**Ready.** You can keep playing.", origin: { kind: "process", pid: "ship", runId: "run" }, createdAt: Date.now(),
  }, directed: true }));
  return { speech, input, send, shortcut, speechStatus, native, started, reply, render, prompt, value: () => value, preferences: () => preferences };
}

describe("desktop voice loop", () => {
  it("clears a failed command after retry without hiding a current helper error", async () => {
    const app = await mount();
    vi.mocked(app.speech.command).mockRejectedValueOnce(new Error("Helper unavailable"));
    await act(async () => { expect(await app.preferences().command({ kind: "prepare" })).toBe(false); });
    expect(app.preferences().error).toContain("Helper unavailable");
    await app.speechStatus("error", "Current helper failure");
    await act(async () => { expect(await app.preferences().command({ kind: "prepare" })).toBe(true); });
    expect(app.preferences().error).toBe("Current helper failure");
    await app.speechStatus("ready");
    expect(app.preferences().error).toBeNull();
  });

  it("stops playback before recording, finalizes before sending, and speaks each committed reply once", async () => {
    const app = await mount();
    await app.shortcut("press");
    await vi.waitFor(() => expect(app.input.command).toHaveBeenCalledWith("one", { kind: "start", device_id: null }));
    expect(app.speech.command).toHaveBeenCalledWith({ kind: "cancel" });
    await app.started();
    expect(app.value()).toBe("Hello Ship");
    await app.shortcut("press");
    await vi.waitFor(() => expect(app.input.command).toHaveBeenCalledWith("one", { kind: "finish", request_id: 4 }));
    expect(app.send).not.toHaveBeenCalled();
    await app.native({ events: [{ id: 2, request_id: 4, segment_id: 0, kind: "final", action: "send", text: "Hello Ship" }] }, 2);
    expect(app.send).toHaveBeenCalledExactlyOnceWith("Hello Ship");
    await app.reply(); await app.reply(); await app.reply("contact-reply", "contact-conversation"); await app.reply("user-reply", "ship-conversation", "user");
    expect(vi.mocked(app.speech.command).mock.calls.filter(([command]) => command.kind === "speak")).toHaveLength(1);
  });

  it("hold-to-talk waits for release; cancellation and empty transcripts never send the typed draft", async () => {
    const app = await mount();
    await act(() => app.preferences().setPreferences({ mode: "hold" }));
    app.prompt.current.setValue("Keep this draft.");
    await app.shortcut("press"); await app.started(); await app.shortcut("press");
    expect(vi.mocked(app.input.command).mock.calls.some(([, command]) => command.kind === "finish")).toBe(false);
    await app.shortcut("release");
    await vi.waitFor(() => expect(app.input.command).toHaveBeenCalledWith("one", { kind: "finish", request_id: 4 }));
    await app.native({ events: [{ id: 2, request_id: 4, segment_id: 0, kind: "final", action: "send", text: "" }] }, 2);
    expect(app.send).not.toHaveBeenCalled();
    expect(app.value()).toBe("Keep this draft.");
    await app.shortcut("cancel");
    expect(app.send).not.toHaveBeenCalled();
    expect(app.value()).toBe("Keep this draft.");
  });

  it("does not replay old replies on reconnect or speak process drafts", async () => {
    const app = await mount();
    await act(() => app.preferences().setPreferences({ replies: "all" }));
    await app.reply();
    await app.render(false); await app.render(true); await app.reply();
    expect(vi.mocked(app.speech.command).mock.calls.filter(([command]) => command.kind === "speak")).toHaveLength(1);
  });

  it("releases recording when global voice is disabled and preserves the displayed draft", async () => {
    const app = await mount();
    await app.shortcut("press"); await app.started();
    await act(() => app.preferences().setPreferences({ enabled: false }));
    expect(app.input.command).toHaveBeenCalledWith("one", { kind: "cancel" });
    expect(app.value()).toBe("Hello Ship");
    expect(app.send).not.toHaveBeenCalled();
  });

  it("can start again after recording is cancelled by the local controls", async () => {
    const app = await mount();
    await app.shortcut("press"); await app.started();
    await app.native({ voice: null }, 2);
    vi.mocked(app.input.command).mockClear();
    await app.shortcut("press");
    await vi.waitFor(() => expect(app.input.command).toHaveBeenCalledWith("one", { kind: "start", device_id: null }));
    expect(app.send).not.toHaveBeenCalled();
  });

  it("pauses global actions while choosing keys and keeps preferences after a rejected binding", async () => {
    const app = await mount();
    await act(async () => { await app.preferences().captureShortcuts(true); });
    expect(app.speech.configure).toHaveBeenLastCalledWith({ enabled: false, talk: "Ctrl+Alt+Space", stop: "Ctrl+Alt+Escape" });
    await app.shortcut("press");
    expect(app.input.command).not.toHaveBeenCalled();
    await act(async () => { await app.preferences().captureShortcuts(false); });
    vi.mocked(app.speech.configure).mockRejectedValueOnce(new Error("Already in use"));
    await act(async () => { await app.preferences().applyShortcuts("Alt+KeyV", "Alt+Escape"); });
    expect(app.preferences().preferences.talk).toBe("Ctrl+Alt+Space");
    expect(app.preferences().error).toContain("Already in use");
    await act(async () => { await app.preferences().command({ kind: "cue", cue: "attention" }); });
    expect(app.preferences().error).toContain("Already in use");
    await act(async () => { await app.preferences().applyShortcuts("Alt+KeyV", "Alt+Escape"); });
    expect(app.preferences().preferences.talk).toBe("Alt+KeyV");
  });
});
