import {
  activeTab,
  captureTabPng,
  executeInTab,
  getTab,
  type TabSummary,
} from "../../shared/chrome";
import {
  acquireDebugger,
  releaseDebugger,
} from "../../shared/debugger";
import { abortable, abortableDelay, throwIfAborted } from "../abort";
import {
  findPageSelector,
  readPageText,
  snapshotDomPage,
  type InjectedPageResult,
} from "../page-dom";
import {
  clickPageElement,
  scrollPage,
  sendPageKey,
  typePageText,
  type PageLocator,
  type PageScrollTarget,
} from "../page-actions";
import {
  captureSemanticSnapshot,
  formatSemanticSnapshot,
  isPageReference,
  pageReferences,
} from "../page-semantics";
import { evaluatePageJavaScript } from "../page-javascript";
import type { BrowserCommand, CommandContext, CommandResult } from "../types";
import { commandError, commandOk } from "../types";
import { hasHelpFlag, parseInteger, splitOption } from "./args";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
type PageOptions = { tabId: number | null; args: string[] };

const PAGE_USAGE = [
  "Usage: page <snapshot|text|screenshot|click|type|key|scroll|wait|js> [args]",
  "       page snapshot [--tab <tabId>] [--json]",
  "       page snapshot [--tab <tabId>] --dom [selector]",
  "       page text [--tab <tabId>] [selector]",
  "       page screenshot [--tab <tabId>]",
  "       page click [--tab <tabId>] <ref|selector> [index]",
  "       page type [--tab <tabId>] <ref|selector> <text>",
  "       page key [--tab <tabId>] <key>",
  "       page scroll [--tab <tabId>] [ref] <up|down|top|bottom|x,y>",
  "       page wait [--tab <tabId>] <selector> [--timeout ms]",
  "       page js [--tab <tabId>] <source>",
].join("\n");

const PAGE_SNAPSHOT_USAGE = [
  "Usage: page snapshot [--tab <tabId>] [--json]",
  "       page snapshot [--tab <tabId>] --dom [selector]",
].join("\n");
const PAGE_TEXT_USAGE = "Usage: page text [--tab <tabId>] [selector]";
const PAGE_SCREENSHOT_USAGE = "Usage: page screenshot [--tab <tabId>]";
const PAGE_CLICK_USAGE = "Usage: page click [--tab <tabId>] <ref|selector> [index]";
const PAGE_TYPE_USAGE = "Usage: page type [--tab <tabId>] <ref|selector> <text>";
const PAGE_KEY_USAGE = "Usage: page key [--tab <tabId>] <key>";
const PAGE_SCROLL_USAGE = "Usage: page scroll [--tab <tabId>] [ref] <up|down|top|bottom|x,y>";
const PAGE_WAIT_USAGE = "Usage: page wait [--tab <tabId>] <selector> [--timeout ms]";
const PAGE_JS_USAGE = "Usage: page js [--tab <tabId>] <source>";

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;

export const pageCommand: BrowserCommand = {
  name: "page",
  summary: "Inspect and automate browser pages.",
  run(args, ctx) {
    return runPageCommand(args, ctx);
  },
};

export const pageCommands: BrowserCommand[] = [pageCommand];

export default pageCommand;

async function runPageCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const subcommand = args[0] ?? "";
  if (hasHelpFlag(args) || subcommand === "help") {
    return commandOk(`${pageUsageFor(subcommand)}\n`);
  }
  if (!subcommand) {
    return commandError(PAGE_USAGE);
  }

  const rest = args.slice(1);
  try {
    switch (subcommand) {
      case "snapshot":
        return await runSnapshot(rest, ctx);
      case "text":
        return await runText(rest);
      case "screenshot":
        return await runScreenshot(rest, ctx);
      case "click":
        return await runClick(rest, ctx);
      case "type":
        return await runType(rest, ctx);
      case "key":
        return await runKey(rest, ctx);
      case "scroll":
        return await runScroll(rest, ctx);
      case "wait":
        return await runWait(rest, ctx);
      case "js":
        return await runJavaScript(rest);
      default:
        return commandError(`Unknown page command: ${subcommand}\n${PAGE_USAGE}`);
    }
  } catch (error) {
    return commandError(`page ${subcommand}: ${errorMessage(error)}`);
  }
}

