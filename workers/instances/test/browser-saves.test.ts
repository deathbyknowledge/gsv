import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Browser, BrowserContext, CDPSession, Frame, Page, Worker } from "@cloudflare/playwright";
import { expect, it } from "vitest";
import { CloudBrowser } from "../src/browser";
import { exportBrowserStorage, restoreBrowserStorage } from "../src/browser-storage";
import { InstanceStore } from "../src/store";

const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 2, profileStorageBytes: 5242880 };

it("reads only sites with a page open since the last save, those of a failed commit again, and every site after reattaching", async () => {
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const record = store.admit({ ownerUid: 1000, human: true }, { requestId: "saves", templateId: "browser" }, limits);
    const [a, b, c, d] = ["https://a.example", "https://b.example", "https://c.example", "https://d.example"];
    // Nothing observed this browser before it was attached, so any tracked site may have changed.
    store.sql.exec("UPDATE instances SET runtime = ? WHERE id = ?", JSON.stringify({ contextId: "context", activeTabId: 1, nextTabId: 2, tabs: { "1": "live" }, origins: [a, b, c, d] }), record.instanceId);
    // SAFETY: Saving reads only each frame's URL.
    const frame = (url: string) => ({ url: () => url }) as Frame;
    let url = `${a}/account`;
    let navigated: ((value: Frame) => void) | undefined;
    const navigate = (next: string) => { url = next; navigated!(frame(next)); };
    const read: string[] = [];
    const site = (origin: string) => ({ origin, bytes: 2, localStorageBytes: 2, indexedDBBytes: 2, localStorageEntries: 0, databases: 0, records: 0 });
    // SAFETY: Saving needs only the open tab's frame URLs and navigation events.
    const tab = { isClosed: () => false, frames: () => [frame(url)], on: (event: string, listener: (value: Frame) => void) => { if (event === "framenavigated") navigated = listener; } } as Page;
    const exporter = () => {
      let current = "";
      // SAFETY: Export needs only interception, navigation, evaluation and closing from its private pages.
      return { route: async () => {}, goto: async (origin: string) => { current = origin; read.push(origin); return null; }, evaluate: async () => ({ summary: site(current), json: JSON.stringify({ origin: current, localStorage: [] }) }), isClosed: () => false, close: async () => {} } as Page;
    };
    // SAFETY: Target metadata identifies the attached context and the exporter's page.
    const cdp = { send: async () => ({ targetInfo: { targetId: "live", browserContextId: "context", title: "Account", url } }), detach: async () => {} } as CDPSession;
    // SAFETY: This context supplies attachment, tab enumeration and storage export.
    const context = { serviceWorkers: () => [], pages: () => [tab], newCDPSession: async () => cdp, addInitScript: async () => {}, on: () => {}, cookies: async () => [], newPage: async () => exporter() } as BrowserContext;
    // SAFETY: The browser is already attached and only enumerates its existing contexts.
    const attach = () => CloudBrowser.fromConnection({ contexts: () => [context] } as Browser, record, store);
    let browser = await attach();
    const save = async () => {
      read.length = 0;
      const snapshot = await browser.save(10000, new AbortController().signal);
      read.sort();
      expect(snapshot.state.origins.map(entry => entry.origin)).toEqual(read);
      return snapshot;
    };

    await save();
    expect(read).toEqual([a, b, c, d]);
    await save();
    expect(read).toEqual([a]);
    navigate(`${c}/basket`);
    const snapshot = await save();
    expect(read).toEqual([a, c]);
    // The profile commit failed, so those sites still differ from the saved copy.
    browser.retrySave(snapshot.exported);
    navigate("about:blank");
    await save();
    expect(read).toEqual([a, c]);
    await save();
    expect(read).toEqual([]);
    navigate(`${b}/login`);
    navigate("about:blank");
    await save();
    expect(read).toEqual([b]);
    // The coordinator restarted. Nothing observed the browser meanwhile, so every tracked site is read again.
    browser = await attach();
    await save();
    expect(read).toEqual([a, b, c, d]);
    await save();
    expect(read).toEqual([]);
  });
});

it("rereads a site whose service worker ran with no page open, and keeps it while the worker runs", async () => {
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const record = store.admit({ ownerUid: 1000, human: true }, { requestId: "workers", templateId: "browser" }, limits);
    const [a, b] = ["https://a.example", "https://b.example"];
    store.sql.exec("UPDATE instances SET runtime = ? WHERE id = ?", JSON.stringify({ contextId: "context", activeTabId: 1, nextTabId: 2, tabs: { "1": "live" }, origins: [a, b] }), record.instanceId);
    const read: string[] = [];
    // SAFETY: Saving reads only each frame's URL.
    const tab = { isClosed: () => false, frames: () => [{ url: () => "about:blank" } as Frame], on: () => {} } as Page;
    const exporter = () => {
      let current = "";
      // SAFETY: Export needs only interception, navigation, evaluation and closing from its private pages.
      return { route: async () => {}, goto: async (origin: string) => { current = origin; read.push(origin); return null; }, isClosed: () => false, close: async () => {},
        evaluate: async () => ({ summary: { origin: current, bytes: 2, localStorageBytes: 2, indexedDBBytes: 0, localStorageEntries: 0, databases: 0, records: 0 }, json: JSON.stringify({ origin: current, localStorage: [] }) }) } as Page;
    };
    // SAFETY: Target metadata identifies the attached context and the exporter's page.
    const cdp = { send: async () => ({ targetInfo: { targetId: "live", browserContextId: "context", title: "Blank", url: "about:blank" } }), detach: async () => {} } as CDPSession;
    let workers: Worker[] = [];
    let started: ((worker: Worker) => void) | undefined;
    // SAFETY: This context supplies attachment, tab and service worker enumeration, and storage export.
    const context = { pages: () => [tab], serviceWorkers: () => workers, newCDPSession: async () => cdp, addInitScript: async () => {}, cookies: async () => [], newPage: async () => exporter(),
      on: (event: string, listener: (worker: Worker) => void) => { if (event === "serviceworker") started = listener; } } as BrowserContext;
    // SAFETY: The browser is already attached and only enumerates its existing contexts.
    const browser = await CloudBrowser.fromConnection({ contexts: () => [context] } as Browser, record, store);
    const save = async () => { read.length = 0; await browser.save(10000, new AbortController().signal); return read.sort(); };
    // SAFETY: Saving reads only a service worker's URL.
    const worker = { url: () => `${a}/sw.js` } as Worker;

    // Nothing observed the browser before it was attached, so the first save reads every tracked site.
    expect(await save()).toEqual([a, b]);
    // The site's worker woke with no page open, so it may have written the site's storage.
    workers = [worker];
    started?.(worker);
    expect(await save()).toEqual([a]);
    // A running worker can write again after the export reads its site.
    expect(await save()).toEqual([a]);
    workers = [];
    expect(await save()).toEqual([a]);
    expect(await save()).toEqual([]);
  });
});

