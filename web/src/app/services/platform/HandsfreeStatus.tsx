import { useNativeVoiceSession } from "./NativeVoiceSession";
import { useNativeSpeech } from "./NativeSpeech";
import { voicePreparation } from "./nativePresentation";
import "./native-input.css";

/** Temporary feedback stays available without navigating or taking focus from another app. */
export function HandsfreeStatus() {
  const session = useNativeVoiceSession();
  const speech = useNativeSpeech();
  if (!session) return null;
  const { input, capture, text, outbox, connected } = session;
  const ownsInput = capture?.kind === "handsfree";
  const recording = ownsInput && input.capturing;
  const voice = ownsInput ? input.snapshot?.voice : null;
  const preparation = voicePreparation(voice);
  const error = speech?.preferences.enabled && capture?.kind !== "composer" ? input.error || input.snapshot?.notice : null;
  const speaking = speech?.preferences.enabled && speech.status.phase === "speaking";
  if (!recording && !text && !outbox.messages.length && !error && !speaking) return null;
  const label = recording ? voice?.phase === "listening" ? "Listening" : voice?.phase === "finishing" ? "Finishing…" : preparation?.message ?? "Preparing…"
    : !connected ? "Reconnecting…" : outbox.sending ? "Sending…" : text || outbox.messages.length || error ? "Needs attention" : "Speaking";
  return <aside class="handsfree-status" aria-label="Handsfree mode" data-instrument-dialog onKeyDown={(event) => event.stopPropagation()}>
    <header><span>handsfree <span class="handsfree-phase" role="status">{label}</span></span>
      {recording && <span class="handsfree-actions">
        <button type="button" disabled={voice?.phase === "finishing"} onClick={session.send}>send</button>
        <button type="button" onClick={() => input.cancel()}>cancel</button>
      </span>}
      {speaking && <button type="button" onClick={() => void speech?.command({ kind: "cancel" })}>stop speaking</button>}
    </header>
    {preparation && <progress max={1} value={preparation.progress} aria-label={preparation.message} />}
    {recording && text && <p class="handsfree-preview">{text}</p>}
    {!recording && text && <details>
      <summary>review voice draft</summary>
      <textarea aria-label="Handsfree draft" value={text} onInput={(event) => session.edit(event.currentTarget.value)} rows={3} />
      <div class="handsfree-actions">
        <button type="button" disabled={!connected || outbox.sending || !text.trim()} onClick={session.send}>send to Ship</button>
        <button type="button" onClick={session.discard}>discard</button>
      </div>
    </details>}
    {error && <div class="handsfree-error" role="alert">{error}
      {!input.snapshot && <button type="button" onClick={input.reconnect}>reconnect microphone</button>}
      {input.error && <button type="button" onClick={input.clearError}>dismiss</button>}
    </div>}
    {outbox.messages.filter((message) => message.status === "failed").map((message) => <details key={message.id}>
      <summary>message not sent</summary>
      <p>{message.draft.message}</p>
      <p class="handsfree-error" role="alert">{message.error}</p>
      <div class="handsfree-actions">
        <button type="button" disabled={!connected || outbox.sending} onClick={() => outbox.retry(message)}>retry</button>
        <button type="button" onClick={() => outbox.discard(message.id)}>discard</button>
      </div>
    </details>)}
  </aside>;
}
