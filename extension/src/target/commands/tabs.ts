import {
  activeTab,
  closeTab,
  createTab,
  focusTab,
  getTab,
  listTabs,
  reloadTab,
} from "../../shared/chrome";
import { basename, normalizePath } from "../../shared/paths";
import type { BrowserCommand, CommandContext, CommandResult, FileStat, TargetCopyEndpoint } from "../types";
import { commandError, commandJson, commandOk } from "../types";
import { hasHelpFlag, requiredInteger, splitOption } from "./args";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type OpenOptions = {
  input: string;
  contentType?: string;
};

const TABS_USAGE = [
  "Usage: tabs <list|active|get|open|focus|close|reload> [args]",
  "       tabs list",
  "       tabs active",
  "       tabs get <tabId>",
  "       tabs open [--mime type] <url|path|target:/path|->",
  "       tabs focus <tabId>",
  "       tabs close <tabId>",
  "       tabs reload <tabId>",
].join("\n");

const TABS_LIST_USAGE = "Usage: tabs list";
const TABS_ACTIVE_USAGE = "Usage: tabs active";
const TABS_GET_USAGE = "Usage: tabs get <tabId>";
const TABS_OPEN_USAGE = [
  "Usage: tabs open [--mime type] <url|path|target:/path|->",
  "Paths may be local browser target paths, gsv:/path, target:/path, or [target-with-colons]:/path.",
  "Use - to render stdin.",
].join("\n");
const TABS_FOCUS_USAGE = "Usage: tabs focus <tabId>";
const TABS_CLOSE_USAGE = "Usage: tabs close <tabId>";
const TABS_RELOAD_USAGE = "Usage: tabs reload <tabId>";

export const tabCommands: BrowserCommand[] = [
  {
    name: "tabs",
    summary: "List and control browser tabs.",
    run(args, ctx) {
      return runTabsCommand(args, ctx);
    },
  },
];

export default tabCommands;

async function runTabsCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
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
        return await runOpen(args, ctx);
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

async function runOpen(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseOpenOptions(args.slice(1));
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const { input, contentType } = parsed.value;
  if (isBrowserUrl(input)) {
    const tab = await createTab(input, true);
    return commandOk(`opened tab ${tab.id}\n${compactOpenJson({ tab })}\n`);
  }

  const renderable = input === "-"
    ? await renderableFromStdin(ctx, contentType)
    : await renderableFromPath(input, ctx, contentType);
  const viewerUrl = viewerUrlFor(renderable.path, renderable.contentType, renderable.label);
  const tab = await createTab(viewerUrl, true);
  return commandOk(`opened tab ${tab.id}\n${compactOpenJson({
    tab,
    path: renderable.path,
    source: renderable.source,
    contentType: renderable.contentType,
  })}\n`);
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
  return commandOk(`focused tab ${tab.id}\n${compactOpenJson({ tab })}\n`);
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

function parseOpenOptions(args: string[]): Parsed<OpenOptions> {
  const mimeSplit = splitOption(args, "--mime");
  if (mimeSplit.value !== null && !isContentType(mimeSplit.value)) {
    return { ok: false, error: `${TABS_OPEN_USAGE}\nmime must look like type/subtype` };
  }
  const input = mimeSplit.rest.join(" ").trim();
  if (!input) {
    return { ok: false, error: TABS_OPEN_USAGE };
  }
  return {
    ok: true,
    value: {
      input,
      contentType: mimeSplit.value ?? undefined,
    },
  };
}

type Renderable = {
  path: string;
  source: string;
  label: string;
  contentType: string;
};

async function renderableFromStdin(ctx: CommandContext, contentType?: string): Promise<Renderable> {
  if (!ctx.stdin) {
    throw new Error("tabs open - requires stdin");
  }
  const resolvedType = contentType ?? "text/plain; charset=utf-8";
  const path = tempRenderPath("stdin", extensionForContentType(resolvedType));
  await ctx.fs.mkdir("/tmp/render");
  await ctx.fs.write(path, new TextEncoder().encode(ctx.stdin));
  return {
    path,
    source: "stdin",
    label: "stdin",
    contentType: resolvedType,
  };
}

async function renderableFromPath(input: string, ctx: CommandContext, contentType?: string): Promise<Renderable> {
  const endpoint = parseTargetEndpoint(input);
  if (endpoint) {
    return await renderableFromTargetEndpoint(input, endpoint, ctx, contentType);
  }

  const path = ctx.fs.resolvePath(ctx.cwd, input);
  const stat = await requireFile(ctx, path);
  const resolvedType = contentType ?? stat.contentType ?? inferContentType(path);
  if (isDirectViewerPath(path)) {
    return {
      path,
      source: path,
      label: path,
      contentType: resolvedType,
    };
  }

  const destination = tempRenderPath(basename(path), extensionForPathOrType(path, resolvedType));
  await ctx.fs.mkdir("/tmp/render");
  await ctx.fs.write(destination, await ctx.fs.read(path));
  return {
    path: destination,
    source: path,
    label: path,
    contentType: resolvedType,
  };
}

async function renderableFromTargetEndpoint(
  sourceText: string,
  endpoint: TargetCopyEndpoint,
  ctx: CommandContext,
  contentType?: string,
): Promise<Renderable> {
  if (ctx.currentTargetId && endpoint.target === ctx.currentTargetId) {
    const path = normalizePath(endpoint.path);
    const stat = await requireFile(ctx, path);
    return {
      path,
      source: sourceText,
      label: sourceText,
      contentType: contentType ?? stat.contentType ?? inferContentType(path),
    };
  }
  if (!ctx.currentTargetId) {
    throw new Error("current browser target id is unavailable");
  }
  if (!ctx.copyTargetFile) {
    throw new Error("gateway fs.copy is unavailable from this shell context");
  }

  const inferredType = contentType ?? inferContentType(endpoint.path);
  const destination = tempRenderPath(basename(endpoint.path), extensionForPathOrType(endpoint.path, inferredType));
  await ctx.fs.mkdir("/tmp/render");
  const copy = await ctx.copyTargetFile(endpoint, {
    target: ctx.currentTargetId,
    path: destination,
  });
  const copyRecord = asRecord(copy);
  if (copyRecord.ok === false) {
    throw new Error(typeof copyRecord.error === "string" ? copyRecord.error : "fs.copy failed");
  }
  const copiedType = contentType ?? copyContentType(copy) ?? inferredType;
  const copiedDestination = asRecord(copyRecord.destination);
  const copiedPath = typeof copiedDestination.path === "string" && copiedDestination.path.trim()
    ? copiedDestination.path.trim()
    : destination;
  return {
    path: copiedPath,
    source: sourceText,
    label: sourceText,
    contentType: copiedType,
  };
}

async function requireFile(ctx: CommandContext, path: string): Promise<FileStat> {
  const stat = await ctx.fs.stat(path);
  if (stat.isDirectory) {
    throw new Error(`Is a directory: ${path}`);
  }
  return stat;
}

function parseTargetEndpoint(spec: string): TargetCopyEndpoint | null {
  if (isBrowserUrl(spec)) {
    return null;
  }

  const bracket = spec.match(/^\[([^\]]+)]:(.*)$/);
  if (bracket) {
    return {
      target: bracket[1] || "gsv",
      path: bracket[2] || ".",
    };
  }

  const match = spec.match(/^([A-Za-z0-9_.-]+):(.*)$/);
  if (!match) {
    return null;
  }
  return {
    target: match[1] || "gsv",
    path: match[2] || ".",
  };
}

