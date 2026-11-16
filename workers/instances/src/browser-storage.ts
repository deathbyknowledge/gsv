import type { BrowserContext, Page } from "@cloudflare/playwright";
import type { BrowserStorageIssue, BrowserStorageSite, BrowserStorageUsage } from "@humansandmachines/gsv/protocol";
import type { StorageState } from "./browser";
import { storageScriptSource } from "./playwright-storage.generated";
import { within } from "./browser-operation";
import { boundBrowserStorageUsage, hasBrowserStorage, summarizeBrowserCookies, summarizeBrowserStorage } from "./browser-storage-summary";

export const MAX_PROFILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PROFILE_BYTES = 16 * 1024 * 1024;
export const SAVE_TIMEOUT_MS = 20_000;
export type BrowserSnapshot = {
  state: StorageState;
  usage: BrowserStorageUsage;
  failures?: { issue: BrowserStorageIssue; cause: unknown }[];
  /** Origins this export read; every other saved site keeps its earlier data. */
  exported: string[];
};

export class BrowserStorageError extends Error {
  readonly usage?: BrowserStorageUsage;
  constructor(message: string, usage?: BrowserStorageUsage, options?: ErrorOptions) {
    super(message, options);
    this.usage = usage ? boundBrowserStorageUsage(usage) : undefined;
  }
}

/** Sites visited at once. Each visit mostly waits on remote-browser round trips, which pages overlap. */
const STORAGE_PAGES = 6;

type SiteVisits<T> = {
  pages: number;
  prepare(page: Page): Promise<void>;
  visit(page: Page, site: T): Promise<void>;
  release?(page: Page): void;
  signal?: AbortSignal;
};

/**
 * Visits every site on up to `pages` private pages. A failure stops later
 * visits, and every page is closed and released before this returns.
 */
async function visitSites<T>(context: BrowserContext, sites: T[], { pages, prepare, visit, release, signal }: SiteVisits<T>): Promise<void> {
  const queue = [...sites], open = new Set<Page>();
  const close = () => { for (const page of open) void page.close().catch(() => {}); };
  signal?.addEventListener("abort", close, { once: true });
  try {
    const workers = await Promise.allSettled(Array.from({ length: Math.min(pages, queue.length) }, async () => {
      try {
        const page = await context.newPage();
        open.add(page);
        await prepare(page);
        for (let site = queue.shift(); site !== undefined; site = queue.shift()) {
          signal?.throwIfAborted();
          await visit(page, site);
        }
      } catch (cause) {
        queue.length = 0;
        throw cause;
      }
    }));
    const failed = workers.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  } finally {
    signal?.removeEventListener("abort", close);
    await Promise.all([...open].map(async page => {
      if (!page.isClosed()) await page.close().catch(() => {});
      release?.(page);
    }));
  }
}

