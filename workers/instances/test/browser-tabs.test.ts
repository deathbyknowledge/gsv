import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Browser, BrowserContext, CDPSession, Page } from "@cloudflare/playwright";
import { expect, it } from "vitest";
import { CloudBrowser } from "../src/browser";
import { InstanceStore } from "../src/store";

it("retires closed persisted targets on reattachment and later tab refreshes", async () => {
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const record = store.admit({ ownerUid: 1000, human: true }, { requestId: "tabs", templateId: "browser" },
      { enabled: true, concurrentInstances: 2, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 2, profileStorageBytes: 5242880 });
    store.sql.exec("UPDATE instances SET runtime = ? WHERE id = ?", JSON.stringify({ contextId: "context", activeTabId: 1, nextTabId: 3, tabs: { "1": "live", "2": "closed" } }), record.instanceId);
    // SAFETY: Reattachment only needs target metadata and a detach operation from this CDP fixture.
    const cdp = { send: async () => ({ targetInfo: { targetId: "live", browserContextId: "context", title: "Page", url: "https://example.com" } }), detach: async () => {} } as CDPSession;
    // SAFETY: The tab-refresh fixture only observes page liveness and frame navigation subscriptions.
    const page = { isClosed: () => false, frames: () => [], on: () => {} } as Page;
    let pages = [page];
    // SAFETY: This existing-context fixture exercises only attachment and tab enumeration.
    const context = { pages: () => pages, newCDPSession: async () => cdp, addInitScript: async () => {}, on: () => {} } as BrowserContext;
    // SAFETY: The browser is already attached and only enumerates its existing contexts.
    const connection = { contexts: () => [context] } as Browser;
    const browser = await CloudBrowser.fromConnection(connection, record, store);
    expect(JSON.parse(store.byId(record.instanceId).runtime!)).toMatchObject({ tabs: { "1": "live" }, nextTabId: 3 });
    expect(Object.keys(JSON.parse(store.byId(record.instanceId).runtime!).tabs)).toEqual(["1"]);
    pages = [];
    await browser.listTabs();
    expect(JSON.parse(store.byId(record.instanceId).runtime!)).toMatchObject({ tabs: {}, activeTabId: 0, nextTabId: 3 });
  });
});

it("enters input in a known open tab without rereading every tab, and finds a new tab by refreshing", async () => {
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const record = store.admit({ ownerUid: 1000, human: true }, { requestId: "input", templateId: "browser" },
      { enabled: true, concurrentInstances: 2, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 2, profileStorageBytes: 5242880 });
    store.sql.exec("UPDATE instances SET runtime = ? WHERE id = ?", JSON.stringify({ contextId: "context", activeTabId: 1, nextTabId: 3, tabs: { "1": "first", "2": "second" }, origins: [], unsaved: [] }), record.instanceId);
    let lookups = 0;
    const typed: string[] = [];
    const targets = new Map<Page, string>();
    const tab = (targetId: string) => {
      // SAFETY: Input needs only liveness, frames, navigation subscriptions and text insertion from a tab.
      const page = { isClosed: () => false, frames: () => [], on: () => {}, keyboard: { insertText: async (text: string) => { typed.push(text); } } } as Page;
      targets.set(page, targetId);
      return page;
    };
    const pages = [tab("first"), tab("second")];
    const debuggerFor = (page: Page) => {
      // SAFETY: Tabs answer only target metadata and their document identity.
      return { send: async (method: string) => {
        if (method === "Target.getTargetInfo") { lookups++; return { targetInfo: { targetId: targets.get(page), browserContextId: "context", title: "Page", url: "https://example.com" } }; }
        return { frameTree: { frame: { loaderId: `document-${targets.get(page)}` } } };
      }, detach: async () => {} } as CDPSession;
    };
    // SAFETY: This existing-context fixture exercises only attachment, tab enumeration and debugger sessions.
    const context = { pages: () => pages, newCDPSession: async (page: Page) => debuggerFor(page), addInitScript: async () => {}, on: () => {} } as BrowserContext;
    // SAFETY: The browser is already attached and only enumerates its existing contexts.
    const browser = await CloudBrowser.fromConnection({ contexts: () => [context] } as Browser, record, store);
    lookups = 0;
    expect(await browser.documentId(2)).toBe("document-second");
    await browser.humanInput(2, { kind: "text", text: "a" });
    expect(typed).toEqual(["a"]);
    expect(lookups).toBe(0);
    pages.push(tab("third"));
    await browser.humanInput(3, { kind: "text", text: "b" });
    expect(typed).toEqual(["a", "b"]);
  });
});
