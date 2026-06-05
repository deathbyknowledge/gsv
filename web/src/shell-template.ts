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

          <div class="session-panel session-panel-wide onboarding-panel" data-session-setup-view hidden>
            <form class="session-setup-form onboarding-layout" data-session-setup-form>
              <aside class="onboarding-sidebar">
                <div class="session-panel-head">
                  <p class="session-kicker">First-time setup</p>
                  <h1 data-setup-heading>Create account</h1>
                  <p class="session-copy" data-setup-copy>Choose a setup path.</p>
                </div>
                <ol class="onboarding-step-list">
                  <li class="onboarding-stage-pill" data-setup-stage-pill="details" data-setup-rail-step="account">
                    <span>1</span>
                    <strong>Login credentials</strong>
                  </li>
                  <li class="onboarding-stage-pill" data-setup-stage-pill="details" data-setup-rail-step="preferences">
                    <span>2</span>
                    <strong>Preferences</strong>
                  </li>
                  <li class="onboarding-stage-pill" data-setup-stage-pill="review" data-setup-rail-step="review">
                    <span>3</span>
                    <strong>Review and deploy</strong>
                  </li>
                </ol>
              </aside>

              <div class="onboarding-workspace">
                <main class="onboarding-main">
                  <section class="onboarding-stage onboarding-stage-welcome" data-setup-stage="welcome">
                    <div class="onboarding-mode-grid">
                      <button type="button" class="onboarding-mode-card" data-setup-lane="quick">
                        <span class="onboarding-mode-kicker">Recommended</span>
                        <strong>Quick start</strong>
                        <p>Create the first account, keep the default AI path, and use the official system source.</p>
                      </button>
                      <button type="button" class="onboarding-mode-card" data-setup-lane="customize">
                        <span class="onboarding-mode-kicker">More control</span>
                        <strong>Custom</strong>
                        <p>Choose AI defaults, system source, and optional node bootstrap settings before first boot.</p>
                      </button>
                    </div>
                  </section>

                  <section class="onboarding-stage onboarding-stage-details" data-setup-stage="details" hidden>
                    <div class="onboarding-lane-banner">
                      <span data-setup-lane-kicker>Quick start</span>
                    </div>
                    <div class="setup-step-copy" data-setup-detail-copy>
                      <h2 data-setup-lane-title>Login credentials</h2>
                      <p class="session-copy" data-setup-lane-description>Create the first desktop account and secure it with a password.</p>
                    </div>

                    <section class="onboarding-section" data-setup-detail-step="account">
                      <div class="session-field-grid">
                        <label>
                          Username
                          <input data-setup-username type="text" autocomplete="username" placeholder="hank" />
                        </label>
                        <label>
                          Personal agent username
                          <input data-setup-agent-name type="text" autocomplete="off" placeholder="friday" />
                          <small class="session-field-hint">Optional. Leave blank to use the next available default name.</small>
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
                      <div class="onboarding-field-note">
                        <strong>Keep this password safe.</strong>
                        <p>GSV does not store a recoverable copy. Losing it can lock you out of this gateway.</p>
                      </div>
                    </section>

                    <section class="onboarding-section onboarding-preferences" data-setup-detail-step="system">
                      <div class="onboarding-preference-group">
                        <div class="onboarding-section-head">
                          <h3>Admin security</h3>
                          <p>Choose whether sensitive admin actions need a second password.</p>
                        </div>
                        <div class="session-field-grid">
                          <label class="session-toggle">
                            <span>Include extra security layer for admin tasks</span>
                            <input data-setup-admin-custom type="checkbox" />
                          </label>
                          <label data-setup-root-row hidden>
                            Define admin password
                            <input data-setup-root-password type="password" autocomplete="new-password" />
                          </label>
                          <label data-setup-root-confirm-row hidden>
                            Confirm admin password
                            <input data-setup-root-password-confirm type="password" autocomplete="new-password" />
                          </label>
                        </div>
                        <details class="onboarding-help">
                          <summary aria-label="Explain admin security">?</summary>
                          <div>
                            <strong>Why?</strong>
                            <p>A separate admin password adds a second check for sensitive system actions.</p>
                          </div>
                        </details>
                      </div>

                      <div class="onboarding-preference-group">
                        <div class="onboarding-section-head">
                          <h3>Timezone</h3>
                          <p>Used for schedules, calendars, and timestamp displays.</p>
                        </div>
                        <div class="session-field-grid">
                          <label>
                            Timezone
                            <select data-setup-timezone></select>
                          </label>
                        </div>
                      </div>

                      <div class="onboarding-custom-options" data-setup-ai-section hidden>
                        <div class="onboarding-section-head">
                          <h3>AI defaults</h3>
                          <p>Keep the gateway default AI path, or choose a provider and model from the start.</p>
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
                      </div>

                      <div class="onboarding-custom-options" data-setup-source-section hidden>
                        <div class="onboarding-section-head">
                          <h3>System source</h3>
                          <p>Use the official source, or point first boot at a repository and ref you control.</p>
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
                            <input data-setup-bootstrap-ref type="text" autocomplete="off" placeholder="main" />
                          </label>
                        </div>
                      </div>

                      <div class="onboarding-custom-options" data-setup-node-section hidden>
                        <div class="onboarding-section-head">
                          <h3>Device token</h3>
                          <p>Issue a node token now if you want a machine to connect immediately after setup.</p>
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
                      </div>
                    </section>
                  </section>

                  <section class="onboarding-stage onboarding-stage-review" data-setup-stage="review" hidden>
                    <div class="onboarding-lane-banner">
                      <span>Review and deploy</span>
                    </div>
                    <div class="setup-step-copy">
                      <h2>First-boot plan</h2>
                      <p class="session-copy">This is the first-boot plan that will be applied to the gateway.</p>
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
                        <p>First desktop user and personal agent account.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>Admin access</span>
                        <strong data-setup-summary-admin></strong>
                        <p>System-level recovery and administration path.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>Timezone</span>
                        <strong data-setup-summary-timezone></strong>
                        <p>Calendar basis for schedules and timestamps.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>AI</span>
                        <strong data-setup-summary-ai></strong>
                        <p>Initial model/provider behavior for the gateway.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>System source</span>
                        <strong data-setup-summary-source></strong>
                        <p>The source imported into <code>root/gsv</code> during setup.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>Device token</span>
                        <strong data-setup-summary-device></strong>
                        <p>Optional node bootstrap credentials issued during setup.</p>
                      </article>
                    </div>
                    <aside class="onboarding-review-notes">
                      <div>
                        <strong>You can change this later</strong>
                        <p>AI defaults and package settings can be adjusted from the desktop after provisioning.</p>
                      </div>
                      <div>
                        <strong>What does the system source mean?</strong>
                        <p>The source controls the initial GSV package set synced into <code>root/gsv</code>.</p>
                      </div>
                    </aside>
                  </section>

                  <p class="session-error onboarding-alert" data-session-setup-error role="alert" hidden></p>

                  <div class="session-actions onboarding-actions">
                    <button type="button" class="runtime-btn session-btn-secondary" data-setup-back hidden>Back</button>
                    <div class="onboarding-primary-actions">
                      <button type="button" class="runtime-btn" data-setup-next hidden>Next</button>
                      <button type="submit" class="runtime-btn" data-setup-submit hidden>Deploy</button>
                      <button type="button" class="runtime-btn session-btn-secondary" data-setup-guide-toggle hidden>Ask the guide</button>
                    </div>
                  </div>
                </main>

                <aside class="onboarding-guide-panel" data-setup-guide-panel hidden>
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
                    <textarea data-setup-guide-input rows="3" autocomplete="off" aria-label="Message the setup guide" placeholder="Ask the guide to shape this setup"></textarea>
                    <button type="button" class="runtime-btn" data-setup-guide-send>Send</button>
                  </div>
                </aside>
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
            <button type="button" class="pill topbar-launcher" data-command-launcher aria-label="Open command palette">GSV</button>
          </div>
          <nav class="taskbar-windows" data-taskbar-windows aria-label="Open windows"></nav>
          <div class="topbar-section topbar-presence">
            <button
              type="button"
              class="presence-toggle"
              data-presence-toggle
              data-state="idle"
              aria-label="Mind"
              aria-haspopup="dialog"
              aria-expanded="false"
              aria-controls="presence-panel"
            >
              <span class="topbar-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path>
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
                  <path d="M12 18v3"></path>
                  <path d="M8 21h8"></path>
                </svg>
              </span>
              <span class="presence-toggle-light" aria-hidden="true"></span>
              <span class="presence-toggle-copy">
                <span class="presence-toggle-label">Mind</span>
                <span class="presence-toggle-status" data-presence-compact-status>Paused</span>
              </span>
            </button>
          </div>
          <div class="topbar-section topbar-notifications">
            <button
              type="button"
              class="notifications-toggle"
              data-notifications-toggle
              aria-label="Notifications"
              aria-haspopup="menu"
              aria-expanded="false"
              aria-controls="notifications-panel"
            >
              <span class="topbar-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"></path>
                  <path d="M10 20a2 2 0 0 0 4 0"></path>
                </svg>
              </span>
              <span class="notification-badge" data-notifications-badge hidden>0</span>
            </button>
            <div class="notifications-panel" id="notifications-panel" data-notifications-panel hidden>
              <header class="notifications-panel-head">
                <div>
                  <strong>Notifications</strong>
                  <span data-notifications-delivery-state>In-shell alerts</span>
                </div>
                <button type="button" class="notifications-system-enable" data-notifications-system-enable hidden>Enable system</button>
              </header>
              <p class="windows-empty muted" data-notifications-empty>No notifications</p>
              <ul class="notifications-list" data-notifications-list hidden></ul>
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
        <section class="mobile-shell" data-mobile-shell aria-label="Mobile shell">
          <section class="mobile-home" data-mobile-home>
            <header class="mobile-home-header" aria-label="Home">
              <p class="mobile-home-date" data-mobile-home-date></p>
              <h1>Hello, <span data-mobile-home-username>operator</span></h1>
              <div class="mobile-home-actions">
                <button type="button" class="mobile-home-action" data-notifications-toggle aria-label="Notifications" aria-haspopup="menu" aria-expanded="false" aria-controls="notifications-panel">
                  <span aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"></path>
                      <path d="M10 20a2 2 0 0 0 4 0"></path>
                    </svg>
                  </span>
                  <span class="notification-badge" data-notifications-badge hidden>0</span>
                </button>
                <button type="button" class="mobile-home-action presence-toggle" data-presence-toggle data-state="idle" aria-label="Mind" aria-haspopup="dialog" aria-expanded="false" aria-controls="presence-panel">
                  <span aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path>
                      <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
                      <path d="M12 18v3"></path>
                    </svg>
                  </span>
                </button>
                <button type="button" class="mobile-home-action" data-mobile-command-launcher aria-label="Search apps and windows">
                  <span aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="11" cy="11" r="7"></circle>
                      <path d="m20 20-3.8-3.8"></path>
                    </svg>
                  </span>
                </button>
              </div>
            </header>
            <nav class="mobile-app-grid" data-mobile-apps aria-label="Applications"></nav>
          </section>
          <button type="button" class="mobile-home-handle" data-mobile-home-button aria-label="Home"></button>
        </section>
        <div class="dock-reveal-zone" data-dock-reveal-zone aria-hidden="true"></div>
        <div class="notification-toasts" data-notification-toasts aria-live="polite" aria-atomic="false"></div>
        <button type="button" class="presence-activity" data-presence-activity aria-live="polite" aria-atomic="false" aria-controls="presence-panel" aria-expanded="false">
          <span class="presence-activity-head">
            <span class="presence-activity-pulse" aria-hidden="true"></span>
            <span>
              <strong>Mind</strong>
              <small data-presence-activity-status>Ready</small>
            </span>
          </span>
          <span class="presence-activity-body" data-presence-activity-body></span>
        </button>
        <section class="presence-panel" id="presence-panel" data-presence-panel role="dialog" aria-label="Mind" hidden>
          <header class="presence-panel-head">
            <div class="presence-panel-brand">
              <span class="presence-panel-mark" aria-hidden="true">GSV</span>
              <span class="presence-panel-copy">
                <strong data-presence-title>Mind</strong>
              </span>
            </div>
            <button type="button" class="presence-panel-close" data-presence-close aria-label="Close Mind">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18"></path>
                <path d="m6 6 12 12"></path>
              </svg>
            </button>
          </header>
          <section class="presence-current" aria-live="polite">
            <span class="presence-current-orb" aria-hidden="true"></span>
            <div>
              <strong data-presence-status>Paused</strong>
              <span class="presence-interim" data-presence-interim></span>
            </div>
          </section>
          <div class="presence-actions presence-actions-main">
            <button type="button" class="presence-primary" data-presence-listen>Listen</button>
          </div>
          <div class="presence-log" data-presence-log hidden></div>
          <details class="presence-section presence-manual">
            <summary>Manual</summary>
            <div class="presence-mode" role="group" aria-label="Mind input mode">
              <button type="button" data-presence-mode="ambient" aria-pressed="true">Ambient</button>
              <button type="button" data-presence-mode="push" aria-pressed="false">Manual</button>
            </div>
            <textarea class="presence-transcript" data-presence-transcript rows="4" autocomplete="off" spellcheck="true" aria-label="Message to Mind" placeholder="Talk or type to Mind"></textarea>
            <div class="presence-actions">
              <button type="button" class="presence-secondary" data-presence-send disabled>Send</button>
              <button type="button" class="presence-secondary" data-presence-clear disabled>Clear</button>
            </div>
          </details>
          <details class="presence-section presence-voice">
            <summary>Voice</summary>
            <div class="presence-speech-controls">
              <label class="presence-speech-toggle">
                <span>Read replies</span>
                <input type="checkbox" data-presence-speak checked />
              </label>
              <button type="button" data-presence-speak-test>Preview voice</button>
            </div>
            <div class="presence-speech-status" data-presence-speech-status></div>
          </details>
        </section>
        <section class="command-palette" data-command-palette role="dialog" aria-label="Command palette" hidden>
          <div class="command-palette-panel">
            <input data-command-palette-input type="text" autocomplete="off" placeholder="Search apps and windows" />
            <button type="button" class="command-palette-close" data-command-palette-close aria-label="Close search">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18"></path>
                <path d="m6 6 12 12"></path>
              </svg>
            </button>
            <ul class="command-palette-list" data-command-palette-list></ul>
          </div>
        </section>
      </div>
    </div>
  `;
}