async function runSnapshot(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_SNAPSHOT_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const json = parsed.value.args.includes("--json");
  const dom = parsed.value.args.includes("--dom");
  const snapshotArgs = parsed.value.args.filter((arg) => arg !== "--json" && arg !== "--dom");
  const invalid = firstUnknownOption(snapshotArgs);
  if (invalid) {
    return commandError(`${PAGE_SNAPSHOT_USAGE}\nUnknown option: ${invalid}`);
  }

  const tab = await resolveTab(parsed.value.tabId);
  if (!dom && snapshotArgs.length > 0) {
    return commandError(`${PAGE_SNAPSHOT_USAGE}\nUse --dom when providing a CSS selector.`);
  }
  if (!dom) {
    let target: chrome.debugger.DebuggerSession | null = null;
    try {
      throwIfAborted(ctx.abortSignal);
      target = await acquireDebugger(tab.id);
      throwIfAborted(ctx.abortSignal);
      const snapshot = await captureSemanticSnapshot(target, tab);
      throwIfAborted(ctx.abortSignal);
      return json
        ? commandCompactJson(snapshot)
        : commandOk(formatSemanticSnapshot(snapshot));
    } finally {
      if (target) {
        await releaseDebugger(tab.id).catch((error: unknown) => {
          console.warn("GSV browser target failed to detach debugger", error);
        });
      }
    }
  }

  const selector = joinArgsOrNull(snapshotArgs);
  const result = normalizeInjectedResult<unknown>(
    await executeInTab<unknown>(tab.id, snapshotDomPage, [selector]),
    "page snapshot",
  );
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandCompactJson({ tabId: tab.id, selector, snapshot: result.value });
}

async function runText(args: string[]): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_TEXT_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const invalid = firstUnknownOption(parsed.value.args);
  if (invalid) {
    return commandError(`${PAGE_TEXT_USAGE}\nUnknown option: ${invalid}`);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const selector = joinArgsOrNull(parsed.value.args);
  const result = normalizeInjectedResult<{ text: string; count: number }>(
    await executeInTab<unknown>(tab.id, readPageText, [selector]),
    "page text",
  );
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandOk(ensureTrailingNewline(result.value.text));
}

