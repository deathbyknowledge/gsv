import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AiTranscriptionCreateResult } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { requestAudioTranscription } from "../../../services/gateway/mediaRequests";
import {
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
import { normalizeTranscriptionRequestError } from "../domain/voiceFeedback";

type ChatAmbientTranscriptionArgs = {
  activeRunCount?: number;
  agentName: string;
  conversationId: string;
  disabled?: boolean;
  isSpeechOutputPlaying?: () => boolean;
  onDictation: (text: string) => void;
  onCancelSpeechOutput?: () => void;
  onTranscript: (
    text: string,
    target: ChatTranscriptionTarget,
    signal: AbortSignal,
    adoptTarget: (target: ChatTranscriptionTarget) => void,
  ) => Promise<ChatTranscriptionTarget | null> | ChatTranscriptionTarget | null;
  processId?: string | null;
};

export type ChatTranscriptionTarget = {
  conversationId: string;
  processId: string | null;
};

type LiveTranscriptionSession = {
  controller: AbortController;
  pending: number;
  queue: Promise<void>;
  target: ChatTranscriptionTarget;
};

type DictationSession = {
  controller: AbortController;
  deliver: ChatAmbientTranscriptionArgs["onDictation"];
  target: ChatTranscriptionTarget;
};

type ChatVoiceInputMode = "dictation" | "idle" | "live";

type ChatAmbientTranscription = {
  active: boolean;
  dictationActive: boolean;
  dictationTitle: string;
  dictationUnavailable: boolean;
  error: string;
  /** Increments on every failure occurrence — consecutive failures keep the
   *  same state/note, so consumers key error feedback on this instead. */
  errorNonce: number;
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

function cancellationError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Tooltip titles stay plain action labels — never status or error text; the
 *  chat feedback lines are the status surface. Only the capability notice
 *  (unsupported browser) is allowed through, since it explains a disabled
 *  control. */
function ambientTitle(state: PresenceState): string {
  if (state === "unsupported") {
    return "Live transcription is unavailable in this browser";
  }
  return isLiveState(state) ? "End conversation" : "Start conversation";
}

function dictationTitle(state: PresenceState): string {
  if (state === "unsupported") {
    return "Dictation is unavailable in this browser";
  }
  if (state === "recording" || state === "transcribing") {
    return "Stop dictation";
  }
  return "Dictate message";
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
  conversationId,
  disabled = false,
  isSpeechOutputPlaying,
  onDictation,
  onCancelSpeechOutput,
  onTranscript,
  processId = null,
}: ChatAmbientTranscriptionArgs): ChatAmbientTranscription {
  const { client, connected } = useGateway();
  const [state, setStateValue] = useState<PresenceState>(() => canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
  const [mode, setModeValue] = useState<ChatVoiceInputMode>("idle");
  const [note, setNoteValue] = useState("");
  const [error, setError] = useState("");
  const [errorNonce, setErrorNonce] = useState(0);
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
  const liveSessionRef = useRef<LiveTranscriptionSession | null>(null);
  const dictationSessionRef = useRef<DictationSession | null>(null);
  const targetRef = useRef<ChatTranscriptionTarget>({ conversationId, processId });
  targetRef.current = { conversationId, processId };

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
    if (nextState === "error") {
      setNoteValue("");
    } else if (message !== undefined) {
      setNoteValue(message);
    }
    if (nextState === "error") {
      // Recorder-driven failures (microphone, push transcription) must reach
      // consumers like ambient-segment failures do — keep an earlier, more
      // specific message when one was already set. The nonce distinguishes
      // consecutive failures whose state/note are identical.
      setError((current) => current || message || "Voice input failed");
      setErrorNonce((nonce) => nonce + 1);
    } else {
      setError("");
    }
  }, []);

  const setMode = useCallback((nextMode: ChatVoiceInputMode) => {
    modeRef.current = nextMode;
    setModeValue(nextMode);
  }, []);

  const cancelLiveSession = useCallback((reason: string) => {
    const session = liveSessionRef.current;
    liveSessionRef.current = null;
    pendingJobsRef.current = 0;
    if (session && !session.controller.signal.aborted) {
      session.controller.abort(cancellationError(reason));
    }
  }, []);

  const cancelDictationSession = useCallback((reason: string) => {
    const session = dictationSessionRef.current;
    dictationSessionRef.current = null;
    if (session && !session.controller.signal.aborted) {
      session.controller.abort(cancellationError(reason));
    }
  }, []);

  const transcribeBlob = useCallback(async (
    blob: Blob,
    mimeType: string,
    startedAt = Date.now(),
    target?: ChatTranscriptionTarget,
    signal?: AbortSignal,
  ): Promise<AiTranscriptionCreateResult> => {
    try {
      const result = await requestAudioTranscription(client, {
        audio: {
          mimeType,
          filename: presenceRecordingFilename(mimeType, startedAt),
        },
        ...(target?.processId ? { pid: target.processId } : {}),
      }, blob, signal);
      const text = typeof result.text === "string" ? result.text.trim() : "";
      if (!text) {
        throw new Error("No speech was transcribed");
      }
      return { ...result, text };
    } catch (error) {
      throw normalizeTranscriptionRequestError(error);
    }
  }, [client]);

  const processAmbientSegment = useCallback(async (
    segment: AmbientSegment,
    session: LiveTranscriptionSession,
  ) => {
    const active = () =>
      liveSessionRef.current === session && !session.controller.signal.aborted;
    const durationMs = segment.stoppedAt - segment.startedAt;
    if (durationMs < AMBIENT_MIN_SEGMENT_MS || totalBlobSize(segment.chunks) < AMBIENT_MIN_SEGMENT_BYTES) {
      if (active()) {
        setNoteValue("Listening");
        setRecorderState("listening");
      }
      return;
    }

    const blob = new Blob(segment.chunks, { type: segment.mimeType });
    try {
      if (!active()) return;
      setNoteValue("Transcribing speech");
      setRecorderState("transcribing");
      const result = await transcribeBlob(
        blob,
        segment.mimeType,
        segment.startedAt,
        session.target,
        session.controller.signal,
      );
      if (!active()) return;
      const text = result.text.trim();
      if (!text) {
        throw new Error("No speech was transcribed");
      }
      const currentTarget = targetRef.current;
      if (
        session.target.processId !== currentTarget.processId ||
        session.target.conversationId !== currentTarget.conversationId
      ) {
        cancelLiveSession("Chat changed during live transcription");
        recorderRef.current?.stopAmbient();
        setMode("idle");
        return;
      }
      setNoteValue("Sending transcript");
      setRecorderState("sending");
      const target = await onTranscriptRef.current(
        text,
        session.target,
        session.controller.signal,
        (nextTarget) => {
          if (!active()) {
            throw session.controller.signal.reason ?? cancellationError("Live transcription stopped");
          }
          const latestTarget = targetRef.current;
          if (
            session.target.processId !== latestTarget.processId ||
            session.target.conversationId !== latestTarget.conversationId
          ) {
            const reason = "Chat changed during live transcription";
            cancelLiveSession(reason);
            recorderRef.current?.stopAmbient();
            setMode("idle");
            throw cancellationError(reason);
          }
          session.target = nextTarget;
          targetRef.current = nextTarget;
        },
      );
      if (!active()) return;
      if (!target?.processId) {
        throw new Error("Transcript was not sent");
      }
      session.target = target;
      const currentTargetAfterSend = targetRef.current;
      if (
        currentTargetAfterSend.processId !== target.processId ||
        currentTargetAfterSend.conversationId !== target.conversationId
      ) {
        cancelLiveSession("Chat changed during live transcription");
        recorderRef.current?.stopAmbient();
        setMode("idle");
        return;
      }
      setNoteValue("Listening");
      setRecorderState("listening");
    } catch (segmentError) {
      if (!active()) return;
      const message = formatVoiceError(segmentError);
      cancelLiveSession(message);
      recorderRef.current?.stopAmbient();
      setMode("idle");
      setRecorderState("error", message);
    }
  }, [cancelLiveSession, setMode, setRecorderState, transcribeBlob]);

  const queueAmbientSegment = useCallback((segment: AmbientSegment): Promise<void> | void => {
    const session = liveSessionRef.current;
    if (!session || session.controller.signal.aborted) {
      return;
    }
    session.pending += 1;
    pendingJobsRef.current = session.pending;
    session.queue = session.queue
      .then(() => processAmbientSegment(segment, session))
      .finally(() => {
        session.pending = Math.max(0, session.pending - 1);
        if (
          liveSessionRef.current === session &&
          !destroyedRef.current &&
          connectedRef.current &&
          stateRef.current !== "error" &&
          modeRef.current === "live"
        ) {
          pendingJobsRef.current = session.pending;
          setNoteValue(session.pending > 0 ? `Processing ${session.pending}` : "Listening");
          setRecorderState(session.pending > 0 ? "transcribing" : "listening");
        }
      });
    return session.queue;
  }, [processAmbientSegment, setRecorderState]);

  const handlePushTranscribed = useCallback((result: AiTranscriptionCreateResult) => {
    const session = dictationSessionRef.current;
    if (!session || session.controller.signal.aborted) {
      return;
    }
    const text = result.text.trim();
    const currentTarget = targetRef.current;
    if (
      session.target.processId !== currentTarget.processId ||
      session.target.conversationId !== currentTarget.conversationId
    ) {
      cancelDictationSession("Chat changed during dictation");
      setMode("idle");
      setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
      return;
    }
    if (text) {
      session.deliver(text);
    }
    dictationSessionRef.current = null;
    setMode("idle");
    setNoteValue(text ? "Transcribed" : "");
    setRecorderState("idle", text ? "Transcribed" : undefined);
  }, [cancelDictationSession, setMode, setRecorderState]);

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
    transcribe: async (blob, mimeType, startedAt) => {
      const session = dictationSessionRef.current;
      if (!session) {
        throw new Error("Dictation was cancelled");
      }
      try {
        return await transcribeBlob(
          blob,
          mimeType,
          startedAt,
          session.target,
          session.controller.signal,
        );
      } catch (error) {
        if (dictationSessionRef.current === session) {
          cancelDictationSession(formatVoiceError(error));
          setMode("idle");
        }
        throw error;
      }
    },
    onPushTranscribed: handlePushTranscribed,
    onAmbientSegment: queueAmbientSegment,
  }), [
    agentName,
    cancelDictationSession,
    handlePushTranscribed,
    queueAmbientSegment,
    setMode,
    setRecorderState,
    transcribeBlob,
  ]);

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
      cancelLiveSession("Live transcription closed");
      cancelDictationSession("Dictation closed");
      recorder.destroy();
    };
  }, [cancelDictationSession, cancelLiveSession, recorder]);

  useEffect(() => {
    if (!connected && (liveSessionRef.current || recorder.isAmbientActive())) {
      cancelLiveSession("Gateway disconnected");
      recorder.stopAmbient();
      setMode("idle");
    }
    if (!connected && modeRef.current === "dictation") {
      cancelDictationSession("Gateway disconnected");
      recorder.cleanupPushRecorder();
      setMode("idle");
      setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
    }
  }, [cancelDictationSession, cancelLiveSession, connected, recorder, setMode, setRecorderState]);

  useEffect(() => {
    const live = liveSessionRef.current;
    if (
      live &&
      (
        live.target.conversationId !== conversationId ||
        live.target.processId !== processId
      )
    ) {
      cancelLiveSession("Chat changed during live transcription");
      recorder.stopAmbient();
      setMode("idle");
    }

    const dictation = dictationSessionRef.current;
    if (
      dictation &&
      (
        dictation.target.processId !== processId ||
        dictation.target.conversationId !== conversationId
      )
    ) {
      cancelDictationSession("Chat changed during dictation");
      recorder.cleanupPushRecorder();
      setMode("idle");
      setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
    }
  }, [
    cancelDictationSession,
    cancelLiveSession,
    conversationId,
    processId,
    recorder,
    setMode,
    setRecorderState,
  ]);

  const toggleLive = useCallback(() => {
    if (modeRef.current === "live" || liveSessionRef.current) {
      cancelLiveSession("Live transcription stopped");
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
      cancelDictationSession("Switched to live transcription");
      recorder.cleanupPushRecorder();
    }
    const session: LiveTranscriptionSession = {
      controller: new AbortController(),
      pending: 0,
      queue: Promise.resolve(),
      target: { ...targetRef.current },
    };
    liveSessionRef.current = session;
    pendingJobsRef.current = 0;
    setMode("live");
    void recorder.startAmbient().then(() => {
      if (liveSessionRef.current === session && !recorder.isAmbientActive()) {
        cancelLiveSession("Live transcription did not start");
        setMode("idle");
      }
    });
  }, [cancelDictationSession, cancelLiveSession, disabled, recorder, setMode, setRecorderState]);

  const toggleDictation = useCallback(() => {
    if (modeRef.current === "dictation") {
      if (stateRef.current === "recording") {
        if (recorder.isPushActive()) {
          recorder.stopPushRecording();
        } else {
          cancelDictationSession("Dictation stopped");
          recorder.cleanupPushRecorder();
          setMode("idle");
          setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
        }
        return;
      }
      if (stateRef.current === "transcribing") {
        cancelDictationSession("Dictation stopped");
        recorder.cleanupPushRecorder();
        setMode("idle");
        setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
        return;
      }
      cancelDictationSession("Dictation stopped");
      recorder.cleanupPushRecorder();
      setMode("idle");
      setRecorderState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
      return;
    }
    if (disabled || !connectedRef.current) {
      return;
    }
    if (!canUseBrowserVoiceRecorder()) {
      setRecorderState("unsupported");
      return;
    }
    if (liveSessionRef.current || recorder.isAmbientActive()) {
      cancelLiveSession("Switched to dictation");
      recorder.stopAmbient();
    }
    const session: DictationSession = {
      controller: new AbortController(),
      deliver: onDictationRef.current,
      target: { ...targetRef.current },
    };
    dictationSessionRef.current = session;
    setMode("dictation");
    void recorder.startPushRecording().then(() => {
      if (dictationSessionRef.current === session && stateRef.current === "error") {
        cancelDictationSession("Dictation did not start");
        setMode("idle");
      }
    });
  }, [cancelDictationSession, cancelLiveSession, disabled, recorder, setMode, setRecorderState]);

  const dictationActive = mode === "dictation" && (state === "recording" || state === "transcribing");
  const liveActive = (mode === "live" && isLiveState(state)) || recorder.isAmbientActive();
  const active = dictationActive || liveActive;
  const liveUnavailable = !liveActive && (disabled || !connected || !canUseAmbientMode());
  const dictationUnavailable = !dictationActive && (disabled || !connected || !canUseBrowserVoiceRecorder());
  const currentDictationTitle = dictationTitle(state);
  const currentLiveTitle = ambientTitle(state);
  const title = liveActive ? currentLiveTitle : currentDictationTitle;

  return {
    active,
    dictationActive,
    dictationTitle: currentDictationTitle,
    dictationUnavailable,
    error,
    errorNonce,
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
