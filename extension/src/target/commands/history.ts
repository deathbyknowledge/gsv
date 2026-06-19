import { hasHelpFlag, parseInteger } from "./args";
import type { BrowserCommand, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type HistorySearchArgs = {
  text: string;
  maxResults: number;
  startTime: number;
  endTime?: number;
};

const HISTORY_USAGE = [
  "Usage: history <search|visits|add|delete|delete-range|delete-all> [args]",
  "       history search [--text query] [--limit n] [--start ms-or-iso] [--end ms-or-iso] [query...]",
  "       history visits <url>",
  "       history add <url>",
  "       history delete <url>",
  "       history delete-range <start ms-or-iso> <end ms-or-iso>",
  "       history delete-all --yes",
].join("\n");

const HISTORY_SEARCH_USAGE = "Usage: history search [--text query] [--limit n] [--start ms-or-iso] [--end ms-or-iso] [query...]";
const HISTORY_VISITS_USAGE = "Usage: history visits <url>";
const HISTORY_ADD_USAGE = "Usage: history add <url>";
const HISTORY_DELETE_USAGE = "Usage: history delete <url>";
const HISTORY_DELETE_RANGE_USAGE = "Usage: history delete-range <start ms-or-iso> <end ms-or-iso>";
const HISTORY_DELETE_ALL_USAGE = "Usage: history delete-all --yes";

export const historyCommand: BrowserCommand = {
  name: "history",
  summary: "Search and modify browser history.",
  async run(args: string[]): Promise<CommandResult> {
    return await runHistoryCommand(args);
  },
};

export default historyCommand;

async function runHistoryCommand(args: string[]): Promise<CommandResult> {
  const subcommand = args[0] ?? "search";
  if (hasHelpFlag(args)) {
    return commandOk(`${historyUsageFor(subcommand)}\n`);
  }

  try {
    switch (subcommand) {
      case "search":
        return await searchHistory(args.slice(1));
      case "visits":
        return await getVisits(args.slice(1));
      case "add":
        return await addHistoryUrl(args.slice(1));
      case "delete":
      case "rm":
        return await deleteHistoryUrl(args.slice(1));
      case "delete-range":
        return await deleteHistoryRange(args.slice(1));
      case "delete-all":
        return await deleteAllHistory(args.slice(1));
      default:
        return commandError(`Unknown history command: ${subcommand}\n${HISTORY_USAGE}`);
    }
  } catch (error) {
    return commandError(`history ${subcommand}: ${errorMessage(error)}`);
  }
}

async function searchHistory(args: string[]): Promise<CommandResult> {
  const parsed = parseSearchArgs(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const query: chrome.history.HistoryQuery = {
    text: parsed.value.text,
    maxResults: parsed.value.maxResults,
    startTime: parsed.value.startTime,
  };
  if (parsed.value.endTime !== undefined) {
    query.endTime = parsed.value.endTime;
  }

  const results = await requireHistoryApi().search(query);
  return commandJson({
    history: results.map(formatHistoryItem),
    count: results.length,
  });
}

async function getVisits(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(HISTORY_VISITS_USAGE);
  }
  const url = validateUrl(args[0]);
  if (!url.ok) {
    return commandError(`${HISTORY_VISITS_USAGE}\n${url.error}`);
  }

  const visits = await requireHistoryApi().getVisits({ url: url.value });
  return commandJson({
    url: url.value,
    visits: visits.map(formatVisitItem),
    count: visits.length,
  });
}

async function addHistoryUrl(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(HISTORY_ADD_USAGE);
  }
  const url = validateUrl(args[0]);
  if (!url.ok) {
    return commandError(`${HISTORY_ADD_USAGE}\n${url.error}`);
  }

  await requireHistoryApi().addUrl({ url: url.value });
  return commandOk(`added history url ${url.value}\n`);
}

async function deleteHistoryUrl(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(HISTORY_DELETE_USAGE);
  }
  const url = validateUrl(args[0]);
  if (!url.ok) {
    return commandError(`${HISTORY_DELETE_USAGE}\n${url.error}`);
  }

  await requireHistoryApi().deleteUrl({ url: url.value });
  return commandOk(`deleted history url ${url.value}\n`);
}

async function deleteHistoryRange(args: string[]): Promise<CommandResult> {
  if (args.length !== 2) {
    return commandError(HISTORY_DELETE_RANGE_USAGE);
  }
  const startTime = parseTimeArg(args[0], "start");
  if (!startTime.ok) {
    return commandError(`${HISTORY_DELETE_RANGE_USAGE}\n${startTime.error}`);
  }
  const endTime = parseTimeArg(args[1], "end");
  if (!endTime.ok) {
    return commandError(`${HISTORY_DELETE_RANGE_USAGE}\n${endTime.error}`);
  }
  if (endTime.value < startTime.value) {
    return commandError(`${HISTORY_DELETE_RANGE_USAGE}\nend must be greater than or equal to start`);
  }

  await requireHistoryApi().deleteRange({
    startTime: startTime.value,
    endTime: endTime.value,
  });
  return commandOk(`deleted history from ${isoTime(startTime.value)} to ${isoTime(endTime.value)}\n`);
}