async function runScreenshot(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_SCREENSHOT_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  if (parsed.value.args.length > 0) {
    return commandError(PAGE_SCREENSHOT_USAGE);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const png = await captureTabPng(tab.id);
  const capturedAt = new Date(ctx.now()).toISOString();
  const path = [
    "/home/browser/screenshots/tab-",
    String(tab.id),
    "-",
    capturedAt.replace(/\D/g, "").slice(0, 14),
    ".png",
  ].join("");
  await ctx.fs.write(path, png, "image/png");

  return commandCompactJson({
    tabId: tab.id,
    path,
    capturedAt,
    mimeType: "image/png",
    byteLength: png.byteLength,
    persisted: true,
  });
}

async function runClick(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_CLICK_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const invalid = firstUnknownOption(parsed.value.args);
  if (invalid) {
    return commandError(`${PAGE_CLICK_USAGE}\nUnknown option: ${invalid}`);
  }

  const click = parseSelectorAndOptionalIndex(parsed.value.args);
  if (!click.ok) {
    return commandError(click.error);
  }

  const locator = pageLocator(click.value.selector, click.value.index);
  const tab = await resolveLocatorTab(parsed.value.tabId, locator);
  const result = await clickPageElement(tab.id, locator, ctx.abortSignal);
  return commandCompactJson({ tabId: tab.id, ...result });
}

async function runType(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_TYPE_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const typed = parseTypeArgs(parsed.value.args);
  if (!typed.ok) {
    return commandError(typed.error);
  }

  const locator = pageLocator(typed.value.selector, 0);
  const tab = await resolveLocatorTab(parsed.value.tabId, locator);
  const result = await typePageText(tab.id, locator, typed.value.text, ctx.abortSignal);
  return commandCompactJson({ tabId: tab.id, ...result });
}

async function runKey(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_KEY_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const invalid = firstUnknownOption(parsed.value.args);
  if (invalid) {
    return commandError(`${PAGE_KEY_USAGE}\nUnknown option: ${invalid}`);
  }
  if (parsed.value.args.length !== 1) {
    return commandError(PAGE_KEY_USAGE);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const result = await sendPageKey(tab.id, parsed.value.args[0] ?? "", ctx.abortSignal);
  return commandCompactJson({ tabId: tab.id, ...result });
}

async function runScroll(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_SCROLL_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const invalid = firstUnknownOption(parsed.value.args);
  if (invalid) {
    return commandError(`${PAGE_SCROLL_USAGE}\nUnknown option: ${invalid}`);
  }
  if (parsed.value.args.length !== 1 && parsed.value.args.length !== 2) {
    return commandError(PAGE_SCROLL_USAGE);
  }

  const referenceText = parsed.value.args.length === 2 ? parsed.value.args[0] ?? "" : "";
  if (referenceText && !isPageReference(referenceText)) {
    return commandError(`${PAGE_SCROLL_USAGE}\nA targeted scroll requires a page snapshot ref.`);
  }
  const targetText = parsed.value.args[parsed.value.args.length - 1] ?? "";
  const target = parseScrollTarget(targetText);
  if (!target.ok) {
    return commandError(target.error);
  }

  const reference = referenceText ? pageReferences.resolve(referenceText) : null;
  const tab = reference
    ? await resolveReferencedTab(parsed.value.tabId, reference.tabId, reference.ref)
    : await resolveTab(parsed.value.tabId);
  const result = await scrollPage(tab.id, target.value, reference, ctx.abortSignal);
  return commandCompactJson({ tabId: tab.id, ...result });
}

async function runWait(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseWaitOptions(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const invalid = firstUnknownOption(parsed.value.args);
  if (invalid) {
    return commandError(`${PAGE_WAIT_USAGE}\nUnknown option: ${invalid}`);
  }

  const selector = parsed.value.args.join(" ").trim();
  if (!selector) {
    return commandError(PAGE_WAIT_USAGE);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const startedAt = ctx.now();

  while (true) {
    const result = normalizeInjectedResult<Record<string, unknown> | null>(
      await abortable(
        executeInTab<unknown>(tab.id, findPageSelector, [selector]),
        ctx.abortSignal,
      ),
      "page wait",
    );
    if (!result.ok) {
      return commandError(result.error);
    }

    const elapsedMs = ctx.now() - startedAt;
    if (result.value) {
      return commandCompactJson({
        tabId: tab.id,
        wait: { selector, elapsedMs, element: result.value },
      });
    }
    if (elapsedMs >= parsed.value.timeoutMs) {
      return commandError(`Timed out after ${parsed.value.timeoutMs}ms waiting for selector: ${selector}`);
    }

    await abortableDelay(Math.min(100, parsed.value.timeoutMs - elapsedMs), ctx.abortSignal);
  }
}

async function runJavaScript(args: string[]): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_JS_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }

  const source = parsed.value.args.join(" ").trim();
  if (!source) {
    return commandError(PAGE_JS_USAGE);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const result = await evaluatePageJavaScript(tab.id, source);
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandCompactJson({ tabId: tab.id, js: result.value });
}

function normalizeInjectedResult<T>(value: unknown, command: string): InjectedPageResult<T> {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  ) {
    return value as InjectedPageResult<T>;
  }
  return {
    ok: false,
    error: `${command} returned an invalid injected result: ${describeInjectedValue(value)}`,
  };
}

function describeInjectedValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "object";
    }
  }
  return String(value);
}

function parsePageOptions(args: string[], usage: string): Parsed<PageOptions> {
  const { value, rest } = splitOption(args, "--tab");
  const tabId = parseOptionalPositiveInteger(value, "tabId", usage);
  if (!tabId.ok) {
    return { ok: false, error: tabId.error };
  }
  return { ok: true, value: { tabId: tabId.value, args: rest } };
}

function parseWaitOptions(args: string[]): Parsed<PageOptions & { timeoutMs: number }> {
  const tabSplit = splitOption(args, "--tab");
  const timeoutSplit = splitOption(tabSplit.rest, "--timeout");
  const tabId = parseOptionalPositiveInteger(tabSplit.value, "tabId", PAGE_WAIT_USAGE);
  if (!tabId.ok) {
    return { ok: false, error: tabId.error };
  }
  const timeoutMs = parseOptionalTimeout(timeoutSplit.value);
  if (!timeoutMs.ok) {
    return { ok: false, error: timeoutMs.error };
  }
  return {
    ok: true,
    value: {
      tabId: tabId.value,
      timeoutMs: timeoutMs.value,
      args: timeoutSplit.rest,
    },
  };
}

