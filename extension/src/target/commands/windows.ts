import {
  focusWindow,
  listWindows,
  type WindowSummary,
} from "../../shared/chrome";
import type { BrowserCommand, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";
import { hasHelpFlag, requiredInteger } from "./args";

const WINDOWS_USAGE = [
  "Usage: windows <list|focus> [args]",
  "       windows list",
  "       windows focus <windowId>",
].join("\n");

const WINDOWS_LIST_USAGE = "Usage: windows list";
const WINDOWS_FOCUS_USAGE = "Usage: windows focus <windowId>";

export const windowCommands: BrowserCommand[] = [
  {
    name: "windows",
    summary: "List and focus browser windows.",
    run(args) {
      return runWindowsCommand(args);
    },
  },
];

export default windowCommands;

async function runWindowsCommand(args: string[]): Promise<CommandResult> {
  const subcommand = args[0] ?? "list";
  if (hasHelpFlag(args)) {
    return commandOk(`${windowsUsageFor(subcommand)}\n`);
  }

  try {
    switch (subcommand) {
      case "list":
        return await runList(args);
      case "focus":
        return await runFocus(args);
      default:
        return commandError(`Unknown windows command: ${subcommand}\n${WINDOWS_USAGE}`);
    }
  } catch (error) {
    return commandError(`windows ${subcommand}: ${errorMessage(error)}`);
  }
}

async function runList(args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    return commandError(WINDOWS_LIST_USAGE);
  }

  const windows = await listWindows();
  return commandJson({ windows, count: windows.length });
}

async function runFocus(args: string[]): Promise<CommandResult> {
  const parsed = parseWindowId(args, WINDOWS_FOCUS_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (args.length !== 2) {
    return commandError(WINDOWS_FOCUS_USAGE);
  }

  const window = await focusWindow(parsed.windowId);
  return commandOk(`focused window ${window.id}\n${compactWindowJson(window)}\n`);
}

function parseWindowId(args: string[], usage: string): { ok: true; windowId: number } | { ok: false; error: string } {
  try {
    return { ok: true, windowId: requiredInteger(args[1], "windowId") };
  } catch (error) {
    return { ok: false, error: `${usage}\n${errorMessage(error)}` };
  }
}

function windowsUsageFor(subcommand: string): string {
  switch (subcommand) {
    case "list":
      return WINDOWS_LIST_USAGE;
    case "focus":
      return WINDOWS_FOCUS_USAGE;
    default:
      return WINDOWS_USAGE;
  }
}

function compactWindowJson(window: WindowSummary): string {
  return JSON.stringify({ window });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
