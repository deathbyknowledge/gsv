import { useEffect } from "preact/hooks";
import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";

type UseSessionFrameBridgeOptions = {
  shellRootNode: HTMLElement | null;
  sessionService: SessionService;
  snapshot: SessionSnapshot;
};

function syncSessionFrame(
  shellNode: HTMLElement,
  snapshot: SessionSnapshot,
): void {
  const ready = snapshot.phase === "ready";
  const desktopRootNode = shellNode.querySelector<HTMLElement>("[data-desktop-root]");
  const lockNode = shellNode.querySelector<HTMLButtonElement>("[data-session-lock]");
  const mobileHomeUsernameNode = shellNode.querySelector<HTMLElement>("[data-mobile-home-username]");
  const mobileHomeDateNode = shellNode.querySelector<HTMLElement>("[data-mobile-home-date]");

  if (desktopRootNode) {
    desktopRootNode.hidden = !ready;
  }
  if (lockNode) {
    lockNode.disabled = !ready;
  }
  if (mobileHomeUsernameNode) {
    mobileHomeUsernameNode.textContent = snapshot.username || "operator";
  }
  if (mobileHomeDateNode) {
    mobileHomeDateNode.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(new Date());
  }
}

function bindSessionLock(
  shellNode: HTMLElement,
  sessionService: SessionService,
): () => void {
  const lockNode = shellNode.querySelector<HTMLButtonElement>("[data-session-lock]");
  if (!lockNode) {
    return () => {};
  }

  const onLockClick = (): void => {
    sessionService.lock();
  };

  lockNode.addEventListener("click", onLockClick);
  return () => {
    lockNode.removeEventListener("click", onLockClick);
  };
}

export function useSessionFrameBridge({
  shellRootNode,
  sessionService,
  snapshot,
}: UseSessionFrameBridgeOptions): void {
  useEffect(() => {
    if (!shellRootNode) {
      return;
    }
    void sessionService.start();
  }, [sessionService, shellRootNode]);

  useEffect(() => {
    if (!shellRootNode) {
      return;
    }
    return bindSessionLock(shellRootNode, sessionService);
  }, [sessionService, shellRootNode]);

  useEffect(() => {
    if (!shellRootNode) {
      return;
    }
    syncSessionFrame(shellRootNode, snapshot);
  }, [shellRootNode, snapshot]);
}
