import type { RefObject } from "preact";
import { createPortal, forwardRef } from "preact/compat";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismissOnOutsideClick } from "../../features/instrument/shared/useDismissOnOutsideClick";
import { AppLink } from "../navigation/appNavigation";
import { installInputSounds } from "./inputSounds";
import { voicePreparation } from "./nativePresentation";
import { useNativeVoice } from "./useNativeVoice";
import { useNativeSpeech } from "./NativeSpeech";
import "./native-input.css";

export type NativeVoiceHandle = Pick<ReturnType<typeof useNativeVoice>, "onInput" | "interceptSubmit">;
type NativeVoiceControlsProps = Parameters<typeof useNativeVoice>[0] & {
  /** Zen owns the full reading area; the composer footer must not constrain panels. */
  panelHost: RefObject<HTMLDivElement>;
};

export const NativeVoiceControls = forwardRef<NativeVoiceHandle, NativeVoiceControlsProps>(function NativeVoiceControls({ panelHost, ...options }, ref) {
  const control = useNativeVoice(options);
  const speech = useNativeSpeech();
  useImperativeHandle(ref, () => ({ onInput: control.onInput, interceptSubmit: control.interceptSubmit }));
  const [panel, setPanel] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const voiceButton = useRef<HTMLButtonElement>(null);
  const { snapshot, error } = control;
  const voice = snapshot?.voice;
  const preparation = voicePreparation(voice);
  const notice = error || snapshot?.notice;
  const busy = !options.enabled || !snapshot;
  const voiceLabel = !voice ? "voice" : voice.phase === "listening" ? "listening"
    : voice.phase === "finishing" ? "pausing…" : preparation?.message ?? "preparing…";
  const close = (restoreFocus: boolean) => {
    if (restoreFocus) voiceButton.current?.focus({ preventScroll: true });
    setPanel(false);
  };
  useDismissOnOutsideClick(panel, () => [panelRef.current, voiceButton.current], () => close(false));
  useLayoutEffect(() => { if (panel) panelRef.current?.focus({ preventScroll: true }); }, [panel]);
  useEffect(() => { setPanel(false); }, [options.scope]);
  useEffect(() => { if (!options.enabled) { setPanel(false); } }, [options.enabled]);
  useEffect(() => {
    if (control.available && options.enabled) return installInputSounds();
  }, [control.available, options.enabled]);

  if (!control.available) return null;
  return <div class="native-input-controls" aria-label="Voice input" onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}>
    <button ref={voiceButton} type="button" class={`native-input-trigger${voice ? " is-active" : ""}`}
      aria-expanded={panel} aria-controls="native-input-panel" aria-haspopup="dialog"
      title="Dictate with your microphone"
      onClick={() => setPanel((current) => !current)}>
      {voice && <span class="native-sensor-dot" aria-hidden="true" />}<span aria-live="polite">{voiceLabel}</span>
    </button>
    {voice && <button type="button" disabled={voice.phase === "finishing"}
      onClick={voice.phase === "listening" ? control.stop : control.cancel}>
      {voice.phase === "listening" || voice.phase === "finishing" ? "pause" : "cancel"}
    </button>}
    {speech?.preferences.enabled && speech.status.phase === "speaking" && <button type="button" onClick={() => void speech.command({ kind: "cancel" })}>stop speaking</button>}
    {notice && !panel && <>
      <button type="button" class="native-input-notice" onClick={() => setPanel(true)}>input needs attention</button>
      <span class="native-input-announcement" role="alert">{notice}</span>
    </>}
    {panel && panelHost.current && createPortal(<section ref={panelRef} id="native-input-panel" class="native-input-panel" role="dialog"
      aria-labelledby="native-input-title" tabIndex={-1} data-instrument-dialog
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(true); }
      }}>
      <header>
        <h2 id="native-input-title">Voice</h2>
        <button type="button" onClick={() => close(true)} aria-label="Close input controls">close <kbd>esc</kbd></button>
      </header>
      {notice && <p class="native-input-error" role="alert">{notice}</p>}
      {!snapshot && <button type="button" disabled={!options.enabled} onClick={control.reconnect}>reconnect input</button>}
      <div class="native-panel-actions">
        {!voice ? <button type="button" class="native-primary" disabled={busy} onClick={control.start}>listen</button>
          : <button type="button" class="native-primary" disabled={voice.phase === "finishing"}
            onClick={voice.phase === "listening" ? control.stop : control.cancel}>{voice.phase === "listening" ? "pause" : voice.phase === "finishing" ? "pausing…" : "cancel"}</button>}
        <span class="native-panel-state" role="status">{voice ? voiceLabel : "Microphone off"}</span>
      </div>
      {preparation && <progress max={1} value={preparation.progress} aria-label={preparation.message} />}
      <p class="native-panel-footnote">Pause keeps your draft. Enter sends and keeps listening.</p>
      <AppLink href="/chat/settings?section=voice" class="native-voice-settings-link">voice settings</AppLink>
    </section>, panelHost.current)}
  </div>;
});
