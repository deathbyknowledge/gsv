import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AiTranscriptionCreateResult } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  blobToDataUrl,
  canUseAmbientMode,
  canUseBrowserVoiceRecorder,
  presenceRecordingFilename,
  totalBlobSize,
} from "../../presence/audio";
import {
  AMBIENT_MIN_SEGMENT_BYTES,
  AMBIENT_MIN_SEGMENT_MS,
} from "../../presence/constants";
import { createPresenceRecorder, type AmbientSegment, type PresenceRecorder } from "../../presence/recording";
import type { PresenceState } from "../../presence/types";

type ChatAmbientTranscriptionArgs = {
  activeRunCount?: number;
  agentName: string;
  disabled?: boolean;
  isSpeechOutputPlaying?: () => boolean;
  onDictation: (text: string) => void;
  onCancelSpeechOutput?: () => void;
  onTranscript: (text: string) => Promise<void> | void;
};

type ChatVoiceInputMode = "dictation" | "idle" | "live";

type ChatAmbientTranscription = {
  active: boolean;
  dictationActive: boolean;
  dictationTitle: string;
  dictationUnavailable: boolean;
  error: string;
  liveActive: boolean;
  liveTitle: string;
  liveUnavailable: boolean;
  mode: ChatVoiceInputMode;
  note: string;
  state: PresenceState;
  title: string;
  toggleDictation: () => void;
  toggleLive: () => void;
  unavailable: boolean;
};

function formatVoiceError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "Unknown error";
}

function ambientTitle(state: PresenceState, note: string): string {
  if (state === "listening") {
    return note || "Stop live transcription";
  }
  if (state === "capturing") {
    return note || "Capturing speech";
  }
  if (state === "transcribing") {
    return note || "Transcribing speech";
  }
  if (state === "sending") {
    return note || "Sending transcript";
  }
  if (state === "unsupported") {
    return "Live transcription is unavailable in this browser";
  }
  if (state === "error") {
    return note || "Live transcription needs attention";
  }
  return "Start live transcription";
}

function dictationTitle(state: PresenceState, note: string): string {
  if (state === "recording") {
    return note || "Stop dictation";
  }
  if (state === "transcribing") {
    return note || "Transcribing dictation";
  }
  if (state === "unsupported") {
    return "Dictation is unavailable in this browser";
  }
  if (state === "error") {
    return note || "Dictation needs attention";
  }
  return "Dictate one message";
}

function isLiveState(state: PresenceState): boolean {
  return state === "listening"
    || state === "capturing"
    || state === "transcribing"
    || state === "sending";
}

