import { Button } from "@cloudflare/kumo/components/button";
import { useReactUiStore } from "../state/store";

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function SessionsView() {
  const sessions = useReactUiStore((s) => s.sessions);
  const sessionsLoading = useReactUiStore((s) => s.sessionsLoading);
  const settings = useReactUiStore((s) => s.settings);
  const loadSessions = useReactUiStore((s) => s.loadSessions);
  const selectSession = useReactUiStore((s) => s.selectSession);
  const resetSession = useReactUiStore((s) => s.resetSession);

  return (
    <div className="view-container">
      <div className="section-header">
        <h2 className="section-title">Active Sessions</h2>
        <Button
          size="sm"
          variant="secondary"
          loading={sessionsLoading}
          onClick={() => {
            void loadSessions();
          }}
        >
          Refresh
        </Button>
      </div>

      {sessionsLoading && sessions.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <div className="thinking-indicator">
              <span className="spinner"></span>
              <span>Loading sessions...</span>
            </div>
          </div>
        </div>
      ) : sessions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📋</div>
          <h3 className="empty-state-title">No sessions</h3>
          <p className="empty-state-description">
            Sessions are created when you or others start conversations.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Session Key</th>
                <th>Label</th>
                <th>Last Active</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const isCurrentSession = session.sessionKey === settings.sessionKey;
                return (
                  <tr key={session.sessionKey}>
                    <td>
                      <code className="mono" style={{ fontSize: "var(--font-size-xs)" }}>
                        {session.sessionKey}
                      </code>
                      {isCurrentSession ? (
                        <span
                          className="pill pill-success"
                          style={{ marginLeft: "var(--space-2)" }}
                        >
                          current
                        </span>
                      ) : null}
                    </td>
                    <td>{session.label || <span className="muted">—</span>}</td>
                    <td>{formatRelativeTime(session.lastActiveAt)}</td>
                    <td>{formatRelativeTime(session.createdAt)}</td>
                    <td>
                      <div style={{ display: "flex", gap: "var(--space-2)" }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void selectSession(session.sessionKey);
                          }}
                          disabled={isCurrentSession}
                        >
                          Open
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (
                              confirm(
                                `Reset session ${session.sessionKey}? This will archive all messages.`,
                              )
                            ) {
                              void resetSession(session.sessionKey);
                            }
                          }}
                        >
                          Reset
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
