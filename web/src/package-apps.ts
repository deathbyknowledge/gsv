import { defineAppManifest } from "./app-sdk";
import type { AppIcon, AppManifest, AppWindowDefaults, DesktopIconId } from "./app-sdk";
import type { PkgSummary } from "../../gateway/src/syscalls/packages";

const DEFAULT_WINDOW_DEFAULTS: AppWindowDefaults = {
  width: 1040,
  height: 720,
  minWidth: 760,
  minHeight: 520,
};

const DESKTOP_ICON_IDS: readonly DesktopIconId[] = [
  "chat",
  "shell",
  "devices",
  "files",
  "control",
  "processes",
  "packages",
] as const;

function toDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "App";
  }
  return trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
}

function coerceAppIcon(
  value: PkgSummary["entrypoints"][number]["icon"] | undefined,
  fallbackName: string,
): AppIcon {
  if (value?.kind === "svg" && value.svg.trim().length > 0) {
    return {
      kind: "svg",
      svg: value.svg,
    };
  }

  if (value?.kind === "builtin" && DESKTOP_ICON_IDS.includes(value.id as DesktopIconId)) {
    return {
      kind: "builtin",
      id: value.id as DesktopIconId,
    };
  }

  if (DESKTOP_ICON_IDS.includes(fallbackName as DesktopIconId)) {
    return {
      kind: "builtin",
      id: fallbackName as DesktopIconId,
    };
  }

  return {
    kind: "builtin",
    id: "packages",
  };
}

function coerceWindowDefaults(value: {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
} | undefined): AppWindowDefaults {
  if (!value) {
    return DEFAULT_WINDOW_DEFAULTS;
  }

  const width = Number.isFinite(value.width) ? Math.max(320, value.width as number) : DEFAULT_WINDOW_DEFAULTS.width;
  const height = Number.isFinite(value.height) ? Math.max(240, value.height as number) : DEFAULT_WINDOW_DEFAULTS.height;
  const minWidth = Number.isFinite(value.minWidth)
    ? Math.max(320, value.minWidth as number)
    : DEFAULT_WINDOW_DEFAULTS.minWidth;
  const minHeight = Number.isFinite(value.minHeight)
    ? Math.max(240, value.minHeight as number)
    : DEFAULT_WINDOW_DEFAULTS.minHeight;

  return { width, height, minWidth, minHeight };
}

function makeAppId(pkg: PkgSummary, entrypointName: string, totalUiEntrypoints: number): string {
  if (totalUiEntrypoints === 1) {
    return pkg.name;
  }

  return `${pkg.name}-${entrypointName}`;
}

export function packageToAppManifests(pkg: PkgSummary): AppManifest[] {
  if (!pkg.enabled || pkg.runtime !== "web-ui") {
    return [];
  }

  const uiEntrypoints = pkg.entrypoints.filter((entrypoint) => {
    return entrypoint.kind === "ui" && !!entrypoint.route;
  });

  if (uiEntrypoints.length === 0) {
    return [];
  }

  return uiEntrypoints.map((entrypoint) => {
    const appId = makeAppId(pkg, entrypoint.name, uiEntrypoints.length);

    return defineAppManifest({
      id: appId,
      name: toDisplayName(entrypoint.name),
      description: pkg.description,
      icon: coerceAppIcon(entrypoint.icon, pkg.name),
      entrypoint: {
        kind: "web",
        route: entrypoint.route!,
      },
      permissions: [],
      syscalls: Array.isArray(entrypoint.syscalls) ? entrypoint.syscalls : [],
      windowDefaults: coerceWindowDefaults(entrypoint.windowDefaults),
    });
  });
}
