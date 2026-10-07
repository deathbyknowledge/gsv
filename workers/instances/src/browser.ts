import { Buffer } from "node:buffer";
import { connect, type BrowserWorker, type Browser, type BrowserContext, type CDPSession, type Page } from "@cloudflare/playwright";
import type { BrowserPageBackend, BrowserTabsBackend, BrowserValue, DebuggerBackend, DebuggerCommand, TabSummary } from "@humansandmachines/gsv-browser/backend";
import { BrowserTargetFileSystem, BrowserFsDriver } from "@humansandmachines/gsv-browser/fs";
import { BrowserTargetShell } from "@humansandmachines/gsv-browser/shell";
import { PageReferenceStore } from "@humansandmachines/gsv-browser/page-semantics";
import { createPageCommands } from "@humansandmachines/gsv-browser/commands/page";
import { createTabCommands } from "@humansandmachines/gsv-browser/commands/tabs";
import type { BrowserHumanInput, BrowserPointer, BrowserViewState, CloudInstance } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { BrowserInputQueue } from "./input-queue";
import type { StoredFsEntry } from "@humansandmachines/gsv-browser/fs-persistence";
import type { BrowserCommand, TargetFileSystem } from "@humansandmachines/gsv-browser/types";
import { BrowserRuntimeFiles } from "./runtime-files";
import { instance, type InstanceStore } from "./store";
import { within } from "./browser-operation";
import { BrowserScreencast, type CapturedBrowserFrame } from "./browser-view";
import { exportBrowserStorage, restoreBrowserStorage, type BrowserSnapshot } from "./browser-storage";
import { cloudBrowserCredentials } from "./browser-credentials";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type RuntimeState = { contextId: string; nextTabId: number; activeTabId: number; tabs: Record<string, string>; origins?: string[]; storageTargets?: string[] };

/** Owns one surviving Chromium session. Reconnection never launches a replacement. */
export class CloudBrowser implements BrowserPageBackend, BrowserTabsBackend, DebuggerBackend<CDPSession> {
  readonly fs: BrowserTargetFileSystem;
  readonly files: BrowserFsDriver;
  readonly shell: BrowserTargetShell;
  private readonly debuggers = new Map<Page, CDPSession>();
  private readonly tabs = new Map<number, Page>();
  private readonly tabMetadata = new Map<number, { title: string; url: string }>();
  private readonly references = new PageReferenceStore();
  private readonly screencasts = new Map<number, Promise<BrowserScreencast>>();
  private readonly closingScreencasts = new Map<number, Promise<void>>();
  private readonly viewListeners = new Set<() => void>();
  private readonly storagePages = new Set<Page>();
  private refresh: Promise<void> | undefined;
  private readonly inputQueue = new BrowserInputQueue();
  pointer: BrowserPointer | undefined;

