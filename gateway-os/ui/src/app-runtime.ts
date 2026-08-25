import type { AppManifest } from "./app-sdk/manifest";
import type { AppWindowClient } from "./app-sdk/window-client";

export type AppRuntimeContext = {
  windowId: string;
  manifest: AppManifest;
  window: AppWindowClient;
};

export type AppInstance = {
  mount: (container: HTMLElement, context: AppRuntimeContext) => void | Promise<void>;
  suspend?: () => void | Promise<void>;
  resume?: () => void | Promise<void>;
  terminate?: () => void | Promise<void>;
};

export type AppRuntimeRegistry = {
  createInstance: (manifest: AppManifest) => AppInstance;
};
