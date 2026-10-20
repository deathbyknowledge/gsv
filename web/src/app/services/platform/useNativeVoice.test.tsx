import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../testing/testHarness";
import type { PromptLineHandle } from "../../features/instrument/shared/PromptLine";
import { NativeInputProvider, type NativeInput, type NativeSnapshot, type NativeUpdate, type NativeVoice } from "./PlatformProvider";
import { useNativeVoice } from "./useNativeVoice";
import { ClientControlProvider, type ClientControl, type ControlCommand, type ControlHandler } from "./ClientControl";

const idle = (lease = "view-1"): NativeSnapshot => ({
  lease, voice: null, devices: [], devices_loading: false, devices_revision: 0, notice: null, events: [],
});
const voice = (text: string, segment = 0, revision = 1): NativeVoice => ({
  request_id: 10, segment_id: segment, revision, text, phase: "listening", progress: null,
  muted: false, pending: null,
});
const roots: ReturnType<typeof createTestRoot>[] = [];
let timers: (() => void)[];

beforeEach(() => {
  timers = [];
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  vi.unstubAllGlobals();
});

async function mounted(commands = true) {
  let value = "", renders = 0;
  const receives: ((update: NativeUpdate) => void)[] = [];
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const input: NativeInput = {
    subscribe: (receive) => {
      receives.push(receive);
      const dispose = vi.fn();
      disposals.push(dispose);
      return { initial: Promise.resolve(idle(`view-${receives.length}`)), dispose };
    },
    acknowledge: vi.fn(async () => {}), command: vi.fn(async () => {}),
  };
  const prompt = { current: {
    disabled: false, chip: null, commands,
    selection: () => ({ value, start: value.length, end: value.length }),
    setValue: (next) => { value = next; }, append: () => {}, focus: () => {}, blur: () => {}, submit: () => {},
  } satisfies PromptLineHandle };
  const send = vi.fn(() => true);
  let control: ReturnType<typeof useNativeVoice>;
  function Probe({ scope }: { scope: string }) {
    control = useNativeVoice({ prompt, scope, enabled: true, send });
    renders++;
    return null;
  }
  const root = createTestRoot("native input subscription");
  roots.push(root);
  const handlers = new Map<ControlCommand["type"], ControlHandler>();
  const cli: ClientControl = { register(commands, handler) {
    for (const command of commands) handlers.set(command, handler);
    return () => { for (const command of commands) handlers.delete(command); };
  } };
  const render = (scope: string) => root.render(<ClientControlProvider control={cli}><NativeInputProvider input={input}><Probe scope={scope} /></NativeInputProvider></ClientControlProvider>);
  await render("ship");
  const push = (revision: number, snapshot: NativeSnapshot, listener = 0, age = 0) => act(() => {
    receives[listener]({ revision, snapshot, sent_at_ms: Date.now() - age });
  });
  const start = () => push(1, { ...idle(), voice: voice("hello"), events: [
    { id: 1, request_id: 10, segment_id: 0, kind: "started", action: null, text: "" },
  ] });
  return { input, disposals, prompt, send, render, push, start, handlers, control: () => control, value: () => value, renders: () => renders };
}

