import { activeTab, getTab } from "../../shared/chrome";
import type { BrowserCommand, CommandContext, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";
import { hasHelpFlag, parseInteger, splitOption } from "./args";
import {
  clearNetworkCapture,
  networkEvents,
  networkHar,
  networkRequest,
  networkStatus,
  startNetworkCapture,
  stopNetworkCapture,
} from "../network-recorder";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type TabOptions = {
  tabId: number | null;
  args: string[];
};

type StartOptions = {
  tabId: number;
  bodies: boolean;
  persist: boolean;
  bodyLimit: number;
};

const NETWORK_USAGE = [
  "Usage: network <start|stop|status|events|get|clear|export> [args]",
  "       network start [--tab <tabId>] [--bodies] [--persist] [--body-limit bytes]",
  "       network stop [--tab <tabId>]",
  "       network status [--tab <tabId>]",
  "       network events [--tab <tabId>] [--limit n] [--url text]",
  "       network get <requestId> [--body]",
  "       network clear [--tab <tabId>]",
  "       network export har [--tab <tabId>] [--path path]",
].join("\n");

const NETWORK_START_USAGE = "Usage: network start [--tab <tabId>] [--bodies] [--persist] [--body-limit bytes]";
const NETWORK_STOP_USAGE = "Usage: network stop [--tab <tabId>]";
const NETWORK_STATUS_USAGE = "Usage: network status [--tab <tabId>]";
const NETWORK_EVENTS_USAGE = "Usage: network events [--tab <tabId>] [--limit n] [--url text]";
const NETWORK_GET_USAGE = "Usage: network get <requestId> [--body]";
const NETWORK_CLEAR_USAGE = "Usage: network clear [--tab <tabId>]";
const NETWORK_EXPORT_USAGE = "Usage: network export har [--tab <tabId>] [--path path]";

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_BODY_LIMIT = 50 * 1024 * 1024;
const DEFAULT_EVENT_LIMIT = 100;

export const networkCommand: BrowserCommand = {
  name: "network",
  summary: "Record and inspect tab network activity.",
  async run(args: string[], ctx: CommandContext): Promise<CommandResult> {
    return await runNetworkCommand(args, ctx);
  },
};

export default networkCommand;

async function runNetworkCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const subcommand = args[0] ?? "status";
  if (hasHelpFlag(args)) {
    return commandOk(`${networkUsageFor(subcommand)}\n`);
  }

  try {
    switch (subcommand) {
      case "start":
        return await runStart(args.slice(1), ctx);
      case "stop":
        return await runStop(args.slice(1));
      case "status":
        return runStatus(args.slice(1));
      case "events":
        return runEvents(args.slice(1));
      case "get":
        return await runGet(args.slice(1));
      case "clear":
        return runClear(args.slice(1));
      case "export":
        return await runExport(args.slice(1), ctx);
      default:
        return commandError(`Unknown network command: ${subcommand}\n${NETWORK_USAGE}`);
    }
  } catch (error) {
    return commandError(`network ${subcommand}: ${errorMessage(error)}`);
  }
}

