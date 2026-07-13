import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresenceRecorder } from "./recording";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported() {
    return true;
  }

  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recorderOptions() {
  return {
    isConnected: () => true,
    isDestroyed: () => false,
    isSpeechOutputPlaying: () => false,
    cancelSpeechOutput: () => {},
    activeRunCount: () => 0,
    hasAmbientPendingJobs: () => false,
    ambientIdleNote: () => "Listening",
    setPanelOpen: () => {},
    setNote: () => {},
    getState: () => "idle" as const,
    setState: () => {},
    transcribe: async () => ({ text: "ok", provider: "test", model: "test" }),
    onPushTranscribed: () => {},
    onAmbientSegment: () => {},
  };
}

function installMediaGlobals(streamRequest: Promise<MediaStream>) {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(() => streamRequest),
    },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("window", {
    AudioContext: class {},
    clearInterval: vi.fn(),
    setInterval: vi.fn(() => 1),
  });
}

afterEach(() => {
  FakeMediaRecorder.instances = [];
  vi.unstubAllGlobals();
});

describe("presence recorder permission races", () => {
  it("discards a push stream granted after recording was cancelled", async () => {
    const request = deferred<MediaStream>();
    const stop = vi.fn();
    installMediaGlobals(request.promise);
    const recorder = createPresenceRecorder(recorderOptions());

    const starting = recorder.startPushRecording();
    recorder.cleanupPushRecorder();
    request.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;

    expect(stop).toHaveBeenCalledOnce();
    expect(recorder.isPushActive()).toBe(false);
  });

  it("stops a granted stream when MediaRecorder construction fails", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    installMediaGlobals(Promise.resolve(stream));
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported() {
        return true;
      }

      constructor() {
        throw new Error("recorder unavailable");
      }
    });
    const recorder = createPresenceRecorder(recorderOptions());

    await recorder.startPushRecording();

    expect(stop).toHaveBeenCalledOnce();
    expect(recorder.isPushActive()).toBe(false);
  });

  it("detaches a queued push stop handler during cleanup", async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    installMediaGlobals(Promise.resolve(stream));
    const recorder = createPresenceRecorder(recorderOptions());

    await recorder.startPushRecording();
    const instance = FakeMediaRecorder.instances[0];
    recorder.stopPushRecording();
    expect(instance.onstop).toBeTypeOf("function");

    recorder.cleanupPushRecorder();

    expect(instance.onstop).toBeNull();
    expect(instance.ondataavailable).toBeNull();
  });

  it("discards an ambient stream granted after listening was stopped", async () => {
    const request = deferred<MediaStream>();
    const stop = vi.fn();
    installMediaGlobals(request.promise);
    const recorder = createPresenceRecorder(recorderOptions());

    const starting = recorder.startAmbient();
    recorder.stopAmbient();
    request.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;

    expect(stop).toHaveBeenCalledOnce();
    expect(recorder.isAmbientActive()).toBe(false);
  });

  it("suppresses a queued ambient stop event when listening stops", async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    let tick: (() => void) | undefined;
    const onAmbientSegment = vi.fn();
    installMediaGlobals(Promise.resolve(stream));
    vi.stubGlobal("window", {
      AudioContext: class {
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() };
        }

        createAnalyser() {
          return {
            fftSize: 32,
            disconnect: vi.fn(),
            getFloatTimeDomainData: (samples: Float32Array) => samples.fill(1),
          };
        }

        close() {
          return Promise.resolve();
        }
      },
      clearInterval: vi.fn(),
      setInterval: vi.fn((callback: () => void) => {
        tick = callback;
        return 1;
      }),
    });
    const recorder = createPresenceRecorder({ ...recorderOptions(), onAmbientSegment });

    await recorder.startAmbient();
    tick?.();
    const segmentRecorder = FakeMediaRecorder.instances[0];
    expect(segmentRecorder.onstop).toBeTypeOf("function");
    segmentRecorder.stop();

    recorder.stopAmbient();

    expect(segmentRecorder.onstop).toBeNull();
    expect(onAmbientSegment).not.toHaveBeenCalled();
  });
});
