import type {
  CustomCommand,
} from "just-bash/browser";
import type { AppManifest } from "./apps";
import type { WindowManager, WindowSummary } from "./window-manager";

type JustBashModule = typeof import("just-bash/browser");
type CommandResult = { stdout: string; stderr: string; exitCode: number };
export type BrowserCopyCommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;
export type BrowserOpenCommandRunner = (args: string[], cwd: string, stdin: string) => Promise<CommandResult>;
export type BrowserNotifyCommandRunner = (args: BrowserNotifyArgs) => Promise<CommandResult>;

export type BrowserNotifyArgs = {
  title: string;
  body?: string;
  level?: "info" | "success" | "warning" | "error";
  ttlMs?: number;
};

const WINDOWS_USAGE = "Usage: windows list";
const WINDOW_USAGE = "Usage: window <focus|restore|minimize|maximize|close> <windowId>";
const APPS_USAGE = "Usage: apps list";
const APP_USAGE = "Usage: app open <appId> [route]";
const DOM_USAGE = "Usage: dom <snapshot|query|click|focus|input> [--window <windowId>] ...";
const DOM_SNAPSHOT_USAGE = "Usage: dom snapshot [--window <windowId>] [selector]";
const DOM_QUERY_USAGE = "Usage: dom query [--window <windowId>] <selector>";
const DOM_CLICK_USAGE = "Usage: dom click [--window <windowId>] <selector> [index]\n       dom click [--window <windowId>] --xy <x> <y>";
const DOM_FOCUS_USAGE = "Usage: dom focus [--window <windowId>] <selector> [index]";
const DOM_INPUT_USAGE = "Usage: dom input [--window <windowId>] <selector> <text>\n       dom input [--window <windowId>] --selector <selector> --text <text> [--index N]";
const CLIPBOARD_USAGE = "Usage: clipboard <read|write> [text]\n       echo text | clipboard write";
const NOTIFY_USAGE = "Usage: notify [--level info|success|warning|error] [--ttl MS] [--body TEXT] <title> [body]";
const JS_USAGE = "Usage: js run [--window <windowId>] <source>";