async function runStart(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = await parseStartOptions(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const status = await startNetworkCapture({
    ...parsed.value,
    fs: ctx.fs,
  });
  return commandJson(status);
}

async function runStop(args: string[]): Promise<CommandResult> {
  const parsed = parseTabOptions(args, NETWORK_STOP_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (parsed.value.args.length > 0) {
    return commandError(NETWORK_STOP_USAGE);
  }

  const statuses = await stopNetworkCapture(parsed.value.tabId ?? undefined);
  return commandJson({ stopped: statuses, count: statuses.length });
}

function runStatus(args: string[]): CommandResult {
  const parsed = parseTabOptions(args, NETWORK_STATUS_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (parsed.value.args.length > 0) {
    return commandError(NETWORK_STATUS_USAGE);
  }

  const captures = networkStatus(parsed.value.tabId ?? undefined);
  return commandJson({ captures, activeCount: captures.length });
}

function runEvents(args: string[]): CommandResult {
  const parsed = parseEventsOptions(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const events = networkEvents(parsed.value);
  return commandJson({ events, count: events.length });
}

async function runGet(args: string[]): Promise<CommandResult> {
  let includeBody = false;
  const requestIds: string[] = [];
  for (const arg of args) {
    if (arg === "--body") {
      includeBody = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return commandError(`${NETWORK_GET_USAGE}\nUnknown option: ${arg}`);
    }
    requestIds.push(arg);
  }
  if (requestIds.length !== 1) {
    return commandError(NETWORK_GET_USAGE);
  }

  const request = await networkRequest(requestIds[0], includeBody);
  if (!request) {
    return commandError(`request not found: ${requestIds[0]}`);
  }
  return commandJson(request);
}

function runClear(args: string[]): CommandResult {
  const parsed = parseTabOptions(args, NETWORK_CLEAR_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (parsed.value.args.length > 0) {
    return commandError(NETWORK_CLEAR_USAGE);
  }

  const cleared = clearNetworkCapture(parsed.value.tabId ?? undefined);
  return commandJson({ cleared });
}

async function runExport(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const format = args[0] ?? "";
  if (format !== "har") {
    return commandError(NETWORK_EXPORT_USAGE);
  }

  const parsed = parseExportOptions(args.slice(1));
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const har = await networkHar(parsed.value.tabId ?? undefined);
  if (parsed.value.path) {
    const path = ctx.fs.resolvePath(ctx.cwd, parsed.value.path);
    await ctx.fs.write(path, new TextEncoder().encode(`${JSON.stringify(har, null, 2)}\n`));
    return commandJson({ path, format: "har" });
  }
  return commandJson(har);
}

async function parseStartOptions(args: string[]): Promise<Parsed<StartOptions>> {
  const tabSplit = splitOption(args, "--tab");
  const bodyLimitSplit = splitOption(tabSplit.rest, "--body-limit");
  const tabId = parseOptionalPositiveInteger(tabSplit.value, "tabId", NETWORK_START_USAGE);
  if (!tabId.ok) {
    return { ok: false, error: tabId.error };
  }
  const bodyLimit = parseOptionalBodyLimit(bodyLimitSplit.value);
  if (!bodyLimit.ok) {
    return { ok: false, error: bodyLimit.error };
  }

  let bodies = false;
  let persist = false;
  for (const arg of bodyLimitSplit.rest) {
    if (arg === "--bodies") {
      bodies = true;
      continue;
    }
    if (arg === "--persist") {
      persist = true;
      continue;
    }
    return { ok: false, error: `${NETWORK_START_USAGE}\nUnknown option: ${arg}` };
  }

  const resolvedTabId = tabId.value ?? await activeTabId();
  return {
    ok: true,
    value: {
      tabId: resolvedTabId,
      bodies,
      persist,
      bodyLimit: bodyLimit.value,
    },
  };
}

function parseEventsOptions(args: string[]): Parsed<{ tabId?: number; limit: number; url?: string }> {
  const tabSplit = splitOption(args, "--tab");
  const limitSplit = splitOption(tabSplit.rest, "--limit");
  const urlSplit = splitOption(limitSplit.rest, "--url");
  const tabId = parseOptionalPositiveInteger(tabSplit.value, "tabId", NETWORK_EVENTS_USAGE);
  if (!tabId.ok) {
    return { ok: false, error: tabId.error };
  }
  const limit = parseOptionalLimit(limitSplit.value);
  if (!limit.ok) {
    return { ok: false, error: limit.error };
  }
  if (urlSplit.rest.length > 0) {
    return { ok: false, error: NETWORK_EVENTS_USAGE };
  }

  return {
    ok: true,
    value: {
      tabId: tabId.value ?? undefined,
      limit: limit.value,
      url: urlSplit.value ?? undefined,
    },
  };
}

function parseExportOptions(args: string[]): Parsed<{ tabId?: number; path?: string }> {
  const tabSplit = splitOption(args, "--tab");
  const pathSplit = splitOption(tabSplit.rest, "--path");
  const tabId = parseOptionalPositiveInteger(tabSplit.value, "tabId", NETWORK_EXPORT_USAGE);
  if (!tabId.ok) {
    return { ok: false, error: tabId.error };
  }
  if (pathSplit.rest.length > 0) {
    return { ok: false, error: NETWORK_EXPORT_USAGE };
  }
  return {
    ok: true,
    value: {
      tabId: tabId.value ?? undefined,
      path: pathSplit.value ?? undefined,
    },
  };
}

function parseTabOptions(args: string[], usage: string): Parsed<TabOptions> {
  const split = splitOption(args, "--tab");
  const tabId = parseOptionalPositiveInteger(split.value, "tabId", usage);
  if (!tabId.ok) {
    return { ok: false, error: tabId.error };
  }
  return { ok: true, value: { tabId: tabId.value, args: split.rest } };
}

function parseOptionalPositiveInteger(
  value: string | null,
  label: string,
  usage: string,
): Parsed<number | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0) {
    return { ok: false, error: `${usage}\n${label} must be a positive integer` };
  }
  return { ok: true, value: parsed };
}

function parseOptionalBodyLimit(value: string | null): Parsed<number> {
  if (value === null) {
    return { ok: true, value: DEFAULT_BODY_LIMIT };
  }
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0 || parsed > MAX_BODY_LIMIT) {
    return {
      ok: false,
      error: `${NETWORK_START_USAGE}\nbody limit must be an integer from 1 to ${MAX_BODY_LIMIT}`,
    };
  }
  return { ok: true, value: parsed };
}

function parseOptionalLimit(value: string | null): Parsed<number> {
  if (value === null) {
    return { ok: true, value: DEFAULT_EVENT_LIMIT };
  }
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0 || parsed > 10_000) {
    return { ok: false, error: `${NETWORK_EVENTS_USAGE}\nlimit must be an integer from 1 to 10000` };
  }
  return { ok: true, value: parsed };
}

async function activeTabId(): Promise<number> {
  const tab = await activeTab();
  if (!tab) {
    throw new Error("no active tab");
  }
  const checked = await getTab(tab.id);
  if (!checked) {
    throw new Error(`tab not found: ${tab.id}`);
  }
  return checked.id;
}

function networkUsageFor(subcommand: string): string {
  switch (subcommand) {
    case "start":
      return NETWORK_START_USAGE;
    case "stop":
      return NETWORK_STOP_USAGE;
    case "status":
      return NETWORK_STATUS_USAGE;
    case "events":
      return NETWORK_EVENTS_USAGE;
    case "get":
      return NETWORK_GET_USAGE;
    case "clear":
      return NETWORK_CLEAR_USAGE;
    case "export":
      return NETWORK_EXPORT_USAGE;
    default:
      return NETWORK_USAGE;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
