import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/testHarness";
import { observeVoiceWaveform, VOICE_WAVEFORM_COLUMNS } from "./voiceWaveform";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function microphone() {
  let amplitude = 0, nextFrame = 0;
  const stop = vi.fn();
  vi.stubGlobal("MediaStream", class { getTracks() { return [{ stop }]; } });
  const stream = new MediaStream();
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = { fftSize: 0, getFloatTimeDomainData: (data: Float32Array) => data.fill(amplitude) };
  const context = { createMediaStreamSource: vi.fn(() => source), createAnalyser: vi.fn(() => analyser),
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  vi.stubGlobal("AudioContext", vi.fn(function () { return context; }));
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (draw: FrameRequestCallback) => { frames.set(++nextFrame, draw); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const motion = { matches: false };
  vi.stubGlobal("window", { matchMedia: () => motion });
  const step = (time: number) => {
    const frame = frames.entries().next().value;
    if (!frame) throw new Error("No waveform frame scheduled");
    frames.delete(frame[0]);
    frame[1](time);
  };
  return { stream, stop, context, source, analyser, frames, motion, step, setAmplitude: (value: number) => { amplitude = value; } };
}

describe("microphone waveform", () => {
  it("shows silence and measured voice levels in a bounded history without speaker playback", async () => {
    const mic = microphone();
    const history: number[][] = [];
    const dispose = observeVoiceWaveform(mic.stream, (levels) => history.push(Array.from(levels)), vi.fn());
    await Promise.resolve();
    mic.step(60);
    expect(history[0].every((level) => level === 0)).toBe(true);
    mic.setAmplitude(0.1);
    mic.step(120);
    expect(history[1].at(-1)).toBeCloseTo(2 / 3);
    mic.setAmplitude(2);
    mic.step(180);
    expect(history[2].at(-1)).toBe(1);
    expect(history[2].at(-2)).toBeCloseTo(2 / 3);
    expect(history.every((levels) => levels.length === VOICE_WAVEFORM_COLUMNS)).toBe(true);
    expect(mic.source.connect).toHaveBeenCalledExactlyOnceWith(mic.analyser);
    dispose();
    expect(mic.context.close).toHaveBeenCalledOnce();
    expect(mic.source.disconnect).toHaveBeenCalledOnce();
    expect(mic.frames.size).toBe(0);
    expect(mic.stop).not.toHaveBeenCalled();
  });

  it("reduces visual updates when reduced motion is requested", async () => {
    const mic = microphone();
    mic.motion.matches = true;
    const draw = vi.fn();
    const dispose = observeVoiceWaveform(mic.stream, draw, vi.fn());
    await Promise.resolve();
    mic.step(60);
    mic.step(180);
    expect(draw).not.toHaveBeenCalled();
    mic.step(250);
    expect(draw).toHaveBeenCalledOnce();
    dispose();
  });

  it("cannot restart an animation after a cancelled audio context resumes", async () => {
    const mic = microphone();
    const resumed = deferred<void>();
    mic.context.resume.mockReturnValue(resumed.promise);
    const dispose = observeVoiceWaveform(mic.stream, vi.fn(), vi.fn());
    dispose();
    resumed.resolve();
    await resumed.promise;
    expect(mic.frames.size).toBe(0);
    expect(mic.context.close).toHaveBeenCalledOnce();
  });

  it("releases partial setup and reports a failed resume without stopping capture", async () => {
    const mic = microphone();
    mic.context.createAnalyser.mockImplementationOnce(() => { throw new Error("No audio resources"); });
    expect(() => observeVoiceWaveform(mic.stream, vi.fn(), vi.fn())).toThrow("No audio resources");
    expect(mic.context.close).toHaveBeenCalledOnce();
    const failed = vi.fn();
    const cause = new Error("Audio context cannot resume");
    mic.context.resume.mockRejectedValueOnce(cause);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    observeVoiceWaveform(mic.stream, vi.fn(), failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(diagnostic).toHaveBeenCalledWith("Voice visualization unavailable", cause);
    expect(mic.context.close).toHaveBeenCalledTimes(2);
    expect(mic.stop).not.toHaveBeenCalled();
  });
});
