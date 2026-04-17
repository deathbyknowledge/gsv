export type NotificationLevel = "info" | "success" | "warning" | "error";

export type NotificationAction = {
  kind: string;
  label: string;
  target?: string;
  args?: Record<string, unknown>;
};

export type NotificationSource =
  | {
      kind: "user";
    }
  | {
      kind: "process";
      processId: string;
    }
  | {
      kind: "app";
      packageId: string;
      packageName: string;
      entrypointName: string;
    };

export type NotificationRecord = {
  notificationId: string;
  title: string;
  body?: string;
  level: NotificationLevel;
  createdAt: number;
  readAt: number | null;
  dismissedAt: number | null;
  expiresAt: number | null;
  actions: NotificationAction[];
  source: NotificationSource;
};

export type NotificationCreateArgs = {
  title: string;
  body?: string;
  level?: NotificationLevel;
  actions?: NotificationAction[];
  ttlMs?: number;
};

export type NotificationCreateResult = {
  notification: NotificationRecord;
};

export type NotificationListArgs = {
  includeRead?: boolean;
  includeDismissed?: boolean;
  limit?: number;
};

export type NotificationListResult = {
  notifications: NotificationRecord[];
};

export type NotificationMarkReadArgs = {
  notificationId: string;
};

export type NotificationMarkReadResult = {
  notification: NotificationRecord | null;
};

export type NotificationDismissArgs = {
  notificationId: string;
};

export type NotificationDismissResult = {
  notification: NotificationRecord | null;
};
