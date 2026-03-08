/**
 * Config View - Comprehensive configuration form
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";
import { getGatewayUrl } from "../storage";

// Config types matching gateway/src/config.ts
type GsvConfig = {
  model: { provider: string; id: string };
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
    openrouter?: string;
  };
  timeouts: { llmMs: number; toolMs: number };
  auth: { token?: string };
  transcription?: { provider: "workers-ai" | "openai" };
  channels?: {
    whatsapp?: {
      dmPolicy?: "open" | "allowlist" | "pairing";
      allowFrom?: string[];
    };
  };
  systemPrompt?: string;
  session?: {
    identityLinks?: Record<string, string[]>;
  };
  agents?: {
    list?: { id: string; default?: boolean; model?: { provider: string; id: string } }[];
    bindings?: { agentId: string; match: { channel?: string; accountId?: string } }[];
    defaultHeartbeat?: { every?: string; prompt?: string; target?: string };
  };
};

// Model options
const MODEL_OPTIONS = [
  { provider: "anthropic", id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { provider: "anthropic", id: "claude-opus-4-20250514", label: "Claude Opus 4" },
  { provider: "openai", id: "gpt-4.1", label: "GPT-4.1" },
  { provider: "openai", id: "o3", label: "OpenAI o3" },
  { provider: "google", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

export function renderConfig(app: GsvApp) {
  const config = (app.config || {}) as GsvConfig;
  
  return html`
    <div class="view-container">
      <div class="section-header">
        <h2 class="section-title">Configuration</h2>
        <div style="display: flex; gap: var(--space-2)">
          <button 
            class="btn btn-secondary btn-sm"
            @click=${() => app["loadConfig"]()}
            ?disabled=${app.configLoading}
          >
            ${app.configLoading ? html`<span class="spinner"></span>` : "Refresh"}
          </button>
        </div>
      </div>
      
      <!-- Connection Settings (UI only) -->
      ${renderConnectionSection(app)}
      
      <!-- Model Settings -->
      ${renderModelSection(app, config)}
      
      <!-- API Keys -->
      ${renderApiKeysSection(app, config)}
      
      <!-- Auth Settings -->
      ${renderAuthSection(app, config)}
      
      <!-- Transcription Settings -->
      ${renderTranscriptionSection(app, config)}
      
      <!-- WhatsApp Channel Settings -->
      ${renderWhatsAppSection(app, config)}
      
      <!-- Identity Links -->
      ${renderIdentityLinksSection(app, config)}
      
      <!-- Heartbeat Settings -->
      ${renderHeartbeatSection(app, config)}
      
      <!-- Raw JSON (collapsible) -->
      ${renderRawJsonSection(app, config)}
    </div>
  `;
}

function renderConnectionSection(app: GsvApp) {
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">🌐 Gateway Connection</h3>
        <span class="pill ${app.connectionState === "connected" ? "pill-success" : "pill-warning"}">
          ${app.connectionState}
        </span>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Gateway URL</label>
          <input 
            type="text" 
            class="form-input mono"
            placeholder=${getGatewayUrl(app.settings)}
            .value=${app.settings.gatewayUrl}
            @change=${(e: Event) => {
              app.updateSettings({ gatewayUrl: (e.target as HTMLInputElement).value });
            }}
          />
          <p class="form-hint">
            ${app.settings.gatewayUrl 
              ? "Custom WebSocket URL" 
              : `Auto-derived from page URL: ${getGatewayUrl(app.settings)}`}
          </p>
        </div>
        
        <div class="form-group">
          <label class="form-label">Session Key</label>
          <input 
            type="text" 
            class="form-input mono"
            .value=${app.settings.sessionKey}
            @change=${(e: Event) => {
              app.updateSettings({ sessionKey: (e.target as HTMLInputElement).value });
            }}
          />
          <p class="form-hint">Format: agent:{agentId}:{channel}:{peerKind}:{peerId}</p>
        </div>
        
        <div class="form-group">
          <label class="form-label">Theme</label>
          <select 
            class="form-select"
            .value=${app.settings.theme}
            @change=${(e: Event) => {
              app.updateSettings({ theme: (e.target as HTMLSelectElement).value as "dark" | "light" | "system" });
            }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>
      </div>
    </div>
  `;
}

function renderModelSection(app: GsvApp, config: GsvConfig) {
  const currentModel = config.model || { provider: "anthropic", id: "claude-sonnet-4-20250514" };
  
  // Helper to save model (validates before saving)
  const saveModel = (provider: string, id: string) => {
    if (provider && id) {
      app.saveConfig("model", { provider: provider.trim(), id: id.trim() });
    }
  };
  
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">🤖 Model</h3>
      </div>
      <div class="card-body">
        <!-- Quick select from common models -->
        <div class="form-group">
          <label class="form-label">Quick Select</label>
          <select 
            class="form-select"
            @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              if (val) {
                const [provider, id] = val.split("/");
                saveModel(provider, id);
              }
            }}
          >
            <option value="">-- Select a model --</option>
            ${MODEL_OPTIONS.map(m => html`
              <option value="${m.provider}/${m.id}">
                ${m.label} (${m.provider})
              </option>
            `)}
          </select>
          <p class="form-hint">Choose from common models, or use the fields below for any model</p>
        </div>
        
        <!-- Provider (editable) -->
        <div class="form-group">
          <label class="form-label">Provider</label>
          <input 
            type="text" 
            class="form-input mono"
            list="provider-suggestions"
            .value=${currentModel.provider}
            @change=${(e: Event) => {
              const provider = (e.target as HTMLInputElement).value;
              saveModel(provider, currentModel.id);
            }}
          />
          <datalist id="provider-suggestions">
            <option value="anthropic">
            <option value="openai">
            <option value="google">
            <option value="openrouter">
            <option value="together">
            <option value="groq">
          </datalist>
          <p class="form-hint">Current: <code>${currentModel.provider}</code></p>
        </div>
        
        <!-- Model ID (editable) -->
        <div class="form-group">
          <label class="form-label">Model ID</label>
          <input 
            type="text" 
            class="form-input mono"
            .value=${currentModel.id}
            @change=${(e: Event) => {
              const id = (e.target as HTMLInputElement).value;
              saveModel(currentModel.provider, id);
            }}
          />
          <p class="form-hint">Current: <code>${currentModel.id}</code></p>
        </div>
      </div>
    </div>
  `;
}

function renderApiKeysSection(app: GsvApp, config: GsvConfig) {
  const apiKeys = config.apiKeys || {};
  
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">🔑 API Keys</h3>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Anthropic API Key</label>
          <input 
            type="password" 
            class="form-input mono"
            .value=${apiKeys.anthropic || ""}
            placeholder="sk-ant-..."
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value;
              app.saveConfig("apiKeys.anthropic", val || undefined);
            }}
          />
          <p class="form-hint">${apiKeys.anthropic ? "✓ Configured" : "Required for Claude models"}</p>
        </div>
        
        <div class="form-group">
          <label class="form-label">OpenAI API Key</label>
          <input 
            type="password" 
            class="form-input mono"
            .value=${apiKeys.openai || ""}
            placeholder="sk-..."
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value;
              app.saveConfig("apiKeys.openai", val || undefined);
            }}
          />
          <p class="form-hint">${apiKeys.openai ? "✓ Configured" : "Required for GPT models and OpenAI transcription"}</p>
        </div>
        
        <div class="form-group">
          <label class="form-label">Google API Key</label>
          <input 
            type="password" 
            class="form-input mono"
            .value=${apiKeys.google || ""}
            placeholder="AIza..."
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value;
              app.saveConfig("apiKeys.google", val || undefined);
            }}
          />
          <p class="form-hint">${apiKeys.google ? "✓ Configured" : "Required for Gemini models"}</p>
        </div>
        
        <div class="form-group">
          <label class="form-label">OpenRouter API Key</label>
          <input 
            type="password" 
            class="form-input mono"
            .value=${apiKeys.openrouter || ""}
            placeholder="sk-or-..."
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value;
              app.saveConfig("apiKeys.openrouter", val || undefined);
            }}
          />
          <p class="form-hint">${apiKeys.openrouter ? "✓ Configured" : "Required for OpenRouter models"}</p>
        </div>
      </div>
    </div>
  `;
}

function renderAuthSection(app: GsvApp, config: GsvConfig) {
  const auth = config.auth || {};
  
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">🔒 Authentication</h3>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Auth Token</label>
          <input 
            type="password" 
            class="form-input mono"
            .value=${auth.token || ""}
            placeholder="Leave empty for no authentication"
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value;
              app.saveConfig("auth.token", val || undefined);
              // Also update local settings
              app.updateSettings({ token: val });
            }}
          />
          <p class="form-hint">Clients/nodes must provide this token to connect. ${auth.token ? "✓ Enabled" : "⚠ Disabled (anyone can connect)"}</p>
        </div>
      </div>
    </div>
  `;
}

function renderTranscriptionSection(app: GsvApp, config: GsvConfig) {
  const transcription = config.transcription || { provider: "workers-ai" };
  
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">🎤 Voice Transcription</h3>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Transcription Provider</label>
          <select 
            class="form-select"
            .value=${transcription.provider}
            @change=${(e: Event) => {
              app.saveConfig("transcription.provider", (e.target as HTMLSelectElement).value);
            }}
          >
            <option value="workers-ai">Workers AI (Free)</option>
            <option value="openai">OpenAI Whisper (Requires API key)</option>
          </select>
          <p class="form-hint">Used for transcribing voice messages from WhatsApp</p>
        </div>
      </div>
    </div>
  `;
}

function renderWhatsAppSection(app: GsvApp, config: GsvConfig) {
  const whatsapp = config.channels?.whatsapp || { dmPolicy: "pairing", allowFrom: [] };
  const allowFrom = whatsapp.allowFrom || [];
  
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">📱 WhatsApp Channel</h3>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">DM Access Policy</label>
          <select 
            class="form-select"
            .value=${whatsapp.dmPolicy || "pairing"}
            @change=${(e: Event) => {
              app.saveConfig("channels.whatsapp.dmPolicy", (e.target as HTMLSelectElement).value);
            }}
          >
            <option value="pairing">Pairing (Recommended) - Unknown senders need approval</option>
            <option value="allowlist">Allowlist - Only approved numbers can message</option>
            <option value="open">Open - Anyone can message (use with caution!)</option>
          </select>
          <p class="form-hint">Controls who can message your agent on WhatsApp</p>
        </div>
        
        <div class="form-group">
          <label class="form-label">Allowed Numbers</label>
          <textarea 
            class="form-textarea mono"
            rows="4"
            placeholder="+1234567890&#10;+31612345678&#10;group-id@g.us"
            .value=${allowFrom.join("\n")}
            @change=${(e: Event) => {
              const val = (e.target as HTMLTextAreaElement).value;
              const numbers = val.split("\n").map(s => s.trim()).filter(Boolean);
              app.saveConfig("channels.whatsapp.allowFrom", numbers);
            }}
          ></textarea>
          <p class="form-hint">One per line. E.164 format (+1234567890) or WhatsApp JID for groups. Used by Pairing and Allowlist modes.</p>
        </div>
      </div>
    </div>
  `;
}

function renderIdentityLinksSection(app: GsvApp, config: GsvConfig) {
  const identityLinks = config.session?.identityLinks || {};
  const entries = Object.entries(identityLinks);
  
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">🔗 Identity Links</h3>
      </div>
      <div class="card-body">
        <p class="text-secondary" style="font-size: var(--font-size-sm); margin-bottom: var(--space-3)">
          Link multiple identities (phone numbers, usernames) to a single session. This lets you continue the same conversation across WhatsApp, Discord, etc.
        </p>
        
        ${entries.length === 0 ? html`
          <p class="muted" style="font-size: var(--font-size-sm)">No identity links configured</p>
        ` : html`
          ${entries.map(([name, ids]) => html`
            <div style="background: var(--bg-tertiary); padding: var(--space-3); border-radius: var(--radius-md); margin-bottom: var(--space-2)">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-2)">
                <strong>${name}</strong>
                <button 
                  class="btn btn-ghost btn-sm"
                  @click=${() => {
                    const newLinks = { ...identityLinks };
                    delete newLinks[name];
                    app.saveConfig("session.identityLinks", Object.keys(newLinks).length ? newLinks : undefined);
                  }}
                >
                  Remove
                </button>
              </div>
              <code class="mono" style="font-size: var(--font-size-xs); color: var(--text-muted)">
                ${(ids as string[]).join(", ")}
              </code>
            </div>
          `)}
        `}
        
        <div style="margin-top: var(--space-3)">
          <details>
            <summary style="cursor: pointer; color: var(--accent-primary); font-size: var(--font-size-sm)">
              + Add identity link
            </summary>
            <div style="margin-top: var(--space-2); padding: var(--space-3); background: var(--bg-tertiary); border-radius: var(--radius-md)">
              <div class="form-group">
                <label class="form-label">Canonical Name</label>
                <input type="text" class="form-input" id="identity-link-name" placeholder="e.g., steve" />
              </div>
              <div class="form-group">
                <label class="form-label">Identities (one per line)</label>
                <textarea 
                  class="form-textarea mono" 
                  rows="3" 
                  id="identity-link-ids"
                  placeholder="+1234567890&#10;telegram:123456&#10;discord:username#1234"
                ></textarea>
              </div>
              <button 
                class="btn btn-primary btn-sm"
                @click=${() => {
                  const name = (document.getElementById("identity-link-name") as HTMLInputElement).value.trim();
                  const ids = (document.getElementById("identity-link-ids") as HTMLTextAreaElement).value
                    .split("\n").map(s => s.trim()).filter(Boolean);
                  if (name && ids.length) {
                    const newLinks = { ...identityLinks, [name]: ids };
                    app.saveConfig("session.identityLinks", newLinks);
                  }
                }}
              >
                Add Link
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>
  `;
}

function renderHeartbeatSection(app: GsvApp, config: GsvConfig) {
  const heartbeat = config.agents?.defaultHeartbeat || {};
  
  return html`
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-header">
        <h3 class="card-title">💓 Heartbeat</h3>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Interval</label>
          <input 
            type="text" 
            class="form-input"
            .value=${heartbeat.every || ""}
            placeholder="e.g., 30m, 1h, 0 to disable"
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value.trim();
              app.saveConfig("agents.defaultHeartbeat.every", val || undefined);
            }}
          />
          <p class="form-hint">How often to check in. Use "30m", "1h", etc. Set to "0" to disable.</p>
        </div>
        
        <div class="form-group">
          <label class="form-label">Delivery Target</label>
          <select 
            class="form-select"
            .value=${heartbeat.target || "last"}
            @change=${(e: Event) => {
              app.saveConfig("agents.defaultHeartbeat.target", (e.target as HTMLSelectElement).value);
            }}
          >
            <option value="last">Last active channel</option>
            <option value="none">No delivery (silent)</option>
          </select>
          <p class="form-hint">Where to send heartbeat responses</p>
        </div>
      </div>
    </div>
  `;
}

function renderRawJsonSection(app: GsvApp, config: GsvConfig) {
  return html`
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📄 Raw Configuration</h3>
      </div>
      <div class="card-body">
        <details>
          <summary style="cursor: pointer; color: var(--text-muted); font-size: var(--font-size-sm)">
            View raw JSON
          </summary>
          <pre style="margin-top: var(--space-3); font-size: var(--font-size-xs); max-height: 400px; overflow: auto"><code>${JSON.stringify(config, null, 2)}</code></pre>
        </details>
      </div>
    </div>
  `;
}
