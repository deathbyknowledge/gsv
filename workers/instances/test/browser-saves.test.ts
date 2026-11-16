import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Browser, BrowserContext, CDPSession, Frame, Page } from "@cloudflare/playwright";
import { expect, it } from "vitest";
import { CloudBrowser } from "../src/browser";
import { InstanceStore } from "../src/store";

const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 2, profileStorageBytes: 5242880 };

it("reads only sites with a page open since the last save, and rereads them after a failed commit", async () => {
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const record = store.admit({ ownerUid: 1000, human: true }, { requestId: "saves", templateId: "browser" }, limits);
    const [a, b, c, d] = ["https://a.example", "https://b.example", "https://c.example", "https://d.example"];
    // A browser attached before unsaved sites were tracked has no record of what changed.
    store.sql.exec("UPDATE instances SET runtime = ? WHERE id = ?", JSON.stringify({ contextId: "context", activeTabId: 1, nextTabId: 2, tabs: { "1": "live" }, origins: [a, b, c, d] }), record.instanceId);
    // SAFETY: Saving reads only each frame's URL.
    const frame = (url: string) => ({ url: () => url }) as Frame;
    let url = `${a}/account`;
    let navigated: ((value: Frame) => void) | undefined;
    const navigate = (next: string) => { url = next; navigated!(frame(next)); };
    const read: string[] = [];
    const site = () => ({ origin: read.at(-1), bytes: 2, localStorageBytes: 2, indexedDBBytes: 2, localStorageEntries: 0, databases: 0, records: 0 });
    // SAFETY: Saving needs only the open tab's frame URLs and navigation events.
    const tab = { isClosed: () => false, frames: () => [frame(url)], on: (event: string, listener: (value: Frame) => void) => { if (event === "framenavigated") navigated = listener; } } as Page;
    // SAFETY: Export needs only navigation, evaluation and closing from its private page.
    const exporter = { route: async () => {}, goto: async (origin: string) => { read.push(origin); return null; }, evaluate: async () => ({ summary: site(), json: JSON.stringify({ origin: read.at(-1), localStorage: [] }) }), isClosed: () => false, close: async () => {} } as Page;
    // SAFETY: Target metadata identifies the attached context and the exporter's page.
    const cdp = { send: async () => ({ targetInfo: { targetId: "live", browserContextId: "context", title: "Account", url } }), detach: async () => {} } as CDPSession;
    // SAFETY: This context supplies attachment, tab enumeration and storage export.
    const context = { pages: () => [tab], newCDPSession: async () => cdp, addInitScript: async () => {}, on: () => {}, cookies: async () => [], newPage: async () => exporter } as BrowserContext;
    // SAFETY: The browser is already attached and only enumerates its existing contexts.
    const attach = () => CloudBrowser.fromConnection({ contexts: () => [context] } as Browser, record, store);
    let browser = await attach();
    const save = async () => { read.length = 0; return browser.save(10000, new AbortController().signal); };

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
    // The coordinator restarted before committing that save.
    browser = await attach();
    await save();
    expect(read).toEqual([b]);
    await save();
    expect(read).toEqual([]);
  });
});
