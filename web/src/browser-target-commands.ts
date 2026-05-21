import type {
  CustomCommand,
} from "just-bash/browser";
import type { AppManifest } from "./apps";
import type { WindowManager, WindowSummary } from "./window-manager";

type JustBashModule = typeof import("just-bash/browser");

export function buildBrowserCommands(
  windowManager: WindowManager,
  defineBrowserCommand: JustBashModule["defineCommand"],
): CustomCommand[] {
  return [
    defineBrowserCommand("windows", async (args) => {
      const subcommand = args[0] ?? "list";
      if (subcommand !== "list") {
        return commandError("Usage: windows list");
      }
      return commandOk(formatWindows(windowManager.listWindows()));
    }),
    defineBrowserCommand("window", async (args) => {
      return handleWindowCommand(args, windowManager);
    }),
    defineBrowserCommand("apps", async (args) => {
      const subcommand = args[0] ?? "list";
      if (subcommand !== "list") {
        return commandError("Usage: apps list");
      }
      return commandOk(formatApps(windowManager.listApps()));
    }),
    defineBrowserCommand("app", async (args) => {
      const subcommand = args[0] ?? "";
      if (subcommand !== "open") {
        return commandError("Usage: app open <appId> [route]");
      }
      const appId = args[1] ?? "";
      const route = args[2];
      if (!appId) {
        return commandError("Usage: app open <appId> [route]");
      }
      const windowId = windowManager.openAppById(appId, route);
      if (!windowId) {
        return commandError(`Unknown app: ${appId}`);
      }
      return commandOk(`opened ${appId} as ${windowId}\n`);
    }),
  ];
}

export function toAppSummary(app: AppManifest): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    entrypoint: app.entrypoint,
    permissions: app.permissions,
    syscalls: app.syscalls,
    windowDefaults: app.windowDefaults,
  };
}

function handleWindowCommand(args: string[], windowManager: WindowManager): { stdout: string; stderr: string; exitCode: number } {
  const subcommand = args[0] ?? "";
  const windowId = args[1] ?? "";
  if (!subcommand || !windowId) {
    return commandError("Usage: window <focus|restore|minimize|maximize|close> <windowId>");
  }

  const exists = windowManager.listWindows().some((window) => window.windowId === windowId);
  if (!exists) {
    return commandError(`Unknown window: ${windowId}`);
  }

  switch (subcommand) {
    case "focus":
      windowManager.restoreWindow(windowId);
      windowManager.focusWindow(windowId);
      return commandOk(`focused ${windowId}\n`);
    case "restore":
      windowManager.restoreWindow(windowId);
      return commandOk(`restored ${windowId}\n`);
    case "minimize":
      windowManager.minimizeWindow(windowId);
      return commandOk(`minimized ${windowId}\n`);
    case "maximize":
      windowManager.maximizeWindow(windowId);
      return commandOk(`maximized ${windowId}\n`);
    case "close":
      windowManager.closeWindow(windowId);
      return commandOk(`closed ${windowId}\n`);
    default:
      return commandError(`Unknown window command: ${subcommand}`);
  }
}

function formatWindows(windows: WindowSummary[]): string {
  if (windows.length === 0) {
    return "no windows\n";
  }
  return [
    "WINDOW\tAPP\tMODE\tACTIVE\tTITLE\tROUTE",
    ...windows.map((window) => [
      window.windowId,
      window.appId,
      window.mode,
      window.active ? "yes" : "no",
      window.title,
      window.route,
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatApps(apps: AppManifest[]): string {
  if (apps.length === 0) {
    return "no apps\n";
  }
  return [
    "APP\tNAME\tROUTE",
    ...apps.map((app) => [
      app.id,
      app.name,
      app.entrypoint.route,
    ].join("\t")),
  ].join("\n") + "\n";
}

function commandOk(stdout: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr: "", exitCode: 0 };
}

function commandError(message: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}
