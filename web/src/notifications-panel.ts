import type {
  NotificationDismissResult,
  NotificationListResult,
  NotificationMarkReadResult,
  NotificationRecord,
} from "../../gateway/src/syscalls/notification";
import type { GatewayClientLike } from "./gateway-client";

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

  const toggleNode = rootNode.querySelector<HTMLButtonElement>("[data-notifications-toggle]");
  const panelNode = rootNode.querySelector<HTMLElement>("[data-notifications-panel]");
  const listNode = rootNode.querySelector<HTMLElement>("[data-notifications-list]");
  const emptyNode = rootNode.querySelector<HTMLElement>("[data-notifications-empty]");
  const badgeNode = rootNode.querySelector<HTMLElement>("[data-notifications-badge]");
  const toastsNode = rootNode.querySelector<HTMLElement>("[data-notification-toasts]");

  if (!toggleNode || !panelNode || !listNode || !emptyNode || !badgeNode || !toastsNode) {
    throw new Error("Notifications panel markup is incomplete");
  }

  let isOpen = false;
  let notifications: NotificationRecord[] = [];
  const toasts = new Map<string, ToastRecord>();
  const originalParent = panelNode.parentElement;
  const originalNextSibling = panelNode.nextSibling;

  document.body.appendChild(panelNode);

  const positionPanel = (): void => {
    if (!isOpen) {
      return;
    }
    const rect = toggleNode.getBoundingClientRect();
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
    toggleNode.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      panelNode.style.position = "fixed";
      panelNode.style.bottom = "auto";
      panelNode.style.right = "auto";
      panelNode.style.zIndex = "260";
      panelNode.style.visibility = "hidden";
      requestAnimationFrame(() => {
        positionPanel();
        panelNode.style.visibility = "visible";
        console.debug("[notifications-panel] set open", {
          hidden: panelNode.hidden,
          rect: panelNode.getBoundingClientRect().toJSON?.() ?? null,
        });
      });
    } else {
      panelNode.style.visibility = "";
      console.debug("[notifications-panel] set closed", { hidden: panelNode.hidden });
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
    badgeNode.hidden = unreadCount === 0;
    badgeNode.textContent = unreadCount > 9 ? "9+" : String(unreadCount);

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

  const playNotificationSound = (): void => {
    try {
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        return;
      }
      const audio = new AudioContextCtor();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.value = 0.02;
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.08);
      oscillator.onended = () => {
        void audio.close().catch(() => {});
      };
    } catch {
      // best effort
    }
  };

  const showToast = (notification: NotificationRecord): void => {
    removeToast(notification.notificationId);
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

  const onToggleClick = (): void => {
    console.debug("[notifications-panel] toggle click", {
      isOpen,
      hidden: panelNode.hidden,
      count: notifications.length,
    });
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
    if (panelNode.contains(target) || toggleNode.contains(target)) {
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
    console.debug("[notifications-panel] list click", {
      target: event.target instanceof HTMLElement ? event.target.outerHTML.slice(0, 120) : String(event.target),
    });
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
      console.debug("[notifications-panel] dismiss", { notificationId, found: Boolean(result.notification) });
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
      console.debug("[notifications-panel] mark read", { notificationId, found: Boolean(result.notification) });
      if (result.notification) {
        upsertNotification(result.notification);
      }
    }
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
    if (signal.startsWith("notification.")) {
      console.debug("[notifications-panel] signal", { signal, payload });
    }
    if (signal === "notification.created") {
      const notification = extractNotification(payload);
      if (notification) {
        upsertNotification(notification);
        showToast(notification);
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

  toggleNode.addEventListener("click", onToggleClick);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeyDown);
  window.addEventListener("resize", positionPanel);
  listNode.addEventListener("click", (event) => {
    void onListClick(event);
  });

  render();

  return {
    destroy: () => {
      unsubscribeStatus();
      unsubscribeSignal();
      window.removeEventListener("resize", positionPanel);
      toggleNode.removeEventListener("click", onToggleClick);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
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
