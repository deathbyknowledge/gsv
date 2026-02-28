import { Button } from "@cloudflare/kumo/components/button";
import type { ChannelAccountStatus, ChannelRegistryEntry } from "../../ui/types";
import { useReactUiStore } from "../state/store";

const DEFAULT_ACCOUNT_ID = "default";
const AVAILABLE_CHANNELS: Array<{
  id: string;
  name: string;
  icon: string;
  description: string;
}> = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: "📱",
    description: "Personal WhatsApp messaging",
  },
  {
    id: "discord",
    name: "Discord",
    icon: "🎮",
    description: "Discord server integration",
  },
];

function renderStatusPill(status: ChannelAccountStatus | null) {
  if (!status) {
    return <span className="pill">unknown</span>;
  }
  if (status.connected) {
    return <span className="pill pill-success">connected</span>;
  }
  if (status.error) {
    return <span className="pill pill-danger">error</span>;
  }
  if (status.authenticated) {
    return <span className="pill pill-warning">auth only</span>;
  }
  return <span className="pill">stopped</span>;
}

function getChannelIcon(channelId: string): string {
  if (channelId === "whatsapp") return "📱";
  if (channelId === "discord") return "🎮";
  return "💬";
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function ChannelControls({
  channel,
  accountId,
  status,
}: {
  channel: string;
  accountId: string;
  status: ChannelAccountStatus | null;
}) {
  const connectionState = useReactUiStore((s) => s.connectionState);
  const action = useReactUiStore((s) => s.channelActionState(channel, accountId));
  const startChannel = useReactUiStore((s) => s.startChannel);
  const stopChannel = useReactUiStore((s) => s.stopChannel);
  const loginChannel = useReactUiStore((s) => s.loginChannel);
  const logoutChannel = useReactUiStore((s) => s.logoutChannel);

  const busy = Boolean(action) || connectionState !== "connected";

  return (
    <div className="app-actions" style={{ marginTop: "var(--space-3)" }}>
      <Button
        size="sm"
        variant="secondary"
        loading={action === "start"}
        onClick={() => {
          void startChannel(channel, accountId);
        }}
        disabled={busy || status?.connected === true}
      >
        Start
      </Button>
      <Button
        size="sm"
        variant="secondary"
        loading={action === "stop"}
        onClick={() => {
          void stopChannel(channel, accountId);
        }}
        disabled={busy || status?.connected !== true}
      >
        Stop
      </Button>
      <Button
        size="sm"
        variant="secondary"
        loading={action === "login"}
        onClick={() => {
          void loginChannel(channel, accountId);
        }}
        disabled={busy}
      >
        Login
      </Button>
      <Button
        size="sm"
        variant="secondary"
        loading={action === "logout"}
        onClick={() => {
          void logoutChannel(channel, accountId);
        }}
        disabled={busy || !status?.authenticated}
      >
        Logout
      </Button>
    </div>
  );
}

function ChannelFeedback({
  channel,
  accountId,
}: {
  channel: string;
  accountId: string;
}) {
  const message = useReactUiStore((s) => s.channelMessage(channel, accountId));
  const qrData = useReactUiStore((s) => s.channelQrCode(channel, accountId));
  const hasError = message ? /error|failed|unsupported|unknown/i.test(message) : false;

  return (
    <>
      {message ? (
        <p
          className={hasError ? "text-danger" : "text-secondary"}
          style={{ marginTop: "var(--space-3)", fontSize: "var(--font-size-sm)" }}
        >
          {message}
        </p>
      ) : null}
      {qrData ? (
        <div style={{ marginTop: "var(--space-3)", textAlign: "center" }}>
          <p className="form-hint" style={{ marginBottom: "var(--space-2)" }}>
            Scan QR code to pair
          </p>
          <img
            src={qrData}
            alt={`QR code for ${channel} login`}
            style={{
              maxWidth: 220,
              width: "100%",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              background: "white",
              padding: "var(--space-2)",
            }}
          />
        </div>
      ) : null}
    </>
  );
}

function ConnectedChannelCard({ channel }: { channel: ChannelRegistryEntry }) {
  const status = useReactUiStore((s) => s.channelStatus(channel.channel, channel.accountId));
  const icon = getChannelIcon(channel.channel);

  return (
    <article className="app-list-item">
      <div className="app-list-head">
        <div>
          <div className="app-list-title">
            <span style={{ marginRight: "var(--space-2)" }}>{icon}</span>
            {channel.channel}
          </div>
          <div className="app-list-subtitle">account: {channel.accountId}</div>
        </div>
        {renderStatusPill(status)}
      </div>

      <div className="app-list-meta">
        <div className="app-meta-row">
          <div className="app-meta-label">Connected At</div>
          <div className="app-meta-value">{formatTime(channel.connectedAt)}</div>
        </div>
        <div className="app-meta-row">
          <div className="app-meta-label">Last Message</div>
          <div className="app-meta-value">
            {channel.lastMessageAt ? formatTime(channel.lastMessageAt) : "—"}
          </div>
        </div>
        <div className="app-meta-row">
          <div className="app-meta-label">Mode</div>
          <div className="app-meta-value">{status?.mode || "default"}</div>
        </div>
      </div>

      {status?.error ? (
        <p className="text-danger" style={{ marginTop: "var(--space-3)" }}>
          {status.error}
        </p>
      ) : null}

      <ChannelControls
        channel={channel.channel}
        accountId={channel.accountId}
        status={status}
      />
      <ChannelFeedback channel={channel.channel} accountId={channel.accountId} />
    </article>
  );
}

function AvailableChannelCard({
  channel,
}: {
  channel: { id: string; name: string; icon: string; description: string };
}) {
  const status = useReactUiStore((s) => s.channelStatus(channel.id, DEFAULT_ACCOUNT_ID));

  return (
    <article className="app-list-item">
      <div className="app-list-head">
        <div>
          <div className="app-list-title">
            <span style={{ marginRight: "var(--space-2)" }}>{channel.icon}</span>
            {channel.name}
          </div>
          <div className="app-list-subtitle">{channel.description}</div>
        </div>
        {renderStatusPill(status)}
      </div>

      <div className="app-list-meta">
        <div className="app-meta-row">
          <div className="app-meta-label">Account</div>
          <div className="app-meta-value">{DEFAULT_ACCOUNT_ID}</div>
        </div>
        <div className="app-meta-row">
          <div className="app-meta-label">Connected</div>
          <div className="app-meta-value">{status?.connected ? "yes" : "no"}</div>
        </div>
        <div className="app-meta-row">
          <div className="app-meta-label">Authenticated</div>
          <div className="app-meta-value">{status?.authenticated ? "yes" : "no"}</div>
        </div>
      </div>

      {status?.error ? (
        <p className="text-danger" style={{ marginTop: "var(--space-3)" }}>
          {status.error}
        </p>
      ) : null}

      <ChannelControls channel={channel.id} accountId={DEFAULT_ACCOUNT_ID} status={status} />
      <ChannelFeedback channel={channel.id} accountId={DEFAULT_ACCOUNT_ID} />
    </article>
  );
}

export function ChannelsView() {
  const channels = useReactUiStore((s) => s.channels);
  const channelsLoading = useReactUiStore((s) => s.channelsLoading);
  const channelsError = useReactUiStore((s) => s.channelsError);
  const refreshChannels = useReactUiStore((s) => s.refreshChannels);

  const connectedCount = channels.length;

  return (
    <div className="view-container">
      <div className="app-shell" data-app="channels">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">Channel Hub</h2>
              <p className="app-hero-subtitle">
                Operate inbound/outbound integrations, monitor auth state, and trigger
                channel login flows directly from the desktop.
              </p>
              <div className="app-hero-meta">
                <span className="app-badge-dot" />
                <span>{connectedCount} connected account(s)</span>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={channelsLoading}
              onClick={() => {
                void refreshChannels();
              }}
            >
              Refresh
            </Button>
          </div>
        </section>

        {channelsError ? (
          <div className="app-list-item">
            <p className="text-danger">{channelsError}</p>
          </div>
        ) : null}

        <section className="app-grid">
          <article className="app-panel app-col-7">
            <header className="app-panel-head">
              <h3 className="app-panel-title">Connected Accounts</h3>
              <span className="app-panel-meta">{channels.length} active</span>
            </header>
            <div className="app-panel-body">
              {channelsLoading && channels.length === 0 ? (
                <div className="app-empty">
                  <div>
                    <span className="spinner" />
                    <div style={{ marginTop: "var(--space-2)" }}>Loading channels...</div>
                  </div>
                </div>
              ) : channels.length === 0 ? (
                <div className="app-empty">
                  <div>
                    <div className="app-empty-icon">📡</div>
                    <div>No channels connected</div>
                    <div className="text-secondary" style={{ marginTop: "var(--space-1)" }}>
                      Start and authenticate a channel from the catalog.
                    </div>
                  </div>
                </div>
              ) : (
                <div className="app-list">
                  {channels.map((channel) => (
                    <ConnectedChannelCard
                      key={`${channel.channel}:${channel.accountId}`}
                      channel={channel}
                    />
                  ))}
                </div>
              )}
            </div>
          </article>

          <article className="app-panel app-col-5">
            <header className="app-panel-head">
              <h3 className="app-panel-title">Channel Catalog</h3>
              <span className="app-panel-meta">{AVAILABLE_CHANNELS.length} available</span>
            </header>
            <div className="app-panel-body">
              <div className="app-list">
                {AVAILABLE_CHANNELS.map((channel) => (
                  <AvailableChannelCard key={channel.id} channel={channel} />
                ))}
              </div>
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}
