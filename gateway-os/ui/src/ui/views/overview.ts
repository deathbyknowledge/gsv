/**
 * Overview View
 */

import { html } from "lit";
import type { GsvApp } from "../app";

export function renderOverview(app: GsvApp) {
  const nodeCount = getUniqueNodes(app.tools).length;
  const toolCount = app.tools.length;
  
  return html`
    <div class="view-container">
      <div class="cards-grid">
        <!-- Connection Status -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Connection</h3>
          </div>
          <div class="card-body">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Status</span>
                <span class="pill ${app.connectionState === "connected" ? "pill-success" : "pill-warning"}">
                  ${app.connectionState}
                </span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Gateway URL</span>
                <span class="kv-value mono">${app.settings.gatewayUrl}</span>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Nodes -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Nodes</h3>
          </div>
          <div class="card-body">
            <div class="stat">
              <div class="stat-value">${nodeCount}</div>
              <div class="stat-label">Connected Nodes</div>
            </div>
          </div>
        </div>
        
        <!-- Tools -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Tools</h3>
          </div>
          <div class="card-body">
            <div class="stat">
              <div class="stat-value">${toolCount}</div>
              <div class="stat-label">Available Tools</div>
            </div>
          </div>
        </div>
        
        <!-- Sessions -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Sessions</h3>
          </div>
          <div class="card-body">
            <div class="stat">
              <div class="stat-value">${app.sessions.length}</div>
              <div class="stat-label">Active Sessions</div>
            </div>
          </div>
        </div>
        
        <!-- Channels -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Channels</h3>
          </div>
          <div class="card-body">
            <div class="stat">
              <div class="stat-value">${app.channels.length}</div>
              <div class="stat-label">Connected Channels</div>
            </div>
          </div>
        </div>
        
        <!-- Current Session -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Current Session</h3>
          </div>
          <div class="card-body">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Session Key</span>
                <span class="kv-value mono truncate" style="max-width: 200px">${app.settings.sessionKey}</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Messages</span>
                <span class="kv-value">${app.chatMessages.length}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function getUniqueNodes(tools: { name: string }[]): string[] {
  const nodes = new Set<string>();
  for (const tool of tools) {
    const parts = tool.name.split("__");
    if (parts.length === 2) {
      nodes.add(parts[0]);
    }
  }
  return Array.from(nodes);
}
