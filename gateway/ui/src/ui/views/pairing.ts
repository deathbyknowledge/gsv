/**
 * Pairing View
 *
 * Shows pending pairing requests from channels (e.g. WhatsApp DMs)
 * and allows approving or rejecting them.
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";

type PendingPair = {
  channel: string;
  senderId: string;
  senderName?: string;
  requestedAt: number;
  message?: string;
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function channelIcon(channel: string): string {
  if (channel.includes("whatsapp")) return "\uD83D\uDCF1";
  if (channel.includes("discord")) return "\uD83C\uDFAE";
  return "\uD83D\uDD17";
}

export function renderPairing(app: GsvApp) {
  const pairs = (app as any).pairingRequests as PendingPair[];
  const loading = (app as any).pairingLoading as boolean;

  return html`
    <div class="view-container">
      <div class="section-header">
        <span class="section-title">Pairing Requests</span>
        <button
          class="btn btn-secondary btn-sm"
          ?disabled=${loading}
          @click=${() => (app as any).loadPairing?.()}
        >
          ${loading ? html`<span class="spinner"></span>` : "Refresh"}
        </button>
      </div>

      ${loading && !pairs.length
        ? html`<div class="empty-state"><span class="spinner"></span> Loading...</div>`
        : !pairs.length
          ? html`
              <div class="empty-state">
                <div class="empty-state-icon">&#129309;</div>
                <div class="empty-state-title">No Pending Requests</div>
                <div class="empty-state-description">
                  When someone messages your agent via a channel with pairing enabled,
                  their request will appear here for approval.
                </div>
              </div>
            `
          : html`
              <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                ${pairs.map(
                  (pair) => html`
                    <div class="card">
                      <div class="card-header">
                        <div style="display: flex; align-items: center; gap: var(--space-3);">
                          <span style="font-size: 1.5rem;">${channelIcon(pair.channel)}</span>
                          <div>
                            <div class="card-title">
                              ${pair.senderName || pair.senderId}
                            </div>
                            <div style="font-size: var(--font-size-xs); color: var(--text-muted);">
                              ${pair.channel} - ${pair.senderId}
                            </div>
                          </div>
                        </div>
                        <div style="display: flex; gap: var(--space-2);">
                          <button
                            class="btn btn-primary btn-sm"
                            @click=${async () => {
                              try {
                                await app.client?.pairApprove(pair.channel, pair.senderId);
                                (app as any).loadPairing?.();
                              } catch (e) {
                                console.error("Failed to approve:", e);
                              }
                            }}
                          >
                            Approve
                          </button>
                          <button
                            class="btn btn-danger btn-sm"
                            @click=${async () => {
                              if (confirm(`Reject pairing request from ${pair.senderName || pair.senderId}?`)) {
                                try {
                                  await app.client?.pairReject(pair.channel, pair.senderId);
                                  (app as any).loadPairing?.();
                                } catch (e) {
                                  console.error("Failed to reject:", e);
                                }
                              }
                            }}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                      <div class="card-body">
                        <div class="kv-list">
                          <div class="kv-row">
                            <span class="kv-key">Requested</span>
                            <span class="kv-value">${relativeTime(pair.requestedAt)}</span>
                          </div>
                          ${pair.message
                            ? html`
                                <div class="kv-row">
                                  <span class="kv-key">Message</span>
                                  <span class="kv-value">${pair.message}</span>
                                </div>
                              `
                            : nothing}
                        </div>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `}
    </div>
  `;
}
