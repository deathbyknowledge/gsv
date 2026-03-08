/**
 * Debug View
 */

import { html } from "lit";
import type { GsvApp } from "../app";

export function renderDebug(app: GsvApp) {
  return html`
    <div class="view-container">
      <div class="section-header">
        <h2 class="section-title">Debug</h2>
        <button 
          class="btn btn-secondary btn-sm"
          @click=${() => { app["debugLog"] = []; }}
        >
          Clear Log
        </button>
      </div>
      
      <!-- RPC Tester -->
      <div class="card" style="margin-bottom: var(--space-4)">
        <div class="card-header">
          <h3 class="card-title">RPC Tester</h3>
        </div>
        <div class="card-body">
          <form @submit=${async (e: Event) => {
            e.preventDefault();
            const form = e.target as HTMLFormElement;
            const method = (form.querySelector("#rpc-method") as HTMLInputElement).value;
            const paramsText = (form.querySelector("#rpc-params") as HTMLTextAreaElement).value;
            const resultEl = form.querySelector("#rpc-result") as HTMLPreElement;
            
            try {
              const params = paramsText.trim() ? JSON.parse(paramsText) : undefined;
              const result = await app.client?.request(method, params);
              resultEl.textContent = JSON.stringify(result, null, 2);
            } catch (err) {
              resultEl.textContent = `Error: ${err}`;
            }
          }}>
            <div class="form-group">
              <label class="form-label">Method</label>
              <input 
                type="text" 
                id="rpc-method"
                class="form-input mono"
                placeholder="e.g., tools.list"
              />
            </div>
            
            <div class="form-group">
              <label class="form-label">Params (JSON)</label>
              <textarea 
                id="rpc-params"
                class="form-textarea mono"
                placeholder='{"sessionKey": "..."}'
                rows="3"
              ></textarea>
            </div>
            
            <button type="submit" class="btn btn-primary">Send Request</button>
            
            <div class="form-group" style="margin-top: var(--space-4)">
              <label class="form-label">Result</label>
              <pre id="rpc-result" style="
                margin: 0;
                padding: var(--space-3);
                background: var(--bg-tertiary);
                border-radius: var(--radius-md);
                font-size: var(--font-size-xs);
                max-height: 300px;
                overflow: auto;
              "><code>— No result yet —</code></pre>
            </div>
          </form>
        </div>
      </div>
      
      <!-- Event Log -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Event Log</h3>
          <span class="pill">${app.debugLog.length} events</span>
        </div>
        <div class="card-body" style="max-height: 400px; overflow-y: auto">
          ${app.debugLog.length === 0 ? html`
            <p class="muted">No events yet</p>
          ` : html`
            <div style="display: flex; flex-direction: column; gap: var(--space-2)">
              ${app.debugLog.slice().reverse().map(entry => html`
                <div style="
                  padding: var(--space-2);
                  background: var(--bg-tertiary);
                  border-radius: var(--radius-md);
                  font-size: var(--font-size-xs);
                ">
                  <div style="display: flex; justify-content: space-between; margin-bottom: var(--space-1)">
                    <span class="mono" style="color: var(--accent-primary)">${entry.type}</span>
                    <span class="muted">${entry.time.toLocaleTimeString()}</span>
                  </div>
                  <pre style="margin: 0; overflow-x: auto"><code>${JSON.stringify(entry.data, null, 2)}</code></pre>
                </div>
              `)}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}
