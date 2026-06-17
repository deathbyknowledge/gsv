import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { NotificationRecord } from "@humansandmachines/gsv/protocol";
import {
  canUseServiceWorker as canUseServiceWorkerNotifications,
  registerGsvServiceWorker,
} from "../../../service-worker";
import { useGateway } from "../../services/gateway/GatewayProvider";
import type { NotificationAnchor } from "./types";

type NotificationsPanelProps = {
  anchor: NotificationAnchor | null;
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  onUnreadCountChange: (count: number) => void;
};

type ToastRecord = {
  notification: NotificationRecord;
};

const DEFAULT_NOTIFICATION_SOUND = "/notification-sounds/27568__suonho__memorymoon_space-blaster-plays.wav";
const MOBILE_PANEL_QUERY = "(max-width: 720px)";
const notificationListQueryKey = ["notifications", "list", { includeRead: true, includeDismissed: false }] as const;

function formatTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function extractNotification(payload: unknown): NotificationRecord | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const value = payload as { notification?: NotificationRecord };
  return value.notification ?? null;
}

function supportsSystemNotifications(): boolean {
  return "Notification" in window;
}

function systemPermission(): NotificationPermission | "unsupported" {
  return supportsSystemNotifications() ? Notification.permission : "unsupported";
}

function deliveryStateLabel(permission: NotificationPermission | "unsupported"): string {
  if (permission === "granted") {
    return "System alerts enabled";
  }
  if (permission === "denied") {
    return "System alerts blocked";
  }
  return "In-shell alerts";
}

function upsertNotification(
  notifications: readonly NotificationRecord[] | undefined,
  notification: NotificationRecord,
): NotificationRecord[] {
  const current = notifications ?? [];
  if (notification.dismissedAt) {
    return current.filter((entry) => entry.notificationId !== notification.notificationId);
  }
  const index = current.findIndex((entry) => entry.notificationId === notification.notificationId);
  if (index < 0) {
    return [notification, ...current];
  }
  const next = [...current];
  next[index] = notification;
  return next;
}

function removeNotification(
  notifications: readonly NotificationRecord[] | undefined,
  notificationId: string,
): NotificationRecord[] {
  return (notifications ?? []).filter((entry) => entry.notificationId !== notificationId);
}

