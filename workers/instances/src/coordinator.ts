import { DurableObject, RpcTarget } from "cloudflare:workers";
import { bodyFromBytes, cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { BrowserHandoff, BrowserHumanInput, BrowserProfile, BrowserPersistence, CloudInstance, InstanceSelector, SysInstanceStopArgs, SysBrowserHandoffGetArgs } from "@humansandmachines/gsv/protocol";
import {
  browserHandoffRequestSchema, browserHandoffSelectorSchema, browserProfileCreateSchema,
  instanceActorSchema, instanceListSchema, instanceSelectorSchema, instanceStopSchema, instanceStartSchema, browserFrameSchema, browserInputSchema, browserWatchSchema,
} from "@humansandmachines/gsv/services/instances";
import type { InstallationInstances, InstanceActor, InstanceTargetRequest, InstanceTargetResponse } from "@humansandmachines/gsv/services/instances";
import { z } from "zod";
import { browserTemplate, IMPLEMENTATIONS, InstancePolicy, type Environment } from "./config";
import { CloudBrowser } from "./browser";
import { migrate } from "./schema";
import { instance, InstanceStore, profile, type InstanceRow } from "./store";
import { ProfileStorage } from "./profiles";
import { BrowserProvider } from "./provider";
import { InstanceRetirement } from "./retirement";
import { within } from "./browser-operation";
import { BrowserWatch } from "./browser-watch";
import { BrowserStorageError, SAVE_TIMEOUT_MS } from "./browser-storage";
import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";

const QUIET_ALLOCATION_MS = 180_000;
const PROVIDER_RECOVERY_MS = 60_000;
const humanInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tab"), tabId: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("click"), x: z.number().min(0).max(1280), y: z.number().min(0).max(800) }),
  z.strictObject({ kind: z.literal("scroll"), x: z.number().min(0).max(1280), y: z.number().min(0).max(800), deltaX: z.number().min(-10000).max(10000), deltaY: z.number().min(-10000).max(10000) }),
  z.strictObject({ kind: z.literal("key"), key: z.enum(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "a", "c", "v", "x", "z"]), modifiers: z.number().int().min(0).max(15).optional() }),
  z.strictObject({ kind: z.literal("text"), text: z.string().max(65536) }),
]);
type OwnedOperation = { abort: AbortController; done: Promise<unknown> };
const liveHandoff = (value: BrowserHandoff): boolean => value.state === "pending" || value.state === "active";
const actionPath = (value: BrowserHandoff): string => `/?browserInstance=${encodeURIComponent(value.instanceId)}&browserHandoff=${encodeURIComponent(value.requestId)}`;

