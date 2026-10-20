import { useNativeVoiceSession } from "./NativeVoiceSession";
import { useNativeSpeech } from "./NativeSpeech";
import { voicePreparation } from "./nativePresentation";
import { useT } from "../../i18n/locale";
import "./native-input.css";

/** Temporary feedback stays available without navigating or taking focus from another app. */
export function HandsfreeStatus() {
  const t = useT();
  const session = useNativeVoiceSession();
  const speech = useNativeSpeech();
  if (!session) return null;
  const { input, capture, text, outbox, connected } = session;
  const ownsInput = capture?.kind === "handsfree";
  const recording = ownsInput && input.capturing;
  const voice = ownsInput ? input.snapshot?.voice : null;
  const preparation = voicePreparation(t, voice);
  const error = speech?.preferences.enabled && capture?.kind !== "composer" ? input.error || input.snapshot?.notice : null;
  const speaking = speech?.preferences.enabled && speech.status.phase === "speaking";
  if (!recording && !text && !outbox.messages.length && !error && !speaking) return null;
  const label = recording ? voice?.phase === "listening" ? t("desktop.handsfree.listening") : voice?.phase === "finishing" ? t("desktop.handsfree.finishing") : preparation?.message ?? t("desktop.handsfree.preparing")
    : t(!connected ? "desktop.handsfree.reconnecting" : outbox.sending ? "desktop.handsfree.sending" : text || outbox.messages.length || error ? "desktop.handsfree.needsAttention" : "desktop.handsfree.speaking");
  return <aside class="handsfree-status" aria-label={t("desktop.handsfree.label")} data-instrument-dialog onKeyDown={(event) => event.stopPropagation()}>
    <header><span>{t("desktop.handsfree.title")} <span class="handsfree-phase" role="status">{label}</span></span>
      {recording && <span class="handsfree-actions">
        <button type="button" disabled={voice?.phase === "finishing"} onClick={session.send}>{t("desktop.handsfree.send")}</button>
        <button type="button" onClick={input.cancel}>{t("common.cancel")}</button>
      </span>}
      {speaking && <button type="button" onClick={() => void speech?.command({ kind: "cancel" })}>{t("desktop.voice.stopSpeaking")}</button>}
    </header>
    {preparation && <progress max={1} value={preparation.progress} aria-label={preparation.message} />}
    {recording && text && <p class="handsfree-preview">{text}</p>}
    {!recording && text && <details>
      <summary>{t("desktop.handsfree.review")}</summary>
      <textarea aria-label={t("desktop.handsfree.draft")} value={text} onInput={(event) => session.edit(event.currentTarget.value)} rows={3} />
      <div class="handsfree-actions">
        <button type="button" disabled={!connected || outbox.sending || !text.trim()} onClick={session.send}>{t("desktop.handsfree.sendToShip")}</button>
        <button type="button" onClick={session.discard}>{t("desktop.discard")}</button>
      </div>
    </details>}
    {error && <div class="handsfree-error" role="alert">{error}
      {!input.snapshot && <button type="button" onClick={input.reconnect}>{t("desktop.handsfree.reconnectMicrophone")}</button>}
      {input.error && <button type="button" onClick={input.clearError}>{t("desktop.dismiss")}</button>}
    </div>}
    {outbox.messages.filter((message) => message.status === "failed").map((message) => <details key={message.id}>
      <summary>{t("desktop.handsfree.notSent")}</summary>
      <p>{message.draft.message}</p>
      <p class="handsfree-error" role="alert">{message.error}</p>
      <div class="handsfree-actions">
        <button type="button" disabled={!connected || outbox.sending} onClick={() => outbox.retry(message)}>{t("desktop.retry")}</button>
        <button type="button" onClick={() => outbox.discard(message.id)}>{t("desktop.discard")}</button>
      </div>
    </details>)}
  </aside>;
}
