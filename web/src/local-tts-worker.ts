import { TtsSession } from "@mintplex-labs/piper-tts-web";
import {
  GSV_ONNX_RUNTIME_BASE,
  GSV_PIPER_VOICE_BASE,
  GSV_PIPER_WASM_BASE,
  HUGGINGFACE_PIPER_VOICE_BASE,
} from "./local-tts-assets";

type PiperProgress = {
  url: string;
  total: number;
  loaded: number;
};

type LocalSpeechProgress = {
  phase: "loading" | "downloading" | "generating";
  message: string;
};

type WorkerRequest = {
  id: number;
  text: string;
  voiceId: string;
};

type WorkerResponse =
  | { type: "progress"; id: number; progress: LocalSpeechProgress }
  | { type: "result"; id: number; audio: Blob }
  | { type: "error"; id: number; error: string };

let publicVoiceFetchInstalled = false;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data);
});

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    installPublicVoiceFetch();
    post({
      type: "progress",
      id: request.id,
      progress: { phase: "loading", message: "Loading local voice engine" },
    });
    const session = await TtsSession.create({
      voiceId: request.voiceId,
      progress: (progress: PiperProgress) => post({
        type: "progress",
        id: request.id,
        progress: formatPiperProgress(progress),
      }),
      wasmPaths: {
        onnxWasm: GSV_ONNX_RUNTIME_BASE,
        piperData: `${GSV_PIPER_WASM_BASE}.data`,
        piperWasm: `${GSV_PIPER_WASM_BASE}.wasm`,
      },
    });

    post({
      type: "progress",
      id: request.id,
      progress: { phase: "generating", message: `Generating ${voiceLabel(request.voiceId)}` },
    });
    const audio = await session.predict(request.text);
    post({ type: "result", id: request.id, audio });
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function installPublicVoiceFetch(): void {
  if (publicVoiceFetchInstalled) {
    return;
  }
  publicVoiceFetchInstalled = true;

  const originalFetch = self.fetch.bind(self);
  self.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const publicUrl = url ? publicVoiceAssetUrl(url) : null;
    if (!publicUrl) {
      return originalFetch(input, init);
    }

    return originalFetch(publicUrl, init);
  };
}

function requestUrl(input: RequestInfo | URL): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function publicVoiceAssetUrl(url: string): string | null {
  if (!url.startsWith(`${HUGGINGFACE_PIPER_VOICE_BASE}/`)) {
    return null;
  }

  const voicePath = url.slice(HUGGINGFACE_PIPER_VOICE_BASE.length + 1);
  return `${GSV_PIPER_VOICE_BASE}/${voicePath}`;
}

function formatPiperProgress(progress: PiperProgress): LocalSpeechProgress {
  const total = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 0;
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((progress.loaded / total) * 100))) : 0;
  const filename = progress.url.split("/").pop() || "voice model";
  return {
    phase: "downloading",
    message: total > 0 ? `Downloading ${filename} ${percent}%` : `Downloading ${filename}`,
  };
}

function voiceLabel(voiceId: string): string {
  return voiceId
    .replace(/^en_US-/, "")
    .replace(/-/g, " ");
}
