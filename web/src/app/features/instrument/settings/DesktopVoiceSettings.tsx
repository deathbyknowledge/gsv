import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { InputSoundSettings } from "../../../services/platform/InputSoundSettings";
import { useNativeSpeech } from "../../../services/platform/NativeSpeech";
import { ShortcutRecorder } from "../../../services/platform/ShortcutRecorder";
import { shortcutDefaults } from "../../../services/platform/shortcutKeys";
import { useNativeVoice, type VoiceComposer } from "../../../services/platform/useNativeVoice";
import "../../../services/platform/native-input.css";
import "./desktop-voice.css";

export function DesktopVoiceSettings({ active, onDirty }: { active: boolean; onDirty(dirty: boolean): void }) {
  const speech = useNativeSpeech();
  // Device discovery uses the same input lease as Chat, without a recording or draft.
  const prompt = useRef<VoiceComposer>(null);
  const microphone = useNativeVoice({ prompt, scope: "voice-settings", enabled: active, send: () => false });
  const { snapshot } = microphone;
  const [talk, setTalk] = useState(speech?.preferences.talk ?? shortcutDefaults().talk);
  const [stop, setStop] = useState(speech?.preferences.stop ?? shortcutDefaults().stop);
  const [saving, setSaving] = useState(false);
  const dirty = !!speech && (talk !== speech.preferences.talk || stop !== speech.preferences.stop);
  useLayoutEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useLayoutEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (active && snapshot && !snapshot.voice) void microphone.command({ kind: "devices" });
  }, [active, snapshot?.lease]);
  if (!speech) return null;
  const { preferences, setPreferences } = speech;
  const speaking = speech.status.phase === "speaking";
  return <section class="settings-voice" aria-label="Voice settings">
    <h1>Voice</h1>
    <p class="settings-intro">Voice preferences for this computer.</p>

    <label>Microphone
      <select value={microphone.device} disabled={!snapshot || snapshot.devices_loading || !!snapshot.voice}
        onChange={(event) => microphone.setDevice(event.currentTarget.value)}>
        <option value="">System default</option>
        {microphone.device && !snapshot?.devices.some((device) => device.id === microphone.device)
          && <option value={microphone.device}>Selected microphone unavailable</option>}
        {snapshot?.devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.is_default ? " (default)" : ""}</option>)}
      </select>
      {snapshot?.devices_loading && <small role="status">Finding microphones…</small>}
    </label>
    {(microphone.error || snapshot?.notice) && <p class="settings-error" role="alert">{microphone.error || snapshot?.notice}</p>}
    {!snapshot && <button type="button" class="settings-text-action" onClick={microphone.reconnect}>reconnect microphone controls</button>}

    <h2>Talk from other apps</h2>
    <label class="settings-check"><input type="checkbox" checked={preferences.enabled}
      onChange={(event) => setPreferences({ enabled: event.currentTarget.checked })} />Enable voice shortcuts and spoken replies</label>
    {preferences.enabled && <>
      <p class="settings-muted">Keep Chat open in the background to talk without switching windows.</p>
      <label>Shortcut mode
        <select value={preferences.mode} onChange={(event) => setPreferences({ mode: event.currentTarget.value === "hold" ? "hold" : "toggle" })}>
          <option value="toggle">Press to start · press again to send</option><option value="hold">Hold to talk · release to send</option>
        </select>
      </label>
      {!speech.shortcuts ? <p class="settings-muted" role="status">Registering shortcuts…</p>
        : speech.shortcuts.managed ? <div class="settings-voice-shortcuts">
          <p class="settings-muted">{speech.shortcuts.description}</p>
          {speech.shortcuts.can_configure
            ? <button type="button" class="settings-text-action" onClick={() => void speech.editShortcuts()}>change shortcuts in desktop settings</button>
            : <p class="settings-muted">Set “Talk to Ship” and “Stop Ship speaking or cancel recording” in your desktop’s keyboard configuration.</p>}
        </div> : <div class="native-shortcut-fields">
          <ShortcutRecorder label="Talk" value={talk} disabled={!active || saving} capture={speech.captureShortcuts} onChange={setTalk} />
          <ShortcutRecorder label="Stop / cancel" value={stop} disabled={!active || saving} capture={speech.captureShortcuts} onChange={setStop} />
          <button type="button" class="ibtn" disabled={saving || !dirty} onClick={async () => {
            setSaving(true);
            await speech.applyShortcuts(talk, stop);
            setSaving(false);
          }}>{saving ? "saving…" : "save shortcuts"}</button>
        </div>}

      <h2>Spoken replies</h2>
      <label>Read replies
        <select value={preferences.replies} onChange={(event) => setPreferences({ replies: event.currentTarget.value === "all" ? "all" : event.currentTarget.value === "off" ? "off" : "voice" })}>
          <option value="voice">While talking by voice</option><option value="all">All new Ship replies</option><option value="off">Off</option>
        </select>
      </label>
      <label>Voice
        <select value={preferences.language} onChange={(event) => setPreferences({ language: event.currentTarget.value === "es" ? "es" : "en" })}>
          <option value="en">Heart · English</option><option value="es">Dora · Spanish</option>
        </select>
      </label>
      <div class="settings-actions">
        <button type="button" class="settings-text-action" onClick={() => void speech.command(speaking ? { kind: "cancel" } : {
          kind: "speak", id: "voice-preview", language: preferences.language,
          chunks: [preferences.language === "es" ? "Aquí estoy. Puedes seguir jugando mientras hablamos." : "I'm here. You can keep playing while we talk."],
        })}>{speaking ? "stop preview" : "preview voice"}</button>
        {speech.status.phase === "loading" && <span role="status">Loading voice…</span>}
      </div>
      {speech.error && <p class="settings-error" role="alert">{speech.error}</p>}
    </>}
    <InputSoundSettings />
  </section>;
}
