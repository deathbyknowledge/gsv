import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../testing/testHarness";
import type { PromptLineHandle } from "../../features/instrument/shared/PromptLine";
import { NativeInputProvider, type NativeInput, type NativeSnapshot, type NativeUpdate, type NativeVoice } from "./PlatformProvider";
import { useNativeVoice } from "./useNativeVoice";

const idle = (lease = "view-1"): NativeSnapshot => ({
  lease, voice: null, gestures_enabled: false, gesture_status: "off",
  gesture_context: { mode: "disarmed" }, gesture_progress: null, gesture_action: null, gesture_action_sequence: 0, gesture_needs_reset: false, gesture_reset_after_action: 0,
  gesture_practice: null,
  scroll_velocity: 0, scroll_sequence: 0, devices: [], devices_loading: false, notice: null, events: [],
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

async function mounted() {
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
  const prompt: { current: PromptLineHandle } = { current: {
    disabled: false, chip: null,
    selection: () => ({ value, start: value.length, end: value.length }),
    setValue: (next) => { value = next; }, append: () => {}, focus: () => {}, blur: () => {}, submit: () => {},
  } };
  const send = vi.fn(() => true);
  const scroll = vi.fn();
  function Probe({ scope }: { scope: string }) {
    useNativeVoice({ prompt, scope, enabled: true, send, scroll });
    renders++;
    return null;
  }
  const root = createTestRoot("native input subscription");
  roots.push(root);
  const render = (scope: string) => root.render(<NativeInputProvider input={input}><Probe scope={scope} /></NativeInputProvider>);
  await render("ship");
  const push = (revision: number, snapshot: NativeSnapshot, listener = 0, age = 0) => act(() => {
    receives[listener]({ revision, snapshot, sent_at_ms: Date.now() - age, scroll_age_ms: 0 });
  });
  const start = () => push(1, { ...idle(), voice: voice("hello"), events: [
    { id: 1, request_id: 10, segment_id: 0, kind: "started", action: null, text: "" },
  ] });
  return { input, disposals, prompt, send, render, push, start, value: () => value, renders: () => renders };
}

describe("native input subscription", () => {
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
});
