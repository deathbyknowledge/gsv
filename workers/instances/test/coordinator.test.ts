import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceCoordinator } from "../src/coordinator";
import { CloudBrowser } from "../src/browser";
import { InstancePolicy } from "../src/config";
import { BrowserProvider } from "../src/provider";
import { instance, InstanceStore } from "../src/store";
import { ProfileStorage } from "../src/profiles";
import { BrowserStorageError, SAVE_TIMEOUT_MS } from "../src/browser-storage";

const actor = { ownerUid: 1000, human: true };
const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 36000, maxInstanceSeconds: 1800, savedProfiles: 5, profileStorageBytes: 5242880 };
const namespace = env.INSTANCES;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture(work: (object: InstanceCoordinator, store: InstanceStore, id: string, installationId: string, browser: Partial<CloudBrowser>) => Promise<void>, humanInput = vi.fn(async () => {})) {
  vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
  const shell: Partial<CloudBrowser["shell"]> = { idle: async () => {}, exec: async () => ({ status: "completed", output: "ok", exitCode: 0 }) };
  const browser: Partial<CloudBrowser> = {
    heartbeat: vi.fn(async () => {}),
    getTab: async () => ({ id: 1, url: "https://example.com/login" }),
    activeTab: async () => ({ id: 1, url: "https://example.com/login" }),
    listTabs: async () => ({ tabs: [], total: 0 }),
    viewState: () => ({ kind: "state", activeTabId: 1, tabs: [{ id: 1, title: "Login", url: "https://example.com/login" }] }),
    onViewChange: () => () => {},
    watchTab: async (_id, frame) => { frame({ tabId: 1, documentId: "document", capturedAt: Date.now(), width: 1280, height: 800, image: new Uint8Array([1, 2]) }); return () => {}; },
    humanInput, humanFrame: async () => ({ bytes: new Uint8Array([1, 2]), documentId: "document" }),
    documentId: async () => "document", runInput: async work => work(), focusTab: async () => ({ id: 1 }),
    save: async () => ({ state: { cookies: [], origins: [] }, usage: { bytes: 27, cookieBytes: 2, cookies: 0, sites: [] } }),
    // SAFETY: These coordinator tests exercise only shell execution and its idle barrier.
    shell: shell as CloudBrowser["shell"],
  };
  // SAFETY: The fixture supplies every browser operation exercised by the coordinator tests below.
  vi.spyOn(CloudBrowser, "attach").mockResolvedValue(browser as CloudBrowser);
  const installationId = crypto.randomUUID();
  await runInDurableObject(namespace.getByName(installationId), async (object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const value = store.admit(actor, { requestId: "start", templateId: "browser", lifetimeSeconds: 300 }, limits);
    store.update({ ...value, state: "ready", readyAt: Date.now() });
    store.sql.exec("UPDATE instances SET session_id = ? WHERE id = ?", "test-session", value.instanceId);
    await work(object, store, value.instanceId, installationId, browser);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

describe("human browser control", () => {
  it("resolves displayed IDs within the owner and never reports an unknown stop as successful", () => fixture(async (object, store, instanceId) => {
    const targetId = instance(store.byId(instanceId)).targetId;
    expect(await object.get(actor, { instanceId: targetId })).toMatchObject({ instance: { instanceId } });
    for (const id of ["unknown", targetId.slice(0, 4)]) {
      await expect(object.get(actor, { instanceId: id })).rejects.toThrow("not found");
      await expect(object.stop(actor, { instanceId: id })).rejects.toThrow("not found");
    }
    await expect(object.stop({ ownerUid: 1001, human: true }, { instanceId: targetId })).rejects.toThrow("not found");
    const view = await object.watch(actor, { instanceId: targetId });
    await view.body.stream.cancel();
    const selector = { instanceId: targetId, requestId: "short-handoff" };
    expect(await object.requestHandoff(actor, { ...selector, tabId: 1, purpose: "Sign in" })).toMatchObject({ handoff: { instanceId } });
    await object.openHandoff(actor, selector);
    await object.input(actor, { instanceId: targetId, tabId: 1, documentId: "document", handoffRequestId: selector.requestId }, { kind: "text", text: "test" });
    await object.finishHandoff(actor, selector);
    expect(await object.stop(actor, { instanceId: targetId })).toMatchObject({ instance: { instanceId, state: "stopping" } });
    expect(await object.stop(actor, { startRequestId: "not-admitted" })).toEqual({ instance: null });
    expect(await object.get(actor, { startRequestId: "not-admitted" })).toEqual({ instance: null });
    expect(() => store.admit(actor, { requestId: "not-admitted", templateId: "browser" }, limits)).toThrow("cancelled before admission");
  }));
  it("preserves created and reused start outcomes when a request is replayed", () => fixture(async (object) => {
    vi.spyOn(InstancePolicy.prototype, "limits").mockResolvedValue(limits);
    const created = { requestId: "created", templateId: "browser", fresh: true };
    const reused = { requestId: "reused", templateId: "browser" };
    for (let replay = 0; replay < 2; replay++) {
      expect(await object.start(actor, created)).toMatchObject({ disposition: "created" });
      expect(await object.start(actor, reused)).toMatchObject({ disposition: "reused" });
    }
  }));
  it("scopes and bounds viewers, releases cancelled views, and closes them when the instance stops", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const unsubscribe = vi.fn();
    browser.watchTab = async () => unsubscribe;
    await expect(object.watch({ ...actor, human: false }, { instanceId })).rejects.toThrow("human owner");
    await expect(object.watch({ ownerUid: 1001, human: true }, { instanceId })).rejects.toThrow("not found");
    const views = await Promise.all(Array.from({ length: 4 }, () => object.watch(actor, { instanceId })));
    await expect(object.watch(actor, { instanceId })).rejects.toThrow("four open viewers");
    await views[0]!.body.stream.cancel();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const reopened = await object.watch(actor, { instanceId });
    await object.stop(actor, { instanceId });
    expect(unsubscribe).toHaveBeenCalledTimes(5);
    for (const item of [...views.slice(1), reopened]) expect(await item.body.stream.getReader().read()).toMatchObject({ done: true });
  }));
  it("reclaims abandoned viewers on a static page and lets the owner reopen it", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    browser.watchTab = async (_id, frame) => {
      frame({ tabId: 1, documentId: "document", capturedAt: Date.now(), width: 1280, height: 800, image: new Uint8Array([1, 2]) });
      return unsubscribe;
    };
    const views = await Promise.all(Array.from({ length: 4 }, () => object.watch(actor, { instanceId })));
    const readers = views.map(view => view.body.stream.getReader());
    for (const reader of readers) { await reader.read(); await reader.read(); }
    await expect(object.watch(actor, { instanceId })).rejects.toThrow("four open viewers");
    await vi.advanceTimersByTimeAsync(16000);
    expect(unsubscribe).toHaveBeenCalledTimes(4);
    for (const reader of readers) await expect(reader.read()).rejects.toThrow("stopped reading");
    const reopened = await object.watch(actor, { instanceId });
    await reopened.body.stream.cancel();
    expect(unsubscribe).toHaveBeenCalledTimes(5);
  }));
  it("lets the owner watch and input while automation continues, without creating a handoff", () => fixture(async (object, store, instanceId) => {
    const frame = await object.frame(actor, { instanceId });
    expect(frame.data).toMatchObject({ tabId: 1, documentId: "document", instance: { instanceId } });
    expect(frame.data.handoff).toBeUndefined();
    await frame.body.stream.cancel();
    await object.input(actor, { instanceId, tabId: 1, documentId: "document" }, { kind: "text", text: "hello" });
    expect(store.handoffs(instanceId)).toEqual([]);
    expect(await object.execute(actor, instanceId, { type: "req", id: "watching", call: "shell.exec", args: { input: "page snapshot" } }, Date.now() + 10000)).toMatchObject({ ok: true });
    await expect(object.frame({ ownerUid: 1001, human: true }, { instanceId })).rejects.toThrow("not found");
    await expect(object.input(actor, { instanceId, tabId: 1, documentId: "previous-page" }, { kind: "click", x: 1, y: 2 })).rejects.toThrow("page changed");
    await object.stop(actor, { instanceId });
    await expect(object.input(actor, { instanceId, tabId: 1, documentId: "document" }, { kind: "text", text: "late" })).rejects.toThrow("not ready");
  }));
  it("captures a selected tab without depending on the first inventory page", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    browser.getTab = vi.fn(async id => ({ id, url: "https://example.com/login" }));
    browser.listTabs = vi.fn(async () => ({ tabs: [], total: 1000, nextOffset: 128 }));
    const frame = await object.frame(actor, { instanceId, tabId: 999 });
    expect(frame.data.tabId).toBe(999);
    expect(browser.getTab).toHaveBeenCalledWith(999);
    expect(browser.listTabs).not.toHaveBeenCalled();
    await frame.body.stream.cancel();
  }));
  it("cancels request bodies rejected before admission", () => fixture(async (object, _store, instanceId) => {
    const cancelled = vi.fn();
    const command = { type: "req", id: "write", call: "fs.write", args: { path: "/tmp/file" }, body: { stream: new ReadableStream<Uint8Array>({ cancel: cancelled }) } } as const;
    await expect(object.execute({ ownerUid: 1001, human: true }, instanceId, command, Date.now() + 10000)).rejects.toThrow("not found");
    expect(cancelled).toHaveBeenCalledTimes(1);

    const inactiveCancelled = vi.fn();
    vi.spyOn(InstancePolicy.prototype, "requireActive").mockRejectedValue(new Error("Space is not active"));
    await expect(object.execute(actor, instanceId, { ...command, body: { stream: new ReadableStream<Uint8Array>({ cancel: inactiveCancelled }) } }, Date.now() + 10000)).rejects.toThrow("not active");
    expect(inactiveCancelled).toHaveBeenCalledTimes(1);
  }));

  it("blocks automation throughout human control, rejects processes and other owners, then revokes late input", () => fixture(async (object, _store, instanceId) => {
    const selector = { instanceId, requestId: "login" };
    await object.requestHandoff(actor, { ...selector, tabId: 1, purpose: "Sign in" });
    const command = { type: "req", id: "read", call: "shell.exec", args: { input: "page snapshot" } } as const;
    expect(await object.execute(actor, instanceId, command, Date.now() + 10000)).toMatchObject({ ok: false, error: { code: 409 } });
    await expect(object.openHandoff({ ...actor, human: false, processId: "agent" }, selector)).rejects.toThrow("human owner");
    await expect(object.openHandoff({ ownerUid: 1001, human: true }, selector)).rejects.toThrow("not found");
    await object.openHandoff(actor, selector);
    await expect(object.frame({ ...actor, human: false }, selector)).rejects.toThrow("human owner");
    await expect(object.input({ ...actor, human: false }, { instanceId, tabId: 1, documentId: "document", handoffRequestId: "login" }, { kind: "text", text: "secret" })).rejects.toThrow("human owner");
    await object.input(actor, { instanceId, tabId: 1, documentId: "document", handoffRequestId: "login" }, { kind: "text", text: "test" });
    await object.finishHandoff(actor, selector);
    await expect(object.input(actor, { instanceId, tabId: 1, documentId: "document", handoffRequestId: "login" }, { kind: "text", text: "late" })).rejects.toThrow("no longer active");
    expect(await object.execute(actor, instanceId, command, Date.now() + 10000)).toMatchObject({ ok: true });
  }));

  it("waits for admitted input and cancels queued input before resuming automation", async () => {
    let release!: () => void;
    const input = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    await fixture(async (object, _store, instanceId) => {
      const selector = { instanceId, requestId: "login" };
      await object.requestHandoff(actor, { ...selector, tabId: 1, purpose: "Sign in" });
      await object.openHandoff(actor, selector);
      const first = object.input(actor, { instanceId, tabId: 1, documentId: "document", handoffRequestId: "login" }, { kind: "text", text: "first" });
      await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));
      const second = object.input(actor, { instanceId, tabId: 1, documentId: "document", handoffRequestId: "login" }, { kind: "text", text: "queued" });
      const rejected = expect(second).rejects.toThrow("finishing human control");
      let returned = false;
      const done = object.finishHandoff(actor, selector).then(() => { returned = true; });
      const command = object.execute(actor, instanceId, { type: "req", id: "after-handoff", call: "shell.exec", args: { input: "page snapshot" } }, Date.now() + 10000);
      await Promise.resolve();
      expect(returned).toBe(false);
      release(); await first; await rejected; await done;
      expect(await command).toMatchObject({ ok: true });
      expect(input).toHaveBeenCalledTimes(1);
    }, input);
  });

  it("keeps admission capabilities tied to the admitted template when policy is disabled", () => fixture(async (object, _store, instanceId) => {
    vi.spyOn(InstancePolicy.prototype, "limits").mockResolvedValue({ ...limits, enabled: false });
    expect((await object.catalog(actor)).templates).toEqual([]);
    expect((await object.get(actor, { instanceId })).instance?.implements).toContain("shell.exec");
  }));
});