describe("native input subscription", () => {
  it("keeps the selected microphone when the input owner changes and restores it after reopening", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    let lease = 0;
    const dispose = vi.fn();
    const input: NativeInput = {
      subscribe: () => ({ initial: Promise.resolve(idle(`view-${++lease}`)), dispose }),
      acknowledge: vi.fn(async () => {}), command: vi.fn(async () => {}),
    };
    let control!: ReturnType<typeof useNativeVoice>;
    function Probe() {
      control = useNativeVoice({ prompt: { current: null }, scope: "microphone", enabled: true, send: () => false });
      return null;
    }
    const root = createTestRoot("shared microphone preference"); roots.push(root);
    const render = (owner: string) => root.render(<NativeInputProvider input={input}><Probe key={owner} /></NativeInputProvider>);
    await render("settings");
    await act(() => control.setDevice("usb-microphone"));
    await render("chat");
    expect(dispose).toHaveBeenCalledOnce();
    await act(() => control.start());
    expect(input.command).toHaveBeenLastCalledWith("view-2", { kind: "start", device_id: "usb-microphone" });
    await root.unmount();
    await render("reopened");
    expect(control.device).toBe("usb-microphone");
  });

  it("selects the CLI microphone after discovery even when loading updates were coalesced", async () => {
    const app = await mounted();
    const result = app.handlers.get("microphoneUse")!({
      command: { type: "microphoneUse", name: "USB microphone" },
      checkpoint: async () => {}, signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(app.input.command).toHaveBeenCalledWith("view-1", { kind: "devices" }));
    await app.push(1, { ...idle(), devices_revision: 1, devices: [{ id: "usb", name: "USB microphone", is_default: false }] });
    await expect(result).resolves.toMatchObject({ type: "microphoneSelected", status: { selected: { type: "device", name: "USB microphone" } } });
    expect(app.control().device).toBe("usb");
    expect(app.input.command).toHaveBeenCalledTimes(1);
  });

  it("aborts CLI microphone discovery without changing the selected input", async () => {
    const app = await mounted();
    const abort = new AbortController();
    const result = app.handlers.get("microphoneUse")!({
      command: { type: "microphoneUse", name: "USB microphone" }, checkpoint: async () => {}, signal: abort.signal,
    });
    const rejected = expect(result).rejects.toMatchObject({ code: "conflict" });
    await vi.waitFor(() => expect(app.input.command).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    await app.push(1, { ...idle(), devices_revision: 1, devices: [{ id: "usb", name: "USB microphone", is_default: false }] });
    expect(app.control().device).toBe("");
  });

  it("updates dictated text without rerendering controls or rendering on a heartbeat", async () => {
    const app = await mounted();
    const idleRenders = app.renders();
    await act(() => timers.at(-1)!());
    expect(app.renders()).toBe(idleRenders);
    await app.start();
    const listeningRenders = app.renders();
    await app.push(2, { ...idle(), voice: voice("hello world", 0, 2) });
    expect(app.value()).toBe("hello world");
    expect(app.renders()).toBe(listeningRenders);
    expect(app.input.acknowledge).toHaveBeenLastCalledWith("view-1", 2, 1);
  });

  it("submits a completion once even when only the acknowledged event lane changes", async () => {
    const app = await mounted();
    await app.start();
    const renders = app.renders();
    const next: NativeSnapshot = { ...idle(), voice: voice("", 1, 0), events: [
      { id: 2, request_id: 10, segment_id: 0, kind: "segment", action: "send", text: "hello" },
    ] };
    await app.push(2, next);
    await app.push(3, next);
    expect(app.send).toHaveBeenCalledExactlyOnceWith("hello");
    expect(app.value()).toBe("");
    expect(app.renders()).toBe(renders);
    expect(app.input.acknowledge).toHaveBeenLastCalledWith("view-1", 3, 2);
  });

  it("clears dollar-prefixed notes after dictating an action request", async () => {
    const app = await mounted(false);
    app.prompt.current.setValue("$ ");
    await app.start();
    await app.push(2, { ...idle(), voice: voice("", 1, 0), events: [
      { id: 2, request_id: 10, segment_id: 0, kind: "segment", action: "send", text: "30 a day" },
    ] });
    expect(app.send).toHaveBeenCalledExactlyOnceWith("$ 30 a day");
    expect(app.value()).toBe("");
  });

  it("finalizes Enter before submission and retains terminal mode for the next dictated command", async () => {
    const app = await mounted();
    app.prompt.current.setValue("$ ");
    await app.start();
    expect(app.control().interceptSubmit()).toBe(true);
    expect(app.send).not.toHaveBeenCalled();
    expect(app.input.command).toHaveBeenLastCalledWith("view-1", { kind: "segment", request_id: 10, segment_id: 0, action: "send" });
    await app.push(2, { ...idle(), voice: voice("", 1, 0), events: [
      { id: 2, request_id: 10, segment_id: 0, kind: "segment", action: "send", text: "pwd" },
    ] });
    expect(app.send).toHaveBeenCalledExactlyOnceWith("$ pwd");
    expect(app.value()).toBe("$ ");
    await app.push(3, { ...idle(), voice: voice("", 2, 0), events: [
      { id: 3, request_id: 10, segment_id: 1, kind: "segment", action: "send", text: "ls" },
    ] });
    expect(app.send).toHaveBeenNthCalledWith(2, "$ ls");
    expect(app.value()).toBe("$ ");
  });

  it("sends the dictated draft and pauses capture through the host's finish", async () => {
    const app = await mounted();
    app.prompt.current.setValue("typed ");
    await app.start();
    await act(() => app.control().send());
    expect(app.input.command).toHaveBeenLastCalledWith("view-1", { kind: "finish", request_id: 10 });
    expect(app.send).not.toHaveBeenCalled();
    await app.push(2, { ...idle(), events: [
      { id: 2, request_id: 10, segment_id: 0, kind: "final", action: "send", text: "hello there" },
    ] });
    expect(app.send).toHaveBeenCalledExactlyOnceWith("typed hello there");
    expect(app.value()).toBe("");
    expect(app.control().capturing).toBe(false);
  });

  it("does not request a send before dictation is listening", async () => {
    const app = await mounted();
    await act(() => app.control().send());
    await app.push(1, { ...idle(), voice: { ...voice(""), phase: "loading" }, events: [
      { id: 1, request_id: 10, segment_id: 0, kind: "started", action: null, text: "" },
    ] });
    await act(() => timers.at(-1)!());
    expect(app.input.command).not.toHaveBeenCalled();
  });

  it("retains rejected submissions and stops dictation without replaying the send", async () => {
    const app = await mounted();
    app.prompt.current.setValue("$ ");
    await app.start();
    app.send.mockReturnValue(false);
    const next: NativeSnapshot = { ...idle(), voice: voice("", 1, 0), events: [
      { id: 2, request_id: 10, segment_id: 0, kind: "segment", action: "send", text: "pwd" },
    ] };
    await app.push(2, next);
    await app.push(3, next);
    expect(app.send).toHaveBeenCalledExactlyOnceWith("$ pwd");
    expect(app.value()).toBe("$ pwd");
    expect(app.input.command).toHaveBeenCalledWith("view-1", { kind: "cancel" });
  });

  it("disposes the old subscription before another workspace can consume its output", async () => {
    const app = await mounted();
    await app.render("helper");
    expect(app.disposals[0]).toHaveBeenCalledOnce();
    await app.start();
    expect(app.value()).toBe("");
    expect(app.send).not.toHaveBeenCalled();
  });

  it("preserves the draft and refuses stale sends after suspension", async () => {
    const app = await mounted();
    await app.start();
    await app.push(2, { ...idle(), voice: voice("", 1, 0), events: [
      { id: 2, request_id: 10, segment_id: 0, kind: "segment", action: "send", text: "hello" },
    ] }, 0, 2000);
    expect(app.send).not.toHaveBeenCalled();
    expect(app.value()).toBe("hello");
    expect(app.disposals[0]).toHaveBeenCalledOnce();
  });

  it("keeps live dictated text after a helper failure and ignores its late final", async () => {
    const app = await mounted();
    app.prompt.current.setValue("typed: ");
    await app.start();
    await app.push(2, { ...idle(), notice: "The speech engine stopped. Your unsent text is still in the prompt." });
    expect(app.value()).toBe("typed: hello");
    expect(app.control().snapshot?.notice).toContain("speech engine stopped");
    await app.push(3, { ...idle(), events: [
      { id: 2, request_id: 10, segment_id: 0, kind: "final", action: null, text: "late output" },
    ] });
    expect(app.value()).toBe("typed: hello");
    expect(app.send).not.toHaveBeenCalled();
  });
});
