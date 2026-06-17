import { Component, type ComponentChildren, type RefObject } from "preact";
import {
  PresenceActivity,
  PresenceMobileToggle,
  PresencePanel,
  PresenceTopbarToggle,
} from "../presence/Presence";
import type { PresenceController } from "../presence/presenceController";

type DesktopShellFrameProps = {
  shellRef: RefObject<HTMLDivElement>;
  windowsLayerRef: RefObject<HTMLElement>;
  presenceController: PresenceController;
  standalone: boolean;
  children?: ComponentChildren;
};

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

function Topbar({ presenceController }: { presenceController: PresenceController }) {
  return (
    <header class="topbar">
      <div class="topbar-section">
        <button type="button" class="pill topbar-launcher" data-command-launcher aria-label="Open command palette">GSV</button>
      </div>
      <nav class="taskbar-windows" data-taskbar-windows aria-label="Open windows" />
      <div class="topbar-section topbar-presence">
        <PresenceTopbarToggle controller={presenceController} />
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

function MobileShell({ presenceController }: { presenceController: PresenceController }) {
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
            <PresenceMobileToggle controller={presenceController} />
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

function CommandPalette() {
  return <div data-command-palette-root />;
}

function DesktopRoot({
  windowsLayerRef,
  presenceController,
}: {
  windowsLayerRef: RefObject<HTMLElement>;
  presenceController: PresenceController;
}) {
  return (
    <div class="desktop-root" data-desktop-root hidden>
      <Topbar presenceController={presenceController} />
      <Workspace windowsLayerRef={windowsLayerRef} />
      <MobileShell presenceController={presenceController} />
      <div class="dock-reveal-zone" data-dock-reveal-zone aria-hidden="true" />
      <PresenceActivity controller={presenceController} />
      <PresencePanel controller={presenceController} />
      <CommandPalette />
    </div>
  );
}

class StaticDesktopRoot extends Component<{
  windowsLayerRef: RefObject<HTMLElement>;
  presenceController: PresenceController;
}> {
  shouldComponentUpdate(nextProps: { presenceController: PresenceController }): boolean {
    return nextProps.presenceController !== this.props.presenceController;
  }

  render({
    windowsLayerRef,
    presenceController,
  }: {
    windowsLayerRef: RefObject<HTMLElement>;
    presenceController: PresenceController;
  }) {
    return <DesktopRoot windowsLayerRef={windowsLayerRef} presenceController={presenceController} />;
  }
}

export function DesktopShellFrame({
  shellRef,
  windowsLayerRef,
  presenceController,
  standalone,
  children,
}: DesktopShellFrameProps) {
  return (
    <div class={`desktop-shell${standalone ? " is-standalone" : ""}`} ref={shellRef}>
      {children}
      <StaticDesktopRoot windowsLayerRef={windowsLayerRef} presenceController={presenceController} />
    </div>
  );
}
