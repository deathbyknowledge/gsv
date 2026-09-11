/**
 * Process DO — the composition root for the "smart process" agent loop.
 *
 * Mutable state (messages, tool calls, metadata) is managed by ProcessStore's
 * SQLite-backed repositories. The Process communicates with the Kernel through
 * recvFrame RPC in both directions.
 *
 * Agent loop: user message → LLM call → tool dispatch → collect results →
 * LLM call → ... → proc.run.finished signal.
 * ProcessController, ProcessRun, ProcessHistory, ProcessResources, and
 * ProcessTools own the runtime operations; Process composes them. Durable turn
 * scheduling across request boundaries belongs to ProcessRun and
 * DurableTaskScheduler.
 */

import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";
import { InstallationRetirement, durableResourceName, stateWithRetirementStorage, RESOURCE_IDENTITY_KEY, inspectResourceStorage, attachDurableResourceIdentity } from "../installation/retirement";
import { DurableObject } from "cloudflare:workers";
import type { SignalFrame } from "../protocol/frames";
import type { ProcessIdentity, ProcKillResult, ProcResetResult } from "@humansandmachines/gsv/protocol";
import type { ProcessInboundFrame } from "../protocol/process-frames";
import { createGenerationService } from "../inference/execution-client";
import { ProcessStore } from "./store";
import { sendFrameToKernel } from "../shared/utils";
import { RipgitClient } from "../fs/ripgit/client";
import type { RunState } from "./run/state";
import { runProcessSqlMigrations } from "./schema/migrations";
import { ProcessRunRepository } from "./storage/run-repository";
import { ProcessSettingsService } from "./settings-service";
import { ProcessSignalService } from "./signals";
import { ProcessTraceService } from "./trace-service";
import { ProcessMessageStreamService } from "./message-stream-service";
import { ProcessFinishDeliveryService } from "./finish-delivery-service";
import { DurableTaskScheduler } from "../shared/durable-tasks";
import { parseProcessDurableObjectName } from "../installation/routing";
import { createInstallationStorage } from "../installation/storage";
import { createInstallationRipgit } from "../installation/ripgit";
import type { GatewayEnv } from "../runtime-env";
import { PROCESS_KILLED_TOMBSTONE_KEY, type ProcessKilledTombstone } from "./internal/lifecycle";
import { decodeProcessTask } from "./context/formatters";
import type { CodeModeApprovalWaiter, CodeModeResponseWaiter } from "./internal/contracts";
import type { ProcessTask } from "./run/helpers";
import { ProcessController } from "./controller/runtime";
import { ProcessHistory } from "./history/runtime";
import { ProcessKernelClient } from "./kernel-client";
import { ProcessResources } from "./resources/runtime";
import { ProcessRun } from "./run/runtime";
import { ProcessTools } from "./tools/runtime";
import { recoverProcess } from "./bootstrap";
import { errorMessageFromUnknown } from "../inference/errors";

type ProcessInstallationRuntime = {
  retirement: InstallationRetirement;
  installationId: string;
  pid: string;
  store: ProcessStore;
  runs: ProcessRunRepository;
  storage: R2Bucket;
  ripgit: RipgitClient | null;
  tasks: DurableTaskScheduler<ProcessTask>;
};

export class Process extends DurableObject<GatewayEnv> {
  get retirement(): InstallationRetirement { return this.namedRuntime().retirement; }
  private readonly installationRuntime: ProcessInstallationRuntime | null;
  readonly ctx: DurableObjectState<{}>;
  readonly env: GatewayEnv;
  get installationId(): string { return this.namedRuntime().installationId; }
  get pid(): string { return this.namedRuntime().pid; }
  get store(): ProcessStore { return this.namedRuntime().store; }
  get runs(): ProcessRunRepository { return this.namedRuntime().runs; }
  readonly signals = new ProcessSignalService(this);
  readonly settings = new ProcessSettingsService(this);
  readonly trace = new ProcessTraceService(this);
  readonly streams = new ProcessMessageStreamService(this);
  readonly finishDelivery = new ProcessFinishDeliveryService(this);
  get storage(): R2Bucket { return this.namedRuntime().storage; }
  readonly generation: ReturnType<typeof createGenerationService>;
  get ripgit(): RipgitClient | null { return this.namedRuntime().ripgit; }
  get tasks(): DurableTaskScheduler<ProcessTask> { return this.namedRuntime().tasks; }
  readonly controller = new ProcessController(this);
  readonly history = new ProcessHistory(this);
  readonly kernel = new ProcessKernelClient(this);
  readonly resources = new ProcessResources(this);
  readonly run = new ProcessRun(this);
  readonly tools = new ProcessTools(this);
  readonly startup: Promise<void>;
  readonly codeModeResponses = new Map<string, CodeModeResponseWaiter>();
  readonly codeModeApprovals = new Map<string, CodeModeApprovalWaiter>();
  readonly requestControllers = new Map<string, AbortController>();
  readonly cancelledRequests = new Map<string, string>();
  readonly runAbortControllers = new Map<string, AbortController>();
  readonly activeTickRunIds = new Set<string>();
  readonly deferredTickRunIds = new Set<string>();
  readonly mediaWriteAdmissions = new Map<string, Promise<void>>();
  readonly mediaUploadAbortControllers = new Map<string, AbortController>();
  lifecyclePhase: "ready" | "resetting" | "killing" = "ready";
  lifecycleEpoch = 0;
  queuedSendAdmission: Promise<void> = Promise.resolve();
  runControlCommit: { runId: string; settled: Promise<void> } | null = null;
  killed = false;
  killedTombstone: ProcessKilledTombstone | null = null;
  resetTransition: Promise<ProcResetResult> | null = null;
  killTransition: Promise<ProcKillResult> | null = null;
  killedCleanupTransition: Promise<Extract<ProcKillResult, { ok: true }>> | null = null;

