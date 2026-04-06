export function renderDesktopShell(): string {
  return `
    <div class="desktop-shell">
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

      <section class="session-overlay" data-session-overlay>
        <div class="session-card">
          <h1>Welcome back</h1>
          <form class="session-form" data-session-form>
            <label>
              Username
              <input data-session-username type="text" autocomplete="username" />
            </label>
            <label>
              Password
              <input data-session-password type="password" autocomplete="current-password" />
            </label>
            <details class="session-advanced">
              <summary>Advanced</summary>
              <label>
                Token (optional)
                <input data-session-token type="password" autocomplete="off" />
              </label>
            </details>
            <p class="session-error" data-session-error hidden></p>
            <button type="submit" class="runtime-btn" data-session-submit>Sign in</button>
          </form>
        </div>
      </section>
    </div>
  `;
}