export class InstanceCoordinator extends DurableObject<Environment> implements InstallationInstances {
  readonly #store: InstanceStore;
  readonly #policy: InstancePolicy;
  readonly #profiles: ProfileStorage;
  readonly #provider: BrowserProvider;
  readonly #retirement: InstanceRetirement;
  readonly #browsers = new Map<string, Promise<CloudBrowser>>();
  readonly #operations = new Map<string, Map<string, OwnedOperation>>();
  readonly #saves = new Map<string, { done: Promise<void>; outcome: Promise<boolean>; abort: AbortController }>();
  readonly #stops = new Map<string, Promise<void>>();
  readonly #handoffBarriers = new Map<string, Promise<void>>();
  readonly #autosaveAfter = new Map<string, number>();
  readonly #humanInputs = new Map<string, Promise<unknown>>();
  readonly #watches = new Map<string, { instanceId: string; ownerUid: number; watch: BrowserWatch }>();
  readonly #installationId: string;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    if (!ctx.id.name) throw new Error("Instances require a named installation identity");
    this.#installationId = ctx.id.name;
    migrate(ctx.storage);
    this.#store = new InstanceStore(ctx.storage);
    this.#policy = new InstancePolicy(env, this.#installationId);
    this.#profiles = new ProfileStorage(this.#installationId, env.PROFILES, this.#store);
    this.#provider = new BrowserProvider(env.BROWSER);
    this.#retirement = new InstanceRetirement(ctx.storage, this.#installationId);
  }
  getTarget(): InstallationInstances { this.#retirement.requireLive(); return new InstanceCapability(this); }

  async catalog(raw: InstanceActor) {
    instanceActorSchema.parse(raw);
    const limits = await this.#policy.limits();
    return { templates: limits.enabled ? [browserTemplate(limits)] : [], usage: this.#store.usage(limits) };
  }
  async start(rawActor: InstanceActor, rawArgs: Parameters<InstallationInstances["start"]>[1]) {
    const actor = instanceActorSchema.parse(rawActor), args = instanceStartSchema.parse(rawArgs);
    await this.#policy.requireActive();
    const limits = await this.#policy.limits();
    // Install the recovery alarm before claiming an allocation; an extra empty alarm is harmless.
    await this.ctx.storage.setAlarm(Date.now() + 1);
    this.#retirement.requireLive();
    const value = this.#store.admit(actor, args, limits);
    return { instance: value, disposition: value.startRequestId === args.requestId ? "created" as const : "reused" as const };
  }
  async list(raw: InstanceActor, rawArgs: Parameters<InstallationInstances["list"]>[1]) {
    const actor = instanceActorSchema.parse(raw), args = instanceListSchema.parse(rawArgs);
    const limits = await this.#policy.limits();
    const rows = this.#store.rows(!args.includeTerminal).filter(row => row.owner_uid === actor.ownerUid);
    return { instances: rows.map(instance), handoffs: rows.flatMap(row => this.#store.handoffs(row.id).filter(liveHandoff)), usage: this.#store.usage(limits) };
  }
  async get(raw: InstanceActor, rawSelector: InstanceSelector) {
    const row = this.#store.owned(instanceActorSchema.parse(raw), instanceSelectorSchema.parse(rawSelector));
    if (!row && rawSelector.instanceId) throw new Error("Instance not found");
    return { instance: row ? instance(row) : null };
  }
  async stop(raw: InstanceActor, rawSelector: SysInstanceStopArgs) {
    const actor = instanceActorSchema.parse(raw), { force, ...selector } = instanceStopSchema.parse(rawSelector);
    if ("startRequestId" in selector) this.#store.cancelStart(actor, selector.startRequestId);
    const row = this.#store.owned(actor, selector);
    if (!row) {
      if ("instanceId" in selector) throw new Error("Instance not found");
      return { instance: null };
    }
    if (row.active && instance(row).state !== "stopping") {
      await this.ctx.storage.setAlarm(Date.now() + 1);
      if (force || instance(row).state === "starting") this.fenceStop(instance(this.#store.byId(row.id)), "Stopped without saving");
      else {
        let stopping = this.#stops.get(row.id);
        if (!stopping) {
          stopping = (async () => {
            const quiet = await this.settleOperations(row.id);
            const input = this.#humanInputs.get(row.id);
            const priorSave = this.#saves.get(row.id)?.done;
            if (!quiet || !await boundedSettlement([...(input ? [input] : []), ...(priorSave ? [priorSave] : [])], SAVE_TIMEOUT_MS)) {
              throw new Error("Browser work has not settled. The browser is still running; retry stopping or use force to stop without saving.");
            }
            if (instance(this.#store.byId(row.id)).state !== "ready") return;
            if (!await this.save(row.id)) throw new Error("Browser data could not be saved. The browser is still running; retry saving or use force to stop without saving.");
            this.fenceStop(instance(this.#store.byId(row.id)), "Stopped by owner");
          })().finally(() => { this.#stops.delete(row.id); });
          this.#stops.set(row.id, stopping);
        }
        await stopping;
      }
    }
    return { instance: instance(this.#store.byId(row.id)) };
  }
  async createProfile(raw: InstanceActor, rawArgs: Parameters<InstallationInstances["createProfile"]>[1]) {
    const actor = instanceActorSchema.parse(raw), args = browserProfileCreateSchema.parse(rawArgs);
    await this.#policy.requireActive();
    const limits = await this.#policy.limits();
    this.#retirement.requireLive();
    return { profile: this.#store.createProfile(actor, args.requestId, args.label, limits) };
  }
  async listProfiles(raw: InstanceActor) {
    const actor = instanceActorSchema.parse(raw);
    return { profiles: this.#store.profiles(actor.ownerUid).map(profile).filter(value => value.state !== "deleted") };
  }
  async getProfile(raw: InstanceActor, id: string) {
    const row = this.#store.ownedProfile(instanceActorSchema.parse(raw), id);
    return { profile: row ? profile(row) : null };
  }
  async saveProfile(actor: InstanceActor, id: string) {
    const row = this.requireInstance(actor, id, true);
    if (this.#stops.has(row.id)) throw new Error("Browser is preparing to stop");
    await this.browser(row.id);
    await this.save(row.id);
    const profileId = instance(row).profileId;
    return profileId ? this.getProfile(actor, profileId) : { profile: null };
  }
  async readProfileState(raw: InstanceActor, id: string) {
    const row = this.#store.ownedProfile(instanceActorSchema.parse(raw), id);
    if (!row || profile(row).state !== "active") return null;
    const object = await this.#profiles.read(row);
    return object ? { body: { stream: object.body, length: object.size }, size: object.size } : null;
  }
  async deleteProfile(raw: InstanceActor, id: string) {
    const actor = instanceActorSchema.parse(raw), row = this.#store.ownedProfile(actor, id);
    if (!row || profile(row).state === "deleted") return { profile: row ? profile(row) : null };
    await this.ctx.storage.setAlarm(Date.now() + 1);
    const value = { ...profile(row), state: "deleting" as const, revision: profile(row).revision + 1 };
    this.#store.putProfile(value);
    if (value.activeInstanceId) this.fenceStop(instance(this.#store.byId(value.activeInstanceId)), "Profile deleted");
    else if (!this.profileSaving(id)) await this.#profiles.erase(row);
    return this.getProfile(actor, id);
  }

  private requireInstance(actor: InstanceActor, id: string, ready = false): InstanceRow {
    this.#retirement.requireLive();
    const row = this.#store.owned(instanceActorSchema.parse(actor), { instanceId: id });
    if (!row) throw new Error("Instance not found");
    if (ready && (instance(row).state !== "ready" || instance(row).expiresAt <= Date.now())) throw new Error("Browser is not ready");
    return row;
  }
  private human(actor: InstanceActor): void {
    instanceActorSchema.parse(actor);
    if (!actor.human || actor.processId) throw new Error("This browser action requires its signed-in human owner");
  }
  private handoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs, active = false): BrowserHandoff {
    browserHandoffSelectorSchema.parse(args);
    const row = this.requireInstance(actor, args.instanceId, active);
    const value = this.#store.handoffs(row.id).find(item => item.requestId === args.requestId);
    if (!value) throw new Error("Browser handoff not found");
    if (active && (value.state !== "active" || value.expiresAt <= Date.now())) throw new Error("Browser handoff is no longer active");
    return value;
  }
  async requestHandoff(raw: InstanceActor, rawArgs: Parameters<InstallationInstances["requestHandoff"]>[1]) {
    const actor = instanceActorSchema.parse(raw), args = browserHandoffRequestSchema.parse(rawArgs);
    const row = this.requireInstance(actor, args.instanceId, true);
    args.instanceId = row.id;
    const existing = this.#store.handoffs(row.id).find(value => value.requestId === args.requestId);
    if (existing) {
      if (existing.tabId !== args.tabId || existing.purpose !== args.purpose || existing.responsibilityId !== args.responsibilityId) throw new Error("Handoff requestId has already been used with different arguments");
      if (existing.site || !liveHandoff(existing)) return { handoff: existing, actionPath: actionPath(existing) };
    }
    if (this.#store.handoffs(row.id).some(value => liveHandoff(value) && value.requestId !== args.requestId)) throw new Error("Browser already has a pending human request");
    const value: BrowserHandoff = existing ?? { ...args, site: "", state: "pending", revision: 1, createdAt: Date.now(), expiresAt: Math.min(instance(row).expiresAt, Date.now() + 15 * 60_000) };
    // Fence before awaiting CDP or cancellation. No new automation can enter now.
    this.#store.putHandoff(value);
    try {
      const saving = this.#saves.get(row.id)?.done;
      if (!await boundedSettlement(saving ? [saving] : [], 10000) || !await this.settleOperations(row.id)) {
        this.fenceStop(instance(this.#store.byId(row.id)), "Browser did not release automation for human control");
        throw new Error("Browser could not safely transfer control; the instance is stopping");
      }
      const tab = await (await this.browser(row.id)).getTab(args.tabId);
      if (!tab) throw new Error("Requested browser tab no longer exists");
      this.requireInstance(actor, row.id, true);
      const current = this.handoff(actor, { instanceId: args.instanceId, requestId: args.requestId });
      if (!liveHandoff(current)) throw new Error("Browser handoff was cancelled");
      const prepared = { ...current, site: tab.url ? new URL(tab.url).origin : "about:blank" };
      this.#store.putHandoff(prepared);
      return { handoff: prepared, actionPath: actionPath(prepared) };
    } catch (error) {
      const current = this.handoff(actor, { instanceId: args.instanceId, requestId: args.requestId });
      if (liveHandoff(current)) this.#store.putHandoff({ ...current, state: "failed", revision: current.revision + 1, diagnosticRef: this.#store.diagnostic(row.id, error) });
      throw error;
    }
  }
  async getHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs) { return { handoff: this.handoff(actor, args) }; }
  async openHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs) {
    this.human(actor);
    const previous = this.handoff(actor, args);
    this.requireInstance(actor, args.instanceId, true);
    if (!liveHandoff(previous) || previous.expiresAt <= Date.now()) throw new Error("Browser handoff is no longer available");
    if (!previous.site) throw new Error("Browser is still preparing human control");
    const value: BrowserHandoff = { ...previous, state: "active", revision: previous.state === "active" ? previous.revision : previous.revision + 1 };
    this.#store.putHandoff(value);
    return { handoff: value, actionPath: actionPath(value) };
  }
  async cancelHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs) { return this.endHandoff(actor, args, "cancelled"); }
  async finishHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs) { this.human(actor); return this.endHandoff(actor, args, "completed"); }
  private async endHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs, state: "completed" | "cancelled" | "expired") {
    const value = this.handoff(actor, args);
    args = { ...args, instanceId: value.instanceId };
    if (!liveHandoff(value)) return { handoff: value };
    // Close admission first. execute() also waits for this barrier before resuming.
    const barrier = (async () => {
      const input = this.#humanInputs.get(args.instanceId);
      if (input && !await boundedSettlement([input], 10000)) {
        this.fenceStop(instance(this.#store.byId(args.instanceId)), "Human input outcome could not be confirmed");
        throw new Error("Browser input did not settle; the instance is stopping");
      }
      if (state === "completed") await this.save(args.instanceId);
    })();
    this.#handoffBarriers.set(args.instanceId, barrier);
    const terminal: BrowserHandoff = { ...value, state, completedAt: Date.now(), revision: value.revision + 1 };
    this.#store.putHandoff(terminal);
    try { await barrier; } finally { if (this.#handoffBarriers.get(args.instanceId) === barrier) this.#handoffBarriers.delete(args.instanceId); }
    return { handoff: terminal };
  }
  async frame(actor: InstanceActor, rawArgs: Parameters<InstallationInstances["frame"]>[1]) {
    this.human(actor);
    const args = browserFrameSchema.parse(rawArgs);
    args.instanceId = this.requireInstance(actor, args.instanceId, true).id;
    const browser = await this.browser(args.instanceId);
    const tabs = await browser.listTabs();
    const handoff = this.#store.handoffs(args.instanceId).find(liveHandoff);
    const tab = tabs.find(tab => tab.id === (args.tabId ?? handoff?.activeTabId ?? handoff?.tabId))
      ?? tabs.find(tab => tab.active) ?? tabs[0];
    if (!tab) throw new Error("This browser has no open tabs");
    const { bytes, documentId } = await browser.humanFrame(tab.id);
    const row = this.requireInstance(actor, args.instanceId, true);
    return { data: { instance: instance(row), handoff, tabId: tab.id, documentId, pointer: browser.pointer,
      tabs: tabs.map(({ id, title, url }) => ({ id, title: title ?? "", url: url ?? "about:blank" })),
      width: 1280, height: 800, contentType: "image/jpeg" as const }, body: bodyFromBytes(bytes) };
  }
  async watch(actor: InstanceActor, rawArgs: Parameters<InstallationInstances["watch"]>[1]) {
    this.human(actor);
    const args = browserWatchSchema.parse(rawArgs);
    args.instanceId = this.requireInstance(actor, args.instanceId, true).id;
    const browser = await this.browser(args.instanceId);
    this.requireInstance(actor, args.instanceId, true);
    if ([...this.#watches.values()].filter(value => value.instanceId === args.instanceId).length >= 4) throw new Error("This browser already has four open viewers");
    const watchId = crypto.randomUUID();
    const watch = new BrowserWatch(browser, args.tabId,
      () => this.#store.handoffs(args.instanceId).find(liveHandoff),
      () => { this.requireInstance(actor, args.instanceId, true); },
      cause => new Error(`Browser view interrupted; reference = ${this.#store.diagnostic(args.instanceId, cause)}`),
      () => { this.#watches.delete(watchId); });
    this.#watches.set(watchId, { instanceId: args.instanceId, ownerUid: actor.ownerUid, watch });
    await watch.start();
    return { data: { watchId, version: 1 as const }, body: watch.view.body };
  }
  async input(actor: InstanceActor, rawArgs: Parameters<InstallationInstances["input"]>[1], rawInput: BrowserHumanInput) {
    this.human(actor);
    const args = browserInputSchema.parse(rawArgs), input = humanInputSchema.parse(rawInput);
    args.instanceId = this.requireInstance(actor, args.instanceId, true).id;
    const check = () => {
      this.requireInstance(actor, args.instanceId, true);
      if (this.#stops.has(args.instanceId)) throw new Error("Browser is preparing to stop");
      if (args.handoffRequestId) this.handoff(actor, { instanceId: args.instanceId, requestId: args.handoffRequestId }, true);
      else if (this.#store.handoffs(args.instanceId).some(liveHandoff)) throw new Error("Open the pending browser request before entering input");
    };
    check();
    const deadline = AbortSignal.timeout(10000);
    const previous = this.#humanInputs.get(args.instanceId);
    const operation = (async () => {
      await previous;
      const browser = await this.browser(args.instanceId);
      await browser.runInput(async () => {
        check();
        if (await browser.documentId(args.tabId) !== args.documentId) throw new Error("The page changed. Check the refreshed view before trying again.");
        check(); deadline.throwIfAborted();
        if (input.kind === "tab") {
          await browser.focusTab(input.tabId);
          if (args.handoffRequestId) {
            const value = this.handoff(actor, { instanceId: args.instanceId, requestId: args.handoffRequestId }, true);
            this.#store.putHandoff({ ...value, activeTabId: input.tabId, revision: value.revision + 1 });
          }
        } else await browser.humanInput(args.tabId, input);
      }, deadline, "human");
    })();
    this.#humanInputs.set(args.instanceId, operation);
    try { await operation; return { accepted: true as const }; }
    finally {
      if (this.#humanInputs.get(args.instanceId) === operation) this.#humanInputs.delete(args.instanceId);
      this.#autosaveAfter.set(args.instanceId, Date.now() + 3000);
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + 3000) await this.ctx.storage.setAlarm(Date.now() + 3000);
    }
  }

  async execute(actor: InstanceActor, id: string, frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse> {
    try {
      id = this.requireInstance(actor, id, true).id;
      if (!IMPLEMENTATIONS.includes(frame.call)) throw new Error("Unsupported browser syscall");
      if (this.#store.handoffs(id).some(liveHandoff)) { await cancelBinaryBody(frame.body, "Human controls browser"); return { type: "res", id: frame.id, ok: false, error: { code: 409, message: "human_control: waiting for the user to return browser control" } }; }
      await this.#policy.requireActive();
      if (this.#stops.has(id)) throw new Error("Browser is preparing to stop");
    } catch (error) {
      await cancelBinaryBody(frame.body, "Browser request was not admitted");
      throw error;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("Browser command deadline exceeded")), Math.max(0, Math.min(deadlineAt, instance(this.#store.byId(id)).expiresAt) - Date.now()));
    let operations = this.#operations.get(id);
    if (!operations) { operations = new Map(); this.#operations.set(id, operations); }
    if (operations.has(frame.id)) { clearTimeout(timer); await cancelBinaryBody(frame.body, "Duplicate browser request"); throw new Error("Browser request is already running"); }
    const done = (async (): Promise<InstanceTargetResponse> => {
      let browser: CloudBrowser | undefined;
      try {
        await within(this.#handoffBarriers.get(id) ?? Promise.resolve(), Math.max(1, deadlineAt - Date.now()), "Browser handoff completion", abort.signal);
        browser = await this.browser(id);
        this.requireInstance(actor, id, true);
        if (this.#store.handoffs(id).some(liveHandoff)) throw new Error("human_control: browser is waiting for the user");
        abort.signal.throwIfAborted();
        const result = frame.call === "shell.exec"
          ? { data: await browser.shell.exec(frame.args, { currentTargetId: instance(this.#store.byId(id)).targetId, abortSignal: abort.signal }), body: undefined }
          : await browser.files.handle(frame.call, frame.args, frame.body, abort.signal);
        // Driver results follow the same filesystem and shell contracts as the extension.
        // SAFETY: The shared extension driver handles this exact syscall and returns its matching data/body contract.
        return { type: "res", id: frame.id, ok: true, data: result.data, body: result.body } as InstanceTargetResponse;
      } catch (error) {
        await cancelBinaryBody(frame.body, "Browser request failed");
        const ref = this.#store.diagnostic(id, error);
        return { type: "res", id: frame.id, ok: false, error: { code: abort.signal.aborted ? 499 : 502, message: `Browser request failed; inspect diagnostic ${ref}` } };
      } finally { if (browser) await browser.shell.idle(); }
    })();
    operations.set(frame.id, { abort, done });
    try { return await done; }
    finally { clearTimeout(timer); operations.delete(frame.id); }
  }
  async cancel(actor: InstanceActor, id: string, requestId: string): Promise<void> {
    id = this.requireInstance(actor, id).id;
    this.#operations.get(id)?.get(requestId)?.abort.abort(new Error("Browser command cancelled"));
  }
  private async settleOperations(id: string): Promise<boolean> {
    const operations = [...(this.#operations.get(id)?.values() ?? [])];
    for (const operation of operations) operation.abort.abort(new Error("Browser control transferred"));
    return boundedSettlement(operations.map(operation => operation.done), 10000);
  }
  private browser(id: string): Promise<CloudBrowser> {
    let attached = this.#browsers.get(id);
    if (!attached) {
      const row = this.#store.byId(id);
      if (!row.session_id) throw new Error("Browser session is unavailable");
      const value = instance(row);
      attached = (async () => {
        const saved = value.profileId ? this.#store.ownedProfile({ ownerUid: value.ownerUid, human: false }, value.profileId) : null;
        const state = saved ? await this.#profiles.restore(saved) : undefined;
        return within(CloudBrowser.attach(this.env.BROWSER, row.session_id!, value, this.#store, state), 30000);
      })();
      this.#browsers.set(id, attached);
      attached.catch(() => { if (this.#browsers.get(id) === attached) this.#browsers.delete(id); });
    }
    return attached;
  }
  private save(id: string): Promise<boolean> {
    const pending = this.#saves.get(id)?.outcome;
    if (pending) return pending;
    const value = instance(this.#store.byId(id));
    if (!value.profileId) return Promise.resolve(true);
    const abort = new AbortController();
    const started = Date.now();
    this.updatePersistence(id, { saveStatus: "saving", attemptedAt: started, error: undefined, diagnosticRef: undefined });
    const work = (async () => {
      const limits = await this.#policy.limits();
      abort.signal.throwIfAborted();
      this.updatePersistence(id, { limitBytes: limits.profileStorageBytes });
      const { state, usage } = await (await this.browser(id)).save(limits.profileStorageBytes, abort.signal);
      abort.signal.throwIfAborted();
      await this.#profiles.save(value, state, limits.profileStorageBytes, abort.signal, usage);
      abort.signal.throwIfAborted();
    })();
    // Retain the actual operation after a timeout: deletion and later saves must
    // wait for it, and its abort signal fences any late R2 commit.
    const settled = work.then(() => {}, () => {}).finally(() => {
      if (this.#saves.get(id)?.done === settled) this.#saves.delete(id);
    });
    const outcome = (async () => {
      try {
        await within(work, SAVE_TIMEOUT_MS, "Saving browser data", abort.signal);
        this.updatePersistence(id, { durationMs: Date.now() - started });
        return true;
      } catch (error) {
        abort.abort(error);
        const diagnosticRef = this.#store.diagnostic(id, error);
        const failure: Partial<BrowserProfile> = {
          saveStatus: "failed", durationMs: Date.now() - started, diagnosticRef,
          error: error instanceof BrowserStorageError ? error.message : "Browser data could not be saved. The previous saved state is intact.",
        };
        if (error instanceof BrowserStorageError && error.usage) failure.usage = error.usage;
        this.updatePersistence(id, failure);
        return false;
      }
    })();
    this.#saves.set(id, { done: settled, outcome, abort });
    return outcome;
  }
  private updatePersistence(id: string, patch: Partial<BrowserProfile>): void {
    const value = instance(this.#store.byId(id));
    const row = value.profileId ? this.#store.ownedProfile({ ownerUid: value.ownerUid, human: false }, value.profileId) : null;
    if (!row || profile(row).state !== "active" || profile(row).activeInstanceId !== id) return;
    const saved = { ...profile(row), ...patch, revision: profile(row).revision + 1 };
    this.#store.putProfile(saved);
    const { saveStatus, savedAt, attemptedAt, durationMs, bytes, storedBytes, limitBytes, error, diagnosticRef } = saved;
    const persistence: BrowserPersistence = { saveStatus, savedAt, attemptedAt, durationMs, bytes, storedBytes, limitBytes, error, diagnosticRef };
    this.#store.update({ ...value, persistence, revision: value.revision + 1 });
  }
  private profileSaving(profileId: string): boolean {
    return [...this.#saves.keys()].some(id => instance(this.#store.byId(id)).profileId === profileId);
  }
  private fenceStop(value: CloudInstance, reason: string): void {
    this.#saves.get(value.instanceId)?.abort.abort(new Error(reason));
    for (const item of this.#watches.values()) if (item.instanceId === value.instanceId) item.watch.view.close();
    if (value.state === "stopped" || value.state === "failed") return;
    if (value.state !== "stopping") this.#store.update({ ...value, state: "stopping", reason, revision: value.revision + 1 });
    for (const handoff of this.#store.handoffs(value.instanceId).filter(liveHandoff)) this.#store.putHandoff({ ...handoff, state: "cancelled", reason, revision: handoff.revision + 1 });
    for (const operation of this.#operations.get(value.instanceId)?.values() ?? []) operation.abort.abort(new Error(reason));
  }
  async alarm(): Promise<void> {
    // The next alarm survives a failed or evicted provider call.
    await this.ctx.storage.setAlarm(Date.now() + 20_000);
    await Promise.all(this.#store.rows(true).map(row => this.maintain(row.id)));
    let deleting = false;
    for (const row of this.#store.sql.exec<{ id: string; owner_uid: number }>("SELECT id, owner_uid FROM profiles").toArray()) {
      const saved = this.#store.ownedProfile({ ownerUid: row.owner_uid, human: false }, row.id)!;
      if (profile(saved).state === "deleting") {
        deleting = true;
        if (!profile(saved).activeInstanceId && !this.profileSaving(saved.id)) await this.#profiles.erase(saved);
      }
    }
    if (!this.#store.rows(true).length && !deleting) await this.ctx.storage.deleteAlarm();
  }
  async quiesceInstallation(input: InstallationDeletionRequest) {
    this.#retirement.begin(input);
    for (const row of this.#store.rows(true)) this.fenceStop(instance(row), "Space deleted");
    for (const row of this.#store.sql.exec<{ owner_uid: number }>("SELECT DISTINCT owner_uid FROM profiles").toArray()) {
      for (const saved of this.#store.profiles(row.owner_uid)) {
        const value = profile(saved);
        if (value.state === "active") this.#store.putProfile({ ...value, state: "deleting", revision: value.revision + 1 });
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + 1);
    if (!this.#store.rows(true).length && !this.#saves.size && !this.#humanInputs.size && ![...this.#operations.values()].some(operations => operations.size)) {
      if (this.#retirement.get()?.phase === "quiescing") this.#retirement.phase("quiesced");
    }
    return this.installationDeletionStatus(input);
  }
  async eraseInstallation(input: InstallationDeletionRequest) {
    this.#retirement.validate(input);
    if (!this.#retirement.get()) throw new Error("Browser deletion must quiesce first");
    if (this.#retirement.get()?.phase === "erased") return this.installationDeletionStatus(input);
    const quiesced = await this.quiesceInstallation(input);
    if (quiesced.phase === "quiescing") return quiesced;
    this.#retirement.phase("erasing");
    // Sweep the entire installation prefix, including uncommitted encrypted revisions.
    const listed = await this.env.PROFILES.list({ prefix: `${this.#installationId}/` });
    if (listed.objects.length) await this.env.PROFILES.delete(listed.objects.map(object => object.key));
    if (listed.truncated) return this.installationDeletionStatus(input);
    this.ctx.storage.transactionSync(() => {
      for (const table of ["files", "handoffs", "profiles", "instances", "diagnostics", "cancelled_starts", "start_requests"]) this.#store.sql.exec(`DELETE FROM ${table}`);
      this.#retirement.phase("erased");
    });
    await this.ctx.storage.deleteAlarm();
    return this.installationDeletionStatus(input);
  }
  async installationDeletionStatus(input: InstallationDeletionRequest) {
    return this.#retirement.receipt(input, this.#store.rows().length + this.#store.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM profiles").one().count);
  }
  private async maintain(id: string): Promise<void> {
    try {
      let row = this.#store.byId(id), value = instance(row);
      if (value.expiresAt <= Date.now()) this.fenceStop(value, "Browser lifetime expired");
      value = instance(this.#store.byId(id));
      if (value.state === "starting") {
        await this.#policy.requireActive();
        if (row.acquire_at && !row.session_id) {
          this.fenceStop(value, "Browser allocation outcome is unknown; a new allocation will not be retried");
        } else if (!row.session_id) {
          this.#store.sql.exec("UPDATE instances SET acquire_at = ? WHERE id = ?", Date.now(), id);
          const sessionId = await this.#provider.acquire();
          this.#store.sql.exec("UPDATE instances SET session_id = ? WHERE id = ?", sessionId, id);
        }
        value = instance(this.#store.byId(id));
        if (value.state === "starting") {
          await this.browser(id);
          value = instance(this.#store.byId(id));
          if (value.state === "starting") this.#store.update({ ...value, state: "ready", readyAt: Date.now(), revision: value.revision + 1 });
        }
      }
      row = this.#store.byId(id); value = instance(row);
      for (const handoff of this.#store.handoffs(id).filter(liveHandoff)) {
        if (handoff.expiresAt <= Date.now()) await this.endHandoff({ ownerUid: value.ownerUid, human: false }, { instanceId: id, requestId: handoff.requestId }, "expired");
      }
      if (value.state === "ready") {
        const browser = await this.browser(id);
        // A metadata command keeps this exact session alive; it never creates one.
        await within(browser.heartbeat(), 10000, "Browser health check");
        row = this.#store.byId(id);
        if (instance(row).state !== "ready") return;
        if (row.provider_failed_at !== null) {
          this.#store.sql.exec("UPDATE instances SET provider_failed_at = NULL WHERE id = ?", id);
          const current = instance(row);
          this.#store.update({ ...current, diagnosticRef: undefined, revision: current.revision + 1 });
        }
        const autosaveAfter = this.#autosaveAfter.get(id) ?? 0;
        if (!this.#stops.has(id) && !this.#humanInputs.has(id) && !(this.#operations.get(id)?.size) && Date.now() >= autosaveAfter) {
          await this.save(id);
          this.#autosaveAfter.delete(id);
        } else if (autosaveAfter > Date.now()) {
          const next = await this.ctx.storage.getAlarm();
          if (next === null || next > autosaveAfter) await this.ctx.storage.setAlarm(autosaveAfter);
        }
      }
      if (value.state === "stopping") await this.cleanup(row);
    } catch (error) {
      const value = instance(this.#store.byId(id));
      this.#store.update({ ...value, diagnosticRef: this.#store.diagnostic(id, error), revision: value.revision + 1 });
      if (value.state === "ready") {
        this.#store.sql.exec("UPDATE instances SET provider_failed_at = COALESCE(provider_failed_at, ?) WHERE id = ?", Date.now(), id);
        const failed = this.#store.byId(id);
        let exists = true;
        try { exists = Boolean(failed.session_id) && await within(this.#provider.exists(failed.session_id!), 5000, "Browser recovery lookup"); }
        catch (lookupError) { this.#store.diagnostic(id, lookupError); }
        if (exists && Date.now() - failed.provider_failed_at! < PROVIDER_RECOVERY_MS) return;
      }
      this.fenceStop(instance(this.#store.byId(id)), "Browser provider failed");
    }
  }
  private async cleanup(row: InstanceRow): Promise<void> {
    const value = instance(row);
    if (!row.session_id) {
      if (row.acquire_at && Date.now() < value.expiresAt + QUIET_ALLOCATION_MS) return;
    } else {
      if (await this.#provider.exists(row.session_id)) {
        const settled = await this.settleOperations(row.id);
        const inputs = this.#humanInputs.get(row.id), saving = this.#saves.get(row.id)?.done;
        const quiet = await boundedSettlement([...(inputs ? [inputs] : []), ...(saving ? [saving] : [])], 10000);
        if (settled && quiet && value.reason === "Browser lifetime expired") {
          // Shutdown may stop waiting, but deletion must still own the actual save.
          await this.save(row.id);
        }
        await this.#provider.close(row.session_id);
        // Confirmation happens on the next alarm, before releasing reservations.
        this.#browsers.delete(row.id);
        return;
      }
    }
    this.#browsers.delete(row.id);
    this.#store.terminal(row.id, Boolean(value.diagnosticRef));
  }
}

/** Export only the installation capability, never coordinator maintenance methods. */
class InstanceCapability extends RpcTarget implements InstallationInstances {
  readonly #owner: InstanceCoordinator;
  constructor(owner: InstanceCoordinator) { super(); this.#owner = owner; }
  catalog(...args: Parameters<InstallationInstances["catalog"]>) { return this.#owner.catalog(...args); }
  start(...args: Parameters<InstallationInstances["start"]>) { return this.#owner.start(...args); }
  list(...args: Parameters<InstallationInstances["list"]>) { return this.#owner.list(...args); }
  get(...args: Parameters<InstallationInstances["get"]>) { return this.#owner.get(...args); }
  stop(...args: Parameters<InstallationInstances["stop"]>) { return this.#owner.stop(...args); }
  createProfile(...args: Parameters<InstallationInstances["createProfile"]>) { return this.#owner.createProfile(...args); }
  listProfiles(...args: Parameters<InstallationInstances["listProfiles"]>) { return this.#owner.listProfiles(...args); }
  getProfile(...args: Parameters<InstallationInstances["getProfile"]>) { return this.#owner.getProfile(...args); }
  saveProfile(...args: Parameters<InstallationInstances["saveProfile"]>) { return this.#owner.saveProfile(...args); }
  readProfileState(...args: Parameters<InstallationInstances["readProfileState"]>) { return this.#owner.readProfileState(...args); }
  deleteProfile(...args: Parameters<InstallationInstances["deleteProfile"]>) { return this.#owner.deleteProfile(...args); }
  requestHandoff(...args: Parameters<InstallationInstances["requestHandoff"]>) { return this.#owner.requestHandoff(...args); }
  getHandoff(...args: Parameters<InstallationInstances["getHandoff"]>) { return this.#owner.getHandoff(...args); }
  openHandoff(...args: Parameters<InstallationInstances["openHandoff"]>) { return this.#owner.openHandoff(...args); }
  cancelHandoff(...args: Parameters<InstallationInstances["cancelHandoff"]>) { return this.#owner.cancelHandoff(...args); }
  finishHandoff(...args: Parameters<InstallationInstances["finishHandoff"]>) { return this.#owner.finishHandoff(...args); }
  frame(...args: Parameters<InstallationInstances["frame"]>) { return this.#owner.frame(...args); }
  watch(...args: Parameters<InstallationInstances["watch"]>) { return this.#owner.watch(...args); }
  input(...args: Parameters<InstallationInstances["input"]>) { return this.#owner.input(...args); }
  execute(...args: Parameters<InstallationInstances["execute"]>) { return this.#owner.execute(...args); }
  cancel(...args: Parameters<InstallationInstances["cancel"]>) { return this.#owner.cancel(...args); }
}

/** An unresponsive browser must not hold stop or human-control admission forever. */
async function boundedSettlement(work: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (!work.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(work).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
