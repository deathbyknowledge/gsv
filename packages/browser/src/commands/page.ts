import type { BrowserPageBackend, DebuggerBackend, TabSummary } from "../backend";
import { abortable, abortableDelay, throwIfAborted } from "../abort";
import { findPageSelector, readPageText, snapshotDomPage, type InjectedPageResult } from "../page-dom";
import { createPageActions, type PageLocator, type PageScrollTarget } from "../page-actions";
import { findSemanticReference } from "../page-locators";
import { createPageSemantics, formatSemanticSnapshot, normalizePageReference, PageReferenceStore, type SemanticSnapshot } from "../page-semantics";
import { createPageJavaScript } from "../page-javascript";
import type { BrowserCommand, CommandContext, CommandResult } from "../types";
import { commandError, commandOk } from "../types";
import { hasHelpFlag, parseInteger, splitOption } from "./args";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
type PageOptions = { tabId: number | null; args: string[] };
type ActionInspection = { snapshot: SemanticSnapshot } | { snapshotError: string };

const PAGE_USAGE = [
  "Usage: page <snapshot|text|screenshot|click|fill|select|check|type|key|scroll|wait|js> [args]",
  "       page snapshot [--tab <tabId>] [--within <@ref>] [--json]",
  "       page snapshot [--tab <tabId>] --dom [selector]",
  "       page text [--tab <tabId>] [selector]",
  "       page screenshot [--tab <tabId>]",
  "       page click [--tab <tabId>] <@ref|selector> [index]",
  "       page type [--tab <tabId>] <@ref|selector> <text>",
  "       page fill [--tab <tabId>] <locator> <value>",
  "       page select [--tab <tabId>] <locator> <value> | --option-label <label>",
  "       page check [--tab <tabId>] <locator> [--unchecked]",
  "       page key [--tab <tabId>] <key>",
  "       page scroll [--tab <tabId>] [@ref] <up|down|top|bottom|x,y>",
  "       page wait [--tab <tabId>] <selector> [--timeout ms]",
  "       page js [--tab <tabId>] <source>",
  "Snapshot refs canonically start with @; the bare generated form is also accepted.",
  "Locators: <@ref|CSS> or --label <field label> or --role <role> [--name <exact name>].",
  "Use --within <@ref> to scope role/label locators. Ambiguous matches are errors.",
  "fill replaces a field value (including native dates/times); type inserts text.",
  "select sets a native dropdown; check sets checked state. Form actions verify the result.",
  "click/fill/select/check/type return a JSON action receipt; --snapshot adds a readable page or scoped form outline.",
  "Use --snapshot --json for a single JSON receipt with the full snapshot tree.",
  "Keep action receipts intact; use && for dependent actions so a failure stops the sequence.",
].join("\n");

