import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceCoordinator } from "../src/coordinator";
import { CloudBrowser } from "../src/browser";
import { InstancePolicy } from "../src/config";
import { BrowserProvider } from "../src/provider";
import { InstanceStore } from "../src/store";
import { ProfileStorage } from "../src/profiles";

const actor = { ownerUid: 1000, human: true };
const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 36000, maxInstanceSeconds: 1800, savedProfiles: 5, profileStorageBytes: 5242880 };
const namespace = env.INSTANCES;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture(work: (object: InstanceCoordinator, store: InstanceStore, id: string, installationId: string) => Promise<void>, humanInput = vi.fn(async () => {})) {
  vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
  const shell: Partial<CloudBrowser["shell"]> = { idle: async () => {}, exec: async () => ({ status: "completed", output: "ok", exitCode: 0 }) };
  const browser: Partial<CloudBrowser> = {
    getTab: async () => ({ id: 1, url: "https://example.com/login" }),
    listTabs: async () => [], humanInput, humanFrame: async () => new Uint8Array([1, 2]),
    save: async () => ({ cookies: [], origins: [] }),
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
    await work(object, store, value.instanceId, installationId);
  });
}

describe("human browser control", () => {
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
    await expect(object.handoffFrame({ ...actor, human: false }, selector)).rejects.toThrow("human owner");
    await expect(object.handoffInput({ ...actor, human: false }, selector, { kind: "text", text: "secret" })).rejects.toThrow("human owner");
    await object.handoffInput(actor, selector, { kind: "text", text: "test" });
    await object.finishHandoff(actor, selector);
    await expect(object.handoffInput(actor, selector, { kind: "text", text: "late" })).rejects.toThrow("no longer active");
    expect(await object.execute(actor, instanceId, command, Date.now() + 10000)).toMatchObject({ ok: true });
  }));

  it("waits for admitted input and cancels queued input before resuming automation", async () => {
    let release!: () => void;
    const input = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    await fixture(async (object, _store, instanceId) => {
      const selector = { instanceId, requestId: "login" };
      await object.requestHandoff(actor, { ...selector, tabId: 1, purpose: "Sign in" });
      await object.openHandoff(actor, selector);
      const first = object.handoffInput(actor, selector, { kind: "text", text: "first" });
      await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));
      const second = object.handoffInput(actor, selector, { kind: "text", text: "queued" });
      const rejected = expect(second).rejects.toThrow("no longer active");
      let returned = false;
      const done = object.finishHandoff(actor, selector).then(() => { returned = true; });
      await Promise.resolve();
      expect(returned).toBe(false);
      release(); await first; await rejected; await done;
      expect(input).toHaveBeenCalledTimes(1);
    }, input);
  });

  it("keeps admission capabilities tied to the admitted template when policy is disabled", () => fixture(async (object, _store, instanceId) => {
    vi.spyOn(InstancePolicy.prototype, "limits").mockResolvedValue({ ...limits, enabled: false });
    expect((await object.catalog(actor)).templates).toEqual([]);
    expect((await object.get(actor, { instanceId })).instance?.implements).toContain("shell.exec");
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
    await object.stop(actor, { instanceId });
    vi.useFakeTimers();
    const stopping = object.alarm();
    await saveStarted;
    await vi.advanceTimersByTimeAsync(10001);
    await stopping;
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
    expect(store.profiles(actor.ownerUid)).toEqual([]);
    await expect(object.start(actor, { requestId: "late", templateId: "browser" })).rejects.toThrow("retired");
    await expect(object.eraseInstallation({ ...request, operationId: "other" })).rejects.toThrow("immutable");
  }));
});
