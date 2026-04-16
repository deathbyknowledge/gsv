import type { AppManifest } from "./apps";

export type AppRuntimeContext = {
  windowId: string;
  manifest: AppManifest;
  route: string;
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
