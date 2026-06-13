import type { BrowserCommand } from "../types";
import { bookmarksCommand } from "./bookmarks";
import { clipboardCommand } from "./clipboard";
import { cookiesCommand } from "./cookies";
import { downloadsCommand } from "./downloads";
import { historyCommand } from "./history";
import { networkCommand } from "./network";
import { pageCommand } from "./page";
import { storageCommand } from "./storage";
import { tabCommands } from "./tabs";
import { windowCommands } from "./windows";

export function createBrowserCommands(): BrowserCommand[] {
  return [
    ...tabCommands,
    ...windowCommands,
    pageCommand,
    clipboardCommand,
    cookiesCommand,
    storageCommand,
    downloadsCommand,
    historyCommand,
    bookmarksCommand,
    networkCommand,
  ];
}

export function commandMap(commands: BrowserCommand[]): Map<string, BrowserCommand> {
  return new Map(commands.map((command) => [command.name, command]));
}

export function helpText(commands: BrowserCommand[]): string {
  const rows = commands
    .map((command) => `  ${command.name.padEnd(12)} ${command.summary}`)
    .join("\n");
  return [
    "GSV browser target shell commands",
    "",
    rows,
    "",
    "Run `<command> --help` for command-specific usage.",
    "",
  ].join("\n");
}
