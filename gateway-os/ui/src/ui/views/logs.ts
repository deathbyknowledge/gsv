/**
 * Logs View
 *
 * Fetches and displays node logs from the gateway via logs.get.
 * Allows filtering by node and setting line count.
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";

type LogsData = {
  nodeId: string;
  lines: string[];
  count: number;
  truncated: boolean;
};

export function renderLogs(app: GsvApp) {
  const logs = (app as any).logsData as LogsData | null;
  const loading = (app as any).logsLoading as boolean;
  const logsError = (app as any).logsError as string | null;

  // Derive available nodes from tools (same logic as nodes view)
  const nodeIds = new Set<string>();
  for (const tool of app.tools) {
    const sep = tool.name.indexOf("__");
    if (sep > 0) {
      const prefix = tool.name.slice(0, sep);
      if (prefix !== "gsv") nodeIds.add(prefix);
    }
  }

  return html`
    <div class="view-container">
      <div class="section-header">
        <span class="section-title">Node Logs</span>
      </div>

      <!-- Controls -->
      <div class="card" style="margin-bottom: var(--space-4);">
        <div class="card-body" style="display: flex; gap: var(--space-4); align-items: flex-end; flex-wrap: wrap;">
          <div class="form-group" style="margin: 0; min-width: 200px;">
            <label class="form-label">Node</label>
            <select class="form-select" id="logs-node-id">
              <option value="">All nodes</option>
              ${[...nodeIds].map(
                (id) => html`<option value=${id}>${id}</option>`,
              )}
            </select>
          </div>

          <div class="form-group" style="margin: 0; min-width: 120px;">
            <label class="form-label">Lines</label>
            <input
              type="number"
              class="form-input"
              id="logs-lines"
              value="200"
              min="1"
              max="5000"
            />
          </div>

          <button
            class="btn btn-primary"
            ?disabled=${loading}
            @click=${() => (app as any).loadLogs?.()}
          >
            ${loading ? html`<span class="spinner"></span> Loading...` : "Fetch Logs"}
          </button>
        </div>
      </div>

      ${logsError
        ? html`
            <div class="connect-error" style="margin-bottom: var(--space-4);">
              ${logsError}
            </div>
          `
        : nothing}

      ${logs
        ? html`
            <div class="card">
              <div class="card-header">
                <span class="card-title">
                  ${logs.nodeId || "All Nodes"} - ${logs.count} line${logs.count !== 1 ? "s" : ""}
                  ${logs.truncated ? html` <span class="pill pill-warning">Truncated</span>` : nothing}
                </span>
              </div>
              <div class="card-body" style="padding: 0;">
                <pre class="logs-output">${logs.lines.join("\n")}</pre>
              </div>
            </div>
          `
        : !loading
          ? html`
              <div class="empty-state">
                <div class="empty-state-icon">&#128220;</div>
                <div class="empty-state-title">No Logs Loaded</div>
                <div class="empty-state-description">
                  Select a node and click "Fetch Logs" to view output.
                </div>
              </div>
            `
          : nothing}
    </div>
  `;
}