async function deleteAllHistory(args: string[]): Promise<CommandResult> {
  if (args.length !== 1 || args[0] !== "--yes") {
    return commandError(HISTORY_DELETE_ALL_USAGE);
  }

  await requireHistoryApi().deleteAll();
  return commandOk("deleted all browser history\n");
}

function parseSearchArgs(args: string[]): ParseResult<HistorySearchArgs> {
  const terms: string[] = [];
  let text: string | null = null;
  let maxResults = 50;
  let startTime = 0;
  let endTime: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--text") {
      text = requiredOptionValue(args[i + 1], arg, HISTORY_SEARCH_USAGE);
      i += 1;
      continue;
    }
    if (arg.startsWith("--text=")) {
      text = arg.slice("--text=".length);
      continue;
    }
    if (arg === "--limit") {
      const parsed = parseLimit(args[i + 1]);
      if (!parsed.ok) return parsed;
      maxResults = parsed.value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = parseLimit(arg.slice("--limit=".length));
      if (!parsed.ok) return parsed;
      maxResults = parsed.value;
      continue;
    }
    if (arg === "--start" || arg === "--since") {
      const parsed = parseTimeArg(args[i + 1], arg);
      if (!parsed.ok) return parsed;
      startTime = parsed.value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--start=")) {
      const parsed = parseTimeArg(arg.slice("--start=".length), "--start");
      if (!parsed.ok) return parsed;
      startTime = parsed.value;
      continue;
    }
    if (arg.startsWith("--since=")) {
      const parsed = parseTimeArg(arg.slice("--since=".length), "--since");
      if (!parsed.ok) return parsed;
      startTime = parsed.value;
      continue;
    }
    if (arg === "--end" || arg === "--until") {
      const parsed = parseTimeArg(args[i + 1], arg);
      if (!parsed.ok) return parsed;
      endTime = parsed.value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--end=")) {
      const parsed = parseTimeArg(arg.slice("--end=".length), "--end");
      if (!parsed.ok) return parsed;
      endTime = parsed.value;
      continue;
    }
    if (arg.startsWith("--until=")) {
      const parsed = parseTimeArg(arg.slice("--until=".length), "--until");
      if (!parsed.ok) return parsed;
      endTime = parsed.value;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `${HISTORY_SEARCH_USAGE}\nUnknown option: ${arg}` };
    }
    terms.push(arg);
  }

  return {
    ok: true,
    value: {
      text: text ?? terms.join(" "),
      maxResults,
      startTime,
      endTime,
    },
  };
}

function parseLimit(value: string | undefined): ParseResult<number> {
  const parsed = parseInteger(value);
  if (parsed === null || parsed < 1 || parsed > 10000) {
    return { ok: false, error: `${HISTORY_SEARCH_USAGE}\nlimit must be an integer from 1 to 10000` };
  }
  return { ok: true, value: parsed };
}

function parseTimeArg(value: string | undefined, label: string): ParseResult<number> {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return { ok: false, error: `${label} time is required` };
  }
  if (/^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) {
      return { ok: true, value: parsed };
    }
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return { ok: false, error: `${label} must be milliseconds since epoch or an ISO date` };
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

function requireHistoryApi(): typeof chrome.history {
  if (typeof chrome === "undefined" || !chrome.history) {
    throw new Error("chrome.history is unavailable; check the history permission.");
  }
  return chrome.history;
}

function formatHistoryItem(item: chrome.history.HistoryItem): Record<string, unknown> {
  return omitUndefined({
    id: item.id,
    url: item.url,
    title: item.title,
    lastVisitTime: item.lastVisitTime,
    lastVisitTimeIso: item.lastVisitTime === undefined ? undefined : isoTime(item.lastVisitTime),
    visitCount: item.visitCount,
    typedCount: item.typedCount,
  });
}

function formatVisitItem(item: chrome.history.VisitItem): Record<string, unknown> {
  return omitUndefined({
    id: item.id,
    visitId: item.visitId,
    referringVisitId: item.referringVisitId,
    transition: item.transition,
    isLocal: item.isLocal,
    visitTime: item.visitTime,
    visitTimeIso: item.visitTime === undefined ? undefined : isoTime(item.visitTime),
  });
}

function historyUsageFor(subcommand: string): string {
  switch (subcommand) {
    case "search":
      return HISTORY_SEARCH_USAGE;
    case "visits":
      return HISTORY_VISITS_USAGE;
    case "add":
      return HISTORY_ADD_USAGE;
    case "delete":
    case "rm":
      return HISTORY_DELETE_USAGE;
    case "delete-range":
      return HISTORY_DELETE_RANGE_USAGE;
    case "delete-all":
      return HISTORY_DELETE_ALL_USAGE;
    default:
      return HISTORY_USAGE;
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
