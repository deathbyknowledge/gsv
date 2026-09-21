import type { useNativeVoice } from "./useNativeVoice";
import { NativeGestureFeedback } from "./NativeGestureFeedback";

export function NativeVoiceControls({ control, disabled }: { control: ReturnType<typeof useNativeVoice>; disabled: boolean }) {
  if (!control.available) return null;
  const { snapshot, error, command } = control;
  const voice = snapshot?.voice;
  const busy = disabled || !snapshot;
  return <div class="native-input-controls" aria-label="Native voice and gestures">
    {!snapshot ? <button type="button" onClick={control.reconnect} disabled={disabled}>connect native input</button> : null}
    <button type="button" disabled={busy || voice?.phase === "finishing"} onClick={voice ? control.stop : control.start}>{voice ? "finish voice" : "voice"}</button>
    {voice && <>
      <span role="status">{voice.phase}{voice.progress !== null ? ` ${Math.round(voice.progress * 100)}%` : ""}</span>
      <button type="button" disabled={busy || voice.phase !== "listening" || voice.muted === null || voice.mute_pending} aria-pressed={voice.muted === true}
        onClick={() => void command({ kind: "mute", request_id: voice.request_id, muted: !voice.muted })}>{voice.mute_pending ? "changing mute…" : voice.muted ? "unmute" : "mute"}</button>
      <button type="button" disabled={busy || voice.phase !== "listening" || voice.pending !== null} onClick={() => control.segment("send")}>send segment</button>
      <button type="button" disabled={busy || voice.phase !== "listening" || voice.pending !== null} onClick={() => control.segment("delete")}>delete voice character</button>
      <button type="button" disabled={busy || voice.phase !== "listening" || voice.pending !== null} onClick={() => control.segment("clear")}>clear dictation</button>
      <button type="button" onClick={control.cancel}>cancel voice</button>
    </>}
    <button type="button" disabled={busy || !!voice} onClick={() => void command({ kind: "devices" })}>microphones</button>
    {!!snapshot?.devices.length && <select aria-label="Microphone" disabled={!!voice} value={control.device} onChange={(event) => control.setDevice(event.currentTarget.value)}>
      <option value="">system default</option>
      {snapshot.devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.is_default ? " (default)" : ""}</option>)}
    </select>}
    <button type="button" disabled={busy} aria-pressed={snapshot?.gestures_enabled ?? false}
      onClick={() => void command({ kind: "gestures", enabled: !snapshot?.gestures_enabled })}>{snapshot?.gestures_enabled ? "camera off" : "enable gestures"}</button>
    {snapshot?.gestures_enabled && <>
      <button type="button" disabled={busy || (!snapshot.armed && snapshot.gesture_status !== "ready")} aria-pressed={snapshot.armed}
        onClick={() => void command({ kind: "arm", armed: !snapshot.armed })}>{snapshot.armed ? "disarm gestures" : "arm gestures"}</button>
    </>}
    {snapshot && <NativeGestureFeedback snapshot={snapshot} />}
    {(error || snapshot?.notice) && <span class="native-notice" role="status">{error || snapshot?.notice}</span>}
  </div>;
}
