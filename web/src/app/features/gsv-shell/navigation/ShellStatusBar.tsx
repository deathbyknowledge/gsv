import { StatusBar } from "../../../components/ui/StatusBar";
import type { NotificationSurface } from "../../notifications/types";

type ShellStatusBarProps = {
  context: string;
  clock: string;
  systemLoadLabel: string;
  systemLoadTone?: "error" | "offline" | "loading";
  sessionUsername: string;
  mobileHomeDate: string;
  notificationOpenSurface: NotificationSurface | null;
  notificationUnreadCount: number;
  onNotificationsToggle: (surface: NotificationSurface, node: HTMLButtonElement) => void;
  onLockSession: () => void;
};

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v8" />
      <path d="M7.8 6.6a8 8 0 1 0 8.4 0" />
    </svg>
  );
}

export function ShellStatusBar({
  context,
  clock,
  systemLoadLabel,
  systemLoadTone,
  sessionUsername,
  mobileHomeDate,
  notificationOpenSurface,
  notificationUnreadCount,
  onNotificationsToggle,
  onLockSession,
}: ShellStatusBarProps) {
  return (
    <footer class="gsv-shell-statusbar">
      <StatusBar
        clock={clock}
        context={context}
        power={systemLoadLabel}
        powerTone={systemLoadTone}
        showModel={false}
        showStatus={false}
      />
      <div class="gsv-status-actions">
        <span>{mobileHomeDate}</span>
        <button
          type="button"
          aria-label="Notifications"
          aria-haspopup="menu"
          aria-expanded={notificationOpenSurface === "topbar" ? "true" : "false"}
          aria-controls="notifications-panel"
          onClick={(event) => onNotificationsToggle("topbar", event.currentTarget)}
        >
          <BellIcon />
          <i hidden={notificationUnreadCount === 0}>
            {notificationUnreadCount > 9 ? "9+" : notificationUnreadCount}
          </i>
        </button>
        <button type="button" aria-label={`Lock ${sessionUsername}`} onClick={onLockSession}>
          <PowerIcon />
        </button>
      </div>
    </footer>
  );
}