/** Disposable, intercepted pages own every IndexedDB handle opened by export. */
export async function exportBrowserStorage(
  context: BrowserContext, origins: string[], maxBytes: number, signal: AbortSignal,
  internalPages: Set<Page>,
  ownTarget: (targetId: string, owned: boolean) => void = () => {},
): Promise<BrowserSnapshot> {
  signal.throwIfAborted();
  const exported = [...new Set(origins)].sort();
  const cookies = await context.cookies();
  const bytes = (value: StorageState | StorageState["cookies"]) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const limit = Math.min(maxBytes, MAX_PROFILE_BYTES);
  const state: StorageState = { cookies, origins: [] };
  const failures: NonNullable<BrowserSnapshot["failures"]> = [];
  const usage: BrowserStorageUsage = { measuredAt: Date.now(), complete: false, bytes: bytes(state), cookieBytes: bytes(cookies), cookies: cookies.length, sites: [] };
  Object.assign(usage, summarizeBrowserCookies(cookies));
  const targets = new Map<Page, string>();
  // Each read reserves an even share of the allowance left, so data in flight never
  // exceeds it. A site that needs more than its share is read again alone afterwards.
  let reserved = 0;
  const larger: string[] = [];
  const read = (pages: number) => async (page: Page, origin: string) => {
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 5000 });
      const budget = Math.floor(Math.max(0, limit - usage.bytes - reserved - (usage.sites.length ? 1 : 0)) / pages);
      // Only bounded serialized data crosses CDP. The page computes size metadata
      // even when an origin exceeds the allowance; values never enter diagnostics.
      const expression = `(async () => {
        const module = {};
        ${storageScriptSource}
        const script = new (module.exports.StorageScript())(false);
        let data;
        try { data = { origin: location.origin, ...await script.collect(true, ${budget}) }; }
        catch (error) {
          if (error.name === "StorageBudgetExceeded") return { minimumBytes: error.minimumBytes };
          throw error;
        }
        const json = JSON.stringify(data);
        const summary = (${summarizeBrowserStorage.toString()})(data, new TextEncoder().encode(json).byteLength);
        return { summary, json: summary.bytes <= ${budget} ? json : undefined };
      })()`;
      reserved += budget;
      const result = await within(page.evaluate<{ summary: BrowserStorageSite; json?: string } | { minimumBytes: number }>(expression), 5000, "Site storage export", signal)
        .finally(() => { reserved -= budget; });
      if (pages > 1 && ("minimumBytes" in result || !result.json)) {
        larger.push(origin);
        return;
      }
      if ("minimumBytes" in result) {
        usage.bytes += result.minimumBytes + (usage.sites.length ? 1 : 0);
        throw new BrowserStorageError(`Saved browser data needs at least ${usage.bytes} bytes; allowance is ${limit} bytes. Collection stopped at the limit.`, usage);
      }
      usage.sites.push(result.summary);
      usage.bytes += result.summary.bytes + (usage.sites.length > 1 ? 1 : 0);
      if (result.json) {
        // SAFETY: Our pinned browser-side codec produced this exact JSON storage-state entry.
        state.origins.push(JSON.parse(result.json) as StorageState["origins"][number]);
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
  };
  const visits = {
    signal,
    async prepare(page: Page) {
      internalPages.add(page);
      const cdp = await context.newCDPSession(page);
      const { targetId } = (await cdp.send("Target.getTargetInfo")).targetInfo;
      targets.set(page, targetId);
      ownTarget(targetId, true);
      await cdp.send("Network.setBypassServiceWorker", { bypass: true });
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Browser storage</title>" }));
    },
    release(page: Page) {
      internalPages.delete(page);
      const targetId = targets.get(page);
      if (targetId) ownTarget(targetId, false);
    },
  };
  try {
    const pages = Math.min(STORAGE_PAGES, exported.length);
    await visitSites(context, exported, { ...visits, pages, visit: read(pages) });
    await visitSites(context, larger.sort(), { ...visits, pages: 1, visit: read(1) });
    signal.throwIfAborted();
    // Pages finish in any order; a stable order keeps an unchanged snapshot identical.
    const byOrigin = (a: { origin: string }, b: { origin: string }) => a.origin.localeCompare(b.origin);
    state.origins.sort(byOrigin);
    usage.sites.sort(byOrigin);
    failures.sort((a, b) => byOrigin(a.issue, b.issue));
    usage.complete = failures.length === 0;
    if (usage.bytes > limit) {
      throw new BrowserStorageError(`Saved browser data needs ${usage.bytes} bytes; allowance is ${limit} bytes`, usage);
    }
    return { state, usage: boundBrowserStorageUsage(usage), failures, exported };
  } catch (cause) {
    if (cause instanceof BrowserStorageError) throw cause;
    if (signal.aborted) throw new BrowserStorageError("Saving browser data timed out. The previous saved state is intact.", usage);
    throw new BrowserStorageError("Browser website storage could not be exported", usage, { cause });
  }
}

/** Restore into a fresh context before exposing any tab to humans or agents. */
export async function restoreBrowserStorage(context: BrowserContext, state: StorageState): Promise<void> {
  await context.addCookies(state.cookies);
  // A site with nothing stored needs no visit.
  await visitSites(context, state.origins.filter(hasBrowserStorage), {
    pages: STORAGE_PAGES,
    prepare: page => page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" })),
    async visit(page, origin) {
      await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 5000 });
      await page.evaluate(`(async () => {
        const module = {};
        ${storageScriptSource}
        const script = new (module.exports.StorageScript())(false);
        await script.restore(${JSON.stringify(origin)});
      })()`);
    },
  });
}