const PAGE_SNAPSHOT_USAGE = [
  "Usage: page snapshot [--tab <tabId>] [--within <@ref>] [--json]",
  "       page snapshot [--tab <tabId>] --dom [selector]",
].join("\n");
const PAGE_TEXT_USAGE = "Usage: page text [--tab <tabId>] [selector]";
const PAGE_SCREENSHOT_USAGE = "Usage: page screenshot [--tab <tabId>]";
const PAGE_CLICK_USAGE = [
  "Usage: page click [--tab <tabId>] <@ref|selector> [index]",
  "Snapshot refs canonically start with @; the bare generated form is also accepted.",
  "       page click [--tab <tabId>] --role <role> [--name <name>] [--within <@ref>] [--snapshot]",
  "--snapshot adds a readable outline after the JSON receipt; add --json for the full JSON snapshot tree.",
].join("\n");
const PAGE_TYPE_USAGE = [
  "Usage: page type [--tab <tabId>] <@ref|selector> <text>",
  "Snapshot refs canonically start with @; the bare generated form is also accepted.",
  "Locators also accept --label <label> or --role <role> [--name <name>], optionally --within <@ref>.",
  "type inserts text. Use page fill to replace a value or set a native date/time field.",
  "--snapshot adds a readable outline after the JSON receipt; add --json for the full JSON snapshot tree.",
].join("\n");
const PAGE_FORM_USAGE = [
  "Usage: page fill <locator> <value>",
  "       page select <locator> <value> | --option-label <label>",
  "       page check <locator> [--unchecked]",
  "Locators: <@ref|CSS>, --label <field label>, or --role <role> [--name <exact name>].",
  "Options: --tab <id>, --within <@ref> for role/label locators, --snapshot for fresh references after the action.",
  "--snapshot adds a readable outline after the JSON receipt; add --json for the full JSON snapshot tree.",
  "fill replaces the entire value; an empty value clears the field. Native dates use YYYY-MM-DD; times use HH:mm.",
  "select chooses one native dropdown option by value or --option-label. Custom listboxes use page click --role option --name <name>.",
  "check sets checked state, --unchecked clears it; matching state does not click again.",
  "Form actions verify the resulting state. Password values are omitted from results.",
].join("\n");
const PAGE_KEY_USAGE = [
  "Usage: page key [--tab <tabId>] <key>",
  "Examples: Enter, Tab, Space, ArrowDown, Escape, Ctrl+a, Shift+Tab.",
  "Keys go to the focused element; page click or page type focuses a control.",
].join("\n");
const PAGE_SCROLL_USAGE = [
  "Usage: page scroll [--tab <tabId>] [@ref] <up|down|top|bottom|x,y>",
  "Snapshot refs canonically start with @; the bare generated form is also accepted.",
].join("\n");
const PAGE_WAIT_USAGE = "Usage: page wait [--tab <tabId>] <selector|--label label|--role role [--name name]> [--within <@ref>] [--timeout ms]";
const PAGE_JS_USAGE = "Usage: page js [--tab <tabId>] <source>";

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;

