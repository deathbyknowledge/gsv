import type { RefObject } from "preact";
import { createPortal, forwardRef } from "preact/compat";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismissOnOutsideClick } from "../../features/instrument/shared/useDismissOnOutsideClick";
import { gestureFeedback } from "./NativeGestureFeedback";
import { GestureGuide } from "./GestureGuide";
import { useNativeVoice } from "./useNativeVoice";
import "./native-input.css";

export type NativeVoiceHandle = Pick<ReturnType<typeof useNativeVoice>, "onInput" | "interceptSubmit">;
type Panel = "voice" | "gestures";
type NativeVoiceControlsProps = Parameters<typeof useNativeVoice>[0] & {
  /** Zen owns the full reading area; the composer footer must not constrain panels. */
  panelHost: RefObject<HTMLDivElement>;
};

export const NativeVoiceControls = forwardRef<NativeVoiceHandle, NativeVoiceControlsProps>(function NativeVoiceControls({ panelHost, ...options }, ref) {
  const control = useNativeVoice(options);
  useImperativeHandle(ref, () => ({ onInput: control.onInput, interceptSubmit: control.interceptSubmit }));
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const voiceButton = useRef<HTMLButtonElement>(null);
  const gestureButton = useRef<HTMLButtonElement>(null);
  const { snapshot, error, command } = control;
  const voice = snapshot?.voice;
  const notice = error || snapshot?.notice;
  const busy = !options.enabled || !snapshot;
  const feedback = snapshot ? gestureFeedback(snapshot) : null;
  const cameraOn = snapshot?.gestures_enabled ?? false;
  const gestureReady = snapshot?.gesture_status === "ready";
  const gestureFailed = cameraOn && !gestureReady && snapshot?.gesture_status !== "starting";
  const voiceLabel = !voice ? "voice" : voice.phase === "listening"
    ? voice.muted ? "mic paused" : "listening"
    : voice.phase === "finishing" ? "finishing voice" : "preparing voice";
  const gestureLabel = !cameraOn ? "gestures" : gestureFailed ? "camera unavailable"
    : feedback?.progress !== null && feedback?.progress !== undefined ? feedback.message
    : feedback?.action ?? (snapshot?.armed ? "gestures armed" : gestureReady ? "camera on" : "starting camera");
  const close = (restoreFocus: boolean) => {
    if (restoreFocus) (panel === "voice" ? voiceButton : gestureButton).current?.focus({ preventScroll: true });
    setPanel(null);
  };
  useDismissOnOutsideClick(panel !== null, () => [panelRef.current, voiceButton.current, gestureButton.current], () => close(false));
  useLayoutEffect(() => {
    if (panel) panelRef.current?.focus({ preventScroll: true });
  }, [panel]);
  useEffect(() => {
    if (panel === "voice" && snapshot && !snapshot.voice && !snapshot.devices_loading) void command({ kind: "devices" });
  }, [panel, snapshot?.lease]);
  useEffect(() => { setPanel(null); }, [options.scope]);

  if (!control.available) return null;
  return <div class="native-input-controls" aria-label="Voice and gestures" onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}>
    <button ref={voiceButton} type="button" class={`native-input-trigger${voice ? " is-active" : ""}`}
      aria-expanded={panel === "voice"} aria-controls="native-input-panel" aria-haspopup="dialog"
      title={voice ? "Microphone controls" : "Dictate with your microphone"}
      onClick={() => setPanel((current) => current === "voice" ? null : "voice")}>
      {voice && <span class={`native-sensor-dot${voice.muted ? " is-paused" : ""}`} aria-hidden="true" />}
      <span aria-live="polite">{voiceLabel}</span>
    </button>
    {voice && <button type="button" onClick={voice.phase === "listening" ? control.stop : control.cancel}>
      {voice.phase === "listening" ? "finish" : "cancel"}
    </button>}
    <button ref={gestureButton} type="button" class={`native-input-trigger${cameraOn ? " is-active" : ""}${gestureFailed ? " is-error" : ""}`}
      aria-expanded={panel === "gestures"} aria-controls="native-input-panel" aria-haspopup="dialog"
      title={cameraOn ? `Camera enabled · gestures ${snapshot?.armed ? "armed" : "disarmed"}. Open controls and guide.` : "Camera controls and gesture guide"}
      onClick={() => setPanel((current) => current === "gestures" ? null : "gestures")}>
      {cameraOn && <span class={`native-sensor-dot${!snapshot?.armed ? " is-paused" : ""}`} aria-hidden="true" />}
      <span aria-live="polite">{gestureLabel}</span>
      {cameraOn && feedback?.progress !== null && feedback?.progress !== undefined &&
        <progress class="native-hold" max={1000} value={feedback.progress} aria-label={feedback.message} />}
    </button>
    {notice && !panel && <>
      <button type="button" class="native-input-notice" onClick={() => setPanel("voice")}>input needs attention</button>
      <span class="native-input-announcement" role="alert">{notice}</span>
    </>}
    {panel && panelHost.current && createPortal(<section ref={panelRef} id="native-input-panel" class="native-input-panel" role="dialog"
      aria-labelledby="native-input-title" tabIndex={-1} data-instrument-dialog
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(true); }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && ![panelRef.current, voiceButton.current, gestureButton.current].some((element) => element?.contains(next))) close(false);
      }}>
      <header>
        <h2 id="native-input-title">{panel === "voice" ? "Voice" : "Gestures"}</h2>
        <button type="button" onClick={() => close(true)} aria-label="Close input controls">close <kbd>esc</kbd></button>
      </header>
      {notice && <p class="native-input-error" role="alert">{notice}</p>}
      {!snapshot && <div class="native-panel-actions">
        <button type="button" disabled={!options.enabled} onClick={control.reconnect}>reconnect input</button>
      </div>}
      {panel === "voice" ? <>
        <p>Speak into your draft. Finish keeps your words here; Enter sends them.</p>
        <div class="native-panel-state" role="status">
          {voice ? voiceLabel : "Microphone off"}
          {voice?.progress !== null && voice?.progress !== undefined && voice.phase !== "listening" &&
            <progress max={1} value={voice.progress} aria-label="Preparing voice" />}
        </div>
        <div class="native-panel-actions">
          {!voice ? <button type="button" class="native-primary" disabled={busy || snapshot?.devices_loading} onClick={() => {
            control.start(); close(false); options.prompt.current?.focus();
          }}>start listening</button> : <>
            {voice.phase === "listening" ? <>
              <button type="button" class="native-primary" onClick={control.stop}>finish dictation</button>
              <button type="button" disabled={busy || voice.muted === null || voice.mute_pending}
                onClick={() => void command({ kind: "mute", request_id: voice.request_id, muted: !voice.muted })}>
                {voice.mute_pending ? "updating microphone…" : voice.muted ? "resume microphone" : "pause microphone"}
              </button>
            </> : <button type="button" onClick={control.cancel}>cancel</button>}
          </>}
        </div>
        <label class="native-device">Microphone
          <select value={control.device} disabled={busy || !!voice || snapshot?.devices_loading} onChange={(event) => control.setDevice(event.currentTarget.value)}>
            <option value="">System default</option>
            {snapshot?.devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.is_default ? " (default)" : ""}</option>)}
          </select>
          {snapshot?.devices_loading && <small role="status">Finding microphones…</small>}
        </label>
        <p class="native-panel-footnote">Transcription runs on this computer. While listening, Enter sends and keeps the microphone on.</p>
      </> : <>
        <p>Use your hands to dictate and navigate. Camera video stays on this computer.</p>
        <div class="native-panel-actions">
          <button type="button" class={cameraOn ? "" : "native-primary"} disabled={busy}
            onClick={() => void command({ kind: "gestures", enabled: !cameraOn })}>{cameraOn ? "turn camera off" : "enable camera"}</button>
          {cameraOn && <span class="native-panel-state">{gestureReady ? "Camera on" : snapshot?.gesture_status === "starting" ? "Starting camera…" : "Camera unavailable"}</span>}
        </div>
        {cameraOn && <label class="native-armed">
          <input type="checkbox" checked={snapshot?.armed ?? false} disabled={busy || (!snapshot?.armed && !gestureReady)}
            onChange={(event) => void command({ kind: "arm", armed: event.currentTarget.checked })} />
          <span>Arm gesture control<small>Gestures can send messages and edit dictation while armed.</small></span>
        </label>}
        {cameraOn && feedback && <p class={gestureFailed ? "native-input-error" : "native-panel-state"} role="status">{feedback.message}</p>}
        <GestureGuide />
      </>}
    </section>, panelHost.current)}
  </div>;
});
