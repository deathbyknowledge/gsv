import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ProcMediaInput } from "@humansandmachines/gsv/protocol";
import type { MessageInputAttachment } from "../../../components/ui/MessageInput";

export type ChatVoiceState = {
  elapsedMs: number;
  error?: string;
  status: "idle" | "processing" | "recording" | "requesting";
};

export type ChatVoiceAttachment = ProcMediaInput & MessageInputAttachment & {
  previewUrl?: string;
};

const EMPTY_VOICE_STATE: ChatVoiceState = { status: "idle", elapsedMs: 0 };
const VOICE_AUDIO_BITS_PER_SECOND = 128000;
const MAX_VOICE_RECORDING_MS = 10 * 60 * 1000;
const VOICE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];

function canUseBrowserVoiceRecorder(): boolean {
  return typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";
}

async function requestVoiceStream(): Promise<MediaStream> {
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

function selectVoiceMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return VOICE_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4" || normalized === "audio/aac") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/mpeg") return "mp3";
  return "webm";
}

function voiceFilename(mimeType: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `voice-${stamp}.${extensionForMimeType(mimeType)}`;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) {
    return "";
  }
  const totalSeconds = Math.max(1, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "Unknown error";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read audio"));
    };
    reader.readAsDataURL(blob);
  });
}

type UseChatVoiceRecorderArgs = {
  disabled?: boolean;
  onAttachment: (attachment: ChatVoiceAttachment) => void;
};

export function useChatVoiceRecorder({
  disabled = false,
  onAttachment,
}: UseChatVoiceRecorderArgs) {
  const [voice, setVoice] = useState<ChatVoiceState>(EMPTY_VOICE_STATE);
  const available = useMemo(() => canUseBrowserVoiceRecorder(), []);
  const mountedRef = useRef(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const elapsedMsRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // Recorder state can change between the state check and stop call.
      }
    }
    recorderRef.current = null;
    chunksRef.current = [];
    startedAtRef.current = 0;
    elapsedMsRef.current = 0;
    stopStream();
  }, [clearTimer, stopStream]);

  const finish = useCallback(async () => {
    clearTimer();
    const recorder = recorderRef.current;
    const chunks = chunksRef.current.slice();
    const startedAt = startedAtRef.current;
    const elapsedMs = Math.max(elapsedMsRef.current, startedAt > 0 ? Date.now() - startedAt : 0);
    const mimeType = recorder?.mimeType || chunks.find((chunk) => chunk.type)?.type || "audio/webm";
    cleanup();

    if (!mountedRef.current) {
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      setVoice({ status: "idle", elapsedMs: 0, error: "No audio was captured." });
      return;
    }

    const previewUrl = URL.createObjectURL(blob);
    previewUrlsRef.current.add(previewUrl);
    try {
      const data = await blobToDataUrl(blob);
      if (!mountedRef.current) {
        URL.revokeObjectURL(previewUrl);
        previewUrlsRef.current.delete(previewUrl);
        return;
      }
      const duration = elapsedMs / 1000;
      const filename = voiceFilename(mimeType);
      onAttachment({
        id: `${filename}:${blob.size}:${Date.now()}`,
        type: "audio",
        mimeType,
        data,
        filename,
        size: blob.size,
        duration,
        previewUrl,
        label: filename,
        meta: ["audio", formatDuration(duration)].filter(Boolean).join(" · "),
      });
      setVoice(EMPTY_VOICE_STATE);
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      previewUrlsRef.current.delete(previewUrl);
      if (mountedRef.current) {
        setVoice({ status: "idle", elapsedMs: 0, error: `Voice read failed: ${formatError(error)}` });
      }
    }
  }, [cleanup, clearTimer, onAttachment]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    const startedAt = startedAtRef.current;
    const elapsedMs = Math.max(elapsedMsRef.current, startedAt > 0 ? Date.now() - startedAt : 0);
    elapsedMsRef.current = elapsedMs;
    setVoice({ status: "processing", elapsedMs });
    recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (disabled || voice.status !== "idle") {
      return;
    }
    if (!available) {
      setVoice({ status: "idle", elapsedMs: 0, error: "Voice recording is not available in this browser." });
      return;
    }

    cleanup();
    chunksRef.current = [];
    setVoice({ status: "requesting", elapsedMs: 0 });

    try {
      const stream = await requestVoiceStream();
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = selectVoiceMimeType();
      const options: MediaRecorderOptions = { audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND };
      if (mimeType) {
        options.mimeType = mimeType;
      }
      const recorder = new MediaRecorder(stream, options);
      recorderRef.current = recorder;
      streamRef.current = stream;
      startedAtRef.current = Date.now();
      elapsedMsRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        cleanup();
        if (mountedRef.current) {
          setVoice({ status: "idle", elapsedMs: 0, error: "Voice recording failed." });
        }
      };
      recorder.onstop = () => {
        void finish();
      };

      recorder.start(1000);
      timerRef.current = window.setInterval(() => {
        const elapsedMs = Date.now() - startedAtRef.current;
        elapsedMsRef.current = elapsedMs;
        setVoice((current) => current.status === "recording" ? { ...current, elapsedMs } : current);
        if (elapsedMs >= MAX_VOICE_RECORDING_MS && recorderRef.current?.state === "recording") {
          setVoice({ status: "processing", elapsedMs });
          recorderRef.current.stop();
        }
      }, 250);
      setVoice({ status: "recording", elapsedMs: 0 });
    } catch (error) {
      cleanup();
      if (mountedRef.current) {
        setVoice({ status: "idle", elapsedMs: 0, error: `Microphone failed: ${formatError(error)}` });
      }
    }
  }, [available, cleanup, disabled, finish, voice.status]);

  const toggleRecording = useCallback(() => {
    if (voice.status === "recording") {
      stopRecording();
      return;
    }
    if (voice.status === "idle") {
      void startRecording();
    }
  }, [startRecording, stopRecording, voice.status]);

  const clearVoiceError = useCallback(() => {
    setVoice(EMPTY_VOICE_STATE);
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      cleanup();
      for (const url of previewUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      previewUrlsRef.current.clear();
    };
  }, [cleanup]);

  return {
    available,
    clearVoiceError,
    startRecording,
    stopRecording,
    toggleRecording,
    voice,
  };
}
