import { DEFAULT_PIPER_VOICE } from "./local-tts-assets";

export type LocalSpeechProgress = {
  phase: "loading" | "downloading" | "generating";
  message: string;
};

export type LocalSpeechOptions = {
  voiceId?: string;
  onProgress?: (progress: LocalSpeechProgress) => void;
};

const LOCAL_PIPER_VOICE_KEY = "gsv.presence.tts.voice";

type WorkerRequest = {
  id: number;
  text: string;
  voiceId: string;
};

type WorkerMessage =
  | { type: "progress"; id: number; progress: LocalSpeechProgress }
  | { type: "result"; id: number; audio: Blob }
  | { type: "error"; id: number; error: string };

type PendingSpeech = {
  resolve: (audio: Blob) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: LocalSpeechProgress) => void;
};

let worker: Worker | null = null;
let nextRequestId = 1;
const pendingSpeech = new Map<number, PendingSpeech>();

export function localSpeechSupported(): boolean {
  return typeof WebAssembly !== "undefined"
    && typeof Worker !== "undefined";
}

export async function synthesizeLocalSpeech(
  text: string,
  options: LocalSpeechOptions = {},
): Promise<Blob> {
  if (!localSpeechSupported()) {
    throw new Error("Local speech is not supported by this browser");
  }

  const normalized = text.trim();
  if (!normalized) {
    throw new Error("Local speech text is empty");
  }

  const voiceId = options.voiceId ?? preferredPiperVoice();
  return requestWorkerSpeech({ text: normalized, voiceId }, options.onProgress);
}

export function preferredPiperVoice(): string {
  try {
    return window.localStorage.getItem(LOCAL_PIPER_VOICE_KEY) || DEFAULT_PIPER_VOICE;
  } catch {
    return DEFAULT_PIPER_VOICE;
  }
}

function requestWorkerSpeech(
  request: Omit<WorkerRequest, "id">,
  onProgress: LocalSpeechOptions["onProgress"],
): Promise<Blob> {
  const speechWorker = localSpeechWorker();
  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve, reject) => {
    pendingSpeech.set(id, { resolve, reject, onProgress });
    speechWorker.postMessage({ ...request, id } satisfies WorkerRequest);
  });
}

function localSpeechWorker(): Worker {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./local-tts-worker.ts", import.meta.url), {
    type: "module",
    name: "gsv-local-tts",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    const pending = pendingSpeech.get(message.id);
    if (!pending) {
      return;
    }
    if (message.type === "progress") {
      pending.onProgress?.(message.progress);
      return;
    }
    pendingSpeech.delete(message.id);
    if (message.type === "result") {
      pending.resolve(message.audio);
      return;
    }
    pending.reject(new Error(message.error));
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Local speech worker failed");
    rejectAllPendingSpeech(error);
    worker?.terminate();
    worker = null;
  });
  worker.addEventListener("messageerror", () => {
    const error = new Error("Local speech worker sent an invalid message");
    rejectAllPendingSpeech(error);
    worker?.terminate();
    worker = null;
  });
  return worker;
}

function rejectAllPendingSpeech(error: Error): void {
  for (const pending of pendingSpeech.values()) {
    pending.reject(error);
  }
  pendingSpeech.clear();
}
