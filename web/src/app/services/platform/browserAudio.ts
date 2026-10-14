export const MAX_VOICE_SECONDS = 5 * 60;
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

export function browserRecordingUnavailable(): string | null {
  if (!globalThis.isSecureContext) return "Voice recording needs HTTPS or localhost.";
  if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in globalThis)) {
    return "Voice recording is unavailable in this browser.";
  }
  return null;
}

/** Own the microphone until stop, failure or cancellation, including late permission grants. */
export async function captureBrowserAudio(signal: AbortSignal, onStart: (stop: () => void, stream: MediaStream) => void): Promise<Blob> {
  signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const tracks = stream.getTracks();
  const release = () => { for (const track of tracks) track.stop(); };
  try {
    signal.throwIfAborted();
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
    return await new Promise<Blob>((resolve, reject) => {
      const chunks: Blob[] = [];
      let size = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        for (const track of tracks) track.removeEventListener("ended", stop);
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") recorder.stop();
        release();
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const cancel = () => fail(new DOMException("Recording cancelled", "AbortError"));
      const stop = () => {
        clearTimeout(timer);
        if (recorder.state !== "inactive") recorder.stop();
        release();
      };
      recorder.ondataavailable = ({ data }) => {
        size += data.size;
        if (size > MAX_VOICE_BYTES) {
          fail(new Error("Recording is too large. Try a shorter recording."));
          return;
        }
        if (data.size) chunks.push(data);
      };
      recorder.onerror = (event) => fail("error" in event && event.error instanceof DOMException
        ? event.error : new Error("The microphone recording failed. Please try again.", { cause: event }));
      recorder.onstop = () => {
        const audio = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type });
        cleanup();
        if (!audio.size) reject(new Error("No audio was recorded. Please try again."));
        else if (!audio.type.startsWith("audio/")) reject(new Error("The browser did not provide a supported audio format."));
        else resolve(audio);
      };
      signal.addEventListener("abort", cancel, { once: true });
      for (const track of tracks) track.addEventListener("ended", stop, { once: true });
      try {
        recorder.start(1000);
        timer = setTimeout(stop, MAX_VOICE_SECONDS * 1000);
        onStart(stop, stream);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } finally {
    release();
  }
}
