import { StatusBar } from "../../../components/ui/StatusBar";

type ShellStatusBarProps = {
  context: string;
  clock: string;
  systemLoadLabel: string;
  systemLoadTone?: "error" | "offline" | "loading";
  sessionUsername: string;
  mobileHomeDate: string;
  onLockSession: () => void;
};

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
        <button type="button" aria-label={`Lock ${sessionUsername}`} onClick={onLockSession}>
          <PowerIcon />
        </button>
      </div>
    </footer>
  );
}
