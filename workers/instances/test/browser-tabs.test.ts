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
