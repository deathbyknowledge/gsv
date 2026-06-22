import type { PkgEntrypointSummary, PkgSummary } from "@humansandmachines/gsv/protocol";
import { defineDesktopApp } from "../desktop/domain/desktopApp";
import type { DesktopApp, DesktopAppIcon, DesktopAppWindowDefaults } from "../desktop/domain/desktopApp";

const DEFAULT_WINDOW_DEFAULTS: DesktopAppWindowDefaults = {
  width: 1040,
  height: 720,
  minWidth: 760,
  minHeight: 520,
};

const NATIVE_WEB_PACKAGE_NAMES = new Set([
  "@gsv/chat",
  "@gsv/files",
  "@gsv/gsv",
  "@gsv/shell",
  "@gsv/wiki",
]);

type UiEntrypointSummary = PkgEntrypointSummary & {
  kind: "ui";
  route: string;
};

function toDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "App";
  }
  return trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
}

function fallbackIconLabel(name: string): string {
  const letters = toDisplayName(name).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return letters || "AP";
}

function coerceDesktopAppIcon(
  value: PkgEntrypointSummary["icon"] | undefined,
  fallbackName: string,
): DesktopAppIcon {
  if (value?.kind === "svg" && value.svg.trim().length > 0) {
    return {
      kind: "svg",
      svg: value.svg,
    };
  }

  return {
    kind: "fallback",
    label: fallbackIconLabel(value?.kind === "builtin" ? value.id : fallbackName),
  };
}

function coerceWindowDefaults(value: {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
} | undefined): DesktopAppWindowDefaults {
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

function isLaunchableUiEntrypoint(entrypoint: PkgEntrypointSummary): entrypoint is UiEntrypointSummary {
  return entrypoint.kind === "ui" && typeof entrypoint.route === "string" && entrypoint.route.trim().length > 0;
}

function isNativeWebPackage(pkg: PkgSummary): boolean {
  return NATIVE_WEB_PACKAGE_NAMES.has(pkg.name);
}

export function packageToDesktopApps(pkg: PkgSummary): DesktopApp[] {
  if (!pkg.enabled || pkg.runtime !== "web-ui" || isNativeWebPackage(pkg)) {
    return [];
  }

  const uiEntrypoints = pkg.entrypoints.filter(isLaunchableUiEntrypoint);
  if (uiEntrypoints.length === 0) {
    return [];
  }

  return uiEntrypoints.map((entrypoint) => {
    const appId = makeAppId(pkg, entrypoint.name, uiEntrypoints.length);

    return defineDesktopApp({
      id: appId,
      name: toDisplayName(entrypoint.name),
      description: pkg.description,
      icon: coerceDesktopAppIcon(entrypoint.icon, pkg.name),
      routeBase: entrypoint.route,
      launch: {
        kind: "package",
        packageName: pkg.name,
        entrypointName: entrypoint.name,
      },
      syscalls: Array.isArray(entrypoint.syscalls) ? entrypoint.syscalls : [],
      windowDefaults: coerceWindowDefaults(entrypoint.windowDefaults),
    });
  });
}
