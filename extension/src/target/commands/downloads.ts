import { hasHelpFlag, parseInteger, requiredInteger } from "./args";
import type { BrowserCommand, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type DownloadStartOptions = {
  url: string;
  filename?: string;
  saveAs?: boolean;
  conflictAction?: chrome.downloads.DownloadOptions["conflictAction"];
  method?: chrome.downloads.DownloadOptions["method"];
  body?: string;
  headers?: chrome.downloads.HeaderNameValuePair[];
};

const DOWNLOADS_USAGE = [
  "Usage: downloads <list|get|start|pause|resume|cancel|erase|remove-file|show|show-folder|open> [args]",
  "       downloads list [--limit n] [query...]",
  "       downloads get <downloadId>",
  "       downloads start <url> [--filename path] [--save-as] [--conflict uniquify|overwrite|prompt] [--method GET|POST] [--body text] [--header Name:Value]",
  "       downloads pause <downloadId>",
  "       downloads resume <downloadId>",
  "       downloads cancel <downloadId>",
  "       downloads erase <downloadId>",
  "       downloads remove-file <downloadId>",
  "       downloads show <downloadId>",
  "       downloads show-folder",
  "       downloads open <downloadId>",
].join("\n");

const DOWNLOADS_LIST_USAGE = "Usage: downloads list [--limit n] [query...]";
const DOWNLOADS_GET_USAGE = "Usage: downloads get <downloadId>";
const DOWNLOADS_START_USAGE = "Usage: downloads start <url> [--filename path] [--save-as] [--conflict uniquify|overwrite|prompt] [--method GET|POST] [--body text] [--header Name:Value]";
const DOWNLOADS_PAUSE_USAGE = "Usage: downloads pause <downloadId>";
const DOWNLOADS_RESUME_USAGE = "Usage: downloads resume <downloadId>";
const DOWNLOADS_CANCEL_USAGE = "Usage: downloads cancel <downloadId>";
const DOWNLOADS_ERASE_USAGE = "Usage: downloads erase <downloadId>";
const DOWNLOADS_REMOVE_FILE_USAGE = "Usage: downloads remove-file <downloadId>";
const DOWNLOADS_SHOW_USAGE = "Usage: downloads show <downloadId>";
const DOWNLOADS_SHOW_FOLDER_USAGE = "Usage: downloads show-folder";
const DOWNLOADS_OPEN_USAGE = "Usage: downloads open <downloadId>";

export const downloadsCommand: BrowserCommand = {
  name: "downloads",
  summary: "Start and manage browser downloads.",
  async run(args: string[]): Promise<CommandResult> {
    return await runDownloadsCommand(args);
  },
};

export default downloadsCommand;

async function runDownloadsCommand(args: string[]): Promise<CommandResult> {
  const subcommand = args[0] ?? "list";
  if (hasHelpFlag(args)) {
    return commandOk(`${downloadsUsageFor(subcommand)}\n`);
  }

  try {
    switch (subcommand) {
      case "list":
        return await listDownloads(args.slice(1));
      case "get":
        return await getDownload(args.slice(1));
      case "start":
        return await startDownload(args.slice(1));
      case "pause":
        return await updateDownload(args.slice(1), DOWNLOADS_PAUSE_USAGE, "paused", (id) => requireDownloadsApi().pause(id));
      case "resume":
        return await updateDownload(args.slice(1), DOWNLOADS_RESUME_USAGE, "resumed", (id) => requireDownloadsApi().resume(id));
      case "cancel":
        return await updateDownload(args.slice(1), DOWNLOADS_CANCEL_USAGE, "cancelled", (id) => requireDownloadsApi().cancel(id));
      case "erase":
        return await eraseDownload(args.slice(1));
      case "remove-file":
      case "rm-file":
        return await updateDownload(args.slice(1), DOWNLOADS_REMOVE_FILE_USAGE, "removed file for", (id) => requireDownloadsApi().removeFile(id));
      case "show":
        return showDownload(args.slice(1));
      case "show-folder":
        return showDownloadsFolder(args.slice(1));
      case "open":
        return await updateDownload(args.slice(1), DOWNLOADS_OPEN_USAGE, "opened", (id) => requireDownloadsApi().open(id));
      default:
        return commandError(`Unknown downloads command: ${subcommand}\n${DOWNLOADS_USAGE}`);
    }
  } catch (error) {
    return commandError(`downloads ${subcommand}: ${errorMessage(error)}`);
  }
}

async function listDownloads(args: string[]): Promise<CommandResult> {
  const parsed = parseListArgs(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const query: chrome.downloads.DownloadQuery = {
    orderBy: ["-startTime"],
    limit: parsed.value.limit,
  };
  if (parsed.value.terms.length > 0) {
    query.query = parsed.value.terms;
  }

  const downloads = await requireDownloadsApi().search(query);
  return commandJson({
    downloads: downloads.map(formatDownload),
    count: downloads.length,
  });
}

async function getDownload(args: string[]): Promise<CommandResult> {
  const parsed = parseDownloadId(args, DOWNLOADS_GET_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const downloads = await requireDownloadsApi().search({ id: parsed.value });
  const download = downloads[0];
  if (!download) {
    return commandError(`download not found: ${parsed.value}`);
  }
  return commandJson(formatDownload(download));
}

async function startDownload(args: string[]): Promise<CommandResult> {
  const parsed = parseStartArgs(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const downloadId = await requireDownloadsApi().download(parsed.value);
  const downloads = await requireDownloadsApi().search({ id: downloadId });
  return commandJson({
    downloadId,
    download: downloads[0] ? formatDownload(downloads[0]) : null,
  });
}

async function updateDownload(
  args: string[],
  usage: string,
  label: string,
  update: (downloadId: number) => Promise<void>,
): Promise<CommandResult> {
  const parsed = parseDownloadId(args, usage);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  await update(parsed.value);
  return commandOk(`${label} download ${parsed.value}\n`);
}

async function eraseDownload(args: string[]): Promise<CommandResult> {
  const parsed = parseDownloadId(args, DOWNLOADS_ERASE_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const erasedIds = await requireDownloadsApi().erase({ id: parsed.value });
  return commandJson({ erasedIds, count: erasedIds.length });
}

function showDownload(args: string[]): CommandResult {
  const parsed = parseDownloadId(args, DOWNLOADS_SHOW_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  requireDownloadsApi().show(parsed.value);
  return commandOk(`showing download ${parsed.value}\n`);
}

function showDownloadsFolder(args: string[]): CommandResult {
  if (args.length !== 0) {
    return commandError(DOWNLOADS_SHOW_FOLDER_USAGE);
  }

  requireDownloadsApi().showDefaultFolder();
  return commandOk("showing downloads folder\n");
}

function parseListArgs(args: string[]): ParseResult<{ limit: number; terms: string[] }> {
  const terms: string[] = [];
  let limit = 50;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--limit") {
      const parsed = parseInteger(args[i + 1]);
      if (parsed === null || parsed < 0) {
        return { ok: false, error: `${DOWNLOADS_LIST_USAGE}\nlimit must be a non-negative integer` };
      }
      limit = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = parseInteger(arg.slice("--limit=".length));
      if (parsed === null || parsed < 0) {
        return { ok: false, error: `${DOWNLOADS_LIST_USAGE}\nlimit must be a non-negative integer` };
      }
      limit = parsed;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `${DOWNLOADS_LIST_USAGE}\nUnknown option: ${arg}` };
    }
    terms.push(arg);
  }

  return { ok: true, value: { limit, terms } };
}

function parseStartArgs(args: string[]): ParseResult<DownloadStartOptions> {
  const headers: chrome.downloads.HeaderNameValuePair[] = [];
  let url: string | null = null;
  let filename: string | undefined;
  let saveAs: boolean | undefined;
  let conflictAction: DownloadStartOptions["conflictAction"];
  let method: DownloadStartOptions["method"];
  let body: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--filename") {
      filename = requiredOptionValue(args[i + 1], arg, DOWNLOADS_START_USAGE);
      i += 1;
      continue;
    }
    if (arg.startsWith("--filename=")) {
      filename = arg.slice("--filename=".length);
      continue;
    }
    if (arg === "--save-as") {
      saveAs = true;
      continue;
    }
    if (arg === "--conflict") {
      const value = parseConflictAction(requiredOptionValue(args[i + 1], arg, DOWNLOADS_START_USAGE));
      if (!value.ok) return value;
      conflictAction = value.value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--conflict=")) {
      const value = parseConflictAction(arg.slice("--conflict=".length));
      if (!value.ok) return value;
      conflictAction = value.value;
      continue;
    }
    if (arg === "--method") {
      const value = parseMethod(requiredOptionValue(args[i + 1], arg, DOWNLOADS_START_USAGE));
      if (!value.ok) return value;
      method = value.value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--method=")) {
      const value = parseMethod(arg.slice("--method=".length));
      if (!value.ok) return value;
      method = value.value;
      continue;
    }
    if (arg === "--body") {
      body = requiredOptionValue(args[i + 1], arg, DOWNLOADS_START_USAGE);
      i += 1;
      continue;
    }
    if (arg.startsWith("--body=")) {
      body = arg.slice("--body=".length);
      continue;
    }
    if (arg === "--header") {
      const header = parseHeader(requiredOptionValue(args[i + 1], arg, DOWNLOADS_START_USAGE));
      if (!header.ok) return header;
      headers.push(header.value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--header=")) {
      const header = parseHeader(arg.slice("--header=".length));
      if (!header.ok) return header;
      headers.push(header.value);
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `${DOWNLOADS_START_USAGE}\nUnknown option: ${arg}` };
    }
    if (url) {
      return { ok: false, error: DOWNLOADS_START_USAGE };
    }
    url = arg;
  }

  if (!url) {
    return { ok: false, error: DOWNLOADS_START_USAGE };
  }

  return {
    ok: true,
    value: omitUndefined({
      url,
      filename,
      saveAs,
      conflictAction,
      method,
      body,
      headers: headers.length > 0 ? headers : undefined,
    }) as DownloadStartOptions,
  };
}

function parseDownloadId(args: string[], usage: string): ParseResult<number> {
  if (args.length !== 1) {
    return { ok: false, error: usage };
  }
  try {
    return { ok: true, value: requiredInteger(args[0], "downloadId") };
  } catch (error) {
    return { ok: false, error: `${usage}\n${errorMessage(error)}` };
  }
}

function parseConflictAction(value: string): ParseResult<DownloadStartOptions["conflictAction"]> {
  if (value === "uniquify" || value === "overwrite" || value === "prompt") {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: `${DOWNLOADS_START_USAGE}\nconflict must be one of: uniquify, overwrite, prompt`,
  };
}

function parseMethod(value: string): ParseResult<DownloadStartOptions["method"]> {
  const upper = value.toUpperCase();
  if (upper === "GET" || upper === "POST") {
    return { ok: true, value: upper };
  }
  return { ok: false, error: `${DOWNLOADS_START_USAGE}\nmethod must be GET or POST` };
}

function parseHeader(value: string): ParseResult<chrome.downloads.HeaderNameValuePair> {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return { ok: false, error: `${DOWNLOADS_START_USAGE}\nheader must use Name:Value format` };
  }
  const name = value.slice(0, separator).trim();
  const headerValue = value.slice(separator + 1).trim();
  if (!name) {
    return { ok: false, error: `${DOWNLOADS_START_USAGE}\nheader name is required` };
  }
  return { ok: true, value: { name, value: headerValue } };
}

