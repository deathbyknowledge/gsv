import { DurableObject, RpcTarget } from "cloudflare:workers";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { BrowserHandoff, BrowserHumanInput, BrowserProfile, BrowserPersistence, CloudInstance, InstanceSelector, SysInstanceStopArgs, SysBrowserHandoffGetArgs } from "@humansandmachines/gsv/protocol";
import {
  browserHandoffRequestSchema, browserHandoffSelectorSchema, browserProfileCreateSchema, browserProfileListSchema,
  instanceActorSchema, instanceListSchema, instanceSelectorSchema, instanceStopSchema, instanceStartSchema, browserInputSchema, browserWatchSchema,
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
import { BrowserOperationGate, within } from "./browser-operation";
import { BrowserWatch } from "./browser-watch";
import { BrowserStorageError, SAVE_TIMEOUT_MS } from "./browser-storage";
import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";

const QUIET_ALLOCATION_MS = 180_000;
const PROVIDER_RECOVERY_MS = 60_000;
const MAINTENANCE_BUDGET_MS = 20_000;
const PENDING_CHANGES_KEY = "pending_instance_changes";
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

function isBrowserRequest(frame: InstanceTargetRequest): frame is Extract<InstanceTargetRequest, { call: typeof IMPLEMENTATIONS[number] }> {
  return IMPLEMENTATIONS.some(call => call === frame.call);
}

export class InstanceCoordinator extends DurableObject<Environment> implements InstallationInstances {
  readonly #store: InstanceStore;
  readonly #policy: InstancePolicy;
  readonly #profiles: ProfileStorage;
  readonly #provider: BrowserProvider;
  readonly #retirement: InstanceRetirement;
  readonly #browsers = new Map<string, Promise<CloudBrowser>>();
  readonly #attachments = new Set<Promise<CloudBrowser>>();
  readonly #operations = new Map<string, Map<string, OwnedOperation>>();
  readonly #operationGates = new Map<string, BrowserOperationGate>();
  readonly #profileWork = new BrowserOperationGate();
  readonly #saves = new Map<string, { done: Promise<void>; outcome: Promise<boolean>; abort: AbortController }>();
  readonly #stops = new Map<string, Promise<void>>();
  readonly #handoffBarriers = new Map<string, Promise<void>>();
  readonly #autosaveAfter = new Map<string, number>();
  readonly #humanInputs = new Map<string, Promise<unknown>>();
  readonly #watches = new Map<string, { instanceId: string; watch: BrowserWatch }>();
  #notifying: Promise<void> | null = null;
  readonly #installationId: string;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    if (!ctx.id.name) throw new Error("Instances require a named installation identity");
    this.#installationId = ctx.id.name;
    migrate(ctx.storage);
    this.#store = new InstanceStore(ctx.storage, ownerUid => this.notifyChange(ownerUid));
    this.#policy = new InstancePolicy(env, this.#installationId);
    this.#profiles = new ProfileStorage(this.#installationId, env.PROFILES, this.#store);
    this.#provider = new BrowserProvider(env.BROWSER);
    this.#retirement = new InstanceRetirement(ctx.storage, this.#installationId);
  }
  getTarget(): InstallationInstances { this.#retirement.requireLive(); return new InstanceCapability(this); }

  private notifyChange(ownerUid: number): void {
    if (this.#retirement.get()) return;
    const pending = this.pendingChanges();
    pending.set(ownerUid, (pending.get(ownerUid) ?? 0) + 1);
    this.ctx.storage.kv.put(PENDING_CHANGES_KEY, pending);
    this.ctx.waitUntil(this.publishChanges());
  }

  private pendingChanges(): Map<number, number> {
    return this.ctx.storage.kv.get<Map<number, number>>(PENDING_CHANGES_KEY) ?? new Map();
  }

  private publishChanges(): Promise<void> {
    if (this.#notifying) return this.#notifying;
    // Coalesce synchronous writes after their transaction, off the browser action's critical path.
    this.#notifying = Promise.resolve().then(async () => {
      if (!this.pendingChanges().size || this.#retirement.get()) return;
      const retryAt = Date.now() + 20_000;
      const alarm = await this.ctx.storage.getAlarm();
      if (this.#retirement.get()) return;
      if (alarm === null || alarm > retryAt) await this.ctx.storage.setAlarm(retryAt);
      const failed = new Set<number>();
      while (!this.#retirement.get()) {
        const pending = [...this.pendingChanges()].filter(([ownerUid]) => !failed.has(ownerUid));
        if (!pending.length) break;
        await Promise.all(pending.map(async ([ownerUid, revision]) => {
          try {
            await within(this.env.INSTANCE_EVENTS.instancesChanged({ installationId: this.#installationId, ownerUid }), 5000, "Browser change notification");
            if (this.#retirement.get()) return;
            const remaining = this.pendingChanges();
            if (remaining.get(ownerUid) !== revision) return;
            remaining.delete(ownerUid);
            if (remaining.size) this.ctx.storage.kv.put(PENDING_CHANGES_KEY, remaining);
            else this.ctx.storage.kv.delete(PENDING_CHANGES_KEY);
          } catch (cause) {
            if (this.#retirement.get()) return;
            failed.add(ownerUid);
            const ref = this.#store.diagnostic(null, new Error("Browser change notification failed", { cause }));
            console.warn(`[Instances] Browser change notification failed; diagnostic ${ref}`);
          }
        }));
      }
    }).finally(() => { this.#notifying = null; });
    return this.#notifying;
  }

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
    const value = this.#store.admit(actor, args, limits, Date.now(), new Set(this.#stops.keys()));
    return { instance: value, disposition: value.startRequestId === args.requestId ? "created" as const : "reused" as const };
  }
  async list(raw: InstanceActor, rawArgs: Parameters<InstallationInstances["list"]>[1]) {
    const actor = instanceActorSchema.parse(raw), args = instanceListSchema.parse(rawArgs);
    const limits = await this.#policy.limits();
    const instances = this.#store.inventory(actor.ownerUid, args.includeTerminal);
    return { instances, handoffs: instances.flatMap(value => this.#store.liveHandoffs(value.instanceId)), usage: this.#store.usage(limits) };
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
    if (row.active && (force || instance(row).state !== "stopping")) {
      await this.ctx.storage.setAlarm(Date.now() + 1);
      if (force || instance(row).state === "starting") this.fenceStop(instance(this.#store.byId(row.id)), "Stopped without saving", force);
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
            if (!await this.save(row.id)) {
              const saved = instance(this.#store.byId(row.id)).persistence;
              throw new Error(`${saved?.error ?? "Browser data could not be saved."} The browser is still running. Inspect instance get ${instance(row).targetId} before retrying; --force discards unsaved changes.${saved?.diagnosticRef ? ` Diagnostic: ${saved.diagnosticRef}.` : ""}`);
            }
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
  async listProfiles(raw: InstanceActor, rawArgs: Parameters<InstallationInstances["listProfiles"]>[1]) {
    const actor = instanceActorSchema.parse(raw), args = browserProfileListSchema.parse(rawArgs);
    return this.#store.listProfiles(actor.ownerUid, args.offset);
  }
  async getProfile(raw: InstanceActor, id: string) {
    const row = this.#store.ownedProfile(instanceActorSchema.parse(raw), id);
    return { profile: row ? profile(row) : null };
  }
  async saveProfile(actor: InstanceActor, id: string) {
    const row = this.requireInstance(actor, id, true);
    if (this.#stops.has(row.id)) throw new Error("Browser is preparing to stop");
    await this.browser(row.id);
    this.requireInstance(actor, row.id, true);
    if (this.#stops.has(row.id)) throw new Error("Browser is preparing to stop");
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
    const value = this.#store.handoff(row.id, args.requestId);
    if (!value) throw new Error("Browser handoff not found");
    if (active && (value.state !== "active" || value.expiresAt <= Date.now())) throw new Error("Browser handoff is no longer active");
    return value;
  }
  private requireHandoffAdmission(actor: InstanceActor, id: string): void {
    const row = this.requireInstance(actor, id, true);
    if (this.#stops.has(row.id)) throw new Error("Browser is preparing to stop");
  }
  async requestHandoff(raw: InstanceActor, rawArgs: Parameters<InstallationInstances["requestHandoff"]>[1]) {
    const actor = instanceActorSchema.parse(raw), args = browserHandoffRequestSchema.parse(rawArgs);
    const row = this.requireInstance(actor, args.instanceId, true);
    args.instanceId = row.id;
    const existing = this.#store.handoff(row.id, args.requestId);
    if (existing) {
      if (existing.tabId !== args.tabId || existing.purpose !== args.purpose || existing.responsibilityId !== args.responsibilityId) throw new Error("Handoff requestId has already been used with different arguments");
      if (existing.site || !liveHandoff(existing)) return { handoff: existing, actionPath: actionPath(existing) };
    }
    this.requireHandoffAdmission(actor, row.id);
    if (this.#handoffBarriers.has(row.id)) throw new Error("Browser is finishing human control; retry the request after it settles");
    if (this.#store.liveHandoffs(row.id).some(value => value.requestId !== args.requestId)) throw new Error("Browser already has a pending human request");
    const value: BrowserHandoff = existing ?? { ...args, site: "", state: "pending", revision: 1, createdAt: Date.now(), expiresAt: Math.min(instance(row).expiresAt, Date.now() + 15 * 60_000) };
    // Fence before awaiting CDP or cancellation. No new automation can enter now.
    this.#store.putHandoff(value);
    try {
      const saving = this.#saves.get(row.id)?.done;
      if (!await this.settleOperations(row.id) || !await boundedSettlement(saving ? [saving] : [], 10000)) {
        this.fenceStop(instance(this.#store.byId(row.id)), "Browser did not release automation for human control");
        throw new Error("Browser could not safely transfer control; the instance is stopping");
      }
      const tab = await (await this.browser(row.id)).getTab(args.tabId);
      if (!tab) throw new Error("Requested browser tab no longer exists");
      this.requireHandoffAdmission(actor, row.id);
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
    this.requireHandoffAdmission(actor, previous.instanceId);
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
    const pending = this.#handoffBarriers.get(args.instanceId);
    if (state !== "completed") {
      const terminal: BrowserHandoff = { ...value, state, completedAt: Date.now(), revision: value.revision + 1 };
      this.#store.putHandoff(terminal);
      if (pending) return { handoff: terminal };
    } else if (pending) {
      await pending;
      return { handoff: this.handoff(actor, args) };
    }
    // Close admission first. execute() also waits for this barrier before resuming.
    const barrier = (async () => {
      const input = this.#humanInputs.get(args.instanceId);
      if (input && !await boundedSettlement([input], 10000)) {
        this.fenceStop(instance(this.#store.byId(args.instanceId)), "Human input outcome could not be confirmed");
        throw new Error("Browser input did not settle; the instance is stopping");
      }
      if (state === "completed") {
        const saved = await this.save(args.instanceId);
        const current = this.handoff(actor, args);
        if (!liveHandoff(current)) return;
        if (!saved) {
          const persistence = instance(this.#store.byId(args.instanceId)).persistence;
          throw new Error(`${persistence?.error ?? "Browser data could not be saved."} Human control is still active. Retry finishing or cancel the request.${persistence?.diagnosticRef ? ` Diagnostic: ${persistence.diagnosticRef}.` : ""}`);
        }
        this.#store.putHandoff({ ...current, state, completedAt: Date.now(), revision: current.revision + 1 });
      }
    })();
    this.#handoffBarriers.set(args.instanceId, barrier);
    try { await barrier; } finally { if (this.#handoffBarriers.get(args.instanceId) === barrier) this.#handoffBarriers.delete(args.instanceId); }
    return { handoff: this.handoff(actor, args) };
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
      () => this.#store.liveHandoffs(args.instanceId)[0],
      () => { this.requireInstance(actor, args.instanceId, true); },
      cause => new Error(`Browser view interrupted; reference = ${this.#store.diagnostic(args.instanceId, cause)}`),
      () => { this.#watches.delete(watchId); });
    this.#watches.set(watchId, { instanceId: args.instanceId, watch });
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
      if (this.#handoffBarriers.has(args.instanceId)) throw new Error("Browser is finishing human control; retry input after it settles");
      if (args.handoffRequestId) this.handoff(actor, { instanceId: args.instanceId, requestId: args.handoffRequestId }, true);
      else if (this.#store.liveHandoffs(args.instanceId).length) throw new Error("Open the pending browser request before entering input");
    };
    check();
    const deadline = AbortSignal.timeout(10000);
    const previous = this.#humanInputs.get(args.instanceId);
    const operation = (async () => {
      // The previous input owns its result; serialization only waits for cleanup.
      await previous?.catch(() => {});
      await this.operationGate(args.instanceId).run(async () => {
        const browser = await this.browser(args.instanceId);
        await browser.runInput(async () => {
          check();
          if (await browser.documentId(args.tabId) !== args.documentId) throw new Error("The page changed. Check the refreshed view before trying again.");
          check(); deadline.throwIfAborted();
          if (input.kind === "tab") {
            await browser.focusTab(input.tabId);
            check(); deadline.throwIfAborted();
            if (args.handoffRequestId) {
              const value = this.handoff(actor, { instanceId: args.instanceId, requestId: args.handoffRequestId }, true);
              this.#store.putHandoff({ ...value, activeTabId: input.tabId, revision: value.revision + 1 });
            }
          } else await browser.humanInput(args.tabId, input);
        }, deadline, "human");
      }, deadline);
    })();
    const settled = operation.finally(async () => {
      try {
        if (!this.#retirement.get() && this.#store.byId(args.instanceId).active) {
          this.#autosaveAfter.set(args.instanceId, Date.now() + 3000);
          const alarm = await this.ctx.storage.getAlarm();
          if (!this.#retirement.get() && (alarm === null || alarm > Date.now() + 3000)) await this.ctx.storage.setAlarm(Date.now() + 3000);
        }
      } finally {
        if (this.#humanInputs.get(args.instanceId) === settled) this.#humanInputs.delete(args.instanceId);
      }
    });
    this.#humanInputs.set(args.instanceId, settled);
    this.ctx.waitUntil(settled.catch(cause => {
      if (!this.#retirement.get()) this.#store.diagnostic(args.instanceId, cause);
    }));
    await within(settled, 10000, "Browser input", deadline);
    return { accepted: true as const };
  }

  async execute(actor: InstanceActor, id: string, frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse> {
    try {
      id = this.requireInstance(actor, id, true).id;
      if (!isBrowserRequest(frame)) throw new Error("Unsupported browser syscall");
      if (this.#store.liveHandoffs(id).length && !this.#handoffBarriers.has(id)) { await cancelBinaryBody(frame.body, "Human controls browser"); return { type: "res", id: frame.id, ok: false, error: { code: 409, message: "human_control: waiting for the user to return browser control" } }; }
      await this.#policy.requireActive();
      this.requireInstance(actor, id, true);
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
      try {
        await within(this.#handoffBarriers.get(id) ?? Promise.resolve(), Math.max(1, deadlineAt - Date.now()), "Browser handoff completion", abort.signal);
        return await this.operationGate(id).run(async () => {
          const browser = await this.browser(id);
          try {
            this.requireInstance(actor, id, true);
            if (this.#store.liveHandoffs(id).length) throw new Error("human_control: browser is waiting for the user");
            abort.signal.throwIfAborted();
            const result = frame.call === "shell.exec"
              ? { data: await browser.shell.exec(frame.args, { currentTargetId: instance(this.#store.byId(id)).targetId, abortSignal: abort.signal }), body: undefined }
              : await browser.files.handle(frame.call, frame.args, frame.body, abort.signal);
            // Driver results follow the same filesystem and shell contracts as the extension.
            // SAFETY: The shared extension driver handles this exact syscall and returns its matching data/body contract.
            return { type: "res", id: frame.id, ok: true, data: result.data, body: result.body } as InstanceTargetResponse;
          } finally { await browser.shell.idle(); }
        }, abort.signal);
      } catch (error) {
        await cancelBinaryBody(frame.body, "Browser request failed");
        const ref = this.#store.diagnostic(id, error);
        return { type: "res", id: frame.id, ok: false, error: { code: abort.signal.aborted ? 499 : 502, message: `Browser request failed; inspect diagnostic ${ref}` } };
      }
    })();
    operations.set(frame.id, { abort, done });
    try { return await done; }
    finally {
      clearTimeout(timer); operations.delete(frame.id);
      if (!operations.size && this.#operations.get(id) === operations) this.#operations.delete(id);
    }
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
  private operationGate(id: string): BrowserOperationGate {
    if (!this.#store.byId(id).active) throw new Error("Browser is not ready");
    let gate = this.#operationGates.get(id);
    if (!gate) { gate = new BrowserOperationGate(); this.#operationGates.set(id, gate); }
    return gate;
  }
  private browser(id: string): Promise<CloudBrowser> {
    let attached = this.#browsers.get(id);
    if (!attached) {
      const row = this.#store.byId(id);
      if (!row.session_id) throw new Error("Browser session is unavailable");
      const value = instance(row);
      attached = this.#profileWork.save(async () => {
        const check = () => {
          const current = instance(this.expireIfDue(id));
          const finalSave = current.readyAt !== undefined && current.state === "stopping" && current.reason === "Browser lifetime expired" && this.#saves.has(id);
          if (current.state !== "starting" && current.state !== "ready" && !finalSave) throw new Error("Browser is not ready");
        };
        check();
        const saved = value.profileId ? this.#store.ownedProfile({ ownerUid: value.ownerUid, human: false }, value.profileId) : null;
        const state = saved ? await this.#profiles.restore(saved) : undefined;
        check();
        return CloudBrowser.attach(this.env.BROWSER, row.session_id!, value, this.#store, state);
      }, new AbortController().signal);
      this.#browsers.set(id, attached);
      this.#attachments.add(attached);
      const finished = () => { this.#attachments.delete(attached!); };
      void attached.then(finished, finished);
      attached.catch(() => { if (this.#browsers.get(id) === attached) this.#browsers.delete(id); });
    }
    // A caller may stop waiting, but the actual attachment retains the memory slot.
    return within(attached, 30000, "Browser attachment");
  }
  private save(id: string): Promise<boolean> {
    const pending = this.#saves.get(id)?.outcome;
    if (pending) return pending;
    const value = instance(this.#store.byId(id));
    if (!value.profileId) return Promise.resolve(true);
    const abort = new AbortController();
    const started = Date.now();
    this.updatePersistence(id, { saveStatus: "saving", attemptedAt: started, error: undefined, diagnosticRef: undefined });
    const work = this.operationGate(id).save(async () => {
      const limits = await this.#policy.limits();
      abort.signal.throwIfAborted();
      this.updatePersistence(id, { limitBytes: limits.profileStorageBytes });
      const browser = await this.browser(id);
      await this.#profileWork.save(async () => {
        const { state, usage, failures } = await browser.save(limits.profileStorageBytes, abort.signal);
        abort.signal.throwIfAborted();
        const issues = failures?.map(({ issue, cause }) => ({ ...issue, diagnosticRef: this.#store.diagnostic(id, cause) }));
        await this.#profiles.save(value, state, limits.profileStorageBytes, abort.signal, usage, issues);
        abort.signal.throwIfAborted();
      }, abort.signal);
    }, abort.signal);
    // Retain the actual operation after a timeout: deletion and later saves must
    // wait for it, and its abort signal fences any late R2 commit.
    const settled = work.then(() => {}, () => {}).finally(() => {
      if (this.#saves.get(id)?.done === settled) this.#saves.delete(id);
      this.#store.pruneDiagnostics([...this.#saves.keys()]);
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
      } finally {
        this.#store.pruneDiagnostics([...this.#saves.keys()]);
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
    const { saveStatus, savedAt, attemptedAt, durationMs, bytes, storedBytes, limitBytes, error, diagnosticRef, issues } = saved;
    const persistence: BrowserPersistence = { saveStatus, savedAt, attemptedAt, durationMs, bytes, storedBytes, limitBytes, error, diagnosticRef, issues };
    this.#store.update({ ...value, persistence, revision: value.revision + 1 });
  }
  private profileSaving(profileId: string): boolean {
    return [...this.#saves.keys()].some(id => instance(this.#store.byId(id)).profileId === profileId);
  }
  private fenceStop(value: CloudInstance, reason: string, overrideReason = false): void {
    this.#saves.get(value.instanceId)?.abort.abort(new Error(reason));
    for (const item of this.#watches.values()) if (item.instanceId === value.instanceId) item.watch.view.close();
    if (value.state === "stopped" || value.state === "failed") return;
    if (value.state !== "stopping" || (overrideReason && value.reason !== reason)) this.#store.update({ ...value, state: "stopping", reason, revision: value.revision + 1 });
    for (const handoff of this.#store.liveHandoffs(value.instanceId)) this.#store.putHandoff({ ...handoff, state: "cancelled", reason, revision: handoff.revision + 1 });
    for (const operation of this.#operations.get(value.instanceId)?.values() ?? []) operation.abort.abort(new Error(reason));
  }
  async alarm(): Promise<void> {
    // The next alarm survives a failed or evicted provider call.
    await this.ctx.storage.setAlarm(Date.now() + 20_000);
    const started = Date.now();
    const rows = this.#store.sql.exec<Pick<InstanceRow, "id">>("SELECT id FROM instances WHERE active = 1 ORDER BY rowid DESC").toArray();
    for (const row of rows) {
      const value = instance(this.#store.byId(row.id));
      if (value.expiresAt <= started) this.fenceStop(value, "Browser lifetime expired");
    }
    const stopping = (row: Pick<InstanceRow, "id">) => instance(this.#store.byId(row.id)).state === "stopping";
    const prioritized = [...rows.filter(stopping), ...rows.filter(row => !stopping(row))];
    const last = await this.ctx.storage.get<string>("maintenance_cursor");
    const offset = last ? prioritized.findIndex(row => row.id === last) + 1 : 0;
    const ordered = [...prioritized.slice(offset), ...prioritized.slice(0, offset)];
    for (let i = 0; i < ordered.length; i++) {
      await this.maintain(ordered[i]!.id);
      await this.ctx.storage.put("maintenance_cursor", ordered[i]!.id);
      if (Date.now() - started >= MAINTENANCE_BUDGET_MS && i + 1 < ordered.length) {
        await this.ctx.storage.setAlarm(Date.now() + 1);
        break;
      }
    }
    let deleting = false;
    for (const saved of this.#store.profilesInState("deleting")) {
      deleting = true;
      if (!profile(saved).activeInstanceId && !this.profileSaving(saved.id)) await this.#profiles.erase(saved);
    }
    await this.#profiles.cleanup();
    this.#store.pruneDiagnostics([...this.#saves.keys()]);
    this.ctx.waitUntil(this.publishChanges());
    if (!this.#store.activeRows().length && !deleting && !this.#attachments.size && !this.#profiles.hasPendingCleanup() && !this.pendingChanges().size) await this.ctx.storage.deleteAlarm();
  }
  async quiesceInstallation(input: InstallationDeletionRequest) {
    this.#retirement.begin(input);
    this.ctx.storage.kv.delete(PENDING_CHANGES_KEY);
    for (const row of this.#store.activeRows()) this.fenceStop(instance(row), "Space deleted");
    for (const saved of this.#store.profilesInState("active")) {
      const value = profile(saved);
      this.#store.putProfile({ ...value, state: "deleting", revision: value.revision + 1 });
    }
    await this.ctx.storage.setAlarm(Date.now() + 1);
    if (!this.#store.activeRows().length && !this.#attachments.size && !this.#saves.size && !this.#humanInputs.size && ![...this.#operations.values()].some(operations => operations.size)) {
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
    await this.ctx.storage.delete("maintenance_cursor");
    this.ctx.storage.transactionSync(() => {
      for (const table of ["file_chunks", "files", "handoffs", "handoff_receipts", "profiles", "instance_usage", "instances", "diagnostics", "cancelled_starts", "start_requests", "obsolete_profile_objects"]) this.#store.sql.exec(`DELETE FROM ${table}`);
      this.#retirement.phase("erased");
    });
    await this.ctx.storage.deleteAlarm();
    return this.installationDeletionStatus(input);
  }
  async installationDeletionStatus(input: InstallationDeletionRequest) {
    const count = this.#store.sql.exec<{ count: number }>("SELECT (SELECT COUNT(*) FROM instances) + (SELECT COUNT(*) FROM profiles) AS count").one().count;
    return this.#retirement.receipt(input, count);
  }
  private expireIfDue(id: string): InstanceRow {
    const row = this.#store.byId(id), value = instance(row);
    if (row.active && value.state !== "stopping" && value.expiresAt <= Date.now()) {
      this.fenceStop(value, "Browser lifetime expired");
      return this.#store.byId(id);
    }
    return row;
  }
  private async maintain(id: string): Promise<void> {
    try {
      let row = this.expireIfDue(id), value = instance(row);
      if (value.state === "starting") {
        await this.#policy.requireActive();
        if (this.#retirement.get()) return;
        row = this.expireIfDue(id); value = instance(row);
        if (value.state !== "starting") return;
        if (row.acquire_at && !row.session_id) {
          this.fenceStop(value, "Browser allocation outcome is unknown; a new allocation will not be retried");
        } else if (!row.session_id) {
          this.#store.sql.exec("UPDATE instances SET acquire_at = ? WHERE id = ?", Date.now(), id);
          const sessionId = await this.#provider.acquire();
          this.#store.sql.exec("UPDATE instances SET session_id = ? WHERE id = ?", sessionId, id);
        }
        value = instance(this.expireIfDue(id));
        if (value.state === "starting") {
          await this.browser(id);
          value = instance(this.expireIfDue(id));
          if (value.state === "starting") this.#store.update({ ...value, state: "ready", readyAt: Date.now(), revision: value.revision + 1 });
        }
      }
      row = this.expireIfDue(id); value = instance(row);
      for (const handoff of this.#store.liveHandoffs(id)) {
        if (handoff.expiresAt <= Date.now()) await this.endHandoff({ ownerUid: value.ownerUid, human: false }, { instanceId: id, requestId: handoff.requestId }, "expired");
      }
      row = this.expireIfDue(id); value = instance(row);
      if (value.state === "ready") {
        const browser = await this.browser(id);
        if (instance(this.expireIfDue(id)).state !== "ready") return;
        // A metadata command keeps this exact session alive; it never creates one.
        await within(browser.heartbeat(), 10000, "Browser health check");
        row = this.expireIfDue(id);
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
      const value = instance(this.expireIfDue(id));
      this.#store.update({ ...value, diagnosticRef: this.#store.diagnostic(id, error), revision: value.revision + 1 });
      if (value.state === "ready") {
        this.#store.sql.exec("UPDATE instances SET provider_failed_at = COALESCE(provider_failed_at, ?) WHERE id = ?", Date.now(), id);
        const failed = this.#store.byId(id);
        let exists = true;
        try { exists = Boolean(failed.session_id) && await within(this.#provider.exists(failed.session_id!), 5000, "Browser recovery lookup"); }
        catch (lookupError) { this.#store.diagnostic(id, lookupError); }
        if (instance(this.expireIfDue(id)).state !== "ready") return;
        if (exists && Date.now() - failed.provider_failed_at! < PROVIDER_RECOVERY_MS) return;
      }
      this.fenceStop(instance(this.#store.byId(id)), "Browser provider failed");
    }
  }
  private async cleanup(row: InstanceRow): Promise<void> {
    if (!row.session_id) {
      if (row.acquire_at && Date.now() < row.acquire_at + QUIET_ALLOCATION_MS) return;
    } else {
      if (await this.#provider.exists(row.session_id)) {
        const settled = await this.settleOperations(row.id);
        const inputs = this.#humanInputs.get(row.id), saving = this.#saves.get(row.id)?.done;
        const quiet = await boundedSettlement([...(inputs ? [inputs] : []), ...(saving ? [saving] : [])], 10000);
        const current = instance(this.#store.byId(row.id));
        if (settled && quiet && current.state === "stopping" && current.readyAt !== undefined && current.reason === "Browser lifetime expired") {
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
    this.#store.terminal(row.id, Boolean(instance(this.#store.byId(row.id)).diagnosticRef));
    this.#operationGates.delete(row.id);
    this.#autosaveAfter.delete(row.id);
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
