import { APP_REGISTRY } from "./apps";
import type { ThemeId } from "./themes";

function renderDesktopIcons(): string {
  return APP_REGISTRY.map((appItem) => {
    return `
      <button type="button" class="desktop-icon" data-app-id="${appItem.id}">
        <span class="desktop-glyph ${appItem.iconGlyphClass}" aria-hidden="true"></span>
        <span>${appItem.name}</span>
      </button>
    `;
  }).join("");
}

export function renderDesktopShell(initialTheme: ThemeId): string {
  if (APP_REGISTRY.length === 0) {
    throw new Error("App registry is empty");
  }

  const desktopIconsMarkup = renderDesktopIcons();

  return `
    <div class="desktop-shell" data-theme="${initialTheme}">
      <div class="atmosphere">
        <div class="cloud cloud-a"></div>
        <div class="cloud cloud-b"></div>
        <div class="cloud cloud-c"></div>
        <div class="starship-glow"></div>
        <div class="starship-hull"></div>
      </div>

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
        <nav class="desktop-icons" aria-label="Desktop applications">
          ${desktopIconsMarkup}
        </nav>
        <section class="windows-layer" data-windows-layer></section>
      </main>

      <section class="session-overlay" data-session-overlay>
        <div class="session-card">
          <p class="eyebrow">GSV Desktop</p>
          <h1>Sign in</h1>
          <p class="muted">Unlock this workspace with your gateway credentials.</p>
          <form class="session-form" data-session-form>
            <label>
              Username
              <input data-session-username type="text" autocomplete="username" />
            </label>
            <label>
              Password
              <input data-session-password type="password" autocomplete="current-password" />
            </label>
            <label>
              Token (optional)
              <input data-session-token type="password" autocomplete="off" />
            </label>
            <p class="session-error" data-session-error hidden></p>
            <button type="submit" class="runtime-btn" data-session-submit>Sign in</button>
          </form>
        </div>
      </section>
    </div>
  `;
}
