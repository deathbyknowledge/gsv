import { Button } from "@cloudflare/kumo/components/button";
import { useReactUiStore } from "../state/store";

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function channelIcon(channel: string): string {
  if (channel.includes("whatsapp")) return "📱";
  if (channel.includes("discord")) return "🎮";
  return "🔗";
}

type PairingViewProps = {
  embedded?: boolean;
};

export function PairingView({ embedded = false }: PairingViewProps = {}) {
  const pairingRequests = useReactUiStore((s) => s.pairingRequests);
  const pairingLoading = useReactUiStore((s) => s.pairingLoading);
  const loadPairing = useReactUiStore((s) => s.loadPairing);
  const pairApprove = useReactUiStore((s) => s.pairApprove);
  const pairReject = useReactUiStore((s) => s.pairReject);

  return (
    <div className={embedded ? undefined : "view-container"}>
      <div className={embedded ? "app-list" : "app-shell"} data-app={embedded ? undefined : "pairing"}>
        {!embedded ? (
          <section className="app-hero">
            <div className="app-hero-content">
              <div>
                <h2 className="app-hero-title">Pairing Queue</h2>
                <p className="app-hero-subtitle">
                  Review identity and origin before approving new channel senders.
                  Pending requests are only allowed after explicit approval.
                </p>
                <div className="app-hero-meta">
                  <span className="app-badge-dot" />
                  <span>{pairingRequests.length} pending request(s)</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                loading={pairingLoading}
                onClick={() => {
                  void loadPairing();
                }}
              >
                Refresh
              </Button>
            </div>
          </section>
        ) : (
          <div className="app-actions" style={{ justifyContent: "flex-end" }}>
            <Button
              size="sm"
              variant="secondary"
              loading={pairingLoading}
              onClick={() => {
                void loadPairing();
              }}
            >
              Refresh
            </Button>
          </div>
        )}

        <section className="app-panel">
          <header className="app-panel-head">
            <h3 className="app-panel-title">Requests</h3>
            <span className="app-panel-meta">access control</span>
          </header>
          <div className="app-panel-body">
            {pairingLoading && !pairingRequests.length ? (
              <div className="app-empty" style={{ minHeight: 180 }}>
                <div>
                  <span className="spinner" />
                  <div style={{ marginTop: "var(--space-2)" }}>Loading pairing requests...</div>
                </div>
              </div>
            ) : !pairingRequests.length ? (
              <div className="app-empty" style={{ minHeight: 220 }}>
                <div>
                  <div className="app-empty-icon">🤝</div>
                  <div>No pending requests</div>
                  <div className="text-secondary" style={{ marginTop: "var(--space-1)" }}>
                    New pairing attempts will show up here.
                  </div>
                </div>
              </div>
            ) : (
              <div className="app-list">
                {pairingRequests.map((pair) => (
                  <article className="app-list-item" key={`${pair.channel}:${pair.senderId}`}>
                    <div className="app-list-head">
                      <div>
                        <div className="app-list-title">
                          <span style={{ marginRight: "var(--space-2)" }}>
                            {channelIcon(pair.channel)}
                          </span>
                          {pair.senderName || pair.senderId}
                        </div>
                        <div className="app-list-subtitle mono">
                          {pair.channel} · {pair.senderId}
                        </div>
                      </div>
                      <div className="app-actions">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => {
                            void pairApprove(pair.channel, pair.senderId);
                          }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (
                              confirm(
                                `Reject pairing request from ${pair.senderName || pair.senderId}?`,
                              )
                            ) {
                              void pairReject(pair.channel, pair.senderId);
                            }
                          }}
                        >
                          Reject
                        </Button>
                      </div>
                    </div>

                    <div className="app-list-meta">
                      <div className="app-meta-row">
                        <div className="app-meta-label">Requested</div>
                        <div className="app-meta-value">{relativeTime(pair.requestedAt)}</div>
                      </div>
                      <div className="app-meta-row">
                        <div className="app-meta-label">Channel</div>
                        <div className="app-meta-value">{pair.channel}</div>
                      </div>
                      <div className="app-meta-row">
                        <div className="app-meta-label">Message</div>
                        <div className="app-meta-value">{pair.message || "—"}</div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
