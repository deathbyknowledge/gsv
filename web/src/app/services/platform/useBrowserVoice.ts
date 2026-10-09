import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { GSVClient } from "@humansandmachines/gsv";
import type { PromptLineHandle } from "../../features/instrument/shared/PromptLine";
import { frameBodyFromBlob } from "../gateway/frameBody";
import { captureBrowserAudio } from "./browserAudio";
import { composeVoice } from "./voiceDraft";

type Phase = "idle" | "permission" | "recording" | "transcribing" | "error";
type Recording = { abort: AbortController; stop?: () => void; audio?: Blob };

export function useBrowserVoice({ client, prompt, pid, scope, enabled }: {
  client: Pick<GSVClient, "request">;
  prompt: RefObject<Pick<PromptLineHandle, "selection" | "setValue" | "focus">>;
  pid: string | null;
  scope: string;
  enabled: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const current = useRef<Recording | null>(null);

  const discard = () => {
    const recording = current.current;
    current.current = null;
    recording?.abort.abort();
  };
  const cancel = () => { discard(); setPhase("idle"); setError(null); };

  useLayoutEffect(() => {
    setPhase("idle");
    setError(null);
    return discard;
  }, [client, prompt, pid, scope, enabled]);

  useLayoutEffect(() => {
    if (phase !== "recording") return;
    const start = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  useLayoutEffect(() => {
    const leave = () => cancel();
    const visibility = () => { if (document.visibilityState === "hidden") cancel(); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const transcribe = async (recording: Recording, audio: Blob) => {
    if (!pid || current.current !== recording) return;
    setPhase("transcribing");
    setError(null);
    try {
      const { data: { text } } = await client.request("ai.transcription.create", { pid, audio: { mimeType: audio.type }, mode: "transcribe" }, {
        body: frameBodyFromBlob(audio), signal: recording.abort.signal,
      });
      if (current.current !== recording) return;
      const composer = prompt.current;
      if (!text.trim()) {
        current.current = null;
        setPhase("error");
        setError("No speech was detected. Try recording again.");
        return;
      }
      current.current = null;
      setPhase("idle");
      if (composer) {
        const selection = composer.selection();
        const draft = composeVoice(selection.value.slice(0, selection.start), text, selection.value.slice(selection.start));
        composer.setValue(draft.value, draft.caret);
        composer.focus();
      }
    } catch (error) {
      if (current.current !== recording) return;
      setPhase("error");
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const start = async () => {
    if (!enabled || !pid || current.current) return;
    const recording: Recording = { abort: new AbortController() };
    current.current = recording;
    setPhase("permission");
    setError(null);
    try {
      const audio = await captureBrowserAudio(recording.abort.signal, (stop) => {
        recording.stop = stop;
        setPhase("recording");
      });
      if (current.current !== recording) return;
      recording.stop = undefined;
      recording.audio = audio;
      await transcribe(recording, audio);
    } catch (error) {
      if (current.current !== recording) return;
      current.current = null;
      setPhase("error");
      setError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow it in your browser’s site settings and try again."
        : error instanceof Error ? error.message : String(error));
    }
  };
  const stop = () => {
    if (!current.current?.stop) return;
    setPhase("transcribing");
    current.current.stop();
  };
  const retry = () => {
    const recording = current.current;
    if (recording?.audio && phase === "error") void transcribe(recording, recording.audio);
  };
  const interceptSubmit = () => {
    if (phase === "error") { cancel(); return false; }
    if (!current.current) return false;
    stop();
    return true;
  };
  const onInput = (value: string) => { if (!value && current.current) cancel(); };

  return { phase, error, seconds, canRetry: phase === "error" && !!current.current?.audio, start, stop, cancel, retry, onInput, interceptSubmit };
}
