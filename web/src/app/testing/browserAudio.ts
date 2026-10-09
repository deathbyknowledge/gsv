import { vi } from "vitest";

export function installBrowserAudio() {
  const track = new EventTarget();
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack, addEventListener: track.addEventListener.bind(track), removeEventListener: track.removeEventListener.bind(track) }] };
  const microphone = vi.fn(async () => stream);
  const recorders: Recorder[] = [];
  const supported = vi.fn((type: string) => type === "audio/webm;codecs=opus");
  class Recorder {
    static isTypeSupported = supported;
    state = "inactive";
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    finalData = new Blob(["audio"], { type: "audio/webm;codecs=opus" });
    constructor(_stream: typeof stream, options: MediaRecorderOptions) {
      this.mimeType = options.mimeType ?? "audio/webm";
      recorders.push(this);
    }
    start() { this.state = "recording"; }
    stop = vi.fn(() => {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: this.finalData });
        this.onstop?.();
      });
    });
  }
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: microphone } });
  vi.stubGlobal("MediaRecorder", Recorder);
  return { microphone, stream, track, stopTrack, recorders, supported };
}
