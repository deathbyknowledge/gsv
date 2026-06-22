import { hasHelpFlag, parseInteger } from "./args";
import type { BrowserCommand, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const BOOKMARKS_USAGE = [
  "Usage: bookmarks <tree|children|recent|search|get|create|folder|update|move|delete|delete-tree> [args]",
  "       bookmarks tree [bookmarkId]",
  "       bookmarks children <folderId>",
  "       bookmarks recent [limit]",
  "       bookmarks search <query>",
  "       bookmarks get <bookmarkId>",
  "       bookmarks create <parentId> <url> <title...>",
  "       bookmarks folder <parentId> <title...>",
  "       bookmarks update <bookmarkId> [--title title] [--url url]",
  "       bookmarks move <bookmarkId> [--parent parentId] [--index index]",
  "       bookmarks delete <bookmarkId>",
  "       bookmarks delete-tree <folderId>",
].join("\n");

const BOOKMARKS_TREE_USAGE = "Usage: bookmarks tree [bookmarkId]";
const BOOKMARKS_CHILDREN_USAGE = "Usage: bookmarks children <folderId>";
const BOOKMARKS_RECENT_USAGE = "Usage: bookmarks recent [limit]";
const BOOKMARKS_SEARCH_USAGE = "Usage: bookmarks search <query>";
const BOOKMARKS_GET_USAGE = "Usage: bookmarks get <bookmarkId>";
const BOOKMARKS_CREATE_USAGE = "Usage: bookmarks create <parentId> <url> <title...>";
const BOOKMARKS_FOLDER_USAGE = "Usage: bookmarks folder <parentId> <title...>";
const BOOKMARKS_UPDATE_USAGE = "Usage: bookmarks update <bookmarkId> [--title title] [--url url]";
const BOOKMARKS_MOVE_USAGE = "Usage: bookmarks move <bookmarkId> [--parent parentId] [--index index]";
const BOOKMARKS_DELETE_USAGE = "Usage: bookmarks delete <bookmarkId>";
const BOOKMARKS_DELETE_TREE_USAGE = "Usage: bookmarks delete-tree <folderId>";

export const bookmarksCommand: BrowserCommand = {
  name: "bookmarks",
  summary: "Read and modify browser bookmarks.",
  async run(args: string[]): Promise<CommandResult> {
    return await runBookmarksCommand(args);
  },
};

export default bookmarksCommand;

async function runBookmarksCommand(args: string[]): Promise<CommandResult> {
  const subcommand = args[0] ?? "tree";
  if (hasHelpFlag(args)) {
    return commandOk(`${bookmarksUsageFor(subcommand)}\n`);
  }

  try {
    switch (subcommand) {
      case "tree":
        return await bookmarkTree(args.slice(1));
      case "children":
      case "list":
        return await bookmarkChildren(args.slice(1));
      case "recent":
        return await recentBookmarks(args.slice(1));
      case "search":
        return await searchBookmarks(args.slice(1));
      case "get":
        return await getBookmark(args.slice(1));
      case "create":
        return await createBookmark(args.slice(1));
      case "folder":
        return await createBookmarkFolder(args.slice(1));
      case "update":
        return await updateBookmark(args.slice(1));
      case "move":
        return await moveBookmark(args.slice(1));
      case "delete":
      case "rm":
        return await deleteBookmark(args.slice(1));
      case "delete-tree":
      case "rm-tree":
        return await deleteBookmarkTree(args.slice(1));
      default:
        return commandError(`Unknown bookmarks command: ${subcommand}\n${BOOKMARKS_USAGE}`);
    }
  } catch (error) {
    return commandError(`bookmarks ${subcommand}: ${errorMessage(error)}`);
  }
}

async function bookmarkTree(args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    return commandError(BOOKMARKS_TREE_USAGE);
  }

  const tree = args[0]
    ? await requireBookmarksApi().getSubTree(args[0])
    : await requireBookmarksApi().getTree();
  return commandJson(tree.map((node) => formatBookmarkNode(node)));
}

async function bookmarkChildren(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(BOOKMARKS_CHILDREN_USAGE);
  }

  const children = await requireBookmarksApi().getChildren(args[0]);
  return commandJson({
    parentId: args[0],
    children: children.map((node) => formatBookmarkNode(node)),
    count: children.length,
  });
}

