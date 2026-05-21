import type {
  CustomCommand,
} from "just-bash/browser";
import type { AppManifest } from "./apps";
import type { WindowManager, WindowSummary } from "./window-manager";

type JustBashModule = typeof import("just-bash/browser");
type CommandResult = { stdout: string; stderr: string; exitCode: number };
export type BrowserCopyCommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;
export type BrowserOpenCommandRunner = (args: string[], cwd: string, stdin: string) => Promise<CommandResult>;

export function buildBrowserCommands(
  windowManager: WindowManager,
  defineBrowserCommand: JustBashModule["defineCommand"],
  copyCommand?: BrowserCopyCommandRunner,
  openCommand?: BrowserOpenCommandRunner,
): CustomCommand[] {
  const commands: CustomCommand[] = [
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
    defineBrowserCommand("dom", async (args) => {
      return handleDomCommand(args, windowManager);
    }),
    defineBrowserCommand("js", async (args) => {
      return handleJsCommand(args, windowManager);
    }),
  ];

  if (openCommand) {
    commands.push(defineBrowserCommand("open", async (args, ctx) => {
      return openCommand(args, ctx.cwd, ctx.stdin);
    }));
  }

  if (copyCommand) {
    commands.push(defineBrowserCommand("cp", async (args, ctx) => {
      return copyCommand(args, ctx.cwd);
    }));
  }

  return commands;
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

function handleWindowCommand(args: string[], windowManager: WindowManager): CommandResult {
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

function handleDomCommand(args: string[], windowManager: WindowManager): CommandResult {
  const subcommand = args[0] ?? "";
  const windowId = args[1] ?? "";
  if (!subcommand || !windowId) {
    return commandError("Usage: dom <snapshot|query|click> <windowId> [selector] [index]");
  }

  try {
    switch (subcommand) {
      case "snapshot": {
        const selector = args.slice(2).join(" ").trim();
        const snapshot = windowManager.snapshotWindowDom(windowId, selector || null);
        if (!snapshot) {
          return commandError(`No DOM snapshot available for ${windowId}`);
        }
        return jsonOk(snapshot);
      }
      case "query": {
        const selector = args.slice(2).join(" ").trim();
        if (!selector) {
          return commandError("Usage: dom query <windowId> <selector>");
        }
        const matches = windowManager.queryWindowDom(windowId, selector);
        if (!matches) {
          return commandError(`No DOM available for ${windowId}`);
        }
        return jsonOk({ matches, count: matches.length });
      }
      case "click": {
        const selectorArgs = args.slice(2);
        if (selectorArgs.length === 0) {
          return commandError("Usage: dom click <windowId> <selector> [index]");
        }
        const maybeIndex = selectorArgs[selectorArgs.length - 1];
        const parsedIndex = /^\d+$/.test(maybeIndex ?? "") ? Number.parseInt(maybeIndex ?? "", 10) : null;
        const selector = (parsedIndex === null ? selectorArgs : selectorArgs.slice(0, -1)).join(" ").trim();
        if (!selector) {
          return commandError("Usage: dom click <windowId> <selector> [index]");
        }
        const match = windowManager.clickWindowDom(windowId, selector, parsedIndex ?? 0);
        if (!match) {
          return commandError(`No matching element in ${windowId}`);
        }
        return jsonOk({ clicked: match });
      }
      default:
        return commandError(`Unknown dom command: ${subcommand}`);
    }
  } catch (error) {
    return commandError(error instanceof Error ? error.message : String(error));
  }
}

async function handleJsCommand(args: string[], windowManager: WindowManager): Promise<CommandResult> {
  const subcommand = args[0] ?? "";
  if (subcommand !== "run") {
    return commandError("Usage: js run [--window <windowId>] <windowId> <source>");
  }

  let cursor = 1;
  let windowId = "";
  const first = args[cursor] ?? "";
  if (first === "--window") {
    windowId = args[cursor + 1] ?? "";
    cursor += 2;
  } else if (first.startsWith("--window=")) {
    windowId = first.slice("--window=".length);
    cursor += 1;
  } else {
    windowId = first;
    cursor += 1;
  }

  const source = args.slice(cursor).join(" ").trim();
  if (!windowId || !source) {
    return commandError("Usage: js run [--window <windowId>] <windowId> <source>");
  }

  try {
    const result = await windowManager.runWindowJavaScript(windowId, source);
    if (!result) {
      return commandError(`No JavaScript context available for ${windowId}`);
    }
    return jsonOk(result);
  } catch (error) {
    return commandError(error instanceof Error ? error.message : String(error));
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

function jsonOk(value: unknown): CommandResult {
  return commandOk(`${JSON.stringify(value, null, 2)}\n`);
}

function commandOk(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function commandError(message: string): CommandResult {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}
