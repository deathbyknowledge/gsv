export function renderDesktopShell(): string {
  return `
    <div class="desktop-shell">
      <header class="topbar">
        <div class="topbar-section">
          <span class="pill">GSV</span>
          <span class="muted">workspace: bridge</span>
        </div>
        <div class="topbar-section topbar-windows">
          <button
            type="button"
            class="windows-toggle"
            data-windows-toggle
            aria-haspopup="menu"
            aria-expanded="false"
            aria-controls="windows-panel"
          >
            Windows
          </button>
          <div class="windows-panel" id="windows-panel" data-windows-panel hidden>
            <p class="windows-empty muted" data-windows-empty>No minimized windows</p>
            <ul class="windows-list" data-windows-list hidden></ul>
          </div>
        </div>
        <div class="topbar-section topbar-session">
          <span class="status-dot is-offline" data-session-dot aria-hidden="true"></span>
          <span class="muted" data-session-status>session: locked</span>
          <button type="button" class="session-lock-btn" data-session-lock>Lock</button>
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