describe("browser save ordering", () => {
  it.each(["export", "upload"] as const)("keeps human control open after a failed final %s and permits retry", failure => fixture(async (object, store, instanceId, _installationId, browser) => {
    const selector = { instanceId, requestId: "save-login" };
    await object.requestHandoff(actor, { ...selector, tabId: 1, purpose: "Sign in" });
    const { handoff: opened } = await object.openHandoff(actor, selector);
    if (failure === "export") vi.spyOn(browser, "save").mockRejectedValueOnce(new Error("Export failed"));
    else vi.spyOn(ProfileStorage.prototype, "save").mockRejectedValueOnce(new Error("Upload failed"));
    await expect(object.finishHandoff(actor, selector)).rejects.toThrow(/Human control is still active.*Retry Continue.*Diagnostic:/);
    expect((await object.getHandoff(actor, selector)).handoff).toEqual(opened);
    expect(new InstanceStore(store.storage).handoffs(instanceId)[0]).toMatchObject({ state: "active" });
    expect((await object.get(actor, { instanceId })).instance?.persistence?.saveStatus).toBe("failed");
    expect(await object.execute(actor, instanceId, { type: "req", id: "too-early", call: "shell.exec", args: { input: "page snapshot" } }, Date.now() + 10000)).toMatchObject({ ok: false, error: { code: 409 } });
    expect(await object.input(actor, { instanceId, tabId: 1, documentId: "document", handoffRequestId: selector.requestId }, { kind: "text", text: "retry" })).toEqual({ accepted: true });
    expect((await object.finishHandoff(actor, selector)).handoff.state).toBe("completed");
    expect((await object.get(actor, { instanceId })).instance?.persistence?.saveStatus).toBe("saved");
  }));

  it("publishes handoff completion only after saving and shares concurrent finish requests", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const selector = { instanceId, requestId: "saving" };
    await object.requestHandoff(actor, { ...selector, tabId: 1, purpose: "Sign in" });
    const { handoff: opened } = await object.openHandoff(actor, selector);
    const waiting = deferred(), original = browser.save!;
    const save = vi.spyOn(browser, "save").mockImplementation(async (...args) => { await waiting.promise; return original(...args); });
    const first = object.finishHandoff(actor, selector);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const second = object.finishHandoff(actor, selector);
    expect((await object.getHandoff(actor, selector)).handoff).toEqual(opened);
    await expect(object.input(actor, { instanceId, tabId: 1, documentId: "document", handoffRequestId: selector.requestId }, { kind: "text", text: "late" })).rejects.toThrow("finishing human control");
    waiting.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.handoff).toMatchObject({ state: "completed", revision: opened.revision + 1 });
    expect(await object.finishHandoff(actor, selector)).toEqual(a);
    expect(save).toHaveBeenCalledOnce();
  }));

  it.each(["cancel", "stop"] as const)("preserves %s while a handoff completion save is still running", action => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const selector = { instanceId, requestId: "cancel-save" };
    await object.requestHandoff(actor, { ...selector, tabId: 1, purpose: "Sign in" });
    await object.openHandoff(actor, selector);
    const waiting = deferred(), original = browser.save!;
    const save = vi.spyOn(browser, "save").mockImplementation(async (...args) => { await waiting.promise; return original(...args); });
    const finishing = object.finishHandoff(actor, selector);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    if (action === "cancel") {
      expect((await object.cancelHandoff(actor, selector)).handoff.state).toBe("cancelled");
      await expect(object.requestHandoff(actor, { instanceId, requestId: "next", tabId: 1, purpose: "Another sign-in" })).rejects.toThrow("finishing human control");
    } else await object.stop(actor, { instanceId, force: true });
    waiting.resolve();
    expect((await finishing).handoff.state).toBe("cancelled");
    expect((await object.getHandoff(actor, selector)).handoff.state).toBe("cancelled");
    if (action === "cancel") expect((await object.requestHandoff(actor, { instanceId, requestId: "next", tabId: 1, purpose: "Another sign-in" })).handoff.state).toBe("pending");
  }));

  it("stops after a committed save while slow obsolete-object cleanup retries independently", () => fixture(async (object, store, instanceId, _installationId, browser) => {
    await object.saveProfile(actor, instanceId);
    const oldKey = store.ownedProfile(actor, instance(store.byId(instanceId)).profileId!)!.object_key!;
    const stalled = deferred();
    const remove = vi.spyOn(env.PROFILES, "delete").mockImplementationOnce(() => stalled.promise);
    const original = browser.save!;
    browser.save = async (...args) => ({ ...await original(...args), state: { cookies: [], origins: [{ origin: "https://example.com", localStorage: [] }] } });
    expect((await object.stop(actor, { instanceId })).instance).toMatchObject({ state: "stopping", persistence: { saveStatus: "saved" } });
    expect(remove).not.toHaveBeenCalled();
    vi.spyOn(BrowserProvider.prototype, "exists").mockResolvedValue(false);
    vi.useFakeTimers();
    const maintenance = object.alarm();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith([oldKey]));
    await vi.advanceTimersByTimeAsync(5001);
    await maintenance;
    expect(instance(store.byId(instanceId))).toMatchObject({ state: "stopped", persistence: { saveStatus: "saved" } });
    expect(await store.storage.getAlarm()).not.toBeNull();
    expect(store.sql.exec("SELECT * FROM obsolete_profile_objects").toArray()).toHaveLength(1);
    stalled.resolve();
    remove.mockRestore();
    await object.alarm();
    expect(await env.PROFILES.head(oldKey)).toBeNull();
    expect(store.sql.exec("SELECT * FROM obsolete_profile_objects").toArray()).toHaveLength(0);
    expect(await store.storage.getAlarm()).toBeNull();
  }));

  it("cancels automation before a handoff waits for the save queued behind it", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const started = deferred();
    vi.spyOn(browser.shell!, "exec").mockImplementation(async (_args, context) => {
      started.resolve();
      await new Promise<void>(resolve => context!.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "failed", output: "", error: "cancelled" };
    });
    const save = vi.spyOn(browser, "save");
    const command = object.execute(actor, instanceId, { type: "req", id: "before-handoff", call: "shell.exec", args: { input: "page wait '#ready'" } }, Date.now() + 10000);
    await started.promise;
    const saving = object.saveProfile(actor, instanceId);
    await vi.waitFor(async () => expect((await object.get(actor, { instanceId })).instance?.persistence?.saveStatus).toBe("saving"));
    expect(save).not.toHaveBeenCalled();
    const result = await object.requestHandoff(actor, { instanceId, requestId: "during-save", tabId: 1, purpose: "Sign in" });
    expect(result.handoff).toMatchObject({ state: "pending", site: "https://example.com" });
    expect((await saving).profile?.saveStatus).toBe("saved");
    expect(await command).toMatchObject({ ok: true, data: { status: "failed" } });
  }));

  it("waits for admitted shell work to relinquish the browser before saving", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const idle = deferred();
    const enteredIdle = deferred();
    vi.spyOn(browser.shell!, "idle").mockImplementation(async () => { enteredIdle.resolve(); await idle.promise; });
    const save = vi.spyOn(browser, "save");
    const command = object.execute(actor, instanceId, { type: "req", id: "active", call: "shell.exec", args: { input: "tabs close 1" } }, Date.now() + 10000);
    await enteredIdle.promise;
    const saving = object.saveProfile(actor, instanceId);
    await vi.waitFor(async () => expect((await object.get(actor, { instanceId })).instance?.persistence?.saveStatus).toBe("saving"));
    expect(save).not.toHaveBeenCalled();
    idle.resolve();
    expect(await command).toMatchObject({ ok: true });
    expect((await saving).profile?.saveStatus).toBe("saved");
    expect(save).toHaveBeenCalledOnce();
  }));

  it("waits for active human input before exporting storage", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const inputDone = deferred();
    const inputStarted = deferred();
    browser.humanInput = async () => { inputStarted.resolve(); await inputDone.promise; };
    const save = vi.spyOn(browser, "save");
    const input = object.input(actor, { instanceId, tabId: 1, documentId: "document" }, { kind: "text", text: "typing" });
    await inputStarted.promise;
    const saving = object.saveProfile(actor, instanceId);
    await vi.waitFor(async () => expect((await object.get(actor, { instanceId })).instance?.persistence?.saveStatus).toBe("saving"));
    expect(save).not.toHaveBeenCalled();
    inputDone.resolve();
    await input;
    expect((await saving).profile?.saveStatus).toBe("saved");
    expect(save).toHaveBeenCalledOnce();
  }));

  it.each(["manual", "alarm"] as const)("holds new commands and human input until a %s save commits", trigger => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const exported = deferred();
    const uploading = deferred();
    const committed = deferred();
    const events: string[] = [];
    const exportState = browser.save!;
    browser.save = vi.fn(async (...args) => { await exported.promise; events.push("export"); return exportState(...args); });
    const upload = ProfileStorage.prototype.save;
    vi.spyOn(ProfileStorage.prototype, "save").mockImplementation(async function (...args) {
      uploading.resolve();
      await committed.promise;
      await upload.apply(this, args);
      events.push("commit");
    });
    vi.spyOn(browser.shell!, "exec").mockImplementation(async () => { events.push("command"); return { status: "completed", output: "ok", exitCode: 0 }; });
    browser.humanInput = async () => { events.push("input"); };
    const saving = trigger === "manual" ? object.saveProfile(actor, instanceId) : object.alarm();
    await vi.waitFor(() => expect(browser.save).toHaveBeenCalledOnce());
    const command = object.execute(actor, instanceId, { type: "req", id: "after-save", call: "shell.exec", args: { input: "tabs close 1" } }, Date.now() + 10000);
    const input = object.input(actor, { instanceId, tabId: 1, documentId: "document" }, { kind: "click", x: 10, y: 10 });
    const frame = await object.frame(actor, { instanceId });
    await frame.body.stream.cancel();
    expect(events).toEqual([]);
    exported.resolve();
    await uploading.promise;
    expect(events).toEqual(["export"]);
    committed.resolve();
    await Promise.all([saving, input]);
    expect(await command).toMatchObject({ ok: true });
    expect(events.slice(0, 2)).toEqual(["export", "commit"]);
    expect(events.slice(2).sort()).toEqual(["command", "input"]);
  }));

  it("cancels a command waiting on a save and consumes its body without releasing later work", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const exported = deferred();
    const exportState = browser.save!;
    browser.save = vi.fn(async (...args) => { await exported.promise; return exportState(...args); });
    const exec = vi.spyOn(browser.shell!, "exec");
    const cancelled = vi.fn();
    const saving = object.saveProfile(actor, instanceId);
    await vi.waitFor(() => expect(browser.save).toHaveBeenCalledOnce());
    const command = object.execute(actor, instanceId, {
      type: "req", id: "cancelled", call: "fs.write", args: { path: "/tmp/file" },
      body: { stream: new ReadableStream<Uint8Array>({ cancel: cancelled }) },
    }, Date.now() + 10000);
    await vi.waitFor(async () => {
      await object.cancel(actor, instanceId, "cancelled");
      expect(cancelled).toHaveBeenCalledOnce();
    });
    expect(await command).toMatchObject({ ok: false, error: { code: 499 } });
    const later = object.execute(actor, instanceId, { type: "req", id: "later", call: "shell.exec", args: { input: "page snapshot" } }, Date.now() + 10000);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(exec).not.toHaveBeenCalled();
    exported.resolve();
    await saving;
    expect(await later).toMatchObject({ ok: true });
    expect(exec).toHaveBeenCalledOnce();
  }));

  it("retains a timed-out export's barrier until the actual browser work ends", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const exported = deferred();
    const exporting = deferred();
    const exportState = browser.save!;
    browser.save = async (...args) => { exporting.resolve(); await exported.promise; return exportState(...args); };
    const exec = vi.spyOn(browser.shell!, "exec");
    const upload = vi.spyOn(ProfileStorage.prototype, "save");
    vi.useFakeTimers();
    const saving = object.saveProfile(actor, instanceId);
    await exporting.promise;
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS + 1);
    expect((await saving).profile?.saveStatus).toBe("failed");
    const command = object.execute(actor, instanceId, { type: "req", id: "after-timeout", call: "shell.exec", args: { input: "tabs close 1" } }, Date.now() + 10000);
    await vi.advanceTimersByTimeAsync(1);
    expect(exec).not.toHaveBeenCalled();
    exported.resolve();
    expect(await command).toMatchObject({ ok: true });
    expect(upload).not.toHaveBeenCalled();
  }));

  it("force-stops during a save without admitting the queued command", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    const exported = deferred();
    const exportState = browser.save!;
    browser.save = vi.fn(async (...args) => { await exported.promise; return exportState(...args); });
    const exec = vi.spyOn(browser.shell!, "exec");
    const saving = object.saveProfile(actor, instanceId);
    await vi.waitFor(() => expect(browser.save).toHaveBeenCalledOnce());
    const command = object.execute(actor, instanceId, { type: "req", id: "stopping", call: "shell.exec", args: { input: "tabs close 1" } }, Date.now() + 10000);
    expect((await object.stop(actor, { instanceId, force: true })).instance?.state).toBe("stopping");
    expect(await command).toMatchObject({ ok: false, error: { code: 499 } });
    exported.resolve();
    await saving;
    expect(exec).not.toHaveBeenCalled();
  }));
});

