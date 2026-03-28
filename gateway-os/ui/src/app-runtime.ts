import type { AppManifest } from "./apps";
import type { AppWindowSession } from "./gateway-client";

export type AppRuntimeContext = {
  windowId: string;
  manifest: AppManifest;
  session: AppWindowSession;
};

export type AppInstance = {
  mount: (container: HTMLElement, context: AppRuntimeContext) => void | Promise<void>;
  suspend?: () => void | Promise<void>;
  resume?: () => void | Promise<void>;
  terminate?: () => void | Promise<void>;
};

export type AppRuntimeRegistry = {
  openWindowSession: (manifest: AppManifest, windowId: string) => Promise<AppWindowSession>;
  createInstance: (manifest: AppManifest) => AppInstance;
};
