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
              <div class="session-panel-head">
                <p class="session-kicker">First-time setup</p>
                <h1 data-setup-heading>Bring this gateway online</h1>
                <p class="session-copy" data-setup-copy>Choose how much control you want, then review the exact plan before provisioning.</p>
              </div>

              <div class="onboarding-stage-indicator">
                <span class="onboarding-stage-pill" data-setup-stage-pill="welcome">Choose path</span>
                <span class="onboarding-stage-pill" data-setup-stage-pill="details">Configure</span>
                <span class="onboarding-stage-pill" data-setup-stage-pill="review">Review</span>
              </div>

              <section class="onboarding-stage" data-setup-stage="welcome">
                <div class="onboarding-mode-grid">
                  <button type="button" class="onboarding-mode-card" data-setup-lane="quick">
                    <span class="onboarding-mode-kicker">Recommended</span>
                    <strong>Quick start</strong>
                    <p>Smallest setup. Use the default system source and default AI configuration.</p>
                  </button>
                  <button type="button" class="onboarding-mode-card" data-setup-lane="customize">
                    <span class="onboarding-mode-kicker">Guided</span>
                    <strong>Customize</strong>
                    <p>Adjust AI, device bootstrap, and source settings without dropping into raw system details.</p>
                  </button>
                  <button type="button" class="onboarding-mode-card" data-setup-lane="advanced">
                    <span class="onboarding-mode-kicker">Full control</span>
                    <strong>Advanced</strong>
                    <p>Pick your own source, ref, and detailed boot settings up front.</p>
                  </button>
                </div>
              </section>

              <section class="onboarding-stage" data-setup-stage="details" hidden>
                <div class="setup-step-copy">
                  <p class="session-kicker" data-setup-lane-kicker>Quick start</p>
                  <h2 data-setup-lane-title>Create the first operator</h2>
                  <p class="session-copy" data-setup-lane-description>Start with the account and admin access. Defaults for AI and system source are already chosen.</p>
                </div>

                <div class="onboarding-assist-toggle" data-setup-assist-toggle hidden>
                  <label class="session-radio-option onboarding-assist-option">
                    <input data-setup-mode-manual type="radio" name="setup-mode" checked />
                    <span>
                      <strong>Manual</strong>
                      <small>Fill the fields yourself.</small>
                    </span>
                  </label>
                  <label class="session-radio-option onboarding-assist-option">
                    <input data-setup-mode-guided type="radio" name="setup-mode" />
                    <span>
                      <strong>Guided</strong>
                      <small>Have the setup guide collect the non-secret choices and patch the draft for you.</small>
                    </span>
                  </label>
                </div>

                <section class="onboarding-guide-panel" data-setup-guide-panel hidden>
                  <div class="onboarding-guide-head">
                    <div>
                      <p class="session-kicker">Setup guide</p>
                      <h3>Ask for help shaping the plan</h3>
                    </div>
                    <p class="session-copy">Passwords and API keys stay manual. The guide only patches non-secret fields.</p>
                  </div>
                  <div class="onboarding-guide-log" data-setup-guide-log></div>
                  <p class="session-error" data-setup-guide-error hidden></p>
                  <div class="onboarding-guide-form" data-setup-guide-form>
                    <label>
                      Message
                      <input data-setup-guide-input type="text" autocomplete="off" placeholder="I want to use my own OpenAI model and issue a device token for my laptop." />
                    </label>
                    <button type="button" class="runtime-btn" data-setup-guide-send>Ask guide</button>
                  </div>
                </section>

                <section class="onboarding-section" data-setup-detail-step="account">
                  <div class="onboarding-section-head">
                    <h3>Account</h3>
                    <p>Create the first account that signs into the desktop and owns the initial home directory.</p>
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

                <section class="onboarding-section" data-setup-detail-step="admin">
                  <div class="onboarding-section-head">
                    <h3>Admin access</h3>
                    <p>Admin access is always configured during first boot. Use the same password for simplicity, or set a separate admin password.</p>
                  </div>
                  <div class="session-radio-group">
                    <label class="session-radio-option">
                      <input data-setup-admin-same type="radio" name="setup-admin-mode" checked />
                      <span>
                        <strong>Use the same password</strong>
                        <small>Simplest option. Your account password is also used for admin access.</small>
                      </span>
                    </label>
                    <label class="session-radio-option">
                      <input data-setup-admin-custom type="radio" name="setup-admin-mode" />
                      <span>
                        <strong>Use a separate admin password</strong>
                        <small>Best if you want a distinct credential for system-level changes and recovery.</small>
                      </span>
                    </label>
                  </div>
                  <div class="session-field-grid">
                    <label data-setup-root-row hidden>
                      Admin password
                      <input data-setup-root-password type="password" autocomplete="new-password" />
                    </label>
                  </div>
                </section>

                <section class="onboarding-section" data-setup-detail-step="ai" data-setup-ai-section hidden>
                  <div class="onboarding-section-head">
                    <h3>AI defaults</h3>
                    <p>The gateway already has a working default provider path. Only customize this if you want a different provider or model from the start.</p>
                  </div>
                  <div class="session-field-grid">
                    <label class="session-toggle">
                      <span>Customize AI settings</span>
                      <input data-setup-ai-enabled type="checkbox" />
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

                <section class="onboarding-section" data-setup-detail-step="source" data-setup-source-section hidden>
                  <div class="onboarding-section-head">
                    <h3>System source</h3>
                    <p>The system source is bootstrapped during first setup. Leave this on the default upstream, or point at a custom repository and ref now.</p>
                  </div>
                  <div class="session-field-grid">
                    <label class="session-toggle">
                      <span>Use a custom source</span>
                      <input data-setup-source-enabled type="checkbox" />
                    </label>
                    <label data-setup-source-row hidden>
                      Repository or remote URL
                      <input data-setup-bootstrap-source type="text" autocomplete="off" placeholder="deathbyknowledge/gsv" />
                    </label>
                    <label data-setup-source-ref-row hidden>
                      Ref
                      <input data-setup-bootstrap-ref type="text" autocomplete="off" placeholder="osify" />
                    </label>
                  </div>
                </section>

                <section class="onboarding-section" data-setup-detail-step="device" data-setup-node-section hidden>
                  <div class="onboarding-section-head">
                    <h3>Device token</h3>
                    <p>Optional. Issue a driver token now if you want to bring a node online immediately after setup.</p>
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
              </section>

              <section class="onboarding-stage" data-setup-stage="review" hidden>
                <div class="setup-step-copy">
                  <p class="session-kicker">Review</p>
                  <h2>Provisioning plan</h2>
                  <p class="session-copy">This is the exact first-boot configuration that will be applied.</p>
                </div>
                <div class="onboarding-summary-grid">
                  <article class="onboarding-summary-card">
                    <span>Path</span>
                    <strong data-setup-summary-lane></strong>
                    <p data-setup-summary-lane-copy></p>
                  </article>
                  <article class="onboarding-summary-card">
                    <span>Account</span>
                    <strong data-setup-summary-account></strong>
                    <p>First desktop user and home directory owner.</p>
                  </article>
                  <article class="onboarding-summary-card">
                    <span>Admin access</span>
                    <strong data-setup-summary-admin></strong>
                    <p>System-level recovery and administration path.</p>
                  </article>
                  <article class="onboarding-summary-card">
                    <span>AI</span>
                    <strong data-setup-summary-ai></strong>
                    <p>Initial model/provider behavior for the gateway.</p>
                  </article>
                  <article class="onboarding-summary-card">
                    <span>System source</span>
                    <strong data-setup-summary-source></strong>
                    <p>The source imported into <code>system/gsv</code> during setup.</p>
                  </article>
                  <article class="onboarding-summary-card">
                    <span>Device token</span>
                    <strong data-setup-summary-device></strong>
                    <p>Optional node bootstrap credentials issued during setup.</p>
                  </article>
                </div>
              </section>

              <p class="session-error" data-session-setup-error hidden></p>

              <div class="session-actions">
                <button type="button" class="runtime-btn session-btn-secondary" data-setup-back hidden>Back</button>
                <button type="button" class="runtime-btn" data-setup-next hidden>Continue</button>
                <button type="submit" class="runtime-btn" data-setup-submit hidden>Provision gateway</button>
              </div>
            </form>
          </div>

          <div class="session-panel" data-session-provisioning-view hidden>
            <div class="session-panel-head">
              <p class="session-kicker">Provisioning</p>
              <h1 data-session-provisioning-title>Provisioning gateway</h1>
              <p class="session-copy" data-session-provisioning-copy>Importing the system source, mirroring CLI binaries, and finalizing first-boot state.</p>
            </div>
            <div class="session-progress-shell">
              <div class="session-progress-bar" aria-hidden="true">
                <span></span>
              </div>
              <div class="session-progress-note">
                <strong>Keep this tab open</strong>
                <p>First boot can take a few seconds while the gateway prepares the system source and local download artifacts.</p>
              </div>
            </div>
          </div>

          <div class="session-panel" data-session-setup-complete hidden>
            <div class="session-panel-head">
              <p class="session-kicker">Gateway ready</p>
              <h1>Provisioning complete</h1>
              <p class="session-copy">The control plane, first account, and system source are ready. Install the CLI on the next machine from this deployment, then bring a device online when you are ready.</p>
            </div>
            <div class="session-result-grid">
              <div class="session-result-card">
                <span>First user</span>
                <strong data-setup-result-username></strong>
              </div>
              <div class="session-result-card">
                <span>Admin access</span>
                <strong data-setup-result-root></strong>
              </div>
              <div class="session-result-card">
                <span>System source</span>
                <strong data-setup-result-source></strong>
              </div>
              <div class="session-result-card">
                <span>Source ref</span>
                <strong data-setup-result-ref></strong>
              </div>
            </div>
            <div class="session-token-panel">
              <div class="session-token-head">
                <div>
                  <p class="session-kicker">CLI install</p>
                  <h2 data-setup-result-cli-label>Install on this machine</h2>
                </div>
                <button type="button" class="runtime-btn session-btn-secondary" data-setup-copy-cli>Copy install command</button>
              </div>
              <textarea class="session-token-value" data-setup-result-cli-command readonly></textarea>
              <p class="session-token-meta" data-setup-result-cli-meta></p>
            </div>
            <div class="session-token-panel" data-setup-node-result hidden>
              <div class="session-token-head">
                <div>
                  <p class="session-kicker">New device</p>
                  <h2 data-setup-result-node-label>Bootstrap device</h2>
                </div>
                <button type="button" class="runtime-btn session-btn-secondary" data-setup-copy-token>Copy device steps</button>
              </div>
              <textarea class="session-token-value" data-setup-result-node-token readonly></textarea>
              <p class="session-token-meta" data-setup-result-node-meta></p>
            </div>
            <p class="session-error" data-session-setup-complete-error hidden></p>
            <div class="session-actions">
              <button type="button" class="runtime-btn" data-session-setup-continue>Enter desktop</button>
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
