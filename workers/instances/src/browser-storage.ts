import type { BrowserContext, Page } from "@cloudflare/playwright";
import type { BrowserStorageIssue, BrowserStorageSite, BrowserStorageUsage } from "@humansandmachines/gsv/protocol";
import type { StorageState } from "./browser";
import { storageScriptSource } from "./playwright-storage.generated";
import { within } from "./browser-operation";
import { boundBrowserStorageUsage, summarizeBrowserCookies, summarizeBrowserStorage } from "./browser-storage-summary";

export const MAX_PROFILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PROFILE_BYTES = 16 * 1024 * 1024;
export const SAVE_TIMEOUT_MS = 20_000;
export type BrowserSnapshot = {
  state: StorageState;
  usage: BrowserStorageUsage;
  failures?: { issue: BrowserStorageIssue; cause: unknown }[];
};

export class BrowserStorageError extends Error {
  readonly usage?: BrowserStorageUsage;
  constructor(message: string, usage?: BrowserStorageUsage, options?: ErrorOptions) {
    super(message, options);
    this.usage = usage ? boundBrowserStorageUsage(usage) : undefined;
  }
}

/** A disposable, intercepted page owns every IndexedDB handle opened by export. */
export async function exportBrowserStorage(
  context: BrowserContext, origins: string[], maxBytes: number, signal: AbortSignal,
  internalPages: Set<Page>,
  ownTarget: (targetId: string, owned: boolean) => void = () => {},
): Promise<BrowserSnapshot> {
  signal.throwIfAborted();
  const cookies = await context.cookies();
  const bytes = (value: StorageState | StorageState["cookies"]) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const state: StorageState = { cookies, origins: [] };
  const failures: NonNullable<BrowserSnapshot["failures"]> = [];
  const usage: BrowserStorageUsage = { measuredAt: Date.now(), complete: false, bytes: bytes(state), cookieBytes: bytes(cookies), cookies: cookies.length, sites: [] };
  Object.assign(usage, summarizeBrowserCookies(cookies));
  let page: Page | undefined;
  let targetId: string | undefined;
  const close = () => page?.close().catch(() => {});
  signal.addEventListener("abort", close, { once: true });
  try {
    page = await context.newPage();
    internalPages.add(page);
    signal.throwIfAborted();
    const cdp = await context.newCDPSession(page);
    targetId = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    ownTarget(targetId, true);
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Browser storage</title>" }));
    for (const origin of [...new Set(origins)].sort()) {
      signal.throwIfAborted();
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 5000 });
        // Only bounded serialized data crosses CDP. The page computes size metadata
        // even when an origin exceeds the allowance; values never enter diagnostics.
        const expression = `(async () => {
          const module = {};
          ${storageScriptSource}
          const script = new (module.exports.StorageScript())(false);
          let data;
          try { data = { origin: location.origin, ...await script.collect(true, ${Math.max(0, Math.min(maxBytes, MAX_PROFILE_BYTES) - usage.bytes - (usage.sites.length ? 1 : 0))}) }; }
          catch (error) {
            if (error.name === "StorageBudgetExceeded") return { minimumBytes: error.minimumBytes };
            throw error;
          }
          const json = JSON.stringify(data);
          const summary = (${summarizeBrowserStorage.toString()})(data, new TextEncoder().encode(json).byteLength);
          return { summary, json: summary.bytes <= ${Math.max(0, Math.min(maxBytes, MAX_PROFILE_BYTES) - usage.bytes)} ? json : undefined };
        })()`;
        const exported = await within(page.evaluate<{ summary: BrowserStorageSite; json?: string } | { minimumBytes: number }>(expression), 5000, "Site storage export", signal);
        if ("minimumBytes" in exported) {
          usage.bytes += exported.minimumBytes + (usage.sites.length ? 1 : 0);
          throw new BrowserStorageError(`Saved browser data needs at least ${usage.bytes} bytes; allowance is ${Math.min(maxBytes, MAX_PROFILE_BYTES)} bytes. Collection stopped at the limit.`, usage);
        }
        usage.sites.push(exported.summary);
        usage.bytes += exported.summary.bytes + (usage.sites.length > 1 ? 1 : 0);
        if (exported.json) {
          // SAFETY: Our pinned browser-side codec produced this exact JSON storage-state entry.
          state.origins.push(JSON.parse(exported.json) as StorageState["origins"][number]);
        }
      } catch (cause) {
        if (cause instanceof BrowserStorageError) throw cause;
        if (signal.aborted || page.isClosed()) throw cause;
        const unsupported = cause instanceof Error && cause.message.includes("Unsupported IndexedDB value type");
        const complex = cause instanceof Error && cause.message.includes("IndexedDB storage exceeds the safe complexity limit");
        const type = unsupported && cause instanceof Error ? cause.message.match(/Unsupported IndexedDB value type: \[object (CryptoKey|Blob|File)\]/)?.[1] : undefined;
        failures.push({ issue: {
          origin, reason: unsupported || complex ? "unsupported" : "unavailable",
          message: complex ? "This site's storage is too complex to save safely. Earlier saved state is retained when available." : unsupported ? `This site stores ${type ?? "unsupported"} values that cannot be saved by this browser.` : "This site's storage could not be read. Retry saving while the browser is running.",
        }, cause });
      }
    }
    signal.throwIfAborted();
    usage.complete = failures.length === 0;
    if (usage.bytes > Math.min(maxBytes, MAX_PROFILE_BYTES)) {
      throw new BrowserStorageError(`Saved browser data needs ${usage.bytes} bytes; allowance is ${Math.min(maxBytes, MAX_PROFILE_BYTES)} bytes`, usage);
    }
    return { state, usage: boundBrowserStorageUsage(usage), failures };
  } catch (cause) {
    if (cause instanceof BrowserStorageError) throw cause;
    if (signal.aborted) throw new BrowserStorageError("Saving browser data timed out. The previous saved state is intact.", usage);
    throw new BrowserStorageError("Browser website storage could not be exported", usage, { cause });
  } finally {
    signal.removeEventListener("abort", close);
    if (page && !page.isClosed()) await page.close();
    if (page) internalPages.delete(page);
    if (targetId) ownTarget(targetId, false);
  }
}

/** Restore into a fresh context before exposing any tab to humans or agents. */
export async function restoreBrowserStorage(context: BrowserContext, state: StorageState): Promise<void> {
  await context.addCookies(state.cookies);
  const page = await context.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    for (const origin of state.origins) {
      await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 5000 });
      await page.evaluate(`(async () => {
        const module = {};
        ${storageScriptSource}
        const script = new (module.exports.StorageScript())(false);
        await script.restore(${JSON.stringify(origin)});
      })()`);
    }
  } finally { await page.close(); }
}