describe("browser health", () => {
  it.each(["saved", "failed"] as const)("does not bind a new start to a pending stop whose final save is %s", outcome => fixture(async (object, store, instanceId, _installationId, browser) => {
    vi.spyOn(InstancePolicy.prototype, "limits").mockResolvedValue(limits);
    const exporting = deferred(), release = deferred();
    const originalSave = browser.save!;
    browser.save = async (...args) => {
      exporting.resolve();
      await release.promise;
      if (outcome === "failed") throw new Error("Save unavailable");
      return originalSave(...args);
    };
    const stopping = object.stop(actor, { instanceId });
    const stopped = outcome === "failed" ? expect(stopping).rejects.toThrow("still running") : stopping;
    await exporting.promise;
    const request = { requestId: "during-stop", templateId: "browser" };
    await expect(object.start(actor, request)).rejects.toThrow("preparing to stop");
    expect(store.owned(actor, { startRequestId: request.requestId })).toBeNull();
    expect(store.usage(limits).activeInstances).toBe(1);
    release.resolve(); await stopped;
    if (outcome === "saved") store.terminal(instanceId, false);
    const restarted = await object.start(actor, request);
    expect(restarted.instance.state).toBe(outcome === "saved" ? "starting" : "ready");
    expect(restarted.instance.instanceId === instanceId).toBe(outcome === "failed");
  }));

  it("keeps a failed final save running, exposes measured usage, and permits force stop", () => fixture(async (object, store, instanceId, _installationId, browser) => {
    const usage = { bytes: 7000000, cookieBytes: 42, cookies: 1, sites: [{ origin: "https://example.com", bytes: 6999958, localStorageBytes: 10, indexedDBBytes: 6999948, localStorageEntries: 1, databases: 1, records: 3 }] };
    browser.save = vi.fn(async () => { throw new BrowserStorageError("Storage allowance exceeded", usage); });
    await expect(object.stop(actor, { instanceId })).rejects.toThrow(/Storage allowance exceeded.*still running.*Diagnostic:/);
    expect((await object.get(actor, { instanceId })).instance).toMatchObject({ state: "ready", persistence: { saveStatus: "failed", error: "Storage allowance exceeded" } });
    expect((await object.getProfile(actor, instance(store.byId(instanceId)).profileId!)).profile?.usage).toMatchObject(usage);
    await object.stop(actor, { instanceId, force: true });
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("stopping");
    expect(browser.save).toHaveBeenCalledOnce();
  }));

  it("stops normally after a partial save and exposes the affected site and diagnostic", () => fixture(async (object, store, instanceId, _installationId, browser) => {
    browser.save = async () => ({
      state: { cookies: [], origins: [{ origin: "https://shop.example", localStorage: [{ name: "login", value: "kept" }] }] },
      usage: { complete: false, bytes: 100, cookieBytes: 2, cookies: 0, sites: [] },
      failures: [{ issue: { origin: "https://unsupported.example", reason: "unsupported", message: "This site stores CryptoKey values that cannot be saved by this browser." }, cause: new Error("Unsupported IndexedDB value type: [object CryptoKey]") }],
    });
    const { instance: stopped } = await object.stop(actor, { instanceId });
    expect(stopped).toMatchObject({ state: "stopping", persistence: { saveStatus: "partial", issues: [{ origin: "https://unsupported.example", reason: "unsupported", diagnosticRef: expect.any(String) }] } });
    const row = store.ownedProfile(actor, stopped!.profileId!)!;
    expect(row.object_key).not.toBeNull();
    expect((await object.getProfile(actor, row.id)).profile?.issues).toEqual(stopped!.persistence!.issues);
    expect(store.sql.exec("SELECT id FROM diagnostics WHERE id = ?", stopped!.persistence!.issues![0]!.diagnosticRef!).toArray()).toHaveLength(1);
  }));

  it("reuses repeated partial-save diagnostics and prunes replaced failures after saving", () => fixture(async (object, store, instanceId, _installationId, browser) => {
    const successful = browser.save!;
    let version = 0;
    browser.save = async () => ({
      state: { cookies: [], origins: [] }, usage: { bytes: 27, cookieBytes: 2, cookies: 0, sites: [] },
      failures: Array.from({ length: 128 }, (_, i) => ({ issue: { origin: `https://site-${i}.example.com`, reason: "unavailable" as const, message: "Site storage unavailable" }, cause: `Site ${i} failure ${version}` })),
    });
    const first = (await object.saveProfile(actor, instanceId)).profile!;
    const repeated = (await object.saveProfile(actor, instanceId)).profile!;
    expect(repeated.issues).toEqual(first.issues);
    expect(store.sql.exec("SELECT id FROM diagnostics").toArray()).toHaveLength(128);
    version++;
    const changed = (await object.saveProfile(actor, instanceId)).profile!;
    await vi.waitFor(() => expect(store.sql.exec("SELECT id FROM diagnostics").toArray()).toHaveLength(128 + 64));
    for (const issue of changed.issues!) expect(store.sql.exec("SELECT id FROM diagnostics WHERE id = ?", issue.diagnosticRef!).toArray()).toHaveLength(1);
    browser.save = successful;
    expect((await object.saveProfile(actor, instanceId)).profile?.saveStatus).toBe("saved");
    await vi.waitFor(() => expect(store.sql.exec("SELECT id FROM diagnostics").toArray()).toHaveLength(64));
  }));

  it("serializes concurrent saves and retries successfully before stopping", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    let release!: () => void;
    const original = browser.save!;
    browser.save = vi.fn(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); });
    const first = object.saveProfile(actor, instanceId);
    const second = object.saveProfile(actor, instanceId);
    await vi.waitFor(() => expect(browser.save).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all([first, second]);
    expect(results.every(result => result.profile?.saveStatus === "saved")).toBe(true);
    browser.save = original;
    await object.stop(actor, { instanceId });
    expect((await object.get(actor, { instanceId })).instance).toMatchObject({ state: "stopping", persistence: { saveStatus: "saved" } });
  }));

  it("fences a save when forgetting while it is still exporting", () => fixture(async (object, store, instanceId, _installationId, browser) => {
    let release!: () => void;
    const original = browser.save!;
    browser.save = vi.fn(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); });
    const saving = object.saveProfile(actor, instanceId);
    await vi.waitFor(() => expect(browser.save).toHaveBeenCalledOnce());
    const profileId = instance(store.byId(instanceId)).profileId!;
    await object.deleteProfile(actor, profileId);
    release(); await saving;
    expect(store.ownedProfile(actor, profileId)?.object_key).toBeNull();
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("stopping");
    vi.spyOn(BrowserProvider.prototype, "exists").mockResolvedValue(false);
    await object.alarm();
    expect((await object.getProfile(actor, profileId)).profile?.state).toBe("deleted");
  }));

  it("checks browser liveness without waiting for a page title or frame", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    browser.listTabs = vi.fn(() => new Promise(() => {}));
    await object.alarm();
    expect(browser.heartbeat).toHaveBeenCalledOnce();
    expect(browser.listTabs).not.toHaveBeenCalled();
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("ready");
  }));

  it("preserves the session during a transient failure and clears recovery state when it answers", () => fixture(async (object, store, instanceId, _installationId, browser) => {
    const heartbeat = vi.fn().mockRejectedValueOnce(new Error("Health timed out")).mockResolvedValue(undefined);
    browser.heartbeat = heartbeat;
    vi.spyOn(BrowserProvider.prototype, "exists").mockResolvedValue(true);
    const close = vi.spyOn(BrowserProvider.prototype, "close").mockResolvedValue();
    await object.alarm();
    expect(store.byId(instanceId).provider_failed_at).not.toBeNull();
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("ready");
    await object.alarm();
    expect(store.byId(instanceId).provider_failed_at).toBeNull();
    expect((await object.get(actor, { instanceId })).instance?.diagnosticRef).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  }));

  it("bounds persistent failures with a durable recovery deadline", () => fixture(async (object, store, instanceId, _installationId, browser) => {
    browser.heartbeat = vi.fn().mockRejectedValue(new Error("Health timed out"));
    vi.spyOn(BrowserProvider.prototype, "exists").mockResolvedValue(true);
    await object.alarm();
    store.sql.exec("UPDATE instances SET provider_failed_at = ? WHERE id = ?", Date.now() - 60001, instanceId);
    await object.alarm();
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("stopping");
  }));

  it("stops immediately when the provider confirms the session is gone", () => fixture(async (object, _store, instanceId, _installationId, browser) => {
    browser.heartbeat = vi.fn().mockRejectedValue(new Error("Disconnected"));
    vi.spyOn(BrowserProvider.prototype, "exists").mockResolvedValue(false);
    await object.alarm();
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("stopping");
  }));
});

