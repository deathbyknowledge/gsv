import { forwardRef } from "preact/compat";
import { useImperativeHandle } from "preact/hooks";
import { browserRecordingUnavailable } from "./browserAudio";
import { useBrowserVoice } from "./useBrowserVoice";
import "./browser-voice.css";

export type BrowserVoiceHandle = Pick<ReturnType<typeof useBrowserVoice>, "onInput" | "interceptSubmit">;

export const BrowserVoiceControls = forwardRef<BrowserVoiceHandle, Parameters<typeof useBrowserVoice>[0]>(function BrowserVoiceControls(options, ref) {
  const control = useBrowserVoice(options);
  useImperativeHandle(ref, () => ({ onInput: control.onInput, interceptSubmit: control.interceptSubmit }));
  const unavailable = browserRecordingUnavailable();
  const busy = ["permission", "recording", "transcribing"].includes(control.phase);
  const elapsed = `${Math.floor(control.seconds / 60)}:${String(control.seconds % 60).padStart(2, "0")}`;
  return <div class="browser-voice-controls" aria-label="Voice input" onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}>
    {!busy && !control.canRetry && <button type="button" disabled={!options.enabled || !!unavailable}
      title={unavailable ?? "Record up to 5 minutes. Audio is transcribed through your space; review the text before sending."}
      onClick={() => void control.start()}>record</button>}
    {control.phase === "recording" && <button type="button" class="browser-voice-stop" onClick={control.stop}>stop recording</button>}
    <span role="status">{control.phase === "recording" ? <>Recording <span aria-hidden="true">{elapsed}</span></>
      : control.phase === "permission" ? "Allow microphone access…"
        : control.phase === "transcribing" ? "Transcribing…" : ""}</span>
    {control.canRetry && <button type="button" disabled={!options.enabled} onClick={control.retry}>retry transcription</button>}
    {(busy || control.canRetry) && <button type="button" onClick={control.cancel}>cancel</button>}
    {control.error && <span class="browser-voice-error" role="alert">{control.error}</span>}
  </div>;
});
