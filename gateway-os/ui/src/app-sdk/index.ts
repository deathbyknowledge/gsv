export type {
  AppCapability,
  AppEntrypoint,
  AppIcon,
  AppManifest,
  AppWindowDefaults,
  DesktopIconId,
} from "./manifest";
export { defineAppManifest } from "./manifest";

export type { AppKernelClient } from "./kernel-client";
export { createScopedKernelClient } from "./kernel-client";

export type { AppThemeClient, AppThemeSnapshot } from "./theme";
export { createThemeClient } from "./theme";
