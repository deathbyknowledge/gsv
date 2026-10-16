import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { GSVClient } from "@humansandmachines/gsv";
import type { PromptLineHandle } from "../../features/instrument/shared/PromptLine";
import { frameBodyFromBlob } from "../gateway/frameBody";
import { captureBrowserAudio } from "./browserAudio";
import { composeVoice } from "./voiceDraft";

type Phase = "idle" | "permission" | "recording" | "transcribing" | "error";
type Recording = {
  abort: AbortController;
  attempt?: AbortController;
  stop?: () => void;
  audio?: Blob;
  paused?: boolean;
};

export function useBrowserVoice({ client, prompt, pid, scope, enabled }: {
  client: Pick<GSVClient, "request">;
  prompt: RefObject<Pick<PromptLineHandle, "selection" | "setValue" | "focus">>;
  pid: string | null;
  scope: string;
  enabled: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const current = useRef<Recording | null>(null);
  const restoreFocus = useRef(false);
  const available = useRef(enabled);
  available.current = enabled;

  const discard = () => {
    const recording = current.current;
    current.current = null;
    restoreFocus.current = false;
    recording?.abort.abort();
    recording?.attempt?.abort();
  };
  const cancel = (focus = false) => {
    discard();
    restoreFocus.current = focus;
    setStream(null);
    setPhase("idle");
    setError(null);
  };

  useLayoutEffect(() => {
    setPhase("idle");
    setError(null);
    setStream(null);
    return discard;
  }, [client, prompt, pid, scope]);

  const pause = () => {
    const recording = current.current;
    if (!recording) return;
    if (!recording.stop && !recording.audio) { cancel(); return; }
    recording.paused = true;
    const attempt = recording.attempt;
    recording.attempt = undefined;
    attempt?.abort();
    recording.stop?.();
    setStream(null);
    setPhase(recording.audio ? "error" : "transcribing");
    setError("Recording kept. Retry transcription when you’re ready.");
  };

  useLayoutEffect(() => { if (!enabled) pause(); }, [enabled]);

  useEffect(() => {
    if (phase !== "idle" || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (enabled) prompt.current?.focus();
  }, [phase, enabled, prompt]);

  useLayoutEffect(() => {
    const leave = () => pause();
    const visibility = () => { if (document.visibilityState === "hidden") pause(); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const transcribe = async (recording: Recording, audio: Blob) => {
    if (!pid || !available.current || document.visibilityState === "hidden"
      || current.current !== recording || recording.attempt) return;
    const attempt = new AbortController();
    recording.attempt = attempt;
    recording.paused = false;
    setPhase("transcribing");
    setError(null);
    try {
      const { data: { text } } = await client.request("ai.transcription.create", { pid, audio: { mimeType: audio.type }, mode: "transcribe" }, {
        body: frameBodyFromBlob(audio), signal: attempt.signal,
      });
      if (current.current !== recording || recording.attempt !== attempt) return;
      const composer = prompt.current;
      if (!text.trim()) {
        throw new Error("No speech was detected. Retry transcription or download the recording.");
      }
      if (!composer) throw new Error("The prompt is unavailable. Retry transcription when it’s ready.");
      const selection = composer.selection();
      const draft = composeVoice(selection.value.slice(0, selection.start), text, selection.value.slice(selection.start));
      composer.setValue(draft.value, draft.caret);
      current.current = null;
      restoreFocus.current = true;
      setPhase("idle");
    } catch (error) {
      if (current.current !== recording || recording.attempt !== attempt) return;
      setPhase("error");
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (recording.attempt === attempt) recording.attempt = undefined;
    }
  };

  const start = async () => {
    if (!enabled || !pid || current.current) return;
    const recording: Recording = { abort: new AbortController() };
    current.current = recording;
    setPhase("permission");
    setError(null);
    try {
      const audio = await captureBrowserAudio(recording.abort.signal, (stop, microphone) => {
        recording.stop = stop;
        setStream(microphone);
        setPhase("recording");
      });
      if (current.current !== recording) return;
      setStream(null);
      recording.stop = undefined;
      recording.audio = audio;
      if (recording.paused || !available.current || document.visibilityState === "hidden") {
        setPhase("error");
        setError("Recording kept. Retry transcription when you’re ready.");
      } else await transcribe(recording, audio);
    } catch (error) {
      if (current.current !== recording) return;
      current.current = null;
      setStream(null);
      setPhase("error");
      setError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow it in your browser’s site settings and try again."
        : error instanceof Error ? error.message : String(error));
    }
  };
  const stop = () => {
    if (!current.current?.stop) return;
    setPhase("transcribing");
    setStream(null);
    current.current.stop();
  };
  const retry = () => {
    const recording = current.current;
    if (recording?.audio && phase === "error") void transcribe(recording, recording.audio);
  };
  const interceptSubmit = () => {
    if (phase === "error") return false;
    if (!current.current) return false;
    stop();
    return true;
  };
  const onInput = (value: string) => { if (!value && current.current && !current.current.audio) cancel(); };

  return { phase, error, stream, audio: current.current?.audio,
    canRetry: phase === "error" && !!current.current?.audio, start, stop, cancel, retry, onInput, interceptSubmit };
}