  private constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    private readonly state: RuntimeState,
    private readonly record: CloudInstance,
    private readonly store: InstanceStore,
  ) {
    this.state.origins ??= [];
    const observe = (page: Page) => {
      const remember = (url: string) => {
        if (this.storagePages.has(page) || !/^https?:\/\//.test(url)) return;
        const origin = new URL(url).origin;
        if (!this.state.origins!.includes(origin)) { this.state.origins!.push(origin); this.persist(); }
      };
      for (const frame of page.frames()) remember(frame.url());
      page.on("framenavigated", frame => remember(frame.url()));
    };
    for (const page of context.pages()) observe(page);
    context.on("page", observe);
    const pageBackend: BrowserPageBackend = {
      activeTab: () => this.activeTab(), getTab: id => this.getTab(id), captureTabPng: id => this.captureTabPng(id),
      executeInTab: (id, func, args) => this.executeInTab(id, func, args),
    };
    const tabBackend: BrowserTabsBackend = {
      ...pageBackend, listTabs: () => this.listTabs(), createTab: (url, active) => this.createTab(url, active),
      focusTab: id => this.focusTab(id), closeTab: id => this.closeTab(id), reloadTab: id => this.reloadTab(id),
      viewerUrlFor: (path, type, label, fs) => this.viewerUrlFor(path, type, label, fs),
      runInput: (work, signal) => this.runInput(work, signal),
    };
    const debuggerBackend: DebuggerBackend<CDPSession> = {
      acquireDebugger: id => this.acquireDebugger(id), releaseDebugger: id => this.releaseDebugger(id), sendDebuggerCommand: this.sendDebuggerCommand,
      runInput: (work, signal) => this.runInput(work, signal),
    };
    const commands: BrowserCommand[] = [...createTabCommands(tabBackend).tabCommands, ...createPageCommands(pageBackend, debuggerBackend, this.references).pageCommands];
    this.fs = new BrowserTargetFileSystem(new BrowserRuntimeFiles(this, record, commands), async () => ({
      list: async () => this.store.sql.exec<{ entry: ArrayBuffer }>("SELECT entry FROM files WHERE instance_id = ?", record.instanceId).toArray().map(row => decodeEntry(row.entry)),
      get: async (path) => {
        const row = this.store.sql.exec<{ entry: ArrayBuffer }>("SELECT entry FROM files WHERE instance_id = ? AND path = ?", record.instanceId, path).toArray()[0];
        return row ? decodeEntry(row.entry) : null;
      },
      put: async (entry) => {
        if (JSON.parse(this.store.byId(record.instanceId).record).state !== "ready") throw new Error("Browser instance is no longer writable");
        const data = encodeEntry(entry);
        if (data.byteLength > 16 * 1024 * 1024) throw new Error("Browser file exceeds the 16 MiB limit");
        const total = this.store.sql.exec<{ bytes: number }>("SELECT COALESCE(SUM(length(entry)), 0) AS bytes FROM files WHERE instance_id = ? AND path != ?", record.instanceId, entry.path).one().bytes;
        if (total + data.byteLength > 64 * 1024 * 1024) throw new Error("Browser temporary storage limit reached");
        this.store.sql.exec("INSERT INTO files (instance_id, path, entry) VALUES (?, ?, ?) ON CONFLICT(instance_id, path) DO UPDATE SET entry = excluded.entry", record.instanceId, entry.path, data);
      },
      delete: async (paths) => {
        if (JSON.parse(this.store.byId(record.instanceId).record).state !== "ready") throw new Error("Browser instance is no longer writable");
        for (const path of paths) this.store.sql.exec("DELETE FROM files WHERE instance_id = ? AND path = ?", record.instanceId, path);
      },
    }));
    this.files = new BrowserFsDriver(this.fs, async () => record.targetId);
    this.shell = new BrowserTargetShell(this.fs, commands);
  }

  static async attach(binding: BrowserWorker, sessionId: string, record: CloudInstance, store: InstanceStore, savedState?: StorageState): Promise<CloudBrowser> {
    const browser = await connect(binding, sessionId);
    const row = store.byId(record.instanceId);
    let state: RuntimeState;
    let context: BrowserContext;
    if (row.runtime) {
      // SAFETY: persist() is the sole writer of this private runtime record.
      state = JSON.parse(row.runtime) as RuntimeState;
      state.origins = [...new Set([...(state.origins ?? []), ...(savedState?.origins.map(origin => origin.origin) ?? [])])];
      const candidates = await Promise.all(browser.contexts().map(async candidate => {
        const page = candidate.pages()[0];
        if (!page) return null;
        const cdp = await candidate.newCDPSession(page);
        try {
          const { targetInfo } = await cdp.send("Target.getTargetInfo");
          return targetInfo.browserContextId === state.contextId ? candidate : null;
        } finally { await cdp.detach(); }
      }));
      const existing = candidates.find(candidate => candidate !== null);
      if (!existing) throw new Error("Browser context no longer exists; start a new instance");
      context = existing;
      // A coordinator eviction can strand an export page. Close only targets
      // durably claimed by the exporter, before publishing tabs again.
      if (state.storageTargets?.length) {
        for (const page of context.pages()) {
          const cdp = await context.newCDPSession(page);
          try {
            const { targetInfo } = await cdp.send("Target.getTargetInfo");
            if (state.storageTargets.includes(targetInfo.targetId)) await page.close();
          } finally { if (!page.isClosed()) await cdp.detach(); }
        }
        state.storageTargets = [];
      }
    } else {
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      if (savedState) await restoreBrowserStorage(context, savedState);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      await cdp.detach();
      if (!targetInfo.browserContextId) throw new Error("Browser did not provide an isolated context");
      state = { contextId: targetInfo.browserContextId, nextTabId: 2, activeTabId: 1, tabs: { "1": targetInfo.targetId }, origins: savedState?.origins.map(origin => origin.origin) ?? [] };
    }
    await context.addInitScript(cloudBrowserCredentials);
    const runtime = new CloudBrowser(browser, context, state, record, store);
    runtime.persist();
    await runtime.refreshTabs();
    return runtime;
  }

  private persist(): void {
    this.store.sql.exec("UPDATE instances SET runtime = ? WHERE id = ? AND active = 1 AND json_extract(record, '$.state') IN ('starting', 'ready')", JSON.stringify(this.state), this.record.instanceId);
    this.notifyView();
  }
  private async refreshTabs(): Promise<void> {
    this.refresh ??= (async () => {
      const found = new Set<number>();
      for (const page of this.context.pages()) {
        if (page.isClosed() || this.storagePages.has(page)) continue;
        const cdp = await this.debuggerFor(page);
        const { targetInfo } = await within(cdp.send("Target.getTargetInfo"), 5000, "Browser tab metadata");
        let id = Number(Object.keys(this.state.tabs).find(key => this.state.tabs[key] === targetInfo.targetId));
        if (!id) { id = this.state.nextTabId++; this.state.tabs[String(id)] = targetInfo.targetId; }
        this.tabs.set(id, page);
        this.tabMetadata.set(id, { title: targetInfo.title, url: targetInfo.url });
        found.add(id);
      }
      for (const [id, page] of this.tabs) if (!found.has(id)) { this.tabs.delete(id); this.tabMetadata.delete(id); this.debuggers.delete(page); }
      if (!found.has(this.state.activeTabId)) this.state.activeTabId = found.values().next().value ?? 0;
      this.persist();
    })().finally(() => { this.refresh = undefined; });
    await this.refresh;
  }
  private async debuggerFor(page: Page): Promise<CDPSession> {
    const existing = this.debuggers.get(page);
    if (existing) return existing;
    const cdp = await within(this.context.newCDPSession(page), 5000, "Browser tab connection");
    this.debuggers.set(page, cdp);
    return cdp;
  }
  private async page(id: number): Promise<Page> {
    await this.refreshTabs();
    const page = this.tabs.get(id);
    if (!page || page.isClosed()) throw new Error(`Browser tab ${id} is closed`);
    return page;
  }
  private async agentPage(tabId: number): Promise<Page> {
    const page = await this.page(tabId);
    this.state.activeTabId = tabId;
    this.persist();
    return page;
  }
  async acquireDebugger(tabId: number): Promise<CDPSession> {
    return this.debuggerFor(await this.agentPage(tabId));
  }
  async releaseDebugger(_tabId: number): Promise<void> { /* The instance owns its CDP sessions until stop. */ }
  readonly sendDebuggerCommand: DebuggerCommand<CDPSession> = async <T extends object | undefined>(target: CDPSession, method: string, params?: Record<string, BrowserValue>): Promise<T> => {
    // The shared browser core validates and owns its CDP methods. Playwright's generated overloads cannot express this portable boundary.
    // SAFETY: The shared CDP adapter pairs each supported command with its response type.
    const send = target.send.bind(target) as (method: string, params?: Record<string, BrowserValue>) => Promise<T>;
    if (method === "Input.dispatchMouseEvent") {
      const point = z.object({ x: z.number(), y: z.number(), type: z.string() }).parse(params);
      const tabId = [...this.tabs].find(([, page]) => this.debuggers.get(page) === target)?.[0];
      if (tabId !== undefined) {
        this.pointer = { tabId, x: point.x, y: point.y, actor: "ship", clickedAt: point.type === "mousePressed" ? Date.now() : this.pointer?.clickedAt };
        this.notifyView();
      }
    }
    return send(method, params);
  };
  private async summary(id: number, page: Page, index = 0): Promise<TabSummary> {
    return { id, windowId: 1, index, active: id === this.state.activeTabId, highlighted: id === this.state.activeTabId,
      pinned: false, audible: false, muted: false, status: "complete", title: this.tabMetadata.get(id)?.title ?? "", url: page.url(), favIconUrl: null };
  }
  async heartbeat(): Promise<void> {
    const cdp = await within(this.browser.newBrowserCDPSession(), 5000, "Browser health connection");
    try { await within(cdp.send("Browser.getVersion"), 5000, "Browser health check"); }
    finally { await within(cdp.detach(), 5000, "Browser health disconnect"); }
  }
  async listTabs(): Promise<TabSummary[]> { await this.refreshTabs(); return Promise.all([...this.tabs].map(([id, page], index) => this.summary(id, page, index))); }
  async activeTab(): Promise<TabSummary | null> { await this.refreshTabs(); return this.state.activeTabId ? this.getTab(this.state.activeTabId) : null; }
  async getTab(tabId: number): Promise<TabSummary | null> { await this.refreshTabs(); const page = this.tabs.get(tabId); return page ? this.summary(tabId, page) : null; }
  async createTab(url: string, active: boolean): Promise<TabSummary> {
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.refreshTabs();
    const id = [...this.tabs].find(([, candidate]) => candidate === page)![0];
    if (active) return this.focusTab(id);
    return this.summary(id, page);
  }
  async focusTab(id: number): Promise<TabSummary> { const page = await this.page(id); await page.bringToFront(); this.state.activeTabId = id; this.persist(); return this.summary(id, page); }
  async closeTab(id: number): Promise<void> {
    // Keep a context anchor so it can be recovered after the last visible tab closes.
    if (this.context.pages().length === 1) await this.context.newPage();
    await (await this.page(id)).close(); await this.refreshTabs();
  }
  async reloadTab(id: number): Promise<void> { await (await this.agentPage(id)).reload({ waitUntil: "domcontentloaded", timeout: 30000 }); }
  async captureTabPng(id: number): Promise<Uint8Array> { return (await this.agentPage(id)).screenshot({ type: "png", timeout: 10000 }); }
  async executeInTab<Args extends BrowserValue[], T>(id: number, func: (...args: Args) => T, args: Args): Promise<T> {
    // SAFETY: The serialized expression invokes this exact backend callback with its typed arguments.
    return (await this.agentPage(id)).evaluate(`(${func.toString()})(...${JSON.stringify(args)})`) as Promise<T>;
  }
  async viewerUrlFor(path: string, contentType: string, _label: string, fs: TargetFileSystem): Promise<string> {
    return `data:${contentType};base64,${Buffer.from(await fs.read(path)).toString("base64")}`;
  }
  async save(maxBytes: number, signal: AbortSignal): Promise<BrowserSnapshot> {
    return exportBrowserStorage(this.context, this.state.origins ?? [], maxBytes, signal, this.storagePages, (targetId, owned) => {
      this.state.storageTargets = owned ? [...(this.state.storageTargets ?? []), targetId] : (this.state.storageTargets ?? []).filter(id => id !== targetId);
      this.persist();
    });
  }
  async documentId(id: number): Promise<string> {
    const cdp = await this.debuggerFor(await this.page(id));
    return (await within(cdp.send("Page.getFrameTree"), 5000, "Browser document identity")).frameTree.frame.loaderId;
  }
  async humanFrame(id: number): Promise<{ bytes: Uint8Array; documentId: string }> {
    const documentId = await this.documentId(id);
    const bytes = await within((await this.page(id)).screenshot({ type: "jpeg", quality: 75, timeout: 10000 }), 11000, "Browser live frame");
    if (documentId !== await this.documentId(id)) throw new Error("The page changed; refreshing the view");
    return { bytes, documentId };
  }
  viewState(): BrowserViewState {
    return { kind: "state", tabs: [...this.tabMetadata].map(([id, metadata]) => ({ id, ...metadata })), activeTabId: this.state.activeTabId, pointer: this.pointer };
  }
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => { this.viewListeners.delete(listener); };
  }
  private notifyView(): void { for (const listener of this.viewListeners) listener(); }
  async watchTab(id: number, frame: (value: CapturedBrowserFrame) => void, error: (cause: unknown) => void): Promise<() => void> {
    let pending = this.screencasts.get(id);
    if (!pending) {
      pending = (async () => {
        await this.closingScreencasts.get(id);
        const page = await this.page(id);
        const cdp = await within(this.context.newCDPSession(page), 5000, "Browser view connection");
        const producer = new BrowserScreencast(cdp, id);
        try { await producer.start(); }
        catch (cause) { await producer.close(); throw cause; }
        return producer;
      })();
      this.screencasts.set(id, pending);
    }
    const owned = pending;
    const producer = await pending.catch(cause => { if (this.screencasts.get(id) === owned) this.screencasts.delete(id); throw cause; });
    const unsubscribe = producer.subscribe(frame, error);
    return () => {
      unsubscribe();
      if (!producer.viewers && this.screencasts.get(id) === owned) {
        this.screencasts.delete(id);
        const closing = producer.close().finally(() => { if (this.closingScreencasts.get(id) === closing) this.closingScreencasts.delete(id); });
        this.closingScreencasts.set(id, closing);
      }
    };
  }
  runInput<T>(work: () => Promise<T>, signal?: AbortSignal, owner: "ship" | "human" = "ship"): Promise<T> {
    return this.inputQueue.run(async () => {
      const value = instance(this.store.byId(this.record.instanceId));
      if (value.state !== "ready" || value.expiresAt <= Date.now()) throw new Error("Browser is no longer ready");
      return work();
    }, signal, owner);
  }
  async humanInput(id: number, input: Exclude<BrowserHumanInput, { kind: "tab" }>): Promise<void> {
    const page = await this.page(id);
    if (input.kind === "click") {
      this.pointer = { tabId: id, x: input.x, y: input.y, actor: "human", clickedAt: Date.now() };
      this.notifyView();
      await page.mouse.click(input.x, input.y);
    }
    else if (input.kind === "text") await page.keyboard.insertText(input.text);
    else if (input.kind === "key") {
      const modifiers = input.modifiers ?? 0;
      const prefix = [[1, "Alt"], [2, "Control"], [4, "Meta"], [8, "Shift"]] as const;
      await page.keyboard.press([...prefix.filter(([mask]) => modifiers & mask).map(([, key]) => key), input.key].join("+"));
    } else { await page.mouse.move(input.x, input.y); await page.mouse.wheel(input.deltaX, input.deltaY); }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.screencasts.values()].map(async pending => (await pending).close()));
    await Promise.allSettled(this.closingScreencasts.values());
    this.screencasts.clear();
    await this.browser.close();
  }
}

function encodeEntry(entry: StoredFsEntry): ArrayBuffer {
  const value = entry.kind === "file" ? { ...entry, content: Buffer.from(entry.content).toString("base64") } : entry;
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(value))).buffer;
}
function decodeEntry(bytes: ArrayBuffer): StoredFsEntry {
  // SAFETY: encodeEntry is the sole writer; its file payload is base64 rather than an ArrayBuffer.
  const value = JSON.parse(new TextDecoder().decode(bytes)) as StoredFsEntry & { content?: string };
  if (value.kind === "file") return { ...value, content: new Uint8Array(Buffer.from(value.content, "base64")).buffer };
  return value;
}