async function recentBookmarks(args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    return commandError(BOOKMARKS_RECENT_USAGE);
  }

  const limit = args[0] === undefined ? 20 : parseInteger(args[0]);
  if (limit === null || limit < 1) {
    return commandError(`${BOOKMARKS_RECENT_USAGE}\nlimit must be a positive integer`);
  }

  const bookmarks = await requireBookmarksApi().getRecent(limit);
  return commandJson({
    bookmarks: bookmarks.map((node) => formatBookmarkNode(node)),
    count: bookmarks.length,
  });
}

async function searchBookmarks(args: string[]): Promise<CommandResult> {
  const query = args.join(" ").trim();
  if (!query) {
    return commandError(BOOKMARKS_SEARCH_USAGE);
  }

  const results = await requireBookmarksApi().search(query);
  return commandJson({
    bookmarks: results.map((node) => formatBookmarkNode(node)),
    count: results.length,
  });
}

async function getBookmark(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(BOOKMARKS_GET_USAGE);
  }

  const bookmarks = await requireBookmarksApi().get(args[0]);
  if (bookmarks.length === 0) {
    return commandError(`bookmark not found: ${args[0]}`);
  }
  return commandJson(formatBookmarkNode(bookmarks[0]));
}

async function createBookmark(args: string[]): Promise<CommandResult> {
  if (args.length < 3) {
    return commandError(BOOKMARKS_CREATE_USAGE);
  }

  const url = validateUrl(args[1]);
  if (!url.ok) {
    return commandError(`${BOOKMARKS_CREATE_USAGE}\n${url.error}`);
  }

  const bookmark = await requireBookmarksApi().create({
    parentId: args[0],
    url: url.value,
    title: args.slice(2).join(" "),
  });
  return commandJson(formatBookmarkNode(bookmark));
}

async function createBookmarkFolder(args: string[]): Promise<CommandResult> {
  if (args.length < 2) {
    return commandError(BOOKMARKS_FOLDER_USAGE);
  }

  const folder = await requireBookmarksApi().create({
    parentId: args[0],
    title: args.slice(1).join(" "),
  });
  return commandJson(formatBookmarkNode(folder));
}

async function updateBookmark(args: string[]): Promise<CommandResult> {
  const parsed = parseUpdateArgs(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const updated = await requireBookmarksApi().update(parsed.value.id, parsed.value.changes);
  return commandJson(formatBookmarkNode(updated));
}

async function moveBookmark(args: string[]): Promise<CommandResult> {
  const parsed = parseMoveArgs(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const moved = await requireBookmarksApi().move(parsed.value.id, parsed.value.destination);
  return commandJson(formatBookmarkNode(moved));
}

async function deleteBookmark(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(BOOKMARKS_DELETE_USAGE);
  }

  await requireBookmarksApi().remove(args[0]);
  return commandOk(`deleted bookmark ${args[0]}\n`);
}

async function deleteBookmarkTree(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(BOOKMARKS_DELETE_TREE_USAGE);
  }

  await requireBookmarksApi().removeTree(args[0]);
  return commandOk(`deleted bookmark tree ${args[0]}\n`);
}

function parseUpdateArgs(args: string[]): ParseResult<{ id: string; changes: chrome.bookmarks.UpdateChanges }> {
  if (args.length < 2) {
    return { ok: false, error: BOOKMARKS_UPDATE_USAGE };
  }

  const id = args[0] ?? "";
  const changes: chrome.bookmarks.UpdateChanges = {};
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--title") {
      changes.title = requiredOptionValue(args[i + 1], arg, BOOKMARKS_UPDATE_USAGE);
      i += 1;
      continue;
    }
    if (arg.startsWith("--title=")) {
      changes.title = arg.slice("--title=".length);
      continue;
    }
    if (arg === "--url") {
      const url = validateUrl(requiredOptionValue(args[i + 1], arg, BOOKMARKS_UPDATE_USAGE));
      if (!url.ok) return url;
      changes.url = url.value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      const url = validateUrl(arg.slice("--url=".length));
      if (!url.ok) return url;
      changes.url = url.value;
      continue;
    }
    return { ok: false, error: `${BOOKMARKS_UPDATE_USAGE}\nUnknown option: ${arg}` };
  }

  if (!changes.title && !changes.url) {
    return { ok: false, error: `${BOOKMARKS_UPDATE_USAGE}\nAt least one of --title or --url is required` };
  }
  return { ok: true, value: { id, changes } };
}

