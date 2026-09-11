import { useTerminalSessions } from "../../../services/terminal/TerminalProvider";
import { terminalFinished, type TerminalSession } from "../../../services/terminal/terminalSessions";

export function TerminalControls({ session }: { session: TerminalSession }) {
  const { sessions, connected } = useTerminalSessions();
  const live = !terminalFinished(session);
  return <div class="terminal-controls">
    {session.truncated && <div class="terminal-note">Showing the latest output.</div>}
    {(session.error || session.actionError) && <div class="terminal-error" role="alert">{session.actionError || session.error}</div>}
    {live && <div class="terminal-actions">
      {session.sessionId && <button type="button" onClick={() => sessions.toggleInput(session.id)} aria-expanded={session.inputOpen}>send input</button>}
      {session.status === "unavailable" && session.sessionId && <button type="button" disabled={!connected || !!session.action} onClick={() => sessions.retry(session.id)}>retry</button>}
      <button type="button" class="is-danger" disabled={!connected || session.action === "stop"} onClick={() => { void sessions.stop(session.id); }}>{session.action === "stop" ? "stopping…" : "stop"}</button>
    </div>}
    {live && session.sessionId && session.inputOpen && <form class="terminal-input" onSubmit={(event) => {
      event.preventDefault();
      void sessions.sendInput(session.id);
    }}>
      <input aria-label={`Input for ${session.command}`} autoFocus value={session.draft}
        disabled={!connected || session.action === "stop"}
        onInput={(event) => sessions.setDraft(session.id, event.currentTarget.value)} />
      <button type="submit" disabled={!connected || !!session.action}>{session.action === "input" ? "sending…" : "send"}</button>
    </form>}
  </div>;
}