export function buildBrowserCommands(
  windowManager: WindowManager,
  defineBrowserCommand: JustBashModule["defineCommand"],
  copyCommand?: BrowserCopyCommandRunner,
  openCommand?: BrowserOpenCommandRunner,
  notifyCommand?: BrowserNotifyCommandRunner,
): CustomCommand[] {
  const commands: CustomCommand[] = [
    defineBrowserCommand("windows", async (args) => {
      if (hasHelpFlag(args)) {
        return commandHelp(WINDOWS_USAGE);
      }
      const subcommand = args[0] ?? "list";
      if (subcommand !== "list") {
        return commandError(WINDOWS_USAGE);
      }
      return commandOk(formatWindows(windowManager.listWindows()));
    }),
    defineBrowserCommand("window", async (args) => {
      return handleWindowCommand(args, windowManager);
    }),
    defineBrowserCommand("apps", async (args) => {
      if (hasHelpFlag(args)) {
        return commandHelp(APPS_USAGE);
      }
      const subcommand = args[0] ?? "list";
      if (subcommand !== "list") {
        return commandError(APPS_USAGE);
      }
      return commandOk(formatApps(windowManager.listApps()));
    }),
    defineBrowserCommand("app", async (args) => {
      if (hasHelpFlag(args)) {
        return commandHelp(APP_USAGE);
      }
      const subcommand = args[0] ?? "";
      if (subcommand !== "open") {
        return commandError(APP_USAGE);
      }
      const appId = args[1] ?? "";
      const route = args[2];
      if (!appId) {
        return commandError(APP_USAGE);
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
    defineBrowserCommand("clipboard", async (args, ctx) => {
      return handleClipboardCommand(args, ctx.stdin);
    }),
  ];

  if (notifyCommand) {
    commands.push(defineBrowserCommand("notify", async (args) => {
      return handleNotifyCommand(args, notifyCommand);
    }));
  }

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
  if (hasHelpFlag(args)) {
    return commandHelp(WINDOW_USAGE);
  }

  const subcommand = args[0] ?? "";
  const windowId = args[1] ?? "";
  if (!subcommand || !windowId) {
    return commandError(WINDOW_USAGE);
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
      return commandError(`Unknown window command: ${subcommand}\n${WINDOW_USAGE}`);
  }
}

function handleDomCommand(args: string[], windowManager: WindowManager): CommandResult {
  const subcommand = args[0] ?? "";
  if (shouldShowDomHelp(args)) {
    return commandHelp(domUsageForSubcommand(subcommand));
  }

  if (!subcommand) {
    return commandError(DOM_USAGE);
  }

  try {
    switch (subcommand) {
      case "snapshot": {
        const resolved = resolveWindowArgs(args.slice(1), windowManager, DOM_SNAPSHOT_USAGE);
        if (!resolved.ok) {
          return commandError(resolved.error);
        }
        const selector = resolved.args.join(" ").trim();
        const snapshot = windowManager.snapshotWindowDom(resolved.windowId, selector || null);
        if (!snapshot) {
          return commandError(`No DOM snapshot available for ${resolved.windowId}`);
        }
        return jsonOk(snapshot);
      }
      case "query": {
        const resolved = resolveWindowArgs(args.slice(1), windowManager, DOM_QUERY_USAGE);
        if (!resolved.ok) {
          return commandError(resolved.error);
        }
        const selector = resolved.args.join(" ").trim();
        if (!selector) {
          return commandError(DOM_QUERY_USAGE);
        }
        const matches = windowManager.queryWindowDom(resolved.windowId, selector);
        if (!matches) {
          return commandError(`No DOM available for ${resolved.windowId}`);
        }
        return jsonOk({ matches, count: matches.length });
      }
      case "click": {
        const resolved = resolveWindowArgs(args.slice(1), windowManager, DOM_CLICK_USAGE);
        if (!resolved.ok) {
          return commandError(resolved.error);
        }
        const point = parsePointArgs(resolved.args);
        if (!point.ok && point.error) {
          return commandError(point.error);
        }
        if (point.ok) {
          const match = windowManager.clickWindowPoint(resolved.windowId, point.x, point.y);
          if (!match) {
            return commandError(`No element at ${point.x},${point.y} in ${resolved.windowId}`);
          }
          return jsonOk({ clicked: match, point: { x: point.x, y: point.y } });
        }

        const parsed = parseSelectorArgs(resolved.args, DOM_CLICK_USAGE);
        if (!parsed.ok) {
          return commandError(parsed.error);
        }
        const match = windowManager.clickWindowDom(resolved.windowId, parsed.selector, parsed.index);
        if (!match) {
          return commandError(`No matching element in ${resolved.windowId}`);
        }
        return jsonOk({ clicked: match });
      }
      case "focus": {
        const resolved = resolveWindowArgs(args.slice(1), windowManager, DOM_FOCUS_USAGE);
        if (!resolved.ok) {
          return commandError(resolved.error);
        }
        const parsed = parseSelectorArgs(resolved.args, DOM_FOCUS_USAGE);
        if (!parsed.ok) {
          return commandError(parsed.error);
        }
        const match = windowManager.focusWindowDom(resolved.windowId, parsed.selector, parsed.index);
        if (!match) {
          return commandError(`No matching element in ${resolved.windowId}`);
        }
        return jsonOk({ focused: match });
      }
      case "input": {
        const resolved = resolveWindowArgs(args.slice(1), windowManager, DOM_INPUT_USAGE);
        if (!resolved.ok) {
          return commandError(resolved.error);
        }
        const parsed = parseInputArgs(resolved.args);
        if (!parsed.ok) {
          return commandError(parsed.error);
        }
        const match = windowManager.inputWindowDom(resolved.windowId, parsed.selector, parsed.value, parsed.index);
        if (!match) {
          return commandError(`No matching editable element in ${resolved.windowId}`);
        }
        return jsonOk({ input: match });
      }
      default:
        return commandError(`Unknown dom command: ${subcommand}\n${DOM_USAGE}`);
    }
  } catch (error) {
    return commandError(error instanceof Error ? error.message : String(error));
  }
}

async function handleClipboardCommand(args: string[], stdin: string): Promise<CommandResult> {
  if (shouldShowSubcommandHelp(args)) {
    return commandHelp(CLIPBOARD_USAGE);
  }

  const subcommand = args[0] ?? "";
  switch (subcommand) {
    case "read": {
      if (!navigator.clipboard?.readText) {
        return commandError("Clipboard read is unavailable");
      }
      try {
        return commandOk(`${await navigator.clipboard.readText()}\n`);
      } catch (error) {
        return commandError(`clipboard read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    case "write": {
      const text = args.length > 1 ? args.slice(1).join(" ") : stdin;
      if (args.length <= 1 && !stdin) {
        return commandError(CLIPBOARD_USAGE);
      }
      try {
        await writeClipboardText(text);
        return commandOk(`copied ${new TextEncoder().encode(text).byteLength} bytes\n`);
      } catch (error) {
        return commandError(`clipboard write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    default:
      return commandError(CLIPBOARD_USAGE);
  }
}

async function handleNotifyCommand(args: string[], notifyCommand: BrowserNotifyCommandRunner): Promise<CommandResult> {
  if (shouldShowTopLevelHelp(args)) {
    return commandOk([
      NOTIFY_USAGE,
      "",
      "Create a GSV desktop notification.",
      "",
    ].join("\n"));
  }

  const parsed = parseNotifyArgs(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  return notifyCommand(parsed.args);
}

async function handleJsCommand(args: string[], windowManager: WindowManager): Promise<CommandResult> {
  const subcommand = args[0] ?? "";
  if (shouldShowSubcommandHelp(args)) {
    return commandHelp(JS_USAGE);
  }

  if (subcommand !== "run") {
    return commandError(JS_USAGE);
  }

  const resolved = resolveWindowArgs(args.slice(1), windowManager, JS_USAGE);
  if (!resolved.ok) {
    return commandError(resolved.error);
  }

  const source = resolved.args.join(" ").trim();
  if (!source) {
    return commandError(JS_USAGE);
  }

  try {
    const result = await windowManager.runWindowJavaScript(resolved.windowId, source);
    if (!result) {
      return commandError(`No JavaScript context available for ${resolved.windowId}`);
    }
    return jsonOk(result);
  } catch (error) {
    return commandError(error instanceof Error ? error.message : String(error));
  }
}

function parseSelectorArgs(args: string[], usage: string): { ok: true; selector: string; index: number } | { ok: false; error: string } {
  let index: number | null = null;
  let selector: string | null = null;
  const free: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--selector") {
      selector = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--selector=")) {
      selector = arg.slice("--selector=".length);
      continue;
    }
    if (arg === "--index") {
      const parsed = parseInteger(args[i + 1] ?? "");
      if (parsed === null) {
        return { ok: false, error: `${usage}\nInvalid index: ${args[i + 1] ?? ""}` };
      }
      index = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--index=")) {
      const parsed = parseInteger(arg.slice("--index=".length));
      if (parsed === null) {
        return { ok: false, error: `${usage}\nInvalid index: ${arg}` };
      }
      index = parsed;
      continue;
    }
    free.push(arg);
  }

  if (!selector) {
    const maybeIndex = free[free.length - 1] ?? "";
    const trailingIndex = parseInteger(maybeIndex);
    if (trailingIndex !== null && free.length > 1) {
      index = trailingIndex;
      selector = free.slice(0, -1).join(" ").trim();
    } else {
      selector = free.join(" ").trim();
    }
  }

  if (!selector) {
    return { ok: false, error: usage };
  }
  return { ok: true, selector, index: index ?? 0 };
}

function resolveWindowArgs(
  args: string[],
  windowManager: WindowManager,
  usage: string,
): { ok: true; windowId: string; args: string[] } | { ok: false; error: string } {
  const windows = windowManager.listWindows();
  const windowIds = new Set(windows.map((window) => window.windowId));
  let explicitWindowId: string | null = null;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--window") {
      const value = args[i + 1] ?? "";
      if (!value) {
        return { ok: false, error: `${usage}\n--window requires a value` };
      }
      explicitWindowId = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--window=")) {
      const value = arg.slice("--window=".length);
      if (!value) {
        return { ok: false, error: `${usage}\n--window requires a value` };
      }
      explicitWindowId = value;
      continue;
    }
    remaining.push(arg);
  }

  let windowId = explicitWindowId ?? "";
  if (!windowId && remaining.length > 0 && windowIds.has(remaining[0] ?? "")) {
    windowId = remaining.shift() ?? "";
  }
  if (!windowId) {
    windowId = windows.find((window) => window.active)?.windowId ?? "";
  }
  if (!windowId) {
    return { ok: false, error: `No active window\n${usage}` };
  }
  if (!windowIds.has(windowId)) {
    return { ok: false, error: `Unknown window: ${windowId}` };
  }
  return {
    ok: true,
    windowId,
    args: remaining,
  };
}

function parsePointArgs(args: string[]): { ok: true; x: number; y: number } | { ok: false; error?: string } {
  const markerIndex = args.findIndex((arg) => arg === "--xy" || arg === "--point");
  if (markerIndex < 0) {
    return { ok: false };
  }
  const x = Number(args[markerIndex + 1]);
  const y = Number(args[markerIndex + 2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: DOM_CLICK_USAGE };
  }
  return { ok: true, x, y };
}

function parseInputArgs(args: string[]): { ok: true; selector: string; value: string; index: number } | { ok: false; error: string } {
  let selector: string | null = null;
  let value: string | null = null;
  let index: number | null = null;
  const free: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--selector") {
      selector = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--selector=")) {
      selector = arg.slice("--selector=".length);
      continue;
    }
    if (arg === "--text" || arg === "--value") {
      value = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--text=")) {
      value = arg.slice("--text=".length);
      continue;
    }
    if (arg.startsWith("--value=")) {
      value = arg.slice("--value=".length);
      continue;
    }
    if (arg === "--index") {
      const parsed = parseInteger(args[i + 1] ?? "");
      if (parsed === null) {
        return { ok: false, error: `${DOM_INPUT_USAGE}\nInvalid index: ${args[i + 1] ?? ""}` };
      }
      index = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--index=")) {
      const parsed = parseInteger(arg.slice("--index=".length));
      if (parsed === null) {
        return { ok: false, error: `${DOM_INPUT_USAGE}\nInvalid index: ${arg}` };
      }
      index = parsed;
      continue;
    }
    free.push(arg);
  }

  if (!selector && value !== null) {
    selector = free.join(" ").trim();
  } else if (!selector && value === null && free.length >= 2) {
    selector = free[0] ?? "";
    value = free.slice(1).join(" ");
  }

  if (!selector || value === null) {
    return { ok: false, error: DOM_INPUT_USAGE };
  }
  return { ok: true, selector, value, index: index ?? 0 };
}

function parseNotifyArgs(args: string[]): { ok: true; args: BrowserNotifyArgs } | { ok: false; error: string } {
  let level: BrowserNotifyArgs["level"];
  let ttlMs: number | undefined;
  let body: string | undefined;
  const free: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--level") {
      const parsed = parseNotificationLevel(args[i + 1] ?? "");
      if (!parsed) {
        return { ok: false, error: `Invalid notification level: ${args[i + 1] ?? ""}` };
      }
      level = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--level=")) {
      const parsed = parseNotificationLevel(arg.slice("--level=".length));
      if (!parsed) {
        return { ok: false, error: `Invalid notification level: ${arg}` };
      }
      level = parsed;
      continue;
    }
    if (arg === "--ttl") {
      const parsed = parseInteger(args[i + 1] ?? "");
      if (parsed === null) {
        return { ok: false, error: `Invalid ttl: ${args[i + 1] ?? ""}` };
      }
      ttlMs = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--ttl=")) {
      const parsed = parseInteger(arg.slice("--ttl=".length));
      if (parsed === null) {
        return { ok: false, error: `Invalid ttl: ${arg}` };
      }
      ttlMs = parsed;
      continue;
    }
    if (arg === "--body") {
      body = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--body=")) {
      body = arg.slice("--body=".length);
      continue;
    }
    free.push(arg);
  }

  const title = free[0] ?? "";
  if (!title) {
    return { ok: false, error: NOTIFY_USAGE };
  }
  return {
    ok: true,
    args: {
      title,
      body: body ?? (free.length > 1 ? free.slice(1).join(" ") : undefined),
      level,
      ttlMs,
    },
  };
}