function parseMoveArgs(args: string[]): ParseResult<{ id: string; destination: chrome.bookmarks.MoveDestination }> {
  if (args.length < 2) {
    return { ok: false, error: BOOKMARKS_MOVE_USAGE };
  }

  const id = args[0] ?? "";
  const destination: chrome.bookmarks.MoveDestination = {};
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--parent") {
      destination.parentId = requiredOptionValue(args[i + 1], arg, BOOKMARKS_MOVE_USAGE);
      i += 1;
      continue;
    }
    if (arg.startsWith("--parent=")) {
      destination.parentId = arg.slice("--parent=".length);
      continue;
    }
    if (arg === "--index") {
      const index = parseIndex(args[i + 1]);
      if (!index.ok) return index;
      destination.index = index.value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--index=")) {
      const index = parseIndex(arg.slice("--index=".length));
      if (!index.ok) return index;
      destination.index = index.value;
      continue;
    }
    return { ok: false, error: `${BOOKMARKS_MOVE_USAGE}\nUnknown option: ${arg}` };
  }

  if (!destination.parentId && destination.index === undefined) {
    return { ok: false, error: `${BOOKMARKS_MOVE_USAGE}\nAt least one of --parent or --index is required` };
  }
  return { ok: true, value: { id, destination } };
}

function parseIndex(value: string | undefined): ParseResult<number> {
  const parsed = parseInteger(value);
  if (parsed === null) {
    return { ok: false, error: `${BOOKMARKS_MOVE_USAGE}\nindex must be a non-negative integer` };
  }
  return { ok: true, value: parsed };
}

function validateUrl(value: string | undefined): ParseResult<string> {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return { ok: false, error: "url is required" };
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `url must use http or https: ${raw}` };
    }
    return { ok: true, value: parsed.href };
  } catch {
    return { ok: false, error: `invalid url: ${raw}` };
  }
}

function requiredOptionValue(value: string | undefined, option: string, usage: string): string {
  if (!value) {
    throw new Error(`${usage}\n${option} requires a value`);
  }
  return value;
}

function requireBookmarksApi(): typeof chrome.bookmarks {
  if (typeof chrome === "undefined" || !chrome.bookmarks) {
    throw new Error("chrome.bookmarks is unavailable; check the bookmarks permission.");
  }
  return chrome.bookmarks;
}

function formatBookmarkNode(node: chrome.bookmarks.BookmarkTreeNode): Record<string, unknown> {
  return omitUndefined({
    id: node.id,
    parentId: node.parentId,
    index: node.index,
    title: node.title,
    url: node.url,
    dateAdded: node.dateAdded,
    dateAddedIso: node.dateAdded === undefined ? undefined : isoTime(node.dateAdded),
    dateGroupModified: node.dateGroupModified,
    dateGroupModifiedIso: node.dateGroupModified === undefined ? undefined : isoTime(node.dateGroupModified),
    dateLastUsed: node.dateLastUsed,
    dateLastUsedIso: node.dateLastUsed === undefined ? undefined : isoTime(node.dateLastUsed),
    folderType: node.folderType,
    syncing: node.syncing,
    unmodifiable: node.unmodifiable,
    children: node.children?.map((child) => formatBookmarkNode(child)),
  });
}

function bookmarksUsageFor(subcommand: string): string {
  switch (subcommand) {
    case "tree":
      return BOOKMARKS_TREE_USAGE;
    case "children":
    case "list":
      return BOOKMARKS_CHILDREN_USAGE;
    case "recent":
      return BOOKMARKS_RECENT_USAGE;
    case "search":
      return BOOKMARKS_SEARCH_USAGE;
    case "get":
      return BOOKMARKS_GET_USAGE;
    case "create":
      return BOOKMARKS_CREATE_USAGE;
    case "folder":
      return BOOKMARKS_FOLDER_USAGE;
    case "update":
      return BOOKMARKS_UPDATE_USAGE;
    case "move":
      return BOOKMARKS_MOVE_USAGE;
    case "delete":
    case "rm":
      return BOOKMARKS_DELETE_USAGE;
    case "delete-tree":
    case "rm-tree":
      return BOOKMARKS_DELETE_TREE_USAGE;
    default:
      return BOOKMARKS_USAGE;
  }
}

function isoTime(time: number): string {
  return new Date(time).toISOString();
}

function omitUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
