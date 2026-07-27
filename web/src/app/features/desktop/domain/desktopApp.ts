export type DesktopAppIcon =
  | { kind: "svg"; svg: string }
  | { kind: "fallback"; label: string };

export type DesktopAppWindowDefaults = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

export type DesktopAppLaunch =
  | {
      kind: "package";
      packageName: string;
      entrypointName: string;
    }
  | {
      kind: "internal";
    };

export type DesktopApp = {
  id: string;
  name: string;
  description: string;
  icon: DesktopAppIcon;
  routeBase: string;
  launch: DesktopAppLaunch;
  syscalls: readonly string[];
  windowDefaults: DesktopAppWindowDefaults;
};

function assertDesktopApp(app: DesktopApp): void {
  if (!app.id.trim()) {
    throw new Error("Desktop app id is required");
  }
  if (!app.name.trim()) {
    throw new Error(`Desktop app "${app.id}" is missing name`);
  }
  if (!app.routeBase.trim()) {
    throw new Error(`Desktop app "${app.id}" is missing route base`);
  }
  if (app.icon.kind === "svg" && app.icon.svg.trim().length === 0) {
    throw new Error(`Desktop app "${app.id}" has empty svg icon`);
  }
  if (app.icon.kind === "fallback" && app.icon.label.trim().length === 0) {
    throw new Error(`Desktop app "${app.id}" has empty fallback icon label`);
  }
  if (app.launch.kind === "package") {
    if (!app.launch.packageName.trim()) {
      throw new Error(`Desktop app "${app.id}" is missing package name`);
    }
    if (!app.launch.entrypointName.trim()) {
      throw new Error(`Desktop app "${app.id}" is missing entrypoint name`);
    }
  }
}

export function defineDesktopApp(app: DesktopApp): DesktopApp {
  assertDesktopApp(app);
  return app;
}
