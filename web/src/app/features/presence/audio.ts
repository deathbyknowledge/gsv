import { PRESENCE_RECORDER_MIME_TYPES } from "./constants";

type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export function canUseBrowserVoiceRecorder(): boolean {
  const browserNavigator = globalThis.navigator;
  return Boolean(browserNavigator?.mediaDevices && globalThis.MediaRecorder);
}

export function canUseAmbientMode(): boolean {
  return canUseBrowserVoiceRecorder() && Boolean(resolveAudioContext());
}

export async function requestVoiceStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

export function createAudioContext(): AudioContext {
  const AudioContextConstructor = resolveAudioContext();
  if (!AudioContextConstructor) {
    throw new Error("Audio analysis is unavailable in this browser");
  }
  return new AudioContextConstructor();
}

export function selectVoiceRecorderMimeType(): string {
  const recorder = globalThis.MediaRecorder;
  if (!recorder?.isTypeSupported) {
    return "";
  }
  return PRESENCE_RECORDER_MIME_TYPES.find((mimeType) => recorder.isTypeSupported(mimeType)) || "";
}

export function presenceRecordingFilename(mimeType: string, timestamp = Date.now()): string {
  const stamp = new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `presence-${stamp}.${extensionForVoiceMimeType(mimeType)}`;
}

export function currentRms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length);
}

export function totalBlobSize(blobs: Blob[]): number {
  return blobs.reduce((sum, blob) => sum + blob.size, 0);
}

function resolveAudioContext(): typeof AudioContext | null {
  const browserWindow = globalThis.window;
  if (!browserWindow) {
    return null;
  }
  // SAFETY: The browser window may expose the prefixed constructor on legacy engines.
  const audioWindow = browserWindow as AudioWindow;
  return browserWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function extensionForVoiceMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4" || normalized === "audio/aac") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/mpeg") return "mp3";
  return "webm";
}
