export function renderDesktopShell(): string {
  return `
    <div class="desktop-shell">
      <section class="session-screen" data-session-screen>
        <div class="session-stage">
          <div class="session-panel" data-session-login-view>
            <div class="session-panel-head">
              <h1>Welcome back</h1>
            </div>
            <form class="session-form" data-session-login-form>
              <label>
                Username
                <input data-session-username type="text" autocomplete="username" />
              </label>
              <label>
                Password
                <input data-session-password type="password" autocomplete="current-password" />
              </label>
              <details class="session-advanced">
                <summary>Use token instead</summary>
                <label>
                  Token
                  <input data-session-token type="password" autocomplete="off" />
                </label>
              </details>
              <p class="session-error" data-session-login-error hidden></p>
              <button type="submit" class="runtime-btn" data-session-submit>Sign in</button>
            </form>
          </div>

          <div class="session-panel session-panel-wide" data-session-setup-view hidden>
            <form class="session-setup-form" data-session-setup-form>
              <div class="session-panel-head session-panel-head-with-progress">
                <div>
                  <p class="session-kicker">First-time setup</p>
                  <h1>Set up this gateway</h1>
                  <p class="session-copy">Create the first account, then configure the pieces you actually want right now.</p>
                </div>
                <div class="setup-progress">
                  <p class="setup-progress-label" data-setup-progress-label>Step 1 of 4</p>
                  <div class="setup-progress-track">
                    <span class="setup-progress-fill" data-setup-progress-fill></span>
                  </div>
                </div>
              </div>

              <section class="setup-step" data-setup-step="0">
                <div class="setup-step-copy">
                  <p class="session-kicker">Account</p>
                  <h2>Create the first operator</h2>
                  <p class="session-copy">This account signs into the desktop and owns the initial workspace.</p>
                </div>
                <div class="session-field-grid">
                  <label>
                    Username
                    <input data-setup-username type="text" autocomplete="username" placeholder="hank" />
                  </label>
                  <label>
                    Password
                    <input data-setup-password type="password" autocomplete="new-password" />
                  </label>
                  <label>
                    Confirm password
                    <input data-setup-password-confirm type="password" autocomplete="new-password" />
                  </label>
                </div>
              </section>

              <section class="setup-step" data-setup-step="1" hidden>
                <div class="setup-step-copy">
                  <p class="session-kicker">Root</p>
                  <h2>Root access</h2>
                  <p class="session-copy">Keep root locked, or set a root password during bootstrap.</p>
                </div>
                <div class="session-field-grid">
                  <label class="session-toggle">
                    <span>Set a root password now</span>
                    <input data-setup-root-enabled type="checkbox" />
                  </label>
                  <label data-setup-root-row hidden>
                    Root password
                    <input data-setup-root-password type="password" autocomplete="new-password" />
                  </label>
                </div>
              </section>

              <section class="setup-step" data-setup-step="2" hidden>
                <div class="setup-step-copy">
                  <p class="session-kicker">AI</p>
                  <h2>AI defaults</h2>
                  <p class="session-copy">A default provider is already available. Customize this only if you want different AI settings.</p>
                </div>
                <div class="session-field-grid">
                  <label class="session-toggle">
                    <input data-setup-ai-enabled type="checkbox" />
                    <span>Do you want to customize the AI?</span>
                  </label>
                  <label data-setup-ai-provider-row hidden>
                    Provider
                    <input data-setup-ai-provider type="text" placeholder="openai" autocomplete="off" />
                  </label>
                  <label data-setup-ai-model-row hidden>
                    Model
                    <input data-setup-ai-model type="text" placeholder="gpt-5.4" autocomplete="off" />
                  </label>
                  <label data-setup-ai-key-row hidden>
                    API key
                    <input data-setup-ai-key type="password" autocomplete="off" />
                  </label>
                </div>
              </section>

              <section class="setup-step" data-setup-step="3" hidden>
                <div class="setup-step-copy">
                  <p class="session-kicker">Node</p>
                  <h2>Node bootstrap</h2>
                  <p class="session-copy">Optional. Issue a driver token now if you want to bring a node online immediately after setup.</p>
                </div>
                <div class="session-field-grid">
                  <label class="session-toggle">
                    <span>Issue a node token now</span>
                    <input data-setup-node-enabled type="checkbox" />
                  </label>
                  <label data-setup-node-device-row hidden>
                    Device ID
                    <input data-setup-node-device-id type="text" autocomplete="off" placeholder="node-rearden" />
                  </label>
                  <label data-setup-node-label-row hidden>
                    Label
                    <input data-setup-node-label type="text" autocomplete="off" placeholder="rearden" />
                  </label>
                  <label data-setup-node-expiry-row hidden>
                    Expires in days
                    <input data-setup-node-expiry type="number" min="1" inputmode="numeric" autocomplete="off" placeholder="30" />
                  </label>
                </div>
              </section>

              <p class="session-error" data-session-setup-error hidden></p>

              <div class="session-actions">
                <button type="button" class="runtime-btn session-btn-secondary" data-setup-back hidden>Back</button>
                <button type="button" class="runtime-btn session-btn-secondary" data-setup-next>Next</button>
                <button type="submit" class="runtime-btn" data-setup-submit hidden>Create gateway</button>
              </div>
            </form>
          </div>

          <div class="session-panel" data-session-setup-complete hidden>
            <div class="session-panel-head">
              <p class="session-kicker">Gateway ready</p>
              <h1>Setup complete</h1>
              <p class="session-copy">The control plane is initialized. Seed the system repo now, or enter the desktop and push your own checkout later.</p>
            </div>
            <div class="session-result-grid">
              <div class="session-result-card">
                <span>First user</span>
                <strong data-setup-result-username></strong>
              </div>
              <div class="session-result-card">
                <span>Root</span>
                <strong data-setup-result-root></strong>
              </div>
            </div>
            <div class="session-token-panel" data-setup-node-result hidden>
              <div class="session-token-head">
                <div>
                  <p class="session-kicker">Node token</p>
                  <h2 data-setup-result-node-label>CLI bootstrap</h2>
                </div>
                <button type="button" class="runtime-btn session-btn-secondary" data-setup-copy-token>Copy CLI command</button>
              </div>
              <textarea class="session-token-value" data-setup-result-node-token readonly></textarea>
              <p class="session-token-meta" data-setup-result-node-meta></p>
            </div>
            <details class="session-advanced">
              <summary>Use a custom source</summary>
              <div class="session-field-grid">
                <label>
                  Repository or remote URL
                  <input data-setup-bootstrap-source type="text" autocomplete="off" placeholder="deathbyknowledge/gsv" />
                </label>
                <label>
                  Ref
                  <input data-setup-bootstrap-ref type="text" autocomplete="off" placeholder="codex/app-runtime-from-680877d" />
                </label>
              </div>
            </details>
            <div class="session-inline-status" data-session-setup-bootstrap-status hidden>
              <span class="session-inline-spinner" aria-hidden="true"></span>
              <span>Initializing system repo...</span>
            </div>
            <p class="session-error" data-session-setup-complete-error hidden></p>
            <div class="session-actions">
              <button type="button" class="runtime-btn" data-session-setup-bootstrap>Initialize system repo</button>
              <button type="button" class="runtime-btn session-btn-secondary" data-session-setup-continue>Enter desktop</button>
            </div>
          </div>
        </div>
      </section>

      <div class="desktop-root" data-desktop-root hidden>
        <header class="topbar">
          <div class="topbar-section">
            <span class="pill">GSV</span>
          </div>
          <div class="topbar-section topbar-windows">
            <button
              type="button"
              class="windows-toggle"
              data-windows-toggle
              aria-label="Windows"
              aria-haspopup="menu"
              aria-expanded="false"
              aria-controls="windows-panel"
            >
              <span class="topbar-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4" y="5" width="6.5" height="6.5" rx="1.4"></rect>
                  <rect x="13.5" y="5" width="6.5" height="6.5" rx="1.4"></rect>
                  <rect x="4" y="14.5" width="6.5" height="6.5" rx="1.4"></rect>
                  <rect x="13.5" y="14.5" width="6.5" height="6.5" rx="1.4"></rect>
                </svg>
              </span>
            </button>
            <div class="windows-panel" id="windows-panel" data-windows-panel hidden>
              <p class="windows-empty muted" data-windows-empty>No minimized windows</p>
              <ul class="windows-list" data-windows-list hidden></ul>
            </div>
          </div>
          <div class="topbar-section topbar-session">
            <span class="status-dot is-offline" data-session-dot aria-hidden="true"></span>
            <button type="button" class="session-lock-btn" data-session-lock aria-label="Lock">
              <span class="topbar-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3v8"></path>
                  <path d="M7.8 6.6a8 8 0 1 0 8.4 0"></path>
                </svg>
              </span>
            </button>
          </div>
        </header>

        <main class="workspace" role="presentation">
          <nav class="desktop-icons" data-desktop-icons aria-label="Desktop applications"></nav>
          <section class="windows-layer" data-windows-layer></section>
        </main>
      </div>
    </div>
  `;
}