function requiredOptionValue(value: string | undefined, option: string, usage: string): string {
  if (!value) {
    throw new Error(`${usage}\n${option} requires a value`);
  }
  return value;
}

function requireDownloadsApi(): typeof chrome.downloads {
  if (typeof chrome === "undefined" || !chrome.downloads) {
    throw new Error("chrome.downloads is unavailable; check the downloads permission.");
  }
  return chrome.downloads;
}

function formatDownload(download: chrome.downloads.DownloadItem): Record<string, unknown> {
  return omitUndefined({
    id: download.id,
    url: download.url,
    finalUrl: download.finalUrl,
    filename: download.filename,
    mime: download.mime,
    state: download.state,
    danger: download.danger,
    error: download.error,
    paused: download.paused,
    canResume: download.canResume,
    exists: download.exists,
    incognito: download.incognito,
    bytesReceived: download.bytesReceived,
    totalBytes: download.totalBytes,
    fileSize: download.fileSize,
    startTime: download.startTime,
    estimatedEndTime: download.estimatedEndTime,
    endTime: download.endTime,
    referrer: download.referrer,
    byExtensionId: download.byExtensionId,
    byExtensionName: download.byExtensionName,
  });
}

function downloadsUsageFor(subcommand: string): string {
  switch (subcommand) {
    case "list":
      return DOWNLOADS_LIST_USAGE;
    case "get":
      return DOWNLOADS_GET_USAGE;
    case "start":
      return DOWNLOADS_START_USAGE;
    case "pause":
      return DOWNLOADS_PAUSE_USAGE;
    case "resume":
      return DOWNLOADS_RESUME_USAGE;
    case "cancel":
      return DOWNLOADS_CANCEL_USAGE;
    case "erase":
      return DOWNLOADS_ERASE_USAGE;
    case "remove-file":
    case "rm-file":
      return DOWNLOADS_REMOVE_FILE_USAGE;
    case "show":
      return DOWNLOADS_SHOW_USAGE;
    case "show-folder":
      return DOWNLOADS_SHOW_FOLDER_USAGE;
    case "open":
      return DOWNLOADS_OPEN_USAGE;
    default:
      return DOWNLOADS_USAGE;
  }
}

function omitUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
