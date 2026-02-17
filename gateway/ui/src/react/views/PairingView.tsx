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

export function PairingView() {
  const pairingRequests = useReactUiStore((s) => s.pairingRequests);
  const pairingLoading = useReactUiStore((s) => s.pairingLoading);
  const loadPairing = useReactUiStore((s) => s.loadPairing);
  const pairApprove = useReactUiStore((s) => s.pairApprove);
  const pairReject = useReactUiStore((s) => s.pairReject);

  return (
    <div className="view-container">
      <div className="section-header">
        <span className="section-title">Pairing Requests</span>
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

      {pairingLoading && !pairingRequests.length ? (
        <div className="empty-state">
          <span className="spinner"></span> Loading...
        </div>
      ) : !pairingRequests.length ? (
        <div className="empty-state">
          <div className="empty-state-icon">🤝</div>
          <div className="empty-state-title">No Pending Requests</div>
          <div className="empty-state-description">
            When someone messages your agent via a channel with pairing enabled,
            their request will appear here for approval.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {pairingRequests.map((pair) => (
            <div className="card" key={`${pair.channel}:${pair.senderId}`}>
              <div className="card-header">
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <span style={{ fontSize: "1.5rem" }}>{channelIcon(pair.channel)}</span>
                  <div>
                    <div className="card-title">{pair.senderName || pair.senderId}</div>
                    <div style={{ fontSize: "var(--font-size-xs)", color: "var(--text-muted)" }}>
                      {pair.channel} - {pair.senderId}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
                          `Reject pairing request from ${
                            pair.senderName || pair.senderId
                          }?`,
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
              <div className="card-body">
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="kv-key">Requested</span>
                    <span className="kv-value">{relativeTime(pair.requestedAt)}</span>
                  </div>
                  {pair.message ? (
                    <div className="kv-row">
                      <span className="kv-key">Message</span>
                      <span className="kv-value">{pair.message}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
