import { useTerminalSessions } from "../../../services/terminal/TerminalProvider";
import { terminalFinished, type TerminalSession } from "../../../services/terminal/terminalSessions";
import { useT } from "../../../i18n/locale";

export function TerminalControls({ session }: { session: TerminalSession }) {
  const t = useT();
  const { sessions, connected } = useTerminalSessions();
  const live = !terminalFinished(session);
  return <div class="terminal-controls">
    {session.truncated && <div class="terminal-note">{t("chat.terminal.latest")}</div>}
    {(session.error || session.actionError) && <div class="terminal-error" role="alert">{session.actionError || session.error}</div>}
    {live && <div class="terminal-actions">
      {session.sessionId && <button type="button" onClick={() => sessions.toggleInput(session.id)} aria-expanded={session.inputOpen}>{t("chat.terminal.input")}</button>}
      {session.status === "unavailable" && session.sessionId && <button type="button" disabled={!connected || !!session.action} onClick={() => sessions.retry(session.id)}>{t("chat.retry")}</button>}
      <button type="button" class="is-danger" disabled={!connected || session.action === "stop"} onClick={() => { void sessions.stop(session.id); }}>{t(session.action === "stop" ? "chat.work.stopping" : "chat.terminal.stop")}</button>
    </div>}
    {live && session.sessionId && session.inputOpen && <form class="terminal-input" onSubmit={(event) => {
      event.preventDefault();
      void sessions.sendInput(session.id);
    }}>
      <input aria-label={t("chat.terminal.inputFor", { command: session.command })} autoFocus value={session.draft}
        disabled={!connected || session.action === "stop"}
        onInput={(event) => sessions.setDraft(session.id, event.currentTarget.value)} />
      <button type="submit" disabled={!connected || !!session.action}>{t(session.action === "input" ? "chat.sending" : "chat.send")}</button>
    </form>}
  </div>;
}
