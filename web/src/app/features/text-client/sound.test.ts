import { describe, expect, it, vi } from "vitest";
import {
  createTextClientSoundGate,
  createTextClientSounds,
  soundForInteraction,
  soundForTextChange,
} from "./sound";

describe("text client sound mapping", () => {
  it("classifies the changed text range instead of only comparing lengths", () => {
    expect(soundForTextChange("ac", "a c")).toBe("space");
    expect(soundForTextChange("a c", "ac")).toBe("delete");
    expect(soundForTextChange("tail", "t中ail")).toBe("character");
    expect(soundForTextChange("one", "one\ntwo")).toBe("character");
    expect(soundForTextChange("one", "one\n")).toBe("commit");
    expect(soundForTextChange("🙂x", "🙂 x")).toBe("space");
    expect(soundForTextChange("same", "same")).toBeNull();
  });

  it("maps product interactions onto the native sound palette", () => {
    expect(soundForInteraction("send")).toBe("commit");
    expect(soundForInteraction("select")).toBe("navigate");
    expect(soundForInteraction("stop")).toBe("delete");
  });
});

describe("text client sound rate gate", () => {
  it("drops key bursts while keeping commit feedback immediate", () => {
    const gate = createTextClientSoundGate();

    expect(gate.allows("character", 1_000)).toBe(true);
    expect(gate.allows("character", 1_004)).toBe(false);
    expect(gate.allows("commit", 1_005)).toBe(true);
    expect(gate.allows("character", 1_022)).toBe(false);
    expect(gate.allows("character", 1_023)).toBe(true);
  });

  it("gives navigation its own slower cadence and can be reset", () => {
    const gate = createTextClientSoundGate();

    expect(gate.allows("navigate", 2_000)).toBe(true);
    expect(gate.allows("navigate", 2_081)).toBe(false);
    expect(gate.allows("navigate", 2_082)).toBe(true);
    gate.reset();
    expect(gate.allows("navigate", 2_083)).toBe(true);
  });
});

describe("text client sound controller", () => {
  it("creates and resumes Web Audio lazily without replaying a key burst", async () => {
    const starts: Array<ReturnType<typeof vi.fn>> = [];
    let state: AudioContextState = "suspended";
    const context = {
      get state() { return state; },
      sampleRate: 48_000,
      destination: {},
      resume: vi.fn(async () => { state = "running"; }),
      suspend: vi.fn(async () => { state = "suspended"; }),
      close: vi.fn(async () => { state = "closed"; }),
      createBuffer: vi.fn(() => ({ copyToChannel: vi.fn() })),
      createBufferSource: vi.fn(() => {
        const start = vi.fn();
        starts.push(start);
        return {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null,
          start,
        };
      }),
    } as unknown as AudioContext;
    const audioContextFactory = vi.fn(() => context);
    let now = 1_000;
    const sounds = createTextClientSounds({ audioContextFactory, now: () => now });

    expect(audioContextFactory).not.toHaveBeenCalled();
    expect(sounds.playTextChange("", "a")).toBe(true);
    now += 20;
    expect(sounds.playTextChange("a", "ab")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContextFactory).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toHaveBeenCalledTimes(1);
    sounds.dispose();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("does not open audio while muted and suspends an unlocked context when muted", async () => {
    let state: AudioContextState = "running";
    const context = {
      get state() { return state; },
      sampleRate: 48_000,
      destination: {},
      resume: vi.fn(async () => { state = "running"; }),
      suspend: vi.fn(async () => { state = "suspended"; }),
      close: vi.fn(async () => { state = "closed"; }),
      createBuffer: vi.fn(() => ({ copyToChannel: vi.fn() })),
      createBufferSource: vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null,
        start: vi.fn(),
      })),
    } as unknown as AudioContext;
    const audioContextFactory = vi.fn(() => context);
    const sounds = createTextClientSounds({ audioContextFactory, muted: true });

    expect(sounds.play("send")).toBe(false);
    expect(audioContextFactory).not.toHaveBeenCalled();
    sounds.setMuted(false);
    expect(sounds.play("send")).toBe(true);
    expect(audioContextFactory).toHaveBeenCalledTimes(1);
    sounds.setMuted(true);
    await Promise.resolve();
    expect(context.suspend).toHaveBeenCalledTimes(1);
    sounds.dispose();
  });
});
