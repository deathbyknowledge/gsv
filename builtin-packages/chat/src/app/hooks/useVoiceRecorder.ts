import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Attachment, VoiceRecordingState } from "../types";
import { formatError, readAttachmentBlob } from "../view-helpers";

export const EMPTY_VOICE_RECORDING: VoiceRecordingState = { status: "idle", elapsedMs: 0 };

const VOICE_AUDIO_BITS_PER_SECOND = 128000;
const MAX_VOICE_RECORDING_MS = 10 * 60 * 1000;
const VOICE_RECORDER_MIME_TYPES = [
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

function selectVoiceRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return VOICE_RECORDER_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function extensionForVoiceMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4" || normalized === "audio/aac") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/mpeg") return "mp3";
  return "webm";
}

function voiceRecordingFilename(mimeType: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `voice-${stamp}.${extensionForVoiceMimeType(mimeType)}`;
}

export function useVoiceRecorder({
  interactive,
  messageBusy,
  previewUrlsRef,
  onAttachment,
}: {
  interactive: boolean;
  messageBusy: boolean;
  previewUrlsRef: { current: Set<string> };
  onAttachment(attachment: Attachment): void;
}) {
  const [voice, setVoice] = useState<VoiceRecordingState>(EMPTY_VOICE_RECORDING);
  const voiceRecorderAvailable = useMemo(() => canUseBrowserVoiceRecorder(), []);
  const mountedRef = useRef(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recorderStartedAtRef = useRef(0);
  const recorderElapsedMsRef = useRef(0);
  const recorderTimerRef = useRef<number | null>(null);
  const recorderCancelRef = useRef(false);

  const clearVoiceTimer = useCallback(() => {
    if (recorderTimerRef.current !== null) {
      window.clearInterval(recorderTimerRef.current);
      recorderTimerRef.current = null;
    }
  }, []);

  const stopVoiceStream = useCallback(() => {
    const stream = recorderStreamRef.current;
    recorderStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const cleanupVoiceRecorder = useCallback(() => {
    clearVoiceTimer();
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
    stopVoiceStream();
    recorderRef.current = null;
    recorderChunksRef.current = [];
    recorderStartedAtRef.current = 0;
    recorderElapsedMsRef.current = 0;
  }, [clearVoiceTimer, stopVoiceStream]);

  const finishVoiceRecording = useCallback(async () => {
    clearVoiceTimer();
    const recorder = recorderRef.current;
    const chunks = recorderChunksRef.current.slice();
    const cancelled = recorderCancelRef.current;
    const startedAt = recorderStartedAtRef.current;
    const elapsedMs = Math.max(recorderElapsedMsRef.current, startedAt > 0 ? Date.now() - startedAt : 0);
    const mimeType = recorder?.mimeType || chunks.find((chunk) => chunk.type)?.type || "audio/webm";
    cleanupVoiceRecorder();
    recorderCancelRef.current = false;

    if (!mountedRef.current) {
      return;
    }
    if (cancelled) {
      setVoice(EMPTY_VOICE_RECORDING);
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
      const attachment = await readAttachmentBlob(blob, voiceRecordingFilename(mimeType), elapsedMs / 1000);
      if (!mountedRef.current) {
        URL.revokeObjectURL(previewUrl);
        previewUrlsRef.current.delete(previewUrl);
        return;
      }
      onAttachment({ ...attachment, type: "audio", previewUrl });
      setVoice(EMPTY_VOICE_RECORDING);
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      previewUrlsRef.current.delete(previewUrl);
      if (mountedRef.current) {
        setVoice({ status: "idle", elapsedMs: 0, error: "Voice read failed: " + formatError(error) });
      }
    }
  }, [cleanupVoiceRecorder, clearVoiceTimer, onAttachment, previewUrlsRef]);

  const stopVoiceRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    const startedAt = recorderStartedAtRef.current;
    const elapsedMs = Math.max(recorderElapsedMsRef.current, startedAt > 0 ? Date.now() - startedAt : 0);
    recorderElapsedMsRef.current = elapsedMs;
    setVoice({ status: "processing", elapsedMs });
    recorder.stop();
  }, []);

  const cancelVoiceRecording = useCallback(() => {
    recorderCancelRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }
    cleanupVoiceRecorder();
    setVoice(EMPTY_VOICE_RECORDING);
  }, [cleanupVoiceRecorder]);

  const startVoiceRecording = useCallback(async () => {
    if (!interactive || messageBusy || voice.status !== "idle") {
      return;
    }
    if (!voiceRecorderAvailable) {
      setVoice({ status: "idle", elapsedMs: 0, error: "Voice recording is not available in this browser." });
      return;
    }

    cleanupVoiceRecorder();
    recorderCancelRef.current = false;
    recorderChunksRef.current = [];
    setVoice({ status: "requesting", elapsedMs: 0 });

    try {
      const stream = await requestVoiceStream();
      if (!mountedRef.current || recorderCancelRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        recorderCancelRef.current = false;
        if (mountedRef.current) {
          setVoice(EMPTY_VOICE_RECORDING);
        }
        return;
      }
      const mimeType = selectVoiceRecorderMimeType();
      const options: MediaRecorderOptions = { audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND };
      if (mimeType) {
        options.mimeType = mimeType;
      }
      const recorder = new MediaRecorder(stream, options);
      recorderRef.current = recorder;
      recorderStreamRef.current = stream;
      recorderStartedAtRef.current = Date.now();
      recorderElapsedMsRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recorderChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        recorderCancelRef.current = true;
        cleanupVoiceRecorder();
        setVoice({ status: "idle", elapsedMs: 0, error: "Voice recording failed." });
      };
      recorder.onstop = () => {
        void finishVoiceRecording();
      };

      recorder.start(1000);
      recorderTimerRef.current = window.setInterval(() => {
        const elapsedMs = Date.now() - recorderStartedAtRef.current;
        recorderElapsedMsRef.current = elapsedMs;
        setVoice((current) => current.status === "recording" ? { ...current, elapsedMs } : current);
        if (elapsedMs >= MAX_VOICE_RECORDING_MS && recorderRef.current?.state === "recording") {
          setVoice({ status: "processing", elapsedMs });
          recorderRef.current.stop();
        }
      }, 250);
      setVoice({ status: "recording", elapsedMs: 0 });
    } catch (error) {
      cleanupVoiceRecorder();
      recorderCancelRef.current = false;
      if (mountedRef.current) {
        setVoice({ status: "idle", elapsedMs: 0, error: "Microphone failed: " + formatError(error) });
      }
    }
  }, [cleanupVoiceRecorder, finishVoiceRecording, interactive, messageBusy, voice.status, voiceRecorderAvailable]);

  const clearVoiceError = useCallback(() => {
    setVoice(EMPTY_VOICE_RECORDING);
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      recorderCancelRef.current = true;
      cleanupVoiceRecorder();
    };
  }, [cleanupVoiceRecorder]);

  return {
    voice,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    clearVoiceError,
  };
}
