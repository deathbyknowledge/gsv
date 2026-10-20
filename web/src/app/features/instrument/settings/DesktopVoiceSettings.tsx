import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { useNativeSpeech } from "../../../services/platform/NativeSpeech";
import { ShortcutRecorder } from "../../../services/platform/ShortcutRecorder";
import { shortcutDefaults } from "../../../services/platform/shortcutKeys";
import { useNativeVoiceSession } from "../../../services/platform/NativeVoiceSession";
import { AppLink } from "../../../services/navigation/appNavigation";
import { rich, useT } from "../../../i18n/locale";
import "../../../services/platform/native-input.css";
import "./desktop-voice.css";

export function DesktopVoiceSettings({ active, onDirty }: { active: boolean; onDirty(dirty: boolean): void }) {
  const t = useT();
  const speech = useNativeSpeech();
  // Device discovery uses the same input lease as Chat, without a recording or draft.
  const session = useNativeVoiceSession();
  const microphone = session?.input;
  const snapshot = microphone?.snapshot;
  const [talk, setTalk] = useState(speech?.preferences.talk ?? shortcutDefaults().talk);
  const [stop, setStop] = useState(speech?.preferences.stop ?? shortcutDefaults().stop);
  const [saving, setSaving] = useState(false);
  const dirty = !!speech && (talk !== speech.preferences.talk || stop !== speech.preferences.stop);
  useLayoutEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useLayoutEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (active && snapshot && !microphone?.capturing) void microphone?.command({ kind: "devices" });
  }, [active, snapshot?.lease, microphone?.capturing]);
  if (!speech || !microphone || !session) return null;
  const { language, languageError } = session;
  const { preferences, setPreferences } = speech;
  const speaking = speech.status.phase === "speaking";
  return <section class="settings-voice" aria-label={t("settings.voice.label")}>
    <h1>{t("settings.voice.title")}</h1>
    <p class="settings-intro">{t("settings.voice.intro")}</p>

    <label>{t("settings.voice.microphone")}
      <select value={microphone.device} disabled={!snapshot || snapshot.devices_loading || microphone.capturing}
        onChange={(event) => microphone.setDevice(event.currentTarget.value)}>
        <option value="">{t("settings.voice.systemDefault")}</option>
        {microphone.device && !snapshot?.devices.some((device) => device.id === microphone.device)
          && <option value={microphone.device}>{t("settings.voice.microphoneUnavailable")}</option>}
        {snapshot?.devices.map((device) => <option key={device.id} value={device.id}>{device.is_default ? t("settings.voice.defaultDevice", { name: device.name }) : device.name}</option>)}
      </select>
      {snapshot?.devices_loading && <small role="status">{t("settings.voice.finding")}</small>}
    </label>
    {(microphone.error || snapshot?.notice) && <p class="settings-error" role="alert">{microphone.error || snapshot?.notice}</p>}
    {!snapshot && <button type="button" class="settings-text-action" onClick={microphone.reconnect}>{t("settings.voice.reconnect")}</button>}

    <h2>{t("settings.voice.handsfree")}</h2>
    <label class="settings-check"><input type="checkbox" checked={preferences.enabled}
      onChange={(event) => setPreferences({ enabled: event.currentTarget.checked })} />{t("settings.voice.enableHandsfree")}</label>
    {preferences.enabled && <>
      <p class="settings-muted">{t("settings.voice.handsfreeHint")}</p>
      <label>{t("settings.voice.shortcutMode")}
        <select value={preferences.mode} onChange={(event) => setPreferences({ mode: event.currentTarget.value === "hold" ? "hold" : "toggle" })}>
          <option value="toggle">{t("settings.voice.toggle")}</option><option value="hold">{t("settings.voice.hold")}</option>
        </select>
      </label>
      {!speech.shortcuts ? <p class="settings-muted" role="status">{t("settings.voice.registering")}</p>
        : speech.shortcuts.managed ? <div class="settings-voice-shortcuts">
          <p class="settings-muted">{speech.shortcuts.description}</p>
          {speech.shortcuts.can_configure
            ? <button type="button" class="settings-text-action" onClick={() => void speech.editShortcuts()}>{t("settings.voice.editShortcuts")}</button>
            // The desktop portal lists these shortcuts by the names Ship Desktop registers, so they stay as registered.
            : <p class="settings-muted">{t("settings.voice.desktopShortcuts", { talk: "Talk to Ship", stop: "Stop Ship speaking or cancel recording" })}</p>}
        </div> : <div class="native-shortcut-fields">
          <ShortcutRecorder label={t("settings.voice.talk")} value={talk} disabled={!active || saving} capture={speech.captureShortcuts} onChange={setTalk} />
          <ShortcutRecorder label={t("settings.voice.stop")} value={stop} disabled={!active || saving} capture={speech.captureShortcuts} onChange={setStop} />
          <button type="button" class="ibtn" disabled={saving || !dirty} onClick={async () => {
            setSaving(true);
            await speech.applyShortcuts(talk, stop);
            setSaving(false);
          }}>{t(saving ? "common.saving" : "settings.voice.saveShortcuts")}</button>
        </div>}

      <h2>{t("settings.voice.replies")}</h2>
      <label>{t("settings.voice.readReplies")}
        <select value={preferences.replies} onChange={(event) => setPreferences({ replies: event.currentTarget.value === "all" ? "all" : event.currentTarget.value === "off" ? "off" : "voice" })}>
          <option value="voice">{t("settings.voice.repliesVoice")}</option><option value="all">{t("settings.voice.repliesAll")}</option><option value="off">{t("settings.voice.repliesOff")}</option>
        </select>
      </label>
      <p class="settings-muted">{rich(t("settings.voice.usesLanguage"), { link: <AppLink href="/chat/settings?section=preferences">{t("settings.voice.responseLanguage")}</AppLink> })}</p>
      {languageError && <p class="settings-error" role="alert">{languageError}</p>}
      {!language && !languageError && <p class="settings-muted" role="status">{t("settings.voice.loadingLanguage")}</p>}
      <div class="settings-actions">
        <button type="button" class="settings-text-action" disabled={!speaking && !language} onClick={() => {
          if (speaking) void speech.command({ kind: "cancel" });
          else if (language) void speech.command({ kind: "speak", id: "voice-preview", language,
            chunks: [language === "es" ? "Aquí estoy. Puedes seguir jugando mientras hablamos." : "I'm here. You can keep playing while we talk."],
          });
        }}>{t(speaking ? "settings.voice.stopPreview" : "settings.voice.preview")}</button>
        {speech.status.phase === "loading" && <span role="status">{t("settings.voice.loading")}</span>}
      </div>
      {speech.error && <p class="settings-error" role="alert">{speech.error}</p>}
    </>}
  </section>;
}
