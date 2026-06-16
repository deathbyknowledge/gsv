export function renderLegacySessionScreenContent(): string {
  return `
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
                    <strong>Review and start</strong>
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
                        <p>Create the first account, keep the default AI path, and use the official system files.</p>
                      </button>
                      <button type="button" class="onboarding-mode-card" data-setup-lane="customize">
                        <span class="onboarding-mode-kicker">More control</span>
                        <strong>Custom</strong>
                        <p>Choose AI defaults, system files, and optional device setup before first start.</p>
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
                        <p>GSV does not store a recoverable copy. Losing it can lock you out of this workspace.</p>
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
                        <div class="onboarding-help" tabindex="0" aria-label="Explain admin security" aria-describedby="setup-help-admin">
                          <span class="onboarding-help-trigger" aria-hidden="true">?</span>
                          <div id="setup-help-admin" class="onboarding-help-popover" role="tooltip">
                            <strong>Why?</strong>
                            <p>A separate admin password adds a second check for sensitive system actions.</p>
                          </div>
                        </div>
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
                          <p>Keep the default AI path, or choose the AI service and model from the start.</p>
                        </div>
                        <div class="onboarding-help" tabindex="0" aria-label="Explain AI defaults" aria-describedby="setup-help-ai">
                          <span class="onboarding-help-trigger" aria-hidden="true">?</span>
                          <div id="setup-help-ai" class="onboarding-help-popover" role="tooltip">
                            <strong>What does this change?</strong>
                            <p>These settings choose the default AI service GSV uses after setup. You can change them later from settings.</p>
                          </div>
                        </div>
                        <div class="session-field-grid">
                          <label class="session-toggle">
                            <span>Customize AI settings</span>
                            <input data-setup-ai-enabled type="checkbox" />
                          </label>
                          <label data-setup-ai-provider-row hidden>
                            AI service
                            <input data-setup-ai-provider type="text" placeholder="openai" autocomplete="off" />
                          </label>
                          <label data-setup-ai-model-row hidden>
                            AI model
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
                          <h3>System files</h3>
                          <p>Use the official system files, or choose a repository and version you control.</p>
                        </div>
                        <div class="onboarding-help" tabindex="0" aria-label="Explain system files" aria-describedby="setup-help-source">
                          <span class="onboarding-help-trigger" aria-hidden="true">?</span>
                          <div id="setup-help-source" class="onboarding-help-popover" role="tooltip">
                            <strong>For advanced setup</strong>
                            <p>System files are the built-in apps and settings GSV starts with. Advanced users can point this at a Git repository or remote URL; Version can be a branch, tag, or commit.</p>
                          </div>
                        </div>
                        <div class="session-field-grid">
                          <label class="session-toggle">
                            <span>Use custom system files</span>
                            <input data-setup-source-enabled type="checkbox" />
                          </label>
                          <label data-setup-source-row hidden>
                            System files location
                            <input data-setup-bootstrap-source type="text" autocomplete="off" placeholder="deathbyknowledge/gsv" />
                          </label>
                          <label data-setup-source-ref-row hidden>
                            Version
                            <input data-setup-bootstrap-ref type="text" autocomplete="off" placeholder="main" />
                          </label>
                        </div>
                      </div>

                      <div class="onboarding-custom-options" data-setup-node-section hidden>
                        <div class="onboarding-section-head">
                          <h3>Device setup</h3>
                          <p>Create a setup key now if you want another machine to connect immediately.</p>
                        </div>
                        <div class="onboarding-help" tabindex="0" aria-label="Explain device setup" aria-describedby="setup-help-node">
                          <span class="onboarding-help-trigger" aria-hidden="true">?</span>
                          <div id="setup-help-node" class="onboarding-help-popover" role="tooltip">
                            <strong>Setup key</strong>
                            <p>A setup key lets another machine connect to this workspace. Only create one now if you are ready to connect a device.</p>
                          </div>
                        </div>
                        <div class="session-field-grid">
                          <label class="session-toggle">
                            <span>Create a device setup key now</span>
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
                      <span>Review and start</span>
                    </div>
                    <div class="setup-step-copy">
                      <h2>Setup plan</h2>
                      <p class="session-copy">This is the setup plan that will be applied before the desktop opens.</p>
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
                        <span>Admin security</span>
                        <strong data-setup-summary-admin></strong>
                        <p>How sensitive admin actions are protected.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>Timezone</span>
                        <strong data-setup-summary-timezone></strong>
                        <p>Calendar basis for schedules and timestamps.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>AI</span>
                        <strong data-setup-summary-ai></strong>
                        <p>Initial AI service and model behavior.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>System files</span>
                        <strong data-setup-summary-source></strong>
                        <p>The system files loaded during setup.</p>
                      </article>
                      <article class="onboarding-summary-card">
                        <span>Device setup</span>
                        <strong data-setup-summary-device></strong>
                        <p>Optional setup key for connecting another machine.</p>
                      </article>
                    </div>
                    <aside class="onboarding-review-notes">
                      <div>
                        <strong>You can change this later</strong>
                        <p>AI defaults and system settings can be adjusted from the desktop after setup.</p>
                      </div>
                      <div>
                        <strong>What are system files?</strong>
                        <p>They define the built-in apps and settings GSV starts with.</p>
                      </div>
                    </aside>
                  </section>

                  <p class="session-error onboarding-alert" data-session-setup-error role="alert" hidden></p>

                  <div class="session-actions onboarding-actions">
                    <button type="button" class="runtime-btn session-btn-secondary" data-setup-back hidden>Back</button>
                    <div class="onboarding-primary-actions">
                      <button type="button" class="runtime-btn" data-setup-next hidden>Next</button>
                      <button type="submit" class="runtime-btn" data-setup-submit hidden>Start setup</button>
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

          <div class="session-panel session-panel-wide onboarding-panel onboarding-status-panel onboarding-deploying-panel" data-session-provisioning-view hidden>
            <div class="session-setup-form onboarding-layout">
              <aside class="onboarding-sidebar">
                <div class="session-panel-head">
                  <p class="session-kicker">First-time setup</p>
                  <h1>Setting things up</h1>
                  <p class="session-copy">The desktop is almost ready.</p>
                </div>
                <ol class="onboarding-step-list">
                  <li class="onboarding-stage-pill is-complete">
                    <span>1</span>
                    <strong>Login credentials</strong>
                  </li>
                  <li class="onboarding-stage-pill is-complete">
                    <span>2</span>
                    <strong>Preferences</strong>
                  </li>
                  <li class="onboarding-stage-pill is-active">
                    <span>3</span>
                    <strong>Review and start</strong>
                  </li>
                </ol>
              </aside>
              <div class="onboarding-workspace">
                <main class="onboarding-main onboarding-status-main">
                  <section class="onboarding-stage onboarding-status-stage">
                    <div class="onboarding-lane-banner">
                      <span>Setting things up</span>
                    </div>
                    <div class="setup-step-copy">
                      <h2 data-session-provisioning-title>Setting up your workspace</h2>
                      <p class="session-copy" data-session-provisioning-copy>Creating your account, preparing system files, and opening the desktop.</p>
                    </div>
                    <div class="onboarding-deploy-status">
                      <div class="onboarding-deploy-spinner" aria-hidden="true"></div>
                      <div>
                        <strong>Keep this tab open</strong>
                        <p>This can take a few seconds while GSV prepares your workspace.</p>
                      </div>
                    </div>
                    <ol class="onboarding-deploy-steps" aria-label="Setup progress">
                      <li>
                        <span></span>
                        <div>
                          <strong>Creating account</strong>
                          <p>Securing your account and admin settings.</p>
                        </div>
                      </li>
                      <li>
                        <span></span>
                        <div>
                          <strong>Preparing system files</strong>
                          <p>Loading the built-in apps and starter settings.</p>
                        </div>
                      </li>
                      <li>
                        <span></span>
                        <div>
                          <strong>Opening desktop</strong>
                          <p>Getting the first session ready.</p>
                        </div>
                      </li>
                    </ol>
                  </section>
                </main>
              </div>
            </div>
          </div>

          <div class="session-panel session-panel-wide onboarding-panel onboarding-status-panel onboarding-complete-panel" data-session-setup-complete hidden>
            <div class="session-setup-form onboarding-layout">
              <aside class="onboarding-sidebar">
                <div class="session-panel-head">
                  <p class="session-kicker">First-time setup</p>
                  <h1>Complete</h1>
                  <p class="session-copy">Your workspace is ready.</p>
                </div>
                <ol class="onboarding-step-list">
                  <li class="onboarding-stage-pill is-complete">
                    <span>1</span>
                    <strong>Login credentials</strong>
                  </li>
                  <li class="onboarding-stage-pill is-complete">
                    <span>2</span>
                    <strong>Preferences</strong>
                  </li>
                  <li class="onboarding-stage-pill is-complete">
                    <span>3</span>
                    <strong>Review and start</strong>
                  </li>
                </ol>
              </aside>
              <div class="onboarding-workspace">
                <main class="onboarding-main onboarding-status-main">
                  <section class="onboarding-stage onboarding-status-stage">
                    <div class="onboarding-lane-banner">
                      <span>Complete</span>
                    </div>
                    <div class="setup-step-copy onboarding-complete-copy">
                      <h2>Your workspace is ready</h2>
                      <p class="session-copy">Your account and system files are ready. Open the desktop now; command line tools and device setup are available below.</p>
                    </div>
                    <div class="session-result-grid">
                      <div class="session-result-card">
                        <span>Account</span>
                        <strong data-setup-result-username></strong>
                      </div>
                      <div class="session-result-card">
                        <span>Admin security</span>
                        <strong data-setup-result-root></strong>
                      </div>
                      <div class="session-result-card">
                        <span>System files</span>
                        <strong data-setup-result-source></strong>
                      </div>
                      <div class="session-result-card">
                        <span>Version</span>
                        <strong data-setup-result-ref></strong>
                      </div>
                    </div>
                    <div class="session-token-panel">
                      <div class="session-token-head">
                        <div>
                          <p class="session-kicker">Command line tools</p>
                          <h2 data-setup-result-cli-label>Tools for this machine</h2>
                        </div>
                        <div class="onboarding-help" tabindex="0" aria-label="Explain command line tools" aria-describedby="setup-help-cli">
                          <span class="onboarding-help-trigger" aria-hidden="true">?</span>
                          <div id="setup-help-cli" class="onboarding-help-popover" role="tooltip">
                            <strong>For terminal use</strong>
                            <p>These commands install GSV tools on this machine so you can manage or connect to the workspace from a terminal.</p>
                          </div>
                        </div>
                        <button type="button" class="runtime-btn session-btn-secondary" data-setup-copy-cli>Copy command</button>
                      </div>
                      <textarea class="session-token-value" data-setup-result-cli-command readonly></textarea>
                      <p class="session-token-meta" data-setup-result-cli-meta></p>
                    </div>
                    <div class="session-token-panel" data-setup-node-result hidden>
                      <div class="session-token-head">
                        <div>
                          <p class="session-kicker">Device setup</p>
                          <h2 data-setup-result-node-label>Connect a device</h2>
                        </div>
                        <button type="button" class="runtime-btn session-btn-secondary" data-setup-copy-token>Copy setup steps</button>
                      </div>
                      <textarea class="session-token-value" data-setup-result-node-token readonly></textarea>
                      <p class="session-token-meta" data-setup-result-node-meta></p>
                    </div>
                  </section>
                  <p class="session-error onboarding-alert" data-session-setup-complete-error role="alert" hidden></p>
                  <div class="session-actions onboarding-actions">
                    <div></div>
                    <div class="onboarding-primary-actions">
                      <button type="button" class="runtime-btn" data-session-setup-continue>Open desktop</button>
                    </div>
                  </div>
                </main>
              </div>
            </div>
          </div>
        </div>
  `;
}