export function NotificationsPanel({
  anchor,
  open,
  onClose,
  onOpen,
  onUnreadCountChange,
}: NotificationsPanelProps) {
  const { client: gatewayClient, connected } = useGateway();
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLElement>(null);
  const toastTimers = useRef(new Map<string, number>());
  const [panelStyle, setPanelStyle] = useState<JSX.CSSProperties>({});
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(systemPermission);
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const notificationsQuery = useQuery({
    queryKey: notificationListQueryKey,
    enabled: connected,
    queryFn: async () => {
      const result = await gatewayClient.notification.list({
        includeRead: true,
        includeDismissed: false,
        limit: 100,
      });
      return result.notifications;
    },
  });

  const notifications = notificationsQuery.data ?? [];
  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.readAt).length,
    [notifications],
  );
  const activeToggle = anchor?.node ?? null;

  const updateNotificationCache = useCallback((notification: NotificationRecord | null): void => {
    if (!notification) {
      return;
    }
    queryClient.setQueryData<NotificationRecord[]>(
      notificationListQueryKey,
      (current) => upsertNotification(current, notification),
    );
  }, [queryClient]);

  const markReadMutation = useMutation({
    mutationFn: async (notificationId: string) => {
      return await gatewayClient.notification.mark_read({ notificationId });
    },
    onSuccess: (result) => {
      updateNotificationCache(result.notification);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (notificationId: string) => {
      return await gatewayClient.notification.dismiss({ notificationId });
    },
    onSuccess: (result, notificationId) => {
      if (result.notification) {
        updateNotificationCache(result.notification);
      } else {
        queryClient.setQueryData<NotificationRecord[]>(
          notificationListQueryKey,
          (current) => removeNotification(current, notificationId),
        );
      }
      removeToast(notificationId);
    },
  });

  const positionPanel = useCallback((): void => {
    if (!open) {
      return;
    }

    if (window.matchMedia(MOBILE_PANEL_QUERY).matches) {
      setPanelStyle({
        position: "fixed",
        zIndex: 260,
        left: "max(10px, env(safe-area-inset-left))",
        right: "max(10px, env(safe-area-inset-right))",
        top: "max(72px, calc(env(safe-area-inset-top) + 62px))",
        bottom: "max(14px, env(safe-area-inset-bottom))",
      });
      return;
    }

    if (!activeToggle) {
      setPanelStyle({
        position: "fixed",
        zIndex: 260,
        right: 12,
        top: 58,
        left: "auto",
        bottom: "auto",
      });
      return;
    }

    const rect = activeToggle.getBoundingClientRect();
    const panelNode = panelRef.current;
    const width = panelNode?.offsetWidth || 320;
    const height = panelNode?.offsetHeight || 180;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const left = Math.min(maxLeft, Math.max(8, rect.right - width));
    const top = rect.top - height - 10 >= 8 ? rect.top - height - 10 : rect.bottom + 10;
    setPanelStyle({
      position: "fixed",
      zIndex: 260,
      left,
      top,
      right: "auto",
      bottom: "auto",
    });
  }, [activeToggle, open]);

  const removeToast = useCallback((notificationId: string): void => {
    const timer = toastTimers.current.get(notificationId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.current.delete(notificationId);
    }
    setToasts((current) => current.filter((toast) => toast.notification.notificationId !== notificationId));
  }, []);

  const playNotificationSound = useCallback(async (): Promise<void> => {
    try {
      const audio = new Audio(DEFAULT_NOTIFICATION_SOUND);
      audio.volume = 0.36;
      await audio.play();
    } catch {
      // Autoplay policies can block notification sounds.
    }
  }, []);

  const showSystemNotification = useCallback(async (notification: NotificationRecord): Promise<boolean> => {
    if (!supportsSystemNotifications() || permission !== "granted") {
      return false;
    }

    const options: NotificationOptions = {
      body: notification.body,
      tag: notification.notificationId,
      data: {
        notificationId: notification.notificationId,
      },
    };

    const registration = canUseServiceWorkerNotifications()
      ? await registerGsvServiceWorker()
      : null;
    if (registration) {
      await registration.showNotification(notification.title, options);
      return true;
    }

    new Notification(notification.title, options);
    return true;
  }, [permission]);

  const showToast = useCallback(async (notification: NotificationRecord): Promise<void> => {
    removeToast(notification.notificationId);
    const deliveredSystemNotification = await showSystemNotification(notification).catch(() => false);
    if (deliveredSystemNotification) {
      return;
    }

    void playNotificationSound();
    setToasts((current) => [{ notification }, ...current]);
    const timer = window.setTimeout(() => {
      removeToast(notification.notificationId);
    }, 6_000);
    toastTimers.current.set(notification.notificationId, timer);
  }, [playNotificationSound, removeToast, showSystemNotification]);

  const requestSystemPermission = useCallback(async (): Promise<void> => {
    if (!supportsSystemNotifications() || !canUseServiceWorkerNotifications()) {
      return;
    }
    const nextPermission = await Notification.requestPermission();
    setPermission(nextPermission);
    if (nextPermission === "granted") {
      await registerGsvServiceWorker();
    }
  }, []);

  useEffect(() => {
    onUnreadCountChange(unreadCount);
  }, [onUnreadCountChange, unreadCount]);

  useEffect(() => {
    if (!open) {
      setPanelStyle({});
      return;
    }
    const frame = window.requestAnimationFrame(positionPanel);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open, positionPanel]);

  useEffect(() => {
    const mobilePanelMedia = window.matchMedia(MOBILE_PANEL_QUERY);
    window.addEventListener("resize", positionPanel);
    mobilePanelMedia.addEventListener("change", positionPanel);
    return () => {
      window.removeEventListener("resize", positionPanel);
      mobilePanelMedia.removeEventListener("change", positionPanel);
    };
  }, [positionPanel]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      if (!open) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (panelRef.current?.contains(target)) {
        return;
      }
      if (activeToggle?.contains(target)) {
        return;
      }
      onClose();
    };

    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [activeToggle, onClose, open]);

  useEffect(() => {
    return gatewayClient.onSignal((signal, payload) => {
      if (signal === "notification.created") {
        const notification = extractNotification(payload);
        updateNotificationCache(notification);
        if (notification) {
          void showToast(notification);
        }
        return;
      }

      if (signal === "notification.updated" || signal === "notification.dismissed") {
        const notification = extractNotification(payload);
        updateNotificationCache(notification);
        if (notification?.dismissedAt) {
          removeToast(notification.notificationId);
        }
      }
    });
  }, [gatewayClient, removeToast, showToast, updateNotificationCache]);

  useEffect(() => {
    const onServiceWorkerMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; notificationId?: unknown } | null;
      if (!data || data.type !== "gsv.notification.click") {
        return;
      }
      const notificationId = typeof data.notificationId === "string" ? data.notificationId : "";
      if (notificationId) {
        markReadMutation.mutate(notificationId);
      }
      onOpen();
    };

    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
    };
  }, [markReadMutation, onOpen]);

  useEffect(() => {
    setPermission(systemPermission());
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of toastTimers.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimers.current.clear();
    };
  }, []);

  const showEnableSystem = supportsSystemNotifications()
    && canUseServiceWorkerNotifications()
    && permission === "default";

  return (
    <>
      {open ? (
        <section
          ref={panelRef}
          class="notifications-panel"
          id="notifications-panel"
          role="dialog"
          aria-label="Notifications"
          style={panelStyle}
        >
          <header class="notifications-panel-head">
            <div>
              <strong>Notifications</strong>
              <span>{deliveryStateLabel(permission)}</span>
            </div>
            {showEnableSystem ? (
              <button
                type="button"
                class="notifications-system-enable"
                onClick={() => void requestSystemPermission()}
              >
                Enable system
              </button>
            ) : null}
          </header>

          {notifications.length === 0 ? (
            <p class="windows-empty muted">No notifications</p>
          ) : (
            <ul class="notifications-list">
              {notifications.map((notification) => {
                const unreadClass = notification.readAt ? "" : " is-unread";
                return (
                  <li
                    key={notification.notificationId}
                    class={`notification-item${unreadClass}`}
                    data-notification-id={notification.notificationId}
                  >
                    <button
                      type="button"
                      class="notification-main"
                      onClick={() => markReadMutation.mutate(notification.notificationId)}
                    >
                      <div class="notification-item-head">
                        <strong>{notification.title}</strong>
                        <span>{formatTime(notification.createdAt)}</span>
                      </div>
                      {notification.body ? <p>{notification.body}</p> : null}
                    </button>
                    <button
                      type="button"
                      class="notification-dismiss"
                      aria-label="Dismiss notification"
                      onClick={() => dismissMutation.mutate(notification.notificationId)}
                    >
                      x
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <div class="notification-toasts" aria-live="polite" aria-atomic="false">
        {toasts.map(({ notification }) => (
          <div
            key={notification.notificationId}
            class={`notification-toast is-${notification.level}`}
            data-toast-id={notification.notificationId}
          >
            <div class="notification-toast-title">{notification.title}</div>
            {notification.body ? <div class="notification-toast-body">{notification.body}</div> : null}
          </div>
        ))}
      </div>
    </>
  );
}
