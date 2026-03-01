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

function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleString();
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
      <div className="app-shell" data-app="sessions">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">Session Console</h2>
              <p className="app-hero-subtitle">
                Browse active histories, switch the focused conversation, or reset a
                thread to archive and restart context.
              </p>
              <div className="app-hero-meta">
                <span className="app-badge-dot" />
                <span>{sessions.length} tracked sessions</span>
              </div>
            </div>
            <div className="app-actions">
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
          </div>
        </section>

        <section className="app-panel app-col-12">
          <header className="app-panel-head">
            <h3 className="app-panel-title">Active Sessions</h3>
            <span className="app-panel-meta">{sessions.length} entries</span>
          </header>
          <div className="app-panel-body">
            {sessionsLoading && sessions.length === 0 ? (
              <div className="app-empty">
                <div>
                  <span className="spinner" />
                  <div style={{ marginTop: "var(--space-2)" }}>Loading sessions...</div>
                </div>
              </div>
            ) : sessions.length === 0 ? (
              <div className="app-empty">
                <div>
                  <div className="app-empty-icon">📋</div>
                  <div>No sessions yet</div>
                  <div className="text-secondary" style={{ marginTop: "var(--space-1)" }}>
                    Sessions appear after a chat run starts.
                  </div>
                </div>
              </div>
            ) : (
              <div className="app-list">
                {sessions.map((session) => {
                  const isCurrent = session.sessionKey === settings.sessionKey;
                  return (
                    <article className="app-list-item" key={session.sessionKey}>
                      <div className="app-list-head">
                        <div>
                          <div className="app-list-title mono">{session.sessionKey}</div>
                          <div className="app-list-subtitle">
                            {session.label ? session.label : "Unlabeled session"}
                          </div>
                        </div>
                        <div className="app-actions">
                          {isCurrent ? <span className="pill pill-success">current</span> : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              void selectSession(session.sessionKey);
                            }}
                            disabled={isCurrent}
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
                      </div>

                      <div className="app-list-meta">
                        <div className="app-meta-row">
                          <div className="app-meta-label">Last Active</div>
                          <div className="app-meta-value" title={formatAbsoluteTime(session.lastActiveAt)}>
                            {formatRelativeTime(session.lastActiveAt)}
                          </div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Created</div>
                          <div className="app-meta-value" title={formatAbsoluteTime(session.createdAt)}>
                            {formatRelativeTime(session.createdAt)}
                          </div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Status</div>
                          <div className="app-meta-value">{isCurrent ? "In focus" : "Idle"}</div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
