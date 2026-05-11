import type {
  NotificationDismissResult,
  NotificationListResult,
  NotificationMarkReadResult,
  NotificationRecord,
} from "@gsv/protocol/syscalls/notification";
import type { GatewayClientLike } from "./gateway-client";
import { canUseServiceWorker, registerGsvServiceWorker } from "./service-worker";

type NotificationsPanelOptions = {
  rootNode: HTMLElement;
  gatewayClient: GatewayClientLike;
};

type NotificationsPanelController = {
  destroy: () => void;
};

type ToastRecord = {
  timeoutId: number;
};

const DEFAULT_NOTIFICATION_SOUND = "/notification-sounds/27568__suonho__memorymoon_space-blaster-plays.wav";
const MOBILE_PANEL_QUERY = "(max-width: 720px)";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

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

export function createNotificationsPanel(
  options: NotificationsPanelOptions,
): NotificationsPanelController {
  const { rootNode, gatewayClient } = options;

  const toggleNodes = Array.from(rootNode.querySelectorAll<HTMLButtonElement>("[data-notifications-toggle]"));
  const panelNode = rootNode.querySelector<HTMLElement>("[data-notifications-panel]");
  const listNode = rootNode.querySelector<HTMLElement>("[data-notifications-list]");
  const emptyNode = rootNode.querySelector<HTMLElement>("[data-notifications-empty]");
  const badgeNodes = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-notifications-badge]"));
  const toastsNode = rootNode.querySelector<HTMLElement>("[data-notification-toasts]");
  const systemEnableNode = rootNode.querySelector<HTMLButtonElement>("[data-notifications-system-enable]");
  const deliveryStateNode = rootNode.querySelector<HTMLElement>("[data-notifications-delivery-state]");

  if (toggleNodes.length === 0 || !panelNode || !listNode || !emptyNode || badgeNodes.length === 0 || !toastsNode) {
    throw new Error("Notifications panel markup is incomplete");
  }

  let isOpen = false;
  let notifications: NotificationRecord[] = [];
  let activeToggleNode = toggleNodes[0];
  const toasts = new Map<string, ToastRecord>();
  const originalParent = panelNode.parentElement;
  const originalNextSibling = panelNode.nextSibling;
  const mobilePanelMedia = window.matchMedia(MOBILE_PANEL_QUERY);
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        positionPanel();
      })
    : null;

  document.body.appendChild(panelNode);

  const supportsSystemNotifications = (): boolean => {
    return "Notification" in window;
  };

  const supportsServiceWorkerNotifications = (): boolean => {
    return canUseServiceWorker();
  };

  const systemPermission = (): NotificationPermission | "unsupported" => {
    return supportsSystemNotifications() ? Notification.permission : "unsupported";
  };

  const updateDeliveryState = (): void => {
    const permission = systemPermission();
    if (deliveryStateNode) {
      if (permission === "granted") {
        deliveryStateNode.textContent = "System alerts enabled";
      } else if (permission === "denied") {
        deliveryStateNode.textContent = "System alerts blocked";
      } else if (!supportsSystemNotifications() || !supportsServiceWorkerNotifications()) {
        deliveryStateNode.textContent = "In-shell alerts";
      } else {
        deliveryStateNode.textContent = "In-shell alerts";
      }
    }

    if (systemEnableNode) {
      systemEnableNode.hidden = !supportsSystemNotifications() || !supportsServiceWorkerNotifications() || permission !== "default";
    }
  };

  const ensureServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
    if (!supportsServiceWorkerNotifications()) {
      return null;
    }
    return registerGsvServiceWorker();
  };

  const positionPanel = (): void => {
    if (!isOpen) {
      return;
    }

    panelNode.style.position = "fixed";
    panelNode.style.zIndex = "260";

    if (mobilePanelMedia.matches) {
      panelNode.style.left = "max(10px, env(safe-area-inset-left))";
      panelNode.style.right = "max(10px, env(safe-area-inset-right))";
      panelNode.style.top = "max(72px, calc(env(safe-area-inset-top) + 62px))";
      panelNode.style.bottom = "max(14px, env(safe-area-inset-bottom))";
      return;
    }

    panelNode.style.right = "auto";
    panelNode.style.bottom = "auto";
    const rect = activeToggleNode.getBoundingClientRect();
    const width = panelNode.offsetWidth || 320;
    const height = panelNode.offsetHeight || 180;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const left = Math.min(maxLeft, Math.max(8, rect.right - width));
    const top = rect.top - height - 10 >= 8 ? rect.top - height - 10 : rect.bottom + 10;
    panelNode.style.left = `${left}px`;
    panelNode.style.top = `${top}px`;
  };

  const setOpen = (open: boolean): void => {
    isOpen = open;
    panelNode.hidden = !open;
    for (const toggleNode of toggleNodes) {
      toggleNode.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (open) {
      panelNode.style.visibility = "hidden";
      requestAnimationFrame(() => {
        positionPanel();
        panelNode.style.visibility = "visible";
      });
    } else {
      panelNode.style.left = "";
      panelNode.style.right = "";
      panelNode.style.top = "";
      panelNode.style.bottom = "";
      panelNode.style.visibility = "";
    }
  };

  const removeToast = (notificationId: string): void => {
    const toast = toasts.get(notificationId);
    if (!toast) {
      return;
    }
    window.clearTimeout(toast.timeoutId);
    toasts.delete(notificationId);
    const node = toastsNode.querySelector<HTMLElement>(`[data-toast-id="${CSS.escape(notificationId)}"]`);
    if (node) {
      node.remove();
    }
  };

  const render = (): void => {
    const unreadCount = notifications.filter((entry) => !entry.readAt).length;
    for (const badgeNode of badgeNodes) {
      badgeNode.hidden = unreadCount === 0;
      badgeNode.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
    }

    if (notifications.length === 0) {
      listNode.innerHTML = "";
      listNode.hidden = true;
      emptyNode.hidden = false;
      return;
    }

    emptyNode.hidden = true;
    listNode.hidden = false;
    listNode.innerHTML = notifications.map((notification) => {
      const unreadClass = notification.readAt ? "" : " is-unread";
      return `
        <li class="notification-item${unreadClass}" data-notification-id="${escapeHtml(notification.notificationId)}">
          <button type="button" class="notification-main" data-notification-read="${escapeHtml(notification.notificationId)}">
            <div class="notification-item-head">
              <strong>${escapeHtml(notification.title)}</strong>
              <span>${escapeHtml(formatTime(notification.createdAt))}</span>
            </div>
            ${notification.body ? `<p>${escapeHtml(notification.body)}</p>` : ""}
          </button>
          <button type="button" class="notification-dismiss" data-notification-dismiss="${escapeHtml(notification.notificationId)}" aria-label="Dismiss notification">×</button>
        </li>
      `;
    }).join("");

    if (isOpen) {
      requestAnimationFrame(() => {
        positionPanel();
      });
    }
  };

  const upsertNotification = (notification: NotificationRecord): void => {
    const existingIndex = notifications.findIndex((entry) => entry.notificationId === notification.notificationId);
    if (notification.dismissedAt) {
      if (existingIndex >= 0) {
        notifications.splice(existingIndex, 1);
      }
      removeToast(notification.notificationId);
      render();
      return;
    }
    if (existingIndex >= 0) {
      notifications[existingIndex] = notification;
    } else {
      notifications.unshift(notification);
    }
    notifications.sort((a, b) => b.createdAt - a.createdAt);
    render();
  };

  const playNotificationSound = async (): Promise<void> => {
    try {
      const audio = new Audio(DEFAULT_NOTIFICATION_SOUND);
      audio.volume = 0.72;
      audio.preload = "auto";
      await audio.play();
    } catch {
      // best effort
    }
  };

  const showSystemNotification = async (notification: NotificationRecord): Promise<boolean> => {
    if (systemPermission() !== "granted") {
      return false;
    }

    const options: NotificationOptions = {
      body: notification.body,
      tag: notification.notificationId,
      data: {
        notificationId: notification.notificationId,
      },
      silent: false,
    };

    const registration = await ensureServiceWorkerRegistration();
    if (registration) {
      await registration.showNotification(notification.title, options);
      return true;
    }

    new Notification(notification.title, options);
    return true;
  };

  const showToast = async (notification: NotificationRecord): Promise<void> => {
    removeToast(notification.notificationId);
    const deliveredSystemNotification = await showSystemNotification(notification).catch(() => false);
    if (deliveredSystemNotification) {
      return;
    }

    playNotificationSound();
    const toastNode = document.createElement("div");
    toastNode.className = `notification-toast is-${notification.level}`;
    toastNode.dataset.toastId = notification.notificationId;
    toastNode.innerHTML = `
      <div class="notification-toast-title">${escapeHtml(notification.title)}</div>
      ${notification.body ? `<div class="notification-toast-body">${escapeHtml(notification.body)}</div>` : ""}
    `;
    toastsNode.prepend(toastNode);
    const timeoutId = window.setTimeout(() => {
      removeToast(notification.notificationId);
    }, 4500);
    toasts.set(notification.notificationId, { timeoutId });
  };

  const refresh = async (): Promise<void> => {
    if (!gatewayClient.isConnected()) {
      notifications = [];
      render();
      return;
    }
    const result = await gatewayClient.call<NotificationListResult>("notification.list", {
      includeRead: true,
      includeDismissed: false,
      limit: 50,
    });
    notifications = Array.isArray(result.notifications) ? result.notifications : [];
    notifications.sort((a, b) => b.createdAt - a.createdAt);
    render();
  };

  const onToggleClick = (event: MouseEvent): void => {
    if (event.currentTarget instanceof HTMLButtonElement) {
      activeToggleNode = event.currentTarget;
    }
    setOpen(!isOpen);
  };

  const onDocumentClick = (event: MouseEvent): void => {
    if (!isOpen) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (panelNode.contains(target) || toggleNodes.some((toggleNode) => toggleNode.contains(target))) {
      return;
    }
    setOpen(false);
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && isOpen) {
      setOpen(false);
    }
  };

  const onListClick = async (event: MouseEvent): Promise<void> => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const dismissButton = target.closest<HTMLElement>("[data-notification-dismiss]");
    if (dismissButton?.dataset.notificationDismiss) {
      const notificationId = dismissButton.dataset.notificationDismiss;
      const result = await gatewayClient.call<NotificationDismissResult>("notification.dismiss", {
        notificationId,
      });
      if (result.notification) {
        upsertNotification(result.notification);
      }
      return;
    }

    const readButton = target.closest<HTMLElement>("[data-notification-read]");
    if (readButton?.dataset.notificationRead) {
      const notificationId = readButton.dataset.notificationRead;
      const result = await gatewayClient.call<NotificationMarkReadResult>("notification.mark_read", {
        notificationId,
      });
      if (result.notification) {
        upsertNotification(result.notification);
      }
    }
  };

  const onSystemEnableClick = async (): Promise<void> => {
    if (!supportsSystemNotifications()) {
      updateDeliveryState();
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      await ensureServiceWorkerRegistration();
    }
    updateDeliveryState();
  };

  const onSystemEnableButtonClick = (): void => {
    void onSystemEnableClick();
  };

  const onListClickEvent = (event: MouseEvent): void => {
    void onListClick(event);
  };

  const onServiceWorkerMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; notificationId?: unknown } | null;
    if (!data || data.type !== "gsv.notification.click") {
      return;
    }

    if (typeof data.notificationId === "string") {
      void gatewayClient.call<NotificationMarkReadResult>("notification.mark_read", {
        notificationId: data.notificationId,
      }).then((result) => {
        if (result.notification) {
          upsertNotification(result.notification);
        }
      }).catch(() => {});
    }
    setOpen(true);
  };

  const unsubscribeStatus = gatewayClient.onStatus((status) => {
    if (status.state === "connected") {
      void refresh();
      return;
    }
    notifications = [];
    render();
  });

  const unsubscribeSignal = gatewayClient.onSignal((signal, payload) => {
    if (signal === "notification.created") {
      const notification = extractNotification(payload);
      if (notification) {
        upsertNotification(notification);
        void showToast(notification);
      }
      return;
    }
    if (signal === "notification.updated" || signal === "notification.dismissed") {
      const notification = extractNotification(payload);
      if (notification) {
        upsertNotification(notification);
      }
    }
  });

  for (const toggleNode of toggleNodes) {
    toggleNode.addEventListener("click", onToggleClick);
  }
  systemEnableNode?.addEventListener("click", onSystemEnableButtonClick);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeyDown);
  window.addEventListener("resize", positionPanel);
  mobilePanelMedia.addEventListener("change", positionPanel);
  navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
  listNode.addEventListener("click", onListClickEvent);
  resizeObserver?.observe(panelNode);

  updateDeliveryState();
  render();

  return {
    destroy: () => {
      unsubscribeStatus();
      unsubscribeSignal();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", positionPanel);
      mobilePanelMedia.removeEventListener("change", positionPanel);
      for (const toggleNode of toggleNodes) {
        toggleNode.removeEventListener("click", onToggleClick);
      }
      systemEnableNode?.removeEventListener("click", onSystemEnableButtonClick);
      listNode.removeEventListener("click", onListClickEvent);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
      navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
      for (const toast of toasts.values()) {
        window.clearTimeout(toast.timeoutId);
      }
      toasts.clear();
      if (originalParent) {
        if (originalNextSibling) {
          originalParent.insertBefore(panelNode, originalNextSibling);
        } else {
          originalParent.appendChild(panelNode);
        }
      } else {
        panelNode.remove();
      }
    },
  };
}