function parseNotificationLevel(value: string): BrowserNotifyArgs["level"] | null {
  return value === "info" || value === "success" || value === "warning" || value === "error" ? value : null;
}

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "-h" || arg === "--help";
}

function hasHelpFlag(args: readonly string[]): boolean {
  return args.some((arg) => isHelpFlag(arg));
}

function shouldShowTopLevelHelp(args: readonly string[]): boolean {
  return args.length === 1 && isHelpFlag(args[0]);
}

function shouldShowSubcommandHelp(args: readonly string[]): boolean {
  return shouldShowTopLevelHelp(args) || (args.length === 2 && isHelpFlag(args[1]));
}

function shouldShowDomHelp(args: readonly string[]): boolean {
  return shouldShowTopLevelHelp(args) || (args.length === 2 && isHelpFlag(args[1]));
}

function domUsageForSubcommand(subcommand: string): string {
  switch (subcommand) {
    case "query":
      return DOM_QUERY_USAGE;
    case "click":
      return DOM_CLICK_USAGE;
    case "focus":
      return DOM_FOCUS_USAGE;
    case "input":
      return DOM_INPUT_USAGE;
    case "snapshot":
      return DOM_SNAPSHOT_USAGE;
    default:
      return DOM_USAGE;
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("document.execCommand('copy') returned false");
    }
  } finally {
    textarea.remove();
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

function commandHelp(message: string): CommandResult {
  return commandOk(`${message}\n`);
}

function commandError(message: string): CommandResult {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}