it("restores several sites at once and skips sites with nothing stored", async () => {
  let loading = 0, most = 0;
  const visited: string[] = [];
  const page = () => {
    // SAFETY: Restore needs only interception, navigation, evaluation and closing from its pages.
    return { route: async () => {}, goto: async (origin: string) => {
      visited.push(origin);
      most = Math.max(most, ++loading);
      await new Promise(resolve => setTimeout(resolve, 5));
      loading--;
      return null;
    }, evaluate: async () => undefined, isClosed: () => false, close: async () => {} } as Page;
  };
  // SAFETY: Restore needs only cookies and new pages from a fresh context.
  const context = { addCookies: async () => {}, newPage: async () => page() } as BrowserContext;
  const sites = Array.from({ length: 8 }, (_, n) => ({ origin: `https://${n}.example`, localStorage: [{ name: "session", value: `${n}` }] }));
  await restoreBrowserStorage(context, { cookies: [], origins: [...sites, { origin: "https://empty.example", localStorage: [] }] });
  expect(most).toBeGreaterThan(1);
  expect(visited.sort()).toEqual(sites.map(value => value.origin).sort());
});

it("keeps site data in flight within the allowance and reads a larger site again alone", async () => {
  const sizes = new Map([["https://large.example", 600], ...Array.from({ length: 7 }, (_, n): [string, number] => [`https://${n}.example`, 40])]);
  let inFlight = 0, most = 0;
  const page = () => {
    let current = "";
    // SAFETY: Export needs only interception, navigation, evaluation and closing from its pages.
    return { route: async () => {}, goto: async (origin: string) => { current = origin; return null; }, evaluate: async (expression: string) => {
      const budget = Number(/collect\(true, (\d+)\)/.exec(expression)?.[1]);
      most = Math.max(most, inFlight += budget);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= budget;
      const bytes = sizes.get(current)!;
      if (bytes > budget) return { minimumBytes: bytes };
      return { summary: { origin: current, bytes, localStorageBytes: bytes, indexedDBBytes: 0, localStorageEntries: 1, databases: 0, records: 0 }, json: JSON.stringify({ origin: current, localStorage: [] }) };
    }, isClosed: () => false, close: async () => {} } as Page;
  };
  // SAFETY: Export pages report only their target identity and accept a service worker bypass.
  const cdp = { send: async () => ({ targetInfo: { targetId: "export" } }) } as CDPSession;
  // SAFETY: Export needs only cookies, new pages and their debugger sessions.
  const context = { cookies: async () => [], newPage: async () => page(), newCDPSession: async () => cdp } as BrowserContext;
  const snapshot = await exportBrowserStorage(context, [...sizes.keys()], 1000, new AbortController().signal, new Set());
  expect(most).toBeLessThanOrEqual(1000);
  expect(snapshot.state.origins.map(entry => entry.origin)).toEqual([...sizes.keys()].sort());
  expect(snapshot.usage.complete).toBe(true);
});

it("keeps an export page claimed when it fails to close, so it never surfaces as a tab", async () => {
  const claims = new Map<string, boolean>(), targets = new Map<Page, string>();
  const page = () => {
    const targetId = `export-${targets.size + 1}`;
    // SAFETY: Export needs only interception, navigation, evaluation and closing from its pages.
    const value = { route: async () => {}, goto: async () => null, isClosed: () => false,
      evaluate: async () => ({ summary: { origin: "https://a.example", bytes: 2, localStorageBytes: 2, indexedDBBytes: 0, localStorageEntries: 0, databases: 0, records: 0 }, json: JSON.stringify({ origin: "https://a.example", localStorage: [] }) }),
      close: async () => { if (targetId === "export-1") throw new Error("Target close failed"); } } as Page;
    targets.set(value, targetId);
    return value;
  };
  // SAFETY: Export needs only cookies, new pages and their debugger sessions.
  const context = { cookies: async () => [], newPage: async () => page(),
    newCDPSession: async (target: Page) => ({ send: async () => ({ targetInfo: { targetId: targets.get(target) } }) }) as CDPSession } as BrowserContext;
  const internal = new Set<Page>();
  await expect(exportBrowserStorage(context, ["https://a.example", "https://b.example"], 10000, new AbortController().signal, internal,
    (targetId, owned) => { claims.set(targetId, owned); })).rejects.toThrow();
  expect([...internal].map(value => targets.get(value))).toEqual(["export-1"]);
  expect(Object.fromEntries(claims)).toEqual({ "export-1": true, "export-2": false });
});