function isBrowserUrl(value: string): boolean {
  const scheme = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]?.toLowerCase();
  if (!scheme) {
    return false;
  }
  return ["http", "https", "data", "blob", "file", "about", "chrome", "chrome-extension"].includes(scheme);
}

function viewerUrlFor(path: string, contentType: string, label: string): string {
  const params = new URLSearchParams({
    path,
    mime: contentType,
    label,
  });
  return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
}

function tempRenderPath(name: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const slug = slugName(name || "file");
  return `/tmp/render/${timestamp}-${crypto.randomUUID().slice(0, 8)}-${slug}${extension}`;
}

function slugName(value: string): string {
  const base = basename(value).replace(/\.[A-Za-z0-9]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "file";
}

function extensionForPathOrType(path: string, contentType: string): string {
  const match = basename(path).match(/(\.[A-Za-z0-9]+)$/);
  return match?.[1] ?? extensionForContentType(contentType);
}

function extensionForContentType(contentType: string): string {
  const type = normalizeContentType(contentType);
  if (type === "text/html") return ".html";
  if (type === "text/css") return ".css";
  if (type === "text/javascript" || type === "application/javascript") return ".js";
  if (type === "application/json" || type.endsWith("+json")) return ".json";
  if (type === "image/png") return ".png";
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/gif") return ".gif";
  if (type === "image/webp") return ".webp";
  if (type === "image/svg+xml") return ".svg";
  if (type === "audio/webm") return ".webm";
  if (type === "audio/ogg") return ".ogg";
  if (type === "audio/mpeg") return ".mp3";
  if (type === "audio/mp4") return ".m4a";
  if (type === "video/webm") return ".webm";
  if (type === "video/mp4") return ".mp4";
  if (type === "application/pdf") return ".pdf";
  return ".txt";
}

function inferContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".ts")) return "text/javascript";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function isDirectViewerPath(path: string): boolean {
  return path === "/tmp"
    || path.startsWith("/tmp/")
    || path === "/home/browser"
    || path.startsWith("/home/browser/");
}

function isContentType(value: string): boolean {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9_.-]+=[^;]+)*$/.test(value.trim());
}

function copyContentType(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record.contentType === "string" && record.contentType.trim()
    ? record.contentType.trim()
    : null;
}

function normalizeContentType(contentType: string): string {
  return contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

function compactOpenJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
