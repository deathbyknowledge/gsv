import type { RefObject } from "preact";
import { createPortal, forwardRef } from "preact/compat";
import { useImperativeHandle, useLayoutEffect, useRef } from "preact/hooks";
import { useMediaObjectUrl } from "../chat/hooks/useChatMediaSource";
import { browserRecordingUnavailable } from "./browserAudio";
import { useBrowserVoice } from "./useBrowserVoice";
import { VoiceWaveform } from "./VoiceWaveform";
import { useT } from "../../i18n/locale";
import "./browser-voice.css";

export type BrowserVoiceHandle = Pick<ReturnType<typeof useBrowserVoice>, "onInput" | "interceptSubmit">;

type BrowserVoiceControlsProps = Parameters<typeof useBrowserVoice>[0] & {
  surfaceHost: RefObject<HTMLDivElement>;
  onActiveChange(active: boolean): void;
};

export const BrowserVoiceControls = forwardRef<BrowserVoiceHandle, BrowserVoiceControlsProps>(function BrowserVoiceControls({ surfaceHost, onActiveChange, ...options }, ref) {
  const t = useT();
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
  return <div class="browser-voice-controls" aria-label={t("desktop.voice.input")} onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}>
    {!busy && !control.canRetry && <button type="button" disabled={!options.enabled || !!unavailable}
      title={unavailable ?? t("desktop.browserVoice.hint")}
      onClick={() => void control.start()}>{t("desktop.browserVoice.record")}</button>}
    {busy && surfaceHost.current && createPortal(<div ref={surface} class={`browser-voice-surface is-${control.phase}`}
      role="group" aria-label={t("desktop.browserVoice.label")} tabIndex={-1} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); control.cancel(true); }
        if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); control.stop(); }
      }}>
      <VoiceWaveform stream={control.stream} />
      <div class="browser-voice-caption">
        <span class="browser-voice-status" role="status">{t(control.phase === "recording" ? "desktop.voice.listening"
          : control.phase === "permission" ? "desktop.browserVoice.permission" : "desktop.browserVoice.transcribing")}</span>
        <div class="browser-voice-actions">
          {control.phase === "recording" && <button type="button" class="browser-voice-stop" aria-label={t("desktop.browserVoice.stopLabel")} onClick={control.stop}>
            {t("desktop.browserVoice.stop")} <kbd aria-hidden="true">↵</kbd>
          </button>}
          <button type="button" onClick={() => control.cancel(true)}>{t("common.cancel")} <kbd aria-hidden="true">esc</kbd></button>
        </div>
      </div>
    </div>, surfaceHost.current)}
    {control.canRetry && <button type="button" disabled={!options.enabled} onClick={control.retry}>{t("desktop.browserVoice.retry")}</button>}
    {control.canRetry && recordingUrl && <a href={recordingUrl} download={`ship-recording.${recordingExtension}`}>{t("desktop.browserVoice.download")}</a>}
    {control.canRetry && <button type="button" onClick={() => control.cancel(true)}>{t("desktop.browserVoice.discard")}</button>}
    {control.error && <span class="browser-voice-error" role="alert">{control.error}</span>}
    {control.canRetry && <span class="browser-voice-notice">{t("desktop.browserVoice.keptInTab")}</span>}
  </div>;
});
