import type { BrowserCommand } from "../types";
import { bookmarksCommand } from "./bookmarks";
import { clipboardCommand } from "./clipboard";
import { cookiesCommand } from "./cookies";
import { downloadsCommand } from "./downloads";
import { historyCommand } from "./history";
import { mediaCommand } from "./media";
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
    mediaCommand,
  ];
}

export { commandMap, helpText, commandCatalog } from "@humansandmachines/gsv-browser/catalog";
