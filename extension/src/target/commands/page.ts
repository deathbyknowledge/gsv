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
  sendDebuggerCommand,
} from "../../shared/debugger";
import { abortable, abortableDelay } from "../abort";
import type { BrowserCommand, CommandContext, CommandResult } from "../types";
import { commandError, commandOk } from "../types";
import { hasHelpFlag, parseInteger, splitOption } from "./args";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
type InjectedResult<T> = { ok: true; value: T } | { ok: false; error: string };
type PageOptions = { tabId: number | null; args: string[] };
type ScrollTarget = "up" | "down" | "top" | "bottom" | { x: number; y: number };

const PAGE_USAGE = [
  "Usage: page <snapshot|text|screenshot|click|type|key|scroll|wait|js> [args]",
  "       page snapshot [--tab <tabId>] [selector]",
  "       page text [--tab <tabId>] [selector]",
  "       page screenshot [--tab <tabId>]",
  "       page click [--tab <tabId>] <selector> [index]",
  "       page type [--tab <tabId>] <selector> <text>",
  "       page key [--tab <tabId>] <key>",
  "       page scroll [--tab <tabId>] <up|down|top|bottom|x,y>",
  "       page wait [--tab <tabId>] <selector> [--timeout ms]",
  "       page js [--tab <tabId>] <source>",
].join("\n");

const PAGE_SNAPSHOT_USAGE = "Usage: page snapshot [--tab <tabId>] [selector]";
const PAGE_TEXT_USAGE = "Usage: page text [--tab <tabId>] [selector]";
const PAGE_SCREENSHOT_USAGE = "Usage: page screenshot [--tab <tabId>]";
const PAGE_CLICK_USAGE = "Usage: page click [--tab <tabId>] <selector> [index]";
const PAGE_TYPE_USAGE = "Usage: page type [--tab <tabId>] <selector> <text>";
const PAGE_KEY_USAGE = "Usage: page key [--tab <tabId>] <key>";
const PAGE_SCROLL_USAGE = "Usage: page scroll [--tab <tabId>] <up|down|top|bottom|x,y>";
const PAGE_WAIT_USAGE = "Usage: page wait [--tab <tabId>] <selector> [--timeout ms]";
const PAGE_JS_USAGE = "Usage: page js [--tab <tabId>] <source>";

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const DEBUGGER_EVALUATE_TIMEOUT_MS = 30_000;

type RuntimeRemoteObject = {
  type?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
};

type RuntimeExceptionDetails = {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: RuntimeRemoteObject;
};

type RuntimeEvaluateResult = {
  result?: RuntimeRemoteObject;
  exceptionDetails?: RuntimeExceptionDetails;
};

const DEBUGGER_SERIALIZER_FUNCTION = String.raw`function() {
  function summarizeElement(element) {
    const rect = element.getBoundingClientRect();
    const attrs = {};
    for (const name of ["id", "role", "aria-label", "name", "type", "href", "title"]) {
      const value = element.getAttribute(name);
      if (value) {
        attrs[name] = value;
      }
    }
    return {
      tag: element.tagName.toLowerCase(),
      text: ((element.innerText || element.textContent || "")).replace(/\s+/g, " ").trim().slice(0, 160),
      attrs,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function serialize(value, depth, seen) {
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      return value.length > 5000 ? value.slice(0, 4999) + "..." : value;
    }
    if (typeof value === "undefined") {
      return { type: "undefined" };
    }
    if (typeof value === "bigint") {
      return { type: "bigint", value: value.toString() };
    }
    if (typeof value === "symbol") {
      return { type: "symbol", value: String(value) };
    }
    if (typeof value === "function") {
      return { type: "function", name: value.name || undefined };
    }
    if (value instanceof Error) {
      return {
        type: "error",
        name: value.name,
        message: value.message,
        stack: value.stack ? value.stack.slice(0, 2000) : undefined
      };
    }
    if (value instanceof Element) {
      return { type: "element", ...summarizeElement(value) };
    }
    if (value instanceof Node) {
      return {
        type: "node",
        nodeType: value.nodeType,
        nodeName: value.nodeName,
        text: (value.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)
      };
    }
    if (typeof value !== "object") {
      return String(value);
    }
    if (seen.indexOf(value) >= 0) {
      return { type: "circular" };
    }
    if (depth >= 4) {
      return { type: Array.isArray(value) ? "array" : "object", truncated: true };
    }

    const nextSeen = seen.concat([value]);
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        items: value.slice(0, 50).map((item) => serialize(item, depth + 1, nextSeen)),
        truncatedItems: Math.max(0, value.length - 50)
      };
    }

    const keys = Object.keys(value);
    const objectValue = {};
    for (const key of keys.slice(0, 50)) {
      try {
        objectValue[key] = serialize(value[key], depth + 1, nextSeen);
      } catch (error) {
        objectValue[key] = { type: "thrown", error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (keys.length > 50) {
      objectValue.truncatedKeys = keys.length - 50;
    }
    return objectValue;
  }

  return serialize(this, 0, []);
}`;

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
        return await runSnapshot(rest);
      case "text":
        return await runText(rest);
      case "screenshot":
        return await runScreenshot(rest, ctx);
      case "click":
        return await runClick(rest);
      case "type":
        return await runType(rest);
      case "key":
        return await runKey(rest);
      case "scroll":
        return await runScroll(rest);
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

