/**
 * Sessions View
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";
import type { SessionRegistryEntry } from "../types";

export function renderSessions(app: GsvApp) {
  return html`
    <div class="view-container">
      <div class="section-header">
        <h2 class="section-title">Active Sessions</h2>
        <button 
          class="btn btn-secondary btn-sm"
          @click=${() => app["loadSessions"]()}
          ?disabled=${app.sessionsLoading}
        >
          ${app.sessionsLoading ? html`<span class="spinner"></span>` : "Refresh"}
        </button>
      </div>
      
      ${app.sessionsLoading && app.sessions.length === 0 ? html`
        <div class="card">
          <div class="card-body">
            <div class="thinking-indicator">
              <span class="spinner"></span>
              <span>Loading sessions...</span>
            </div>
          </div>
        </div>
      ` : app.sessions.length === 0 ? html`
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <h3 class="empty-state-title">No sessions</h3>
          <p class="empty-state-description">
            Sessions are created when you or others start conversations.
          </p>
        </div>
      ` : html`
        <div class="card">
          <table class="table">
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
              ${app.sessions.map(session => renderSessionRow(app, session))}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderSessionRow(app: GsvApp, session: SessionRegistryEntry) {
  const isCurrentSession = session.sessionKey === app.settings.sessionKey;
  
  return html`
    <tr>
      <td>
        <code class="mono" style="font-size: var(--font-size-xs)">
          ${session.sessionKey}
        </code>
        ${isCurrentSession ? html`
          <span class="pill pill-success" style="margin-left: var(--space-2)">current</span>
        ` : nothing}
      </td>
      <td>${session.label || html`<span class="muted">—</span>`}</td>
      <td>${formatRelativeTime(session.lastActiveAt)}</td>
      <td>${formatRelativeTime(session.createdAt)}</td>
      <td>
        <div style="display: flex; gap: var(--space-2)">
          <button 
            class="btn btn-ghost btn-sm"
            @click=${() => app.selectSession(session.sessionKey)}
            ?disabled=${isCurrentSession}
          >
            Open
          </button>
          <button 
            class="btn btn-ghost btn-sm"
            @click=${() => app.resetSession(session.sessionKey)}
          >
            Reset
          </button>
        </div>
      </td>
    </tr>
  `;
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}