export function useChatAmbientTranscription({
  activeRunCount = 0,
  agentName,
  disabled = false,
  isSpeechOutputPlaying,
  onDictation,
  onCancelSpeechOutput,
  onTranscript,
}: ChatAmbientTranscriptionArgs): ChatAmbientTranscription {
  const { client, connected } = useGateway();
  const [state, setStateValue] = useState<PresenceState>(() => canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
  const [mode, setModeValue] = useState<ChatVoiceInputMode>("idle");
  const [note, setNoteValue] = useState("");
  const [error, setError] = useState("");
  const destroyedRef = useRef(false);
  const stateRef = useRef(state);
  const modeRef = useRef<ChatVoiceInputMode>(mode);
  const connectedRef = useRef(connected);
  const pendingJobsRef = useRef(0);
  const activeRunCountRef = useRef(activeRunCount);
  const onDictationRef = useRef(onDictation);
  const onTranscriptRef = useRef(onTranscript);
  const isSpeechOutputPlayingRef = useRef(isSpeechOutputPlaying);
  const onCancelSpeechOutputRef = useRef(onCancelSpeechOutput);
  const recorderRef = useRef<PresenceRecorder | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    activeRunCountRef.current = activeRunCount;
  }, [activeRunCount]);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    onDictationRef.current = onDictation;
  }, [onDictation]);

  useEffect(() => {
    isSpeechOutputPlayingRef.current = isSpeechOutputPlaying;
  }, [isSpeechOutputPlaying]);

  useEffect(() => {
    onCancelSpeechOutputRef.current = onCancelSpeechOutput;
  }, [onCancelSpeechOutput]);

  const setRecorderState = useCallback((nextState: PresenceState, message?: string) => {
    stateRef.current = nextState;
    setStateValue(nextState);
    if (message !== undefined) {
      setNoteValue(message);
    }
    if (nextState !== "error") {
      setError("");
    }
  }, []);

  const setMode = useCallback((nextMode: ChatVoiceInputMode) => {
    modeRef.current = nextMode;
    setModeValue(nextMode);
  }, []);

  const transcribeBlob = useCallback(async (
    blob: Blob,
    mimeType: string,
    startedAt = Date.now(),
  ): Promise<AiTranscriptionCreateResult> => {
    const data = await blobToDataUrl(blob);
    const result = await client.ai.transcription.create({
      audio: {
        data,
        mimeType,
        filename: presenceRecordingFilename(mimeType, startedAt),
        size: blob.size,
      },
    });
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text) {
      throw new Error("No speech was transcribed");
    }
    return { ...result, text };
  }, [client]);

  const processAmbientSegment = useCallback(async (segment: AmbientSegment) => {
    const durationMs = segment.stoppedAt - segment.startedAt;
    if (durationMs < AMBIENT_MIN_SEGMENT_MS || totalBlobSize(segment.chunks) < AMBIENT_MIN_SEGMENT_BYTES) {
      setNoteValue("Listening");
      setRecorderState(pendingJobsRef.current > 0 ? "transcribing" : "listening");
      return;
    }

    pendingJobsRef.current += 1;
    const blob = new Blob(segment.chunks, { type: segment.mimeType });
    try {
      setNoteValue("Transcribing speech");
      setRecorderState("transcribing");
      const result = await transcribeBlob(blob, segment.mimeType, segment.startedAt);
      const text = result.text.trim();
      if (!text) {
        throw new Error("No speech was transcribed");
      }
      setNoteValue("Sending transcript");
      setRecorderState("sending");
      await onTranscriptRef.current(text);
      setNoteValue("Listening");
      setRecorderState("listening");
    } catch (segmentError) {
      const message = formatVoiceError(segmentError);
      recorderRef.current?.stopAmbient();
      setMode("idle");
      setError(message);
      setNoteValue(message);
      setRecorderState("error", message);
    } finally {
      pendingJobsRef.current = Math.max(0, pendingJobsRef.current - 1);
      if (!destroyedRef.current && connectedRef.current && stateRef.current !== "error" && modeRef.current === "live") {
        setNoteValue(pendingJobsRef.current > 0 ? `Processing ${pendingJobsRef.current}` : "Listening");
        setRecorderState(pendingJobsRef.current > 0 ? "transcribing" : "listening");
      }
    }
  }, [setMode, setRecorderState, transcribeBlob]);

  const handlePushTranscribed = useCallback((result: AiTranscriptionCreateResult) => {
    const text = result.text.trim();
    if (text) {
      onDictationRef.current(text);
    }
    setMode("idle");
    setNoteValue(text ? "Transcribed" : "");
    setRecorderState("idle", text ? "Transcribed" : undefined);
  }, [setMode, setRecorderState]);

  const recorder = useMemo(() => createPresenceRecorder({
    isConnected: () => connectedRef.current,
    isDestroyed: () => destroyedRef.current,
    isSpeechOutputPlaying: () => isSpeechOutputPlayingRef.current?.() ?? false,
    cancelSpeechOutput: () => onCancelSpeechOutputRef.current?.(),
    activeRunCount: () => activeRunCountRef.current,
    hasAmbientPendingJobs: () => pendingJobsRef.current > 0,
    ambientIdleNote: () => pendingJobsRef.current > 0
      ? `Processing ${pendingJobsRef.current}`
      : `Listening to ${agentName}`,
    setPanelOpen: () => {},
    setNote: setNoteValue,
    getState: () => stateRef.current,
    setState: setRecorderState,
    transcribe: transcribeBlob,
    onPushTranscribed: handlePushTranscribed,
    onAmbientSegment: processAmbientSegment,
  }), [agentName, handlePushTranscribed, processAmbientSegment, setRecorderState, transcribeBlob]);

  useEffect(() => {
    recorderRef.current = recorder;
    return () => {
      if (recorderRef.current === recorder) {
        recorderRef.current = null;
      }
    };
  }, [recorder]);

  useEffect(() => {
    destroyedRef.current = false;
    return () => {
      destroyedRef.current = true;
      recorder.destroy();
    };
  }, [recorder]);

  useEffect(() => {
    if (!connected && recorder.isAmbientActive()) {
      recorder.stopAmbient();
    }
    if (!connected && modeRef.current === "dictation") {
      recorder.cleanupPushRecorder();
      setMode("idle");
      setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
    }
  }, [connected, recorder]);

  const toggleLive = useCallback(() => {
    if (recorder.isAmbientActive()) {
      recorder.stopAmbient();
      setMode("idle");
      return;
    }
    if (disabled || !connectedRef.current) {
      return;
    }
    if (!canUseAmbientMode()) {
      setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
      return;
    }
    if (modeRef.current === "dictation") {
      recorder.cleanupPushRecorder();
    }
    setMode("live");
    void recorder.startAmbient();
  }, [disabled, recorder, setMode, setRecorderState]);

  const toggleDictation = useCallback(() => {
    if (modeRef.current === "dictation") {
      if (stateRef.current === "recording") {
        recorder.stopPushRecording();
        return;
      }
      if (stateRef.current === "transcribing") {
        return;
      }
      recorder.cleanupPushRecorder();
      setMode("idle");
      setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
    }
    if (disabled || !connectedRef.current) {
      return;
    }
    if (!canUseBrowserVoiceRecorder()) {
      setRecorderState("unsupported");
      return;
    }
    if (recorder.isAmbientActive()) {
      recorder.stopAmbient();
    }
    setMode("dictation");
    void recorder.startPushRecording();
  }, [disabled, recorder, setMode, setRecorderState]);

  const dictationActive = mode === "dictation" && (state === "recording" || state === "transcribing");
  const liveActive = (mode === "live" && isLiveState(state)) || recorder.isAmbientActive();
  const active = dictationActive || liveActive;
  const liveUnavailable = !liveActive && (disabled || !connected || !canUseAmbientMode());
  const dictationUnavailable = !dictationActive && (disabled || !connected || !canUseBrowserVoiceRecorder());
  const currentDictationTitle = dictationTitle(state, note);
  const currentLiveTitle = ambientTitle(state, note);
  const title = liveActive ? currentLiveTitle : currentDictationTitle;

  return {
    active,
    dictationActive,
    dictationTitle: currentDictationTitle,
    dictationUnavailable,
    error,
    liveActive,
    liveTitle: currentLiveTitle,
    liveUnavailable,
    mode,
    note,
    state,
    title,
    toggleDictation,
    toggleLive,
    unavailable: dictationUnavailable && liveUnavailable,
  };
}