async function runSnapshot(args: string[]): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_SNAPSHOT_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const invalid = firstUnknownOption(parsed.value.args);
  if (invalid) {
    return commandError(`${PAGE_SNAPSHOT_USAGE}\nUnknown option: ${invalid}`);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const selector = joinArgsOrNull(parsed.value.args);
  const result = normalizeInjectedResult<unknown>(
    await executeInTab<unknown>(tab.id, injectedSnapshotPage, [selector]),
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
    await executeInTab<unknown>(tab.id, injectedReadText, [selector]),
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

async function runClick(args: string[]): Promise<CommandResult> {
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

  const tab = await resolveTab(parsed.value.tabId);
  const result = normalizeInjectedResult<unknown>(
    await executeInTab<unknown>(tab.id, injectedClickElement, [click.value.selector, click.value.index]),
    "page click",
  );
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandCompactJson({ tabId: tab.id, clicked: result.value });
}

async function runType(args: string[]): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_TYPE_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const typed = parseTypeArgs(parsed.value.args);
  if (!typed.ok) {
    return commandError(typed.error);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const result = normalizeInjectedResult<unknown>(
    await executeInTab<unknown>(tab.id, injectedTypeText, [typed.value.selector, typed.value.text]),
    "page type",
  );
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandCompactJson({ tabId: tab.id, typed: result.value });
}

async function runKey(args: string[]): Promise<CommandResult> {
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
  const result = normalizeInjectedResult<unknown>(
    await executeInTab<unknown>(tab.id, injectedSendKey, [parsed.value.args[0]]),
    "page key",
  );
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandCompactJson({ tabId: tab.id, key: result.value });
}

async function runScroll(args: string[]): Promise<CommandResult> {
  const parsed = parsePageOptions(args, PAGE_SCROLL_USAGE);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const invalid = firstUnknownOption(parsed.value.args);
  if (invalid) {
    return commandError(`${PAGE_SCROLL_USAGE}\nUnknown option: ${invalid}`);
  }
  if (parsed.value.args.length !== 1) {
    return commandError(PAGE_SCROLL_USAGE);
  }

  const target = parseScrollTarget(parsed.value.args[0] ?? "");
  if (!target.ok) {
    return commandError(target.error);
  }

  const tab = await resolveTab(parsed.value.tabId);
  const result = normalizeInjectedResult<unknown>(
    await executeInTab<unknown>(tab.id, injectedScrollPage, [target.value]),
    "page scroll",
  );
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandCompactJson({ tabId: tab.id, scroll: result.value });
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
        executeInTab<unknown>(tab.id, injectedFindSelector, [selector]),
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
  const result = await evaluateJavaScriptWithDebugger(tab.id, source);
  if (!result.ok) {
    return commandError(result.error);
  }
  return commandCompactJson({ tabId: tab.id, js: result.value });
}

async function evaluateJavaScriptWithDebugger(tabId: number, source: string): Promise<InjectedResult<unknown>> {
  let target: chrome.debugger.DebuggerSession | null = null;

  try {
    target = await acquireDebugger(tabId);
    await sendDebuggerCommand(target, "Runtime.enable");

    let result = await runtimeEvaluate(target, source);
    if (isSyntaxException(result.exceptionDetails)) {
      const syncWrapped = await runtimeEvaluate(target, `(() => {\n${source}\n})()`);
      if (!syncWrapped.exceptionDetails || !isSyntaxException(syncWrapped.exceptionDetails)) {
        result = syncWrapped;
      } else {
        const asyncWrapped = await runtimeEvaluate(target, `(async () => {\n${source}\n})()`);
        result = asyncWrapped;
      }
    }

    if (isSyntaxException(result.exceptionDetails)) {
      const parenthesized = await runtimeEvaluate(target, `(${source})`);
      if (!parenthesized.exceptionDetails) {
        result = parenthesized;
      }
    }

    if (result.exceptionDetails) {
      return { ok: false, error: formatRuntimeException(result.exceptionDetails) };
    }
    if (!result.result) {
      return { ok: false, error: "Runtime.evaluate returned no result" };
    }

    return {
      ok: true,
      value: {
        result: await serializeRuntimeRemoteObject(target, result.result),
      },
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    if (target) {
      try {
        await releaseDebugger(tabId);
      } catch (error) {
        console.warn("GSV browser target failed to detach debugger", error);
      }
    }
  }
}

async function runtimeEvaluate(
  target: chrome.debugger.DebuggerSession,
  expression: string,
): Promise<RuntimeEvaluateResult> {
  return await sendDebuggerCommand<RuntimeEvaluateResult>(target, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: false,
    generatePreview: true,
    userGesture: true,
    timeout: DEBUGGER_EVALUATE_TIMEOUT_MS,
    replMode: true,
  }) as RuntimeEvaluateResult;
}

async function serializeRuntimeRemoteObject(
  target: chrome.debugger.DebuggerSession,
  remote: RuntimeRemoteObject,
): Promise<unknown> {
  if (!remote.objectId) {
    return remoteObjectLiteral(remote);
  }

  try {
    const raw = await sendDebuggerCommand<RuntimeEvaluateResult>(target, "Runtime.callFunctionOn", {
      objectId: remote.objectId,
      functionDeclaration: DEBUGGER_SERIALIZER_FUNCTION,
      returnByValue: true,
      silent: true,
    }) as RuntimeEvaluateResult;
    if (raw.exceptionDetails) {
      return {
        type: remote.type ?? "object",
        subtype: remote.subtype,
        className: remote.className,
        description: remote.description,
        serializationError: formatRuntimeException(raw.exceptionDetails),
      };
    }
    return raw.result ? remoteObjectLiteral(raw.result) : remoteObjectLiteral(remote);
  } finally {
    try {
      await sendDebuggerCommand(target, "Runtime.releaseObject", {
        objectId: remote.objectId,
      });
    } catch {
      // The target may have navigated or closed; releasing is best-effort.
    }
  }
}

function remoteObjectLiteral(remote: RuntimeRemoteObject): unknown {
  if (Object.prototype.hasOwnProperty.call(remote, "value")) {
    return remote.value;
  }
  if (remote.unserializableValue) {
    return { type: remote.type ?? "unserializable", value: remote.unserializableValue };
  }
  if (remote.type === "undefined") {
    return { type: "undefined" };
  }
  return omitUndefined({
    type: remote.type,
    subtype: remote.subtype,
    className: remote.className,
    description: remote.description,
  });
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function formatRuntimeException(details: RuntimeExceptionDetails): string {
  const remote = details.exception;
  const message = String(
    remote?.description
      ?? remote?.value
      ?? details.text
      ?? "JavaScript evaluation failed",
  );
  const location = typeof details.lineNumber === "number" && typeof details.columnNumber === "number"
    ? ` at ${details.lineNumber + 1}:${details.columnNumber + 1}`
    : "";
  return `${message}${location}`;
}

function isSyntaxException(details: RuntimeExceptionDetails | undefined): boolean {
  const remote = details?.exception;
  return remote?.className === "SyntaxError"
    || remote?.description?.startsWith("SyntaxError") === true
    || String(remote?.value ?? details?.text ?? "").startsWith("SyntaxError");
}

function normalizeInjectedResult<T>(value: unknown, command: string): InjectedResult<T> {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  ) {
    return value as InjectedResult<T>;
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

function parseScrollTarget(value: string): Parsed<ScrollTarget> {
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

function injectedSnapshotPage(selector: unknown): InjectedResult<unknown> {
  try {
    const selectorText = typeof selector === "string" && selector.trim() ? selector.trim() : null;
    const root = selectorText ? document.querySelector(selectorText) : document.body ?? document.documentElement;
    if (!root) {
      return { ok: false, error: selectorText ? `No element matches selector: ${selectorText}` : "No document root" };
    }

    const maxDepth = 4;
    const maxChildren = 8;
    const maxTextLength = 180;
    const skippedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK"]);

    function compactText(element: Element): string | undefined {
      const raw = ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw) {
        return undefined;
      }
      return raw.length > maxTextLength ? `${raw.slice(0, maxTextLength - 1)}...` : raw;
    }

    function roleFor(element: Element): string | undefined {
      const explicit = element.getAttribute("role");
      if (explicit) {
        return explicit;
      }
      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) {
        return "link";
      }
      if (tag === "button") {
        return "button";
      }
      if (tag === "textarea") {
        return "textbox";
      }
      if (tag === "select") {
        return "combobox";
      }
      if (tag === "img") {
        return "img";
      }
      if (tag === "input") {
        const type = (element.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          return type;
        }
        if (type === "button" || type === "submit" || type === "reset") {
          return "button";
        }
        return "textbox";
      }
      return undefined;
    }

    function attrsFor(element: Element): Record<string, string | boolean> | undefined {
      const attrs: Record<string, string | boolean> = {};
      for (const name of [
        "id",
        "aria-label",
        "aria-labelledby",
        "aria-describedby",
        "title",
        "alt",
        "name",
        "type",
        "placeholder",
        "href",
      ]) {
        const value = element.getAttribute(name);
        if (value) {
          attrs[name] = value.length > 160 ? `${value.slice(0, 159)}...` : value;
        }
      }
      if (element instanceof HTMLInputElement && element.checked) {
        attrs.checked = true;
      }
      if (
        (element instanceof HTMLInputElement ||
          element instanceof HTMLButtonElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement) &&
        element.disabled
      ) {
        attrs.disabled = true;
      }
      if (element.hasAttribute("aria-expanded")) {
        attrs["aria-expanded"] = element.getAttribute("aria-expanded") || "";
      }
      return Object.keys(attrs).length > 0 ? attrs : undefined;
    }

    function boundsFor(element: Element): Record<string, number> {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    function isVisible(element: Element): boolean {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || Boolean((element.textContent || "").trim());
    }

    function snapshotElement(element: Element, depth: number): Record<string, unknown> {
      const childElements = Array.from(element.children)
        .filter((child) => !skippedTags.has(child.tagName))
        .filter((child) => depth === 0 || isVisible(child));
      const visibleChildren = childElements.slice(0, maxChildren);
      const node: Record<string, unknown> = { tag: element.tagName.toLowerCase() };
      const text = compactText(element);
      const role = roleFor(element);
      const attrs = attrsFor(element);

      if (text) {
        node.text = text;
      }
      if (role) {
        node.role = role;
      }
      if (attrs) {
        node.attrs = attrs;
      }
      node.bounds = boundsFor(element);
      if (depth < maxDepth && visibleChildren.length > 0) {
        node.children = visibleChildren.map((child) => snapshotElement(child, depth + 1));
      }
      if (childElements.length > maxChildren) {
        node.truncatedChildren = childElements.length - maxChildren;
      }
      return node;
    }

    return {
      ok: true,
      value: {
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
        },
        root: snapshotElement(root, 0),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function injectedReadText(selector: unknown): InjectedResult<{ text: string; count: number }> {
  try {
    const selectorText = typeof selector === "string" && selector.trim() ? selector.trim() : null;
    const elements = selectorText
      ? Array.from(document.querySelectorAll(selectorText))
      : [document.body ?? document.documentElement].filter(Boolean);
    if (elements.length === 0) {
      return { ok: false, error: `No element matches selector: ${selectorText}` };
    }
    const text = elements
      .map((element) => ((element as HTMLElement).innerText || element.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");
    return { ok: true, value: { text, count: elements.length } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function injectedClickElement(selector: unknown, index: unknown): InjectedResult<unknown> {
  function summarizeElement(element: Element): Record<string, unknown> {
    const rect = element.getBoundingClientRect();
    const attrs: Record<string, string> = {};
    for (const name of ["id", "role", "aria-label", "name", "type", "href", "title"]) {
      const value = element.getAttribute(name);
      if (value) {
        attrs[name] = value;
      }
    }
    return {
      tag: element.tagName.toLowerCase(),
      text: ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
      attrs,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  try {
    const selectorText = typeof selector === "string" ? selector : "";
    const targetIndex = typeof index === "number" && Number.isInteger(index) ? index : 0;
    const matches = Array.from(document.querySelectorAll(selectorText));
    if (matches.length === 0) {
      return { ok: false, error: `No element matches selector: ${selectorText}` };
    }
    const element = matches[targetIndex];
    if (!element) {
      return { ok: false, error: `Selector matched ${matches.length} element(s), index ${targetIndex} is out of range` };
    }

    element.scrollIntoView({ block: "center", inline: "center" });
    if (element instanceof HTMLElement) {
      element.focus({ preventScroll: true });
    }
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    element.dispatchEvent(new MouseEvent("mouseover", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    if (element instanceof HTMLElement) {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent("click", eventInit));
    }

    return {
      ok: true,
      value: {
        index: targetIndex,
        matches: matches.length,
        element: summarizeElement(element),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function injectedTypeText(selector: unknown, text: unknown): InjectedResult<unknown> {
  function isTextInput(input: HTMLInputElement): boolean {
    const type = (input.type || "text").toLowerCase();
    return !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(type);
  }

  function resolveEditable(element: Element): HTMLElement | HTMLInputElement | HTMLTextAreaElement | null {
    if (element instanceof HTMLInputElement && isTextInput(element)) {
      return element;
    }
    if (element instanceof HTMLTextAreaElement) {
      return element;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return element;
    }
    const child = element.querySelector("input, textarea, [contenteditable=''], [contenteditable='true']");
    if (!child) {
      return null;
    }
    if (child instanceof HTMLInputElement && isTextInput(child)) {
      return child;
    }
    if (child instanceof HTMLTextAreaElement) {
      return child;
    }
    if (child instanceof HTMLElement && child.isContentEditable) {
      return child;
    }
    return null;
  }

  function insertIntoInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const start = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === "number" ? input.selectionEnd : start;
    try {
      input.setRangeText(value, start, end, "end");
    } catch {
      input.value = `${input.value.slice(0, start)}${value}${input.value.slice(end)}`;
      const next = start + value.length;
      input.selectionStart = next;
      input.selectionEnd = next;
    }
  }

  function insertIntoContentEditable(element: HTMLElement, value: string): void {
    const selection = window.getSelection();
    if (!selection) {
      element.append(document.createTextNode(value));
      return;
    }
    if (selection.rangeCount === 0 || !element.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function fireInputEvents(element: HTMLElement, value: string): void {
    try {
      element.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: "insertText",
      }));
    } catch {
      element.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    }
    try {
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertText",
      }));
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function summarizeEditable(element: HTMLElement): Record<string, unknown> {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      name: element.getAttribute("name") || undefined,
      type: element.getAttribute("type") || undefined,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  try {
    const selectorText = typeof selector === "string" ? selector : "";
    const textValue = typeof text === "string" ? text : String(text ?? "");
    const root = document.querySelector(selectorText);
    if (!root) {
      return { ok: false, error: `No element matches selector: ${selectorText}` };
    }

    const editable = resolveEditable(root);
    if (!editable) {
      return { ok: false, error: `Element is not editable: ${selectorText}` };
    }
    if ("disabled" in editable && Boolean((editable as HTMLInputElement | HTMLTextAreaElement).disabled)) {
      return { ok: false, error: "Editable element is disabled" };
    }
    if ("readOnly" in editable && Boolean((editable as HTMLInputElement | HTMLTextAreaElement).readOnly)) {
      return { ok: false, error: "Editable element is read-only" };
    }

    editable.scrollIntoView({ block: "center", inline: "center" });
    editable.focus({ preventScroll: true });

    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      insertIntoInput(editable, textValue);
      fireInputEvents(editable, textValue);
      return {
        ok: true,
        value: {
          element: summarizeEditable(editable),
          textLength: textValue.length,
          valueLength: editable.value.length,
        },
      };
    }

    insertIntoContentEditable(editable, textValue);
    fireInputEvents(editable, textValue);
    return {
      ok: true,
      value: {
        element: summarizeEditable(editable),
        textLength: textValue.length,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function injectedSendKey(key: unknown): InjectedResult<unknown> {
  function parseKey(rawKey: string): {
    key: string;
    code: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  } {
    const parts = rawKey.split("+").map((part) => part.trim()).filter(Boolean);
    const keyPart = parts.pop() || rawKey;
    const modifiers = new Set(parts.map((part) => part.toLowerCase()));
    const normalized = keyPart.toLowerCase();
    const aliases: Record<string, { key: string; code: string }> = {
      esc: { key: "Escape", code: "Escape" },
      escape: { key: "Escape", code: "Escape" },
      enter: { key: "Enter", code: "Enter" },
      return: { key: "Enter", code: "Enter" },
      tab: { key: "Tab", code: "Tab" },
      space: { key: " ", code: "Space" },
      backspace: { key: "Backspace", code: "Backspace" },
      delete: { key: "Delete", code: "Delete" },
      arrowup: { key: "ArrowUp", code: "ArrowUp" },
      up: { key: "ArrowUp", code: "ArrowUp" },
      arrowdown: { key: "ArrowDown", code: "ArrowDown" },
      down: { key: "ArrowDown", code: "ArrowDown" },
      arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
      left: { key: "ArrowLeft", code: "ArrowLeft" },
      arrowright: { key: "ArrowRight", code: "ArrowRight" },
      right: { key: "ArrowRight", code: "ArrowRight" },
    };
    const mapped = aliases[normalized] ?? {
      key: keyPart,
      code: keyPart.length === 1 ? `Key${keyPart.toUpperCase()}` : keyPart,
    };
    return {
      ...mapped,
      ctrlKey: modifiers.has("ctrl") || modifiers.has("control"),
      shiftKey: modifiers.has("shift"),
      altKey: modifiers.has("alt") || modifiers.has("option"),
      metaKey: modifiers.has("meta") || modifiers.has("cmd") || modifiers.has("command"),
    };
  }

  try {
    const raw = typeof key === "string" ? key : "";
    if (!raw.trim()) {
      return { ok: false, error: "Key is required" };
    }
    const parsed = parseKey(raw);
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    if (!target) {
      return { ok: false, error: "No key event target is available" };
    }

    const eventInit = {
      key: parsed.key,
      code: parsed.code,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: parsed.ctrlKey,
      shiftKey: parsed.shiftKey,
      altKey: parsed.altKey,
      metaKey: parsed.metaKey,
    };
    const keydown = new KeyboardEvent("keydown", eventInit);
    const keyup = new KeyboardEvent("keyup", eventInit);
    const keydownDefaultAllowed = target.dispatchEvent(keydown);
    const keyupDefaultAllowed = target.dispatchEvent(keyup);

    return {
      ok: true,
      value: {
        key: parsed.key,
        code: parsed.code,
        target: target.tagName.toLowerCase(),
        keydownDefaultAllowed,
        keyupDefaultAllowed,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function injectedScrollPage(target: unknown): InjectedResult<unknown> {
  try {
    const maxX = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - window.innerWidth;
    const maxY = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) - window.innerHeight;

    if (typeof target === "string") {
      if (target === "up") {
        window.scrollBy(0, -Math.max(1, Math.floor(window.innerHeight * 0.85)));
      } else if (target === "down") {
        window.scrollBy(0, Math.max(1, Math.floor(window.innerHeight * 0.85)));
      } else if (target === "top") {
        window.scrollTo(window.scrollX, 0);
      } else if (target === "bottom") {
        window.scrollTo(window.scrollX, Math.max(0, maxY));
      } else {
        return { ok: false, error: "Invalid scroll target" };
      }
    } else if (
      target &&
      typeof target === "object" &&
      typeof (target as { x?: unknown }).x === "number" &&
      typeof (target as { y?: unknown }).y === "number"
    ) {
      window.scrollTo((target as { x: number }).x, (target as { y: number }).y);
    } else {
      return { ok: false, error: "Invalid scroll target" };
    }

    return {
      ok: true,
      value: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        maxX: Math.max(0, Math.round(maxX)),
        maxY: Math.max(0, Math.round(maxY)),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function injectedFindSelector(selector: unknown): InjectedResult<Record<string, unknown> | null> {
  const selectorText = typeof selector === "string" ? selector : "";

  function summarizeElement(element: Element): Record<string, unknown> {
    const rect = element.getBoundingClientRect();
    const attrs: Record<string, string> = {};
    for (const name of ["id", "role", "aria-label", "name", "type", "href", "title"]) {
      const value = element.getAttribute(name);
      if (value) {
        attrs[name] = value;
      }
    }
    return {
      tag: element.tagName.toLowerCase(),
      text: ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
      attrs,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  try {
    const element = document.querySelector(selectorText);
    return { ok: true, value: element ? summarizeElement(element) : null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
