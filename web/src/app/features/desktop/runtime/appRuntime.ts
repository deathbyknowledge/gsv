import type { DesktopApp } from "../domain/desktopApp";

export type AppRuntimeContext = {
  windowId: string;
  app: DesktopApp;
  route: string;
  requestFocus: () => void;
  setTitle: (title: string | null) => void;
  setBadge: (badge: string | null) => void;
  setDirty: (dirty: boolean) => void;
  // Returns the new window id, or null when no window is created (e.g. the
  // host deferred the route change behind an unsaved-changes confirmation).
  requestNewWindow: (route?: string) => string | null;
};

export type AppInstance = {
  mount: (container: HTMLElement, context: AppRuntimeContext) => void | Promise<void>;
  suspend?: () => void | Promise<void>;
  resume?: () => void | Promise<void>;
  terminate?: () => void | Promise<void>;
};

export type AppRuntimeRegistry = {
  createInstance: (app: DesktopApp) => AppInstance;
};