describe("installation retirement", () => {
  it("retains ownership of a slow shutdown save until installation deletion can drain it", () => fixture(async (object, store, instanceId, installationId) => {
    const saved = store.createProfile(actor, "profile", "Personal", limits);
    const value = (await object.get(actor, { instanceId })).instance!;
    store.update({ ...value, profileId: saved.profileId });
    store.putProfile({ ...saved, activeInstanceId: instanceId });
    // Attach before stop, as a browser that has actually been used would be.
    await object.execute(actor, instanceId, { type: "req", id: "read", call: "shell.exec", args: { input: "page snapshot" } }, Date.now() + 10000);
    let release!: () => void, saving!: () => void;
    const saveStarted = new Promise<void>(resolve => { saving = resolve; });
    vi.spyOn(ProfileStorage.prototype, "save").mockImplementation(() => new Promise<void>(resolve => { release = resolve; saving(); }));
    const exists = vi.spyOn(BrowserProvider.prototype, "exists").mockResolvedValue(true);
    vi.spyOn(BrowserProvider.prototype, "close").mockResolvedValue();
    vi.useFakeTimers();
    const stopping = object.stop(actor, { instanceId });
    const failed = expect(stopping).rejects.toThrow("still running");
    await saveStarted;
    await vi.advanceTimersByTimeAsync(20001);
    await failed;
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("ready");
    await object.stop(actor, { instanceId, force: true });
    exists.mockResolvedValue(false);
    await object.alarm();
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("stopped");
    const request = { version: 1 as const, operationId: "delete-space", installationId };
    expect((await object.quiesceInstallation(request)).phase).toBe("quiescing");
    release();
    await vi.waitFor(async () => expect((await object.quiesceInstallation(request)).phase).toBe("quiesced"));
    expect((await object.eraseInstallation(request)).phase).toBe("live-erased");
  }));

  it("waits for provider shutdown, erases live data, and retains a tombstone and backup receipt", () => fixture(async (object, store, instanceId, installationId) => {
    vi.spyOn(BrowserProvider.prototype, "exists").mockResolvedValue(false);
    const request = { version: 1 as const, operationId: "delete-space", installationId };
    store.createProfile(actor, "profile", "Personal", limits);
    expect((await object.quiesceInstallation(request)).phase).toBe("quiescing");
    expect(() => object.getTarget()).toThrow("retired");
    await object.alarm();
    expect((await object.get(actor, { instanceId })).instance?.state).toBe("stopped");
    const receipt = await object.eraseInstallation(request);
    expect(receipt).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
    expect(receipt.retainedCopies).toHaveLength(1);
    expect(store.rows()).toEqual([]);
    expect([...store.profiles(actor.ownerUid)]).toEqual([]);
    await expect(object.start(actor, { requestId: "late", templateId: "browser" })).rejects.toThrow("retired");
    await expect(object.eraseInstallation({ ...request, operationId: "other" })).rejects.toThrow("immutable");
  }));
});
