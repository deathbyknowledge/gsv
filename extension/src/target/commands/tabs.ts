import {
  activeTab,
  closeTab,
  createTab,
  focusTab,
  getTab,
  listTabs,
  reloadTab,
  type TabSummary,
} from "../../shared/chrome";
import type { BrowserCommand, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";
import { hasHelpFlag, requiredInteger } from "./args";

const TABS_USAGE = [
  "Usage: tabs <list|active|get|open|focus|close|reload> [args]",
  "       tabs list",
  "       tabs active",
  "       tabs get <tabId>",
  "       tabs open <url>",
  "       tabs focus <tabId>",
  "       tabs close <tabId>",
  "       tabs reload <tabId>",
].join("\n");

const TABS_LIST_USAGE = "Usage: tabs list";
const TABS_ACTIVE_USAGE = "Usage: tabs active";
const TABS_GET_USAGE = "Usage: tabs get <tabId>";
const TABS_OPEN_USAGE = "Usage: tabs open <url>";
const TABS_FOCUS_USAGE = "Usage: tabs focus <tabId>";
const TABS_CLOSE_USAGE = "Usage: tabs close <tabId>";
const TABS_RELOAD_USAGE = "Usage: tabs reload <tabId>";

export const tabCommands: BrowserCommand[] = [
  {
    name: "tabs",
    summary: "List and control browser tabs.",
    run(args) {
      return runTabsCommand(args);
    },
  },
];

export default tabCommands;

async function runTabsCommand(args: string[]): Promise<CommandResult> {
  const subcommand = args[0] ?? "list";
  if (hasHelpFlag(args)) {
    return commandOk(`${tabsUsageFor(subcommand)}\n`);
  }

  try {
    switch (subcommand) {
      case "list":
        return await runList(args);
      case "active":
        return await runActive(args);
      case "get":
        return await runGet(args);
      case "open":
        return await runOpen(args);
      case "focus":
        return await runFocus(args);
      case "close":
        return await runClose(args);
      case "reload":
        return await runReload(args);
      default:
        return commandError(`Unknown tabs command: ${subcommand}\n${TABS_USAGE}`);
    }
  } catch (error) {
    return commandError(`tabs ${subcommand}: ${errorMessage(error)}`);
  }
}

async function runList(args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    return commandError(TABS_LIST_USAGE);
  }

  const tabs = await listTabs();
  return commandJson({ tabs, count: tabs.length });
}

async function runActive(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(TABS_ACTIVE_USAGE);
  }

  return commandJson({ tab: await activeTab() });
}

async function runGet(args: string[]): Promise<CommandResult> {
  const parsed = parseTabId(args, TABS_GET_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (args.length !== 2) {
    return commandError(TABS_GET_USAGE);
  }

  const tab = await getTab(parsed.tabId);
  if (!tab) {
    return commandError(`tab not found: ${parsed.tabId}`);
  }
  return commandJson({ tab });
}

async function runOpen(args: string[]): Promise<CommandResult> {
  const url = args.slice(1).join(" ").trim();
  if (!url) {
    return commandError(TABS_OPEN_USAGE);
  }

  const tab = await createTab(url, true);
  return commandOk(`opened tab ${tab.id}\n${compactTabJson(tab)}\n`);
}

async function runFocus(args: string[]): Promise<CommandResult> {
  const parsed = parseTabId(args, TABS_FOCUS_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (args.length !== 2) {
    return commandError(TABS_FOCUS_USAGE);
  }

  const tab = await focusTab(parsed.tabId);
  return commandOk(`focused tab ${tab.id}\n${compactTabJson(tab)}\n`);
}

async function runClose(args: string[]): Promise<CommandResult> {
  const parsed = parseTabId(args, TABS_CLOSE_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (args.length !== 2) {
    return commandError(TABS_CLOSE_USAGE);
  }

  await closeTab(parsed.tabId);
  return commandOk(`closed tab ${parsed.tabId}\n`);
}

async function runReload(args: string[]): Promise<CommandResult> {
  const parsed = parseTabId(args, TABS_RELOAD_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (args.length !== 2) {
    return commandError(TABS_RELOAD_USAGE);
  }

  await reloadTab(parsed.tabId);
  return commandOk(`reloaded tab ${parsed.tabId}\n`);
}

function parseTabId(args: string[], usage: string): { ok: true; tabId: number } | { ok: false; error: string } {
  try {
    return { ok: true, tabId: requiredInteger(args[1], "tabId") };
  } catch (error) {
    return { ok: false, error: `${usage}\n${errorMessage(error)}` };
  }
}

function tabsUsageFor(subcommand: string): string {
  switch (subcommand) {
    case "list":
      return TABS_LIST_USAGE;
    case "active":
      return TABS_ACTIVE_USAGE;
    case "get":
      return TABS_GET_USAGE;
    case "open":
      return TABS_OPEN_USAGE;
    case "focus":
      return TABS_FOCUS_USAGE;
    case "close":
      return TABS_CLOSE_USAGE;
    case "reload":
      return TABS_RELOAD_USAGE;
    default:
      return TABS_USAGE;
  }
}

function compactTabJson(tab: TabSummary): string {
  return JSON.stringify({ tab });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
