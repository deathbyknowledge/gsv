import type { RefObject } from "preact";
import { createPortal, forwardRef } from "preact/compat";
import { useImperativeHandle, useLayoutEffect, useRef } from "preact/hooks";
import { useMediaObjectUrl } from "../chat/hooks/useChatMediaSource";
import { browserRecordingUnavailable } from "./browserAudio";
import { useBrowserVoice } from "./useBrowserVoice";
import { VoiceWaveform } from "./VoiceWaveform";
import "./browser-voice.css";

export type BrowserVoiceHandle = Pick<ReturnType<typeof useBrowserVoice>, "onInput" | "interceptSubmit">;

type BrowserVoiceControlsProps = Parameters<typeof useBrowserVoice>[0] & {
  surfaceHost: RefObject<HTMLDivElement>;
  onActiveChange(active: boolean): void;
};

export const BrowserVoiceControls = forwardRef<BrowserVoiceHandle, BrowserVoiceControlsProps>(function BrowserVoiceControls({ surfaceHost, onActiveChange, ...options }, ref) {
  const control = useBrowserVoice(options);
  const recordingUrl = useMediaObjectUrl(control.audio);
  const recordingExtension = control.audio?.type.startsWith("audio/mp4") ? "m4a"
    : control.audio?.type.startsWith("audio/ogg") ? "ogg" : "webm";
  useImperativeHandle(ref, () => ({ onInput: control.onInput, interceptSubmit: control.interceptSubmit }));
  const unavailable = browserRecordingUnavailable();
  const busy = ["permission", "recording", "transcribing"].includes(control.phase);
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    onActiveChange(busy);
    return () => onActiveChange(false);
  }, [busy, onActiveChange]);
  useLayoutEffect(() => { if (busy) surface.current?.focus({ preventScroll: true }); }, [control.phase, busy]);
  return <div class="browser-voice-controls" aria-label="Voice input" onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}>
    {!busy && !control.canRetry && <button type="button" disabled={!options.enabled || !!unavailable}
      title={unavailable ?? "Record up to 5 minutes. Audio is transcribed through your space; review the text before sending."}
      onClick={() => void control.start()}>record</button>}
    {busy && surfaceHost.current && createPortal(<div ref={surface} class={`browser-voice-surface is-${control.phase}`}
      role="group" aria-label="Voice recording" tabIndex={-1} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); control.cancel(true); }
        if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); control.stop(); }
      }}>
      <VoiceWaveform stream={control.stream} />
      <div class="browser-voice-caption">
        <span class="browser-voice-status" role="status">{control.phase === "recording" ? "listening"
          : control.phase === "permission" ? "allow microphone access…" : "transcribing…"}</span>
        <div class="browser-voice-actions">
          {control.phase === "recording" && <button type="button" class="browser-voice-stop" aria-label="Stop recording" onClick={control.stop}>
            stop <kbd aria-hidden="true">↵</kbd>
          </button>}
          <button type="button" onClick={() => control.cancel(true)}>cancel <kbd aria-hidden="true">esc</kbd></button>
        </div>
      </div>
    </div>, surfaceHost.current)}
    {control.canRetry && <button type="button" disabled={!options.enabled} onClick={control.retry}>retry transcription</button>}
    {control.canRetry && recordingUrl && <a href={recordingUrl} download={`ship-recording.${recordingExtension}`}>download audio</a>}
    {control.canRetry && <button type="button" onClick={() => control.cancel(true)}>discard recording</button>}
    {control.error && <span class="browser-voice-error" role="alert">{control.error}</span>}
    {control.canRetry && <span class="browser-voice-notice">Audio is kept in this tab. Retry or download it before leaving.</span>}
  </div>;
});
