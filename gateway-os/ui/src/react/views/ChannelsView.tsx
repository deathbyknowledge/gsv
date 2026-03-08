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
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
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
          style={{ marginTop: "var(--space-3)" }}
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
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">
          <span style={{ marginRight: "var(--space-2)" }}>{icon}</span>
          {channel.channel}
        </h3>
        {renderStatusPill(status)}
      </div>
      <div className="card-body">
        <div className="kv-list">
          <div className="kv-row">
            <span className="kv-key">Account</span>
            <span className="kv-value">{channel.accountId}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">Connected At</span>
            <span className="kv-value">{formatTime(channel.connectedAt)}</span>
          </div>
          {channel.lastMessageAt ? (
            <div className="kv-row">
              <span className="kv-key">Last Message</span>
              <span className="kv-value">{formatTime(channel.lastMessageAt)}</span>
            </div>
          ) : null}
          {status?.mode ? (
            <div className="kv-row">
              <span className="kv-key">Mode</span>
              <span className="kv-value">{status.mode}</span>
            </div>
          ) : null}
          {status?.lastActivity ? (
            <div className="kv-row">
              <span className="kv-key">Last Activity</span>
              <span className="kv-value">{formatTime(status.lastActivity)}</span>
            </div>
          ) : null}
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
      </div>
    </div>
  );
}

function AvailableChannelCard({
  channel,
}: {
  channel: { id: string; name: string; icon: string; description: string };
}) {
  const status = useReactUiStore((s) => s.channelStatus(channel.id, DEFAULT_ACCOUNT_ID));

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">
          <span style={{ marginRight: "var(--space-2)" }}>{channel.icon}</span>
          {channel.name}
        </h3>
        {renderStatusPill(status)}
      </div>
      <div className="card-body">
        <p className="text-secondary" style={{ fontSize: "var(--font-size-sm)", marginBottom: "var(--space-3)" }}>
          {channel.description}
        </p>
        <div className="kv-list" style={{ marginBottom: "var(--space-3)" }}>
          <div className="kv-row">
            <span className="kv-key">Account</span>
            <span className="kv-value">{DEFAULT_ACCOUNT_ID}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">Connected</span>
            <span className="kv-value">{status?.connected ? "yes" : "no"}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">Authenticated</span>
            <span className="kv-value">{status?.authenticated ? "yes" : "no"}</span>
          </div>
        </div>
        {status?.error ? (
          <p className="text-danger" style={{ marginBottom: "var(--space-3)" }}>
            {status.error}
          </p>
        ) : null}
        <ChannelControls channel={channel.id} accountId={DEFAULT_ACCOUNT_ID} status={status} />
        <ChannelFeedback channel={channel.id} accountId={DEFAULT_ACCOUNT_ID} />
      </div>
    </div>
  );
}

export function ChannelsView() {
  const channels = useReactUiStore((s) => s.channels);
  const channelsLoading = useReactUiStore((s) => s.channelsLoading);
  const channelsError = useReactUiStore((s) => s.channelsError);
  const refreshChannels = useReactUiStore((s) => s.refreshChannels);

  return (
    <div className="view-container">
      <div className="section-header">
        <h2 className="section-title">Connected Channels</h2>
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

      {channelsError ? (
        <div className="card" style={{ marginBottom: "var(--space-4)" }}>
          <div className="card-body text-danger">{channelsError}</div>
        </div>
      ) : null}

      {channelsLoading && channels.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <div className="thinking-indicator">
              <span className="spinner"></span>
              <span>Loading channels...</span>
            </div>
          </div>
        </div>
      ) : channels.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📱</div>
          <h3 className="empty-state-title">No channels connected</h3>
          <p className="empty-state-description">
            Start and authenticate a channel below.
          </p>
        </div>
      ) : (
        <div className="cards-grid">
          {channels.map((channel) => (
            <ConnectedChannelCard
              key={`${channel.channel}:${channel.accountId}`}
              channel={channel}
            />
          ))}
        </div>
      )}

      <div className="section-header" style={{ marginTop: "var(--space-8)" }}>
        <h2 className="section-title">Available Channels</h2>
      </div>

      <div className="cards-grid">
        {AVAILABLE_CHANNELS.map((channel) => (
          <AvailableChannelCard key={channel.id} channel={channel} />
        ))}
      </div>
    </div>
  );
}
