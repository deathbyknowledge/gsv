/**
 * Channels View
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";
import type { ChannelRegistryEntry, ChannelAccountStatus } from "../types";

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

export function renderChannels(app: GsvApp) {
  return html`
    <div class="view-container">
      <div class="section-header">
        <h2 class="section-title">Connected Channels</h2>
        <button
          class="btn btn-secondary btn-sm"
          @click=${() => app.refreshChannels()}
          ?disabled=${app.channelsLoading}
        >
          ${app.channelsLoading ? html`<span class="spinner"></span>` : "Refresh"}
        </button>
      </div>

      ${app.channelsError
        ? html`
            <div class="card" style="margin-bottom: var(--space-4)">
              <div class="card-body text-danger">${app.channelsError}</div>
            </div>
          `
        : nothing}

      ${app.channelsLoading && app.channels.length === 0
        ? html`
            <div class="card">
              <div class="card-body">
                <div class="thinking-indicator">
                  <span class="spinner"></span>
                  <span>Loading channels...</span>
                </div>
              </div>
            </div>
          `
        : app.channels.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-state-icon">📱</div>
                <h3 class="empty-state-title">No channels connected</h3>
                <p class="empty-state-description">
                  Start and authenticate a channel below.
                </p>
              </div>
            `
          : html`
              <div class="cards-grid">
                ${app.channels.map((ch) => renderConnectedChannelCard(app, ch))}
              </div>
            `}

      <div class="section-header" style="margin-top: var(--space-8)">
        <h2 class="section-title">Available Channels</h2>
      </div>

      <div class="cards-grid">
        ${AVAILABLE_CHANNELS.map((ch) => renderAvailableChannelCard(app, ch))}
      </div>
    </div>
  `;
}

function renderConnectedChannelCard(app: GsvApp, channel: ChannelRegistryEntry) {
  const icon = getChannelIcon(channel.channel);
  const status = app.channelStatus(channel.channel, channel.accountId);

  return html`
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">
          <span style="margin-right: var(--space-2)">${icon}</span>
          ${channel.channel}
        </h3>
        ${renderStatusPill(status)}
      </div>
      <div class="card-body">
        <div class="kv-list">
          <div class="kv-row">
            <span class="kv-key">Account</span>
            <span class="kv-value">${channel.accountId}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Connected At</span>
            <span class="kv-value">${formatTime(channel.connectedAt)}</span>
          </div>
          ${channel.lastMessageAt
            ? html`
                <div class="kv-row">
                  <span class="kv-key">Last Message</span>
                  <span class="kv-value">${formatTime(channel.lastMessageAt)}</span>
                </div>
              `
            : nothing}
          ${status?.mode
            ? html`
                <div class="kv-row">
                  <span class="kv-key">Mode</span>
                  <span class="kv-value">${status.mode}</span>
                </div>
              `
            : nothing}
          ${status?.lastActivity
            ? html`
                <div class="kv-row">
                  <span class="kv-key">Last Activity</span>
                  <span class="kv-value">${formatTime(status.lastActivity)}</span>
                </div>
              `
            : nothing}
        </div>

        ${status?.error
          ? html`<p class="text-danger" style="margin-top: var(--space-3)">${status.error}</p>`
          : nothing}

        ${renderChannelControls(app, channel.channel, channel.accountId, status)}
        ${renderChannelFeedback(app, channel.channel, channel.accountId)}
      </div>
    </div>
  `;
}

function renderAvailableChannelCard(
  app: GsvApp,
  channel: { id: string; name: string; icon: string; description: string },
) {
  const status = app.channelStatus(channel.id, DEFAULT_ACCOUNT_ID);

  return html`
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">
          <span style="margin-right: var(--space-2)">${channel.icon}</span>
          ${channel.name}
        </h3>
        ${renderStatusPill(status)}
      </div>
      <div class="card-body">
        <p class="text-secondary" style="font-size: var(--font-size-sm); margin-bottom: var(--space-3)">
          ${channel.description}
        </p>

        <div class="kv-list" style="margin-bottom: var(--space-3)">
          <div class="kv-row">
            <span class="kv-key">Account</span>
            <span class="kv-value">${DEFAULT_ACCOUNT_ID}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Connected</span>
            <span class="kv-value">${status?.connected ? "yes" : "no"}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Authenticated</span>
            <span class="kv-value">${status?.authenticated ? "yes" : "no"}</span>
          </div>
        </div>

        ${status?.error
          ? html`<p class="text-danger" style="margin-bottom: var(--space-3)">${status.error}</p>`
          : nothing}

        ${renderChannelControls(app, channel.id, DEFAULT_ACCOUNT_ID, status)}
        ${renderChannelFeedback(app, channel.id, DEFAULT_ACCOUNT_ID)}
      </div>
    </div>
  `;
}

function renderChannelControls(
  app: GsvApp,
  channel: string,
  accountId: string,
  status: ChannelAccountStatus | null,
) {
  const action = app.channelActionState(channel, accountId);
  const busy = !!action || app.connectionState !== "connected";

  return html`
    <div style="display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3)">
      <button
        class="btn btn-secondary btn-sm"
        @click=${() => app.startChannel(channel, accountId)}
        ?disabled=${busy || status?.connected === true}
      >
        ${action === "start" ? html`<span class="spinner"></span>` : nothing}
        Start
      </button>
      <button
        class="btn btn-secondary btn-sm"
        @click=${() => app.stopChannel(channel, accountId)}
        ?disabled=${busy || status?.connected !== true}
      >
        ${action === "stop" ? html`<span class="spinner"></span>` : nothing}
        Stop
      </button>
      <button
        class="btn btn-secondary btn-sm"
        @click=${() => app.loginChannel(channel, accountId)}
        ?disabled=${busy}
      >
        ${action === "login" ? html`<span class="spinner"></span>` : nothing}
        Login
      </button>
      <button
        class="btn btn-secondary btn-sm"
        @click=${() => app.logoutChannel(channel, accountId)}
        ?disabled=${busy || !status?.authenticated}
      >
        ${action === "logout" ? html`<span class="spinner"></span>` : nothing}
        Logout
      </button>
    </div>
  `;
}

function renderChannelFeedback(app: GsvApp, channel: string, accountId: string) {
  const message = app.channelMessage(channel, accountId);
  const qrData = app.channelQrCode(channel, accountId);
  const hasError = message
    ? /error|failed|unsupported|unknown/i.test(message)
    : false;

  return html`
    ${message
      ? html`
          <p
            class=${hasError ? "text-danger" : "text-secondary"}
            style="margin-top: var(--space-3)"
          >
            ${message}
          </p>
        `
      : nothing}
    ${qrData
      ? html`
          <div style="margin-top: var(--space-3); text-align: center">
            <p class="form-hint" style="margin-bottom: var(--space-2)">
              Scan QR code to pair
            </p>
            <img
              src=${qrData}
              alt="QR code for ${channel} login"
              style="max-width: 220px; width: 100%; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: white; padding: var(--space-2)"
            />
          </div>
        `
      : nothing}
  `;
}

function renderStatusPill(status: ChannelAccountStatus | null) {
  if (!status) {
    return html`<span class="pill">unknown</span>`;
  }
  if (status.connected) {
    return html`<span class="pill pill-success">connected</span>`;
  }
  if (status.error) {
    return html`<span class="pill pill-danger">error</span>`;
  }
  if (status.authenticated) {
    return html`<span class="pill pill-warning">auth only</span>`;
  }
  return html`<span class="pill">stopped</span>`;
}

function getChannelIcon(channelId: string): string {
  if (channelId === "whatsapp") return "📱";
  if (channelId === "discord") return "🎮";
  return "💬";
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
