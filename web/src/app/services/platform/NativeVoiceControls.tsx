import type { RefObject } from "preact";
import { createPortal, forwardRef } from "preact/compat";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismissOnOutsideClick } from "../../features/instrument/shared/useDismissOnOutsideClick";
import { AppLink } from "../navigation/appNavigation";
import { installInputSounds } from "./inputSounds";
import { voicePreparation } from "./nativePresentation";
import { useComposerVoice, type ComposerVoiceOptions } from "./NativeVoiceSession";
import { useNativeSpeech } from "./NativeSpeech";
import { useT } from "../../i18n/locale";
import "./native-input.css";

export type NativeVoiceHandle = Pick<ReturnType<typeof useComposerVoice>, "onInput" | "interceptSubmit">;
type NativeVoiceControlsProps = ComposerVoiceOptions & {
  /** Zen owns the full reading area; the composer footer must not constrain panels. */
  panelHost: RefObject<HTMLDivElement>;
};

export const NativeVoiceControls = forwardRef<NativeVoiceHandle, NativeVoiceControlsProps>(function NativeVoiceControls({ panelHost, ...options }, ref) {
  const t = useT();
  const control = useComposerVoice(options);
  const speech = useNativeSpeech();
  useImperativeHandle(ref, () => ({ onInput: control.onInput, interceptSubmit: control.interceptSubmit }));
  const [panel, setPanel] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const voiceButton = useRef<HTMLButtonElement>(null);
  const { snapshot, error } = control;
  const voice = snapshot?.voice;
  const preparation = voicePreparation(t, voice);
  const notice = error || snapshot?.notice;
  const busy = !options.enabled || !snapshot || control.blocked || control.capturing;
  const voiceLabel = !voice ? t(control.capturing ? "desktop.voice.preparing" : "desktop.voice.trigger") : voice.phase === "listening" ? t("desktop.voice.listening")
    : voice.phase === "finishing" ? t("desktop.voice.pausing") : preparation?.message ?? t("desktop.voice.preparing");
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
  return <div class="native-input-controls" aria-label={t("desktop.voice.input")} onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}>
    <button ref={voiceButton} type="button" class={`native-input-trigger${voice ? " is-active" : ""}`}
      aria-expanded={panel} aria-controls="native-input-panel" aria-haspopup="dialog"
      title={t("desktop.voice.dictate")}
      onClick={() => setPanel((current) => !current)}>
      {voice && <span class="native-sensor-dot" aria-hidden="true" />}<span aria-live="polite">{voiceLabel}</span>
    </button>
    {control.capturing && <>
      <button type="button" class="native-primary" disabled={voice?.phase !== "listening"} onClick={control.send}>{t("desktop.voice.send")}</button>
      {voice?.phase === "listening" && <button type="button" onClick={control.stop}>{t("desktop.voice.pause")}</button>}
      {/* Cancel stays available while the host finalizes, so a mistaken recording can still be stopped before it sends. */}
      <button type="button" onClick={control.cancel}>{t("common.cancel")}</button>
    </>}
    {speech?.preferences.enabled && speech.status.phase === "speaking" && <button type="button" onClick={() => void speech.command({ kind: "cancel" })}>{t("desktop.voice.stopSpeaking")}</button>}
    {notice && !panel && <>
      <button type="button" class="native-input-notice" onClick={() => setPanel(true)}>{t("desktop.voice.needsAttention")}</button>
      <span class="native-input-announcement" role="alert">{notice}</span>
    </>}
    {panel && panelHost.current && createPortal(<section ref={panelRef} id="native-input-panel" class="native-input-panel" role="dialog"
      aria-labelledby="native-input-title" tabIndex={-1} data-instrument-dialog
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(true); }
      }}>
      <header>
        <h2 id="native-input-title">{t("desktop.voice.panelTitle")}</h2>
        <button type="button" onClick={() => close(true)} aria-label={t("desktop.voice.closePanel")}>{t("desktop.close")} <kbd>esc</kbd></button>
      </header>
      {notice && <p class="native-input-error" role="alert">{notice}</p>}
      {!snapshot && <button type="button" disabled={!options.enabled} onClick={control.reconnect}>{t("desktop.voice.reconnect")}</button>}
      <div class="native-panel-actions">
        {!control.capturing ? <button type="button" class="native-primary" disabled={busy} onClick={control.start}>{t("desktop.voice.listen")}</button>
          : <>
            <button type="button" class="native-primary" disabled={voice?.phase !== "listening"} onClick={control.send}>{t("desktop.voice.send")}</button>
            {(voice?.phase === "listening" || voice?.phase === "finishing")
              && <button type="button" disabled={voice.phase === "finishing"} onClick={control.stop}>{t(voice.phase === "finishing" ? "desktop.voice.pausing" : "desktop.voice.pause")}</button>}
            <button type="button" onClick={control.cancel}>{t("common.cancel")}</button>
          </>}
        <span class="native-panel-state" role="status">{control.capturing ? voiceLabel : t(control.blocked ? "desktop.voice.handsfreeRecording" : "desktop.voice.microphoneOff")}</span>
      </div>
      {preparation && <progress max={1} value={preparation.progress} aria-label={preparation.message} />}
      <p class="native-panel-footnote">{t("desktop.voice.footnote")}</p>
      <AppLink href="/chat/settings?section=voice" class="native-voice-settings-link">{t("desktop.voice.settings")}</AppLink>
    </section>, panelHost.current)}
  </div>;
});
