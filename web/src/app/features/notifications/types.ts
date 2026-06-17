export type NotificationSurface = "topbar" | "mobile";

export type NotificationAnchor = {
  surface: NotificationSurface;
  node: HTMLButtonElement;
};
