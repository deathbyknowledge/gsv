import type { RefObject } from "preact";
import { createPortal, forwardRef } from "preact/compat";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismissOnOutsideClick } from "../../features/instrument/shared/useDismissOnOutsideClick";
import { gestureFeedback } from "./NativeGestureFeedback";
import { GestureGuide } from "./GestureGuide";
import { GestureTutorial } from "./GestureTutorial";
import { InputSoundSettings } from "./InputSoundSettings";
import { installInputSounds } from "./inputSounds";
import { useNativeVoice } from "./useNativeVoice";
import "./native-input.css";

export type NativeVoiceHandle = Pick<ReturnType<typeof useNativeVoice>, "onInput" | "interceptSubmit">;
type Panel = "voice" | "gestures";
type NativeVoiceControlsProps = Parameters<typeof useNativeVoice>[0] & {
  /** Zen owns the full reading area; the composer footer must not constrain panels. */
  panelHost: RefObject<HTMLDivElement>;
};

export const NativeVoiceControls = forwardRef<NativeVoiceHandle, NativeVoiceControlsProps>(function NativeVoiceControls({ panelHost, ...options }, ref) {
  const [tutorial, setTutorial] = useState(false);
  const control = useNativeVoice({ ...options, enabled: options.enabled && !tutorial });
  useImperativeHandle(ref, () => ({ onInput: control.onInput, interceptSubmit: control.interceptSubmit }));
  const [panel, setPanel] = useState<Panel | null>(null);
  const startTutorial = useCallback(() => { setPanel(null); setTutorial(true); }, []);
  const panelRef = useRef<HTMLElement>(null);
  const voiceButton = useRef<HTMLButtonElement>(null);
  const gestureButton = useRef<HTMLButtonElement>(null);
  const { snapshot, error, command } = control;
  const voice = snapshot?.voice;
  const notice = error || snapshot?.notice;
  const busy = !options.enabled || !snapshot;
  const feedback = snapshot ? gestureFeedback(snapshot) : null;
  const cameraOn = snapshot?.gestures_enabled ?? false;
  const ready = snapshot?.gesture_status === "ready";
  const failed = cameraOn && !ready && snapshot?.gesture_status !== "starting";
  const voiceLabel = !voice ? "voice" : voice.phase === "listening" ? "listening"
    : voice.phase === "finishing" ? "pausing…" : "preparing…";
  const handsFreeLabel = !cameraOn ? "hands-free" : failed ? "camera unavailable"
    : feedback?.progress != null ? feedback.message : feedback?.action
    ?? (ready ? voice?.phase === "listening" ? "hands-free · listening" : "hands-free · ready" : "starting camera…");
  const close = (restoreFocus: boolean) => {
    if (restoreFocus) (panel === "voice" ? voiceButton : gestureButton).current?.focus({ preventScroll: true });
    setPanel(null);
  };
  useDismissOnOutsideClick(panel !== null, () => [panelRef.current, voiceButton.current, gestureButton.current], () => close(false));
  useLayoutEffect(() => { if (panel) panelRef.current?.focus({ preventScroll: true }); }, [panel]);
  useEffect(() => {
    if (panel === "voice" && snapshot && !snapshot.voice && !snapshot.devices_loading) void command({ kind: "devices" });
  }, [panel, snapshot?.lease]);
  useEffect(() => { setPanel(null); setTutorial(false); }, [options.scope]);
  useEffect(() => { if (!options.enabled) { setPanel(null); setTutorial(false); } }, [options.enabled]);
  useEffect(() => {
    if (control.available && options.enabled) return installInputSounds();
  }, [control.available, options.enabled]);

  if (!control.available) return null;
  return <div class="native-input-controls" aria-label="Voice and hands-free" onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}>
    {!cameraOn && <button ref={voiceButton} type="button" class={`native-input-trigger${voice ? " is-active" : ""}`}
      aria-expanded={panel === "voice"} aria-controls="native-input-panel" aria-haspopup="dialog"
      title="Dictate with your microphone"
      onClick={() => setPanel((current) => current === "voice" ? null : "voice")}>
      {voice && <span class="native-sensor-dot" aria-hidden="true" />}<span aria-live="polite">{voiceLabel}</span>
    </button>}
    {voice && <button type="button" disabled={voice.phase === "finishing"}
      onClick={voice.phase === "listening" ? control.stop : control.cancel}>
      {voice.phase === "listening" || voice.phase === "finishing" ? "pause" : "cancel"}
    </button>}
    <button ref={gestureButton} type="button" class={`native-input-trigger${cameraOn ? " is-active" : ""}${failed ? " is-error" : ""}`}
      aria-expanded={panel === "gestures"} aria-controls="native-input-panel" aria-haspopup="dialog"
      title="Hands-free controls and guide"
      onClick={() => setPanel((current) => current === "gestures" ? null : "gestures")}>
      {cameraOn && <span class="native-sensor-dot" aria-hidden="true" />}
      <span aria-live="polite">{handsFreeLabel}</span>
      {cameraOn && feedback?.progress != null &&
        <progress class="native-hold" max={1000} value={feedback.progress} aria-label={feedback.message} />}
    </button>
    {notice && !panel && !tutorial && <>
      <button type="button" class="native-input-notice" onClick={() => setPanel(failed ? "gestures" : "voice")}>input needs attention</button>
      <span class="native-input-announcement" role="alert">{notice}</span>
    </>}
    {tutorial && options.enabled && panelHost.current && createPortal(
      <GestureTutorial scope={options.scope} onClose={() => { setTutorial(false); gestureButton.current?.focus({ preventScroll: true }); }} />,
      panelHost.current)}
    {panel && panelHost.current && createPortal(<section ref={panelRef} id="native-input-panel" class="native-input-panel" role="dialog"
      aria-labelledby="native-input-title" tabIndex={-1} data-instrument-dialog
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(true); }
      }}>
      <header>
        <h2 id="native-input-title">{panel === "voice" ? "Voice" : "Hands-free"}</h2>
        <button type="button" onClick={() => close(true)} aria-label="Close input controls">close <kbd>esc</kbd></button>
      </header>
      {notice && <p class="native-input-error" role="alert">{notice}</p>}
      {!snapshot && <button type="button" disabled={!options.enabled} onClick={control.reconnect}>reconnect input</button>}
      {panel === "voice" ? <>
        <p>Listen to dictate. Pause keeps your draft.</p>
        <div class="native-panel-actions">
          {!voice ? <button type="button" class="native-primary" disabled={busy || snapshot?.devices_loading} onClick={control.start}>listen</button>
            : <button type="button" class="native-primary" disabled={voice.phase === "finishing"}
              onClick={voice.phase === "listening" ? control.stop : control.cancel}>{voice.phase === "listening" ? "pause" : voice.phase === "finishing" ? "pausing…" : "cancel"}</button>}
          <span class="native-panel-state" role="status">{voice ? voiceLabel : "Microphone off"}</span>
        </div>
        {voice?.progress != null && voice.phase !== "listening" && <progress max={1} value={voice.progress} aria-label="Preparing voice" />}
        <label class="native-device">Microphone
          <select value={control.device} disabled={busy || !!voice || snapshot?.devices_loading} onChange={(event) => control.setDevice(event.currentTarget.value)}>
            <option value="">System default</option>
            {snapshot?.devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.is_default ? " (default)" : ""}</option>)}
          </select>
          {snapshot?.devices_loading && <small role="status">Finding microphones…</small>}
        </label>
        <p class="native-panel-footnote">Local transcription. Enter sends and keeps listening.</p>
      </> : <>
        <div class="native-panel-actions">
          <button type="button" class="native-primary native-hands-free-toggle" disabled={busy} aria-label={cameraOn ? "Disable hands-free" : "Enable hands-free"}
            onClick={() => void command({ kind: "gestures", enabled: !cameraOn })}>{cameraOn ? "disable" : "enable"}</button>
          <span class="native-panel-state" role="status">{cameraOn ? feedback?.message : "Off"}</span>
        </div>
        <GestureGuide tutorialDisabled={busy} onStartTutorial={startTutorial} />
        <p class="native-panel-footnote">Camera stays on while ready. Camera and voice stay on this computer.</p>
      </>}
      <InputSoundSettings />
    </section>, panelHost.current)}
  </div>;
});