export function createPageCommands<Target>(backend: BrowserPageBackend, debuggerBackend: DebuggerBackend<Target>, pageReferences = new PageReferenceStore()) {
  const { activeTab, captureTabPng, executeInTab, getTab } = backend;
  const { acquireDebugger, releaseDebugger } = debuggerBackend;
  const { captureSemanticSnapshot } = createPageSemantics(debuggerBackend.sendDebuggerCommand, pageReferences);
  const { clickPageElement, scrollPage, sendPageKey, typePageText, changeFormControl } = createPageActions(debuggerBackend, pageReferences);
  const { evaluatePageJavaScript } = createPageJavaScript(debuggerBackend);

  const pageCommand: BrowserCommand = {
    name: "page",
    summary: "Inspect pages; click by ref/role/name; fill, select, and check forms with verified results. See page --help.",
    run(args, ctx) {
      return runPageCommand(args, ctx);
    },
  };

  const pageCommands: BrowserCommand[] = [pageCommand];

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
        case "fill":
        case "select":
        case "check":
          return await runForm(subcommand, rest, ctx);
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
    const scoped = splitOption(parsed.value.args, "--within");
    const scope = scoped.value === null ? undefined : pageReferences.resolve(scoped.value);
    const json = scoped.rest.includes("--json");
    const dom = parsed.value.args.includes("--dom");
    const snapshotArgs = scoped.rest.filter((arg) => arg !== "--json" && arg !== "--dom");
    const invalid = firstUnknownOption(snapshotArgs);
    if (invalid) {
      return commandError(`${PAGE_SNAPSHOT_USAGE}\nUnknown option: ${invalid}`);
    }

    const tab = scope ? await resolveReferencedTab(parsed.value.tabId, scope.tabId, scope.ref) : await resolveTab(parsed.value.tabId);
    if (scope && dom) return commandError("--within scopes semantic snapshots; use a selector with --dom.");
    if (!dom && snapshotArgs.length > 0) {
      return commandError(`${PAGE_SNAPSHOT_USAGE}\nUse --dom when providing a CSS selector.`);
    }
    if (!dom) {
      let target: Target | null = null;
      try {
        throwIfAborted(ctx.abortSignal);
        target = await acquireDebugger(tab.id);
        throwIfAborted(ctx.abortSignal);
        const snapshot = await captureSemanticSnapshot(target, tab, pageReferences, scope);
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
    const options = locatorOptions(parsed.value.args);
    const invalid = firstUnknownOption(options.args);
    if (invalid) {
      return commandError(`${PAGE_CLICK_USAGE}\nUnknown option: ${invalid}`);
    }

    const click = options.locator ? { ok: true as const, value: { selector: "", index: 0 } } : parseSelectorAndOptionalIndex(options.args);
    if (!click.ok) {
      return commandError(click.error);
    }

    if (options.locator && options.args.length) return commandError(PAGE_CLICK_USAGE);
    const locator = options.locator ?? pageLocator(click.value.selector, click.value.index);
    const tab = await resolveLocatorTab(parsed.value.tabId, locator);
    const result = await clickPageElement(tab.id, locator, ctx.abortSignal);
    return actionResult(tab, result, options, ctx);
  }

  async function runType(args: string[], ctx: CommandContext): Promise<CommandResult> {
    const parsed = parsePageOptions(args, PAGE_TYPE_USAGE);
    if (!parsed.ok) {
      return commandError(parsed.error);
    }
    const options = locatorOptions(parsed.value.args);
    const typed = options.locator ? { ok: true as const, value: { selector: "", text: options.args.join(" ") } } : parseTypeArgs(options.args);
    if (!typed.ok) {
      return commandError(typed.error);
    }

    const locator = options.locator ?? pageLocator(typed.value.selector, 0);
    const tab = await resolveLocatorTab(parsed.value.tabId, locator);
    const result = await typePageText(tab.id, locator, typed.value.text, ctx.abortSignal);
    return actionResult(tab, result, options, ctx);
  }

  async function runForm(kind: "fill" | "select" | "check", args: string[], ctx: CommandContext): Promise<CommandResult> {
    const parsed = parsePageOptions(args, PAGE_FORM_USAGE);
    if (!parsed.ok) return commandError(parsed.error);
    const option = splitOption(parsed.value.args, "--option-label");
    const unchecked = option.rest.includes("--unchecked");
    const options = locatorOptions(option.rest.filter(arg => arg !== "--unchecked"));
    const remaining = [...options.args];
    const locator = options.locator ?? pageLocator(remaining.shift() ?? "", 0);
    if (firstUnknownOption(remaining)) return commandError(PAGE_FORM_USAGE);
    if ((kind !== "select" && option.value !== null) || (kind !== "check" && unchecked)) return commandError(PAGE_FORM_USAGE);
    if (kind === "check" ? remaining.length !== 0 : option.value !== null ? remaining.length !== 0 : remaining.length !== 1) return commandError(PAGE_FORM_USAGE);
    const tab = await resolveLocatorTab(parsed.value.tabId, locator);
    const result = await changeFormControl(tab.id, locator, kind === "check" ? { kind, checked: !unchecked }
      : kind === "select" ? { kind, value: option.value ?? remaining[0]!, byLabel: option.value !== null }
        : { kind, value: remaining[0]! }, ctx.abortSignal);
    return actionResult(tab, result, options, ctx);
  }

  function locatorOptions(args: string[]) {
    let rest = args;
    const values: Record<string, string> = {};
    for (const flag of ["role", "name", "label", "within"]) {
      const split = splitOption(rest, `--${flag}`); rest = split.rest;
      if (split.value !== null) {
        if (!split.value || split.value.startsWith("--")) throw new Error(`--${flag} requires a value`);
        values[flag] = split.value;
      }
    }
    if (values.label && (values.role || values.name)) throw new Error("Choose --label or --role with --name.");
    if (values.name && !values.role) throw new Error("--name requires --role.");
    const semantic = values.role || values.label;
    if (values.within && !semantic) throw new Error("--within requires a role or label locator.");
    return {
      args: rest.filter(arg => arg !== "--snapshot" && arg !== "--json"),
      snapshot: rest.includes("--snapshot"), json: rest.includes("--json"),
      locator: semantic ? { kind: "semantic" as const, role: values.role, name: values.name, label: values.label,
        within: values.within ? pageReferences.resolve(values.within) : undefined } : undefined,
    };
  }

  async function actionResult(tab: TabSummary, result: Awaited<ReturnType<typeof clickPageElement | typeof typePageText | typeof changeFormControl>>, options: ReturnType<typeof locatorOptions>, ctx: CommandContext): Promise<CommandResult> {
    if (!options.snapshot) return commandCompactJson({ tabId: tab.id, ...result });
    let target: Target | null = null;
    let snapshot: ActionInspection;
    try {
      throwIfAborted(ctx.abortSignal);
      target = await acquireDebugger(tab.id);
      const scope = options.locator?.kind === "semantic" ? options.locator.within : undefined;
      snapshot = { snapshot: await captureSemanticSnapshot(target, tab, pageReferences, scope) };
    } catch (error) {
      snapshot = { snapshotError: errorMessage(error) };
    } finally {
      if (target) await releaseDebugger(tab.id).catch((error) => {
        console.warn("GSV browser target failed to detach debugger", error);
      });
    }
    if (options.json || "snapshotError" in snapshot) return commandCompactJson({ tabId: tab.id, ...result, ...snapshot });
    const receipt = commandCompactJson({ tabId: tab.id, ...result });
    return commandOk(`${receipt.stdout}\n${formatSemanticSnapshot(snapshot.snapshot)}`);
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
    const normalizedReference = referenceText ? normalizePageReference(referenceText) : null;
    if (referenceText && !normalizedReference) {
      return commandError(`${PAGE_SCROLL_USAGE}\nA targeted scroll requires a snapshot ref such as @s4k2e7.`);
    }
    const targetText = parsed.value.args[parsed.value.args.length - 1] ?? "";
    const target = parseScrollTarget(targetText);
    if (!target.ok) {
      return commandError(target.error);
    }

    const reference = normalizedReference ? pageReferences.resolve(normalizedReference) : null;
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
    const options = locatorOptions(parsed.value.args);
    if (options.locator?.kind === "semantic") {
      if (options.args.length) return commandError(PAGE_WAIT_USAGE);
      const tab = await resolveLocatorTab(parsed.value.tabId, options.locator);
      const target = await acquireDebugger(tab.id);
      try {
        const reference = await findSemanticReference(debuggerBackend.sendDebuggerCommand, pageReferences, target, tab.id, options.locator, ctx.abortSignal, parsed.value.timeoutMs);
        return commandCompactJson({ tabId: tab.id, wait: { ref: reference.ref, role: reference.role, name: reference.name } });
      } finally { await releaseDebugger(tab.id); }
    }
    const invalid = firstUnknownOption(options.args);
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
    if (!value.trim()) throw new Error("A non-empty locator is required. Use a reference, CSS selector, --label, or --role with --name.");
    const reference = normalizePageReference(value);
    if (!reference) {
      if (value.startsWith("@")) {
        throw new Error(`Invalid page reference: ${value}. Snapshot refs look like @s4k2e7.`);
      }
      return { kind: "selector", selector: value, index };
    }
    if (index !== 0) {
      throw new Error("Snapshot refs do not accept a selector index");
    }
    return { kind: "reference", reference: pageReferences.resolve(reference) };
  }

  async function resolveLocatorTab(tabId: number | null, locator: PageLocator): Promise<TabSummary> {
    if (locator.kind !== "reference") {
      if (locator.kind === "semantic" && locator.within) return resolveReferencedTab(tabId, locator.within.tabId, locator.within.ref);
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
      case "fill":
      case "select":
      case "check":
        return PAGE_FORM_USAGE;
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
  return { pageCommand, pageCommands };
}
