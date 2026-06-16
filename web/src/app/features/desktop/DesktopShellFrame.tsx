import { Component, type ComponentChildren, type RefObject } from "preact";

type DesktopShellFrameProps = {
  shellRef: RefObject<HTMLDivElement>;
  windowsLayerRef: RefObject<HTMLElement>;
  standalone: boolean;
  children?: ComponentChildren;
};

function MicrophoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v8" />
      <path d="M7.8 6.6a8 8 0 1 0 8.4 0" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function Topbar() {
  return (
    <header class="topbar">
      <div class="topbar-section">
        <button type="button" class="pill topbar-launcher" data-command-launcher aria-label="Open command palette">GSV</button>
      </div>
      <nav class="taskbar-windows" data-taskbar-windows aria-label="Open windows" />
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
            <MicrophoneIcon />
          </span>
          <span class="presence-toggle-light" aria-hidden="true" />
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
            <BellIcon />
          </span>
          <span class="notification-badge" data-notifications-badge hidden>0</span>
        </button>
      </div>
      <div class="topbar-section topbar-session">
        <button type="button" class="session-lock-btn" data-session-lock aria-label="Lock">
          <span class="topbar-icon" aria-hidden="true">
            <PowerIcon />
          </span>
        </button>
      </div>
    </header>
  );
}

function Workspace({ windowsLayerRef }: { windowsLayerRef: RefObject<HTMLElement> }) {
  return (
    <main class="workspace" role="presentation">
      <nav class="desktop-icons" data-desktop-icons aria-label="Desktop applications" />
      <section class="windows-layer" data-windows-layer ref={windowsLayerRef} />
    </main>
  );
}

function MobileShell() {
  return (
    <section class="mobile-shell" data-mobile-shell aria-label="Mobile shell">
      <section class="mobile-home" data-mobile-home>
        <header class="mobile-home-header" aria-label="Home">
          <p class="mobile-home-date" data-mobile-home-date />
          <h1>Hello, <span data-mobile-home-username>operator</span></h1>
          <div class="mobile-home-actions">
            <button
              type="button"
              class="mobile-home-action"
              data-notifications-toggle
              aria-label="Notifications"
              aria-haspopup="menu"
              aria-expanded="false"
              aria-controls="notifications-panel"
            >
              <span aria-hidden="true">
                <BellIcon />
              </span>
              <span class="notification-badge" data-notifications-badge hidden>0</span>
            </button>
            <button
              type="button"
              class="mobile-home-action presence-toggle"
              data-presence-toggle
              data-state="idle"
              aria-label="Mind"
              aria-haspopup="dialog"
              aria-expanded="false"
              aria-controls="presence-panel"
            >
              <span aria-hidden="true">
                <MicrophoneIcon />
              </span>
            </button>
            <button type="button" class="mobile-home-action" data-mobile-command-launcher aria-label="Search apps and windows">
              <span aria-hidden="true">
                <SearchIcon />
              </span>
            </button>
          </div>
        </header>
        <nav class="mobile-app-grid" data-mobile-apps aria-label="Applications" />
      </section>
      <button type="button" class="mobile-home-handle" data-mobile-home-button aria-label="Home" />
    </section>
  );
}

function PresenceActivity() {
  return (
    <button
      type="button"
      class="presence-activity"
      data-presence-activity
      aria-live="polite"
      aria-atomic="false"
      aria-controls="presence-panel"
      aria-expanded="false"
    >
      <span class="presence-activity-head">
        <span class="presence-activity-pulse" aria-hidden="true" />
        <span>
          <strong>Mind</strong>
          <small data-presence-activity-status>Ready</small>
        </span>
      </span>
      <span class="presence-activity-body" data-presence-activity-body />
    </button>
  );
}

function PresencePanel() {
  return (
    <section class="presence-panel" id="presence-panel" data-presence-panel role="dialog" aria-label="Mind" hidden>
      <header class="presence-panel-head">
        <div class="presence-panel-brand">
          <span class="presence-panel-mark" aria-hidden="true">GSV</span>
          <span class="presence-panel-copy">
            <strong data-presence-title>Mind</strong>
          </span>
        </div>
        <button type="button" class="presence-panel-close" data-presence-close aria-label="Close Mind">
          <CloseIcon />
        </button>
      </header>
      <section class="presence-current" aria-live="polite">
        <span class="presence-current-orb" aria-hidden="true" />
        <div>
          <strong data-presence-status>Paused</strong>
          <span class="presence-interim" data-presence-interim />
        </div>
      </section>
      <div class="presence-actions presence-actions-main">
        <button type="button" class="presence-primary" data-presence-listen>Listen</button>
      </div>
      <div class="presence-log" data-presence-log hidden />
      <details class="presence-section presence-manual">
        <summary>Manual</summary>
        <div class="presence-mode" role="group" aria-label="Mind input mode">
          <button type="button" data-presence-mode="ambient" aria-pressed="true">Ambient</button>
          <button type="button" data-presence-mode="push" aria-pressed="false">Manual</button>
        </div>
        <textarea
          class="presence-transcript"
          data-presence-transcript
          rows={4}
          autoComplete="off"
          spellcheck={true}
          aria-label="Message to Mind"
          placeholder="Talk or type to Mind"
        />
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
            <input type="checkbox" data-presence-speak defaultChecked />
          </label>
          <button type="button" data-presence-speak-test>Preview voice</button>
        </div>
        <div class="presence-speech-status" data-presence-speech-status />
      </details>
    </section>
  );
}

function CommandPalette() {
  return (
    <section class="command-palette" data-command-palette role="dialog" aria-label="Command palette" hidden>
      <div class="command-palette-panel">
        <input data-command-palette-input type="text" autoComplete="off" placeholder="Search apps and windows" />
        <button type="button" class="command-palette-close" data-command-palette-close aria-label="Close search">
          <CloseIcon />
        </button>
        <ul class="command-palette-list" data-command-palette-list />
      </div>
    </section>
  );
}

function DesktopRoot({ windowsLayerRef }: { windowsLayerRef: RefObject<HTMLElement> }) {
  return (
    <div class="desktop-root" data-desktop-root hidden>
      <Topbar />
      <Workspace windowsLayerRef={windowsLayerRef} />
      <MobileShell />
      <div class="dock-reveal-zone" data-dock-reveal-zone aria-hidden="true" />
      <PresenceActivity />
      <PresencePanel />
      <CommandPalette />
    </div>
  );
}

class StaticDesktopRoot extends Component<{ windowsLayerRef: RefObject<HTMLElement> }> {
  shouldComponentUpdate(): boolean {
    return false;
  }

  render({ windowsLayerRef }: { windowsLayerRef: RefObject<HTMLElement> }) {
    return <DesktopRoot windowsLayerRef={windowsLayerRef} />;
  }
}

export function DesktopShellFrame({
  shellRef,
  windowsLayerRef,
  standalone,
  children,
}: DesktopShellFrameProps) {
  return (
    <div class={`desktop-shell${standalone ? " is-standalone" : ""}`} ref={shellRef}>
      {children}
      <StaticDesktopRoot windowsLayerRef={windowsLayerRef} />
    </div>
  );
}