function parseSelectorAndOptionalIndex(args: string[]): Parsed<{ selector: string; index: number }> {
  if (args.length === 0) {
    return { ok: false, error: PAGE_CLICK_USAGE };
  }

  let index = 0;
  let selectorArgs = args;
  const last = args[args.length - 1] ?? "";
  if (args.length > 1 && /^-?\d+$/.test(last)) {
    const parsed = parseInteger(last);
    if (parsed === null || parsed < 0) {
      return { ok: false, error: `${PAGE_CLICK_USAGE}\nindex must be a non-negative integer` };
    }
    index = parsed;
    selectorArgs = args.slice(0, -1);
  }

  const selector = selectorArgs.join(" ").trim();
  if (!selector) {
    return { ok: false, error: PAGE_CLICK_USAGE };
  }
  return { ok: true, value: { selector, index } };
}

function parseTypeArgs(args: string[]): Parsed<{ selector: string; text: string }> {
  if (args.length < 2) {
    return { ok: false, error: PAGE_TYPE_USAGE };
  }
  const selector = args[0] ?? "";
  const text = args.slice(1).join(" ");
  if (!selector || text.length === 0) {
    return { ok: false, error: PAGE_TYPE_USAGE };
  }
  return { ok: true, value: { selector, text } };
}

function parseScrollTarget(value: string): Parsed<PageScrollTarget> {
  const normalized = value.toLowerCase();
  if (normalized === "up" || normalized === "down" || normalized === "top" || normalized === "bottom") {
    return { ok: true, value: normalized };
  }

  const parts = value.split(",");
  if (parts.length === 2) {
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { ok: true, value: { x, y } };
    }
  }
  return { ok: false, error: PAGE_SCROLL_USAGE };
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

function parseOptionalTimeout(value: string | null): Parsed<number> {
  if (value === null) {
    return { ok: true, value: DEFAULT_WAIT_TIMEOUT_MS };
  }
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0 || parsed > MAX_WAIT_TIMEOUT_MS) {
    return {
      ok: false,
      error: `${PAGE_WAIT_USAGE}\ntimeout must be an integer from 1 to ${MAX_WAIT_TIMEOUT_MS}`,
    };
  }
  return { ok: true, value: parsed };
}

async function resolveTab(tabId: number | null): Promise<TabSummary> {
  if (tabId !== null) {
    const tab = await getTab(tabId);
    if (!tab) {
      throw new Error(`tab not found: ${tabId}`);
    }
    return tab;
  }

  const tab = await activeTab();
  if (!tab) {
    throw new Error("no active tab");
  }
  return tab;
}

function pageLocator(value: string, index: number): PageLocator {
  if (!isPageReference(value)) {
    return { kind: "selector", selector: value, index };
  }
  if (index !== 0) {
    throw new Error("Snapshot refs do not accept a selector index");
  }
  return { kind: "reference", reference: pageReferences.resolve(value) };
}

async function resolveLocatorTab(tabId: number | null, locator: PageLocator): Promise<TabSummary> {
  if (locator.kind === "selector") {
    return await resolveTab(tabId);
  }
  return await resolveReferencedTab(tabId, locator.reference.tabId, locator.reference.ref);
}

async function resolveReferencedTab(
  requestedTabId: number | null,
  referencedTabId: number,
  ref: string,
): Promise<TabSummary> {
  if (requestedTabId !== null && requestedTabId !== referencedTabId) {
    throw new Error(`Reference ${ref} belongs to tab ${referencedTabId}, not tab ${requestedTabId}`);
  }
  const tab = await getTab(referencedTabId);
  if (!tab) {
    throw new Error(`tab not found for reference ${ref}: ${referencedTabId}`);
  }
  return tab;
}

function pageUsageFor(subcommand: string): string {
  switch (subcommand) {
    case "snapshot":
      return PAGE_SNAPSHOT_USAGE;
    case "text":
      return PAGE_TEXT_USAGE;
    case "screenshot":
      return PAGE_SCREENSHOT_USAGE;
    case "click":
      return PAGE_CLICK_USAGE;
    case "type":
      return PAGE_TYPE_USAGE;
    case "key":
      return PAGE_KEY_USAGE;
    case "scroll":
      return PAGE_SCROLL_USAGE;
    case "wait":
      return PAGE_WAIT_USAGE;
    case "js":
      return PAGE_JS_USAGE;
    default:
      return PAGE_USAGE;
  }
}

function commandCompactJson(value: unknown): CommandResult {
  return commandOk(`${JSON.stringify(value)}\n`);
}

function firstUnknownOption(args: readonly string[]): string | null {
  return args.find((arg) => arg.startsWith("--") && arg !== "--") ?? null;
}

function joinArgsOrNull(args: string[]): string | null {
  const value = args.join(" ").trim();
  return value ? value : null;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