  constructor(state: DurableObjectState<{}>, env: GatewayEnv) {
    super(state, env);
    this.ctx = state;
    this.env = env;
    this.generation = createGenerationService(env);
    // A nameless historical object exposes only content-free inspection. It must not run migrations or recover work.
    if (!state.id.name && !state.storage.kv.get(RESOURCE_IDENTITY_KEY)) {
      this.installationRuntime = null;
      this.startup = Promise.resolve();
      return;
    }
    const processIdentity = parseProcessDurableObjectName(durableResourceName(state, env.PROCESS));
    const retirement = new InstallationRetirement(state.storage, processIdentity.installationId);
    const ctx = stateWithRetirementStorage(state, retirement);
    this.ctx = ctx;
    const killedTombstone = ctx.storage.kv.get<ProcessKilledTombstone | true>(PROCESS_KILLED_TOMBSTONE_KEY);
    this.killedTombstone = killedTombstone && killedTombstone !== true ? killedTombstone : null;
    this.killed = killedTombstone === true || this.killedTombstone !== null || (retirement.state !== undefined && retirement.state.phase !== "quiescing");
    if (!this.killed && !retirement.state) runProcessSqlMigrations(ctx.storage);
    const store = new ProcessStore(ctx.storage.sql);
    this.installationRuntime = {
      ...processIdentity, retirement, store,
      runs: new ProcessRunRepository(store),
      storage: createInstallationStorage(env.STORAGE, processIdentity.installationId, retirement),
      tasks: new DurableTaskScheduler(ctx.storage, decodeProcessTask, this.run.runScheduledTask.bind(this.run)),
      ripgit: env.RIPGIT ? new RipgitClient(createInstallationRipgit(env.RIPGIT, processIdentity.installationId)) : null,
    };
    this.startup = (retirement.state ? Promise.resolve() : recoverProcess(this)).catch((error) => {
      console.warn("[Process] Recovery failed:", error);
    });
  }

  async attachInstallationResourceIdentity(name: string): Promise<void> {
    parseProcessDurableObjectName(name);
    await attachDurableResourceIdentity(this.ctx, this.env.PROCESS, name);
  }

  inspectInstallationResource() {
    const tombstone = this.ctx.storage.kv.get<ProcessKilledTombstone | true>(PROCESS_KILLED_TOMBSTONE_KEY);
    return inspectResourceStorage(this.installationRuntime?.retirement.raw ?? this.ctx.storage,
      tombstone && tombstone !== true ? tombstone.pid : undefined, tombstone === true ? [PROCESS_KILLED_TOMBSTONE_KEY] : []);
  }

  private namedRuntime(): ProcessInstallationRuntime {
    if (!this.installationRuntime) throw new Error("Historical resource identity requires operator discovery");
    return this.installationRuntime;
  }

  async alarm(): Promise<void> {
    if (!this.installationRuntime || this.retirement.state) return;
    await this.startup;
    await this.run.alarm();
  }

  async quiesceInstallationResource(input: InstallationDeletionRequest) {
    const record = this.retirement.begin(input);
    if (record.phase !== "quiescing") return record;
    await this.startup;
    if (!this.killed || this.killedTombstone) await this.controller.handleProcKill({ archive: false });
    await this.retirement.drain();
    if (await this.retirement.abortMultipart(this.env.STORAGE)) return this.retirement.state!;
    return this.retirement.quiesced();
  }

  async eraseInstallationResource(input: InstallationDeletionRequest) {
    const record = this.retirement.begin(input);
    if (record.phase === "quiescing") throw new Error("Process must be quiesced before erasure");
    return this.retirement.erase();
  }

  mutateActiveRun(runId: string, mutation: (run: RunState) => RunState): RunState | null {
    if (this.killed) return null;
    return this.runs.mutate(runId, mutation);
  }

  get identity(): ProcessIdentity {
    return this.settings.identity;
  }

  isInitialized(): boolean {
    return !this.killed && this.lifecyclePhase === "ready" && this.settings.initialized;
  }

  async sendSignal<Payload>(signal: string, payload?: Payload, pid = this.pid): Promise<void> {
    const frame: SignalFrame<Payload> = { type: "sig", signal, payload };
    await sendFrameToKernel(this.installationId, pid, frame);
  }

  maybeStartTaskTitleGeneration(message: string): void {
    const generation = this.settings.startTitleGeneration(message);
    if (generation) this.startBackground("task title generation", generation);
  }

  startBackground(label: string, operation: Promise<unknown>): void {
    void operation.catch((error) => {
      console.warn(`[Process] Background ${label} failed: ${errorMessageFromUnknown(error)}`);
    });
  }

  /**
   * Single entry point — called by the Kernel to deliver frames.
   */
  async recvFrame(frame: ProcessInboundFrame) {
    try {
      this.retirement.assertActive();
      await this.startup;
      this.retirement.assertActive();
    } catch (error) {
      const body = "body" in frame ? frame.body : undefined;
      if (body && !body.stream.locked) await body.stream.cancel("Process admission is closed").catch(() => {});
      throw error;
    }
    return await this.controller.recvFrame(frame);
  }

  handleRunStopped(runId: string): boolean {
    return (
      this.killed || this.lifecyclePhase !== "ready" || this.runs.active?.runId !== runId
    );
  }
}
