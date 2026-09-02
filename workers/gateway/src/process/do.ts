/** Process composition root. Capability owners implement its operations. */

import { DurableObject } from "cloudflare:workers";
import type { SignalFrame } from "../protocol/frames";
import type { ProcessIdentity, ProcKillResult, ProcResetResult } from "@humansandmachines/gsv/protocol";
import type { ProcessInboundFrame } from "../protocol/process-frames";
import { createGenerationService } from "../inference/service";
import { gsvInferenceProviderFactoryFromEnv } from "../inference/gsv-provider";
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

export class Process extends DurableObject<GatewayEnv> {
  readonly ctx: DurableObjectState<{}>;
  readonly env: GatewayEnv;
  readonly installationId: string;
  readonly pid: string;
  readonly store: ProcessStore;
  readonly runs: ProcessRunRepository;
  readonly signals = new ProcessSignalService(this);
  readonly settings = new ProcessSettingsService(this);
  readonly trace = new ProcessTraceService(this);
  readonly streams = new ProcessMessageStreamService(this);
  readonly finishDelivery = new ProcessFinishDeliveryService(this);
  readonly storage: R2Bucket;
  readonly generation: ReturnType<typeof createGenerationService>;
  readonly ripgit: RipgitClient | null;
  readonly tasks: DurableTaskScheduler<ProcessTask>;
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

  constructor(ctx: DurableObjectState<{}>, env: GatewayEnv) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    const gsvInference = gsvInferenceProviderFactoryFromEnv(env);
    this.generation = createGenerationService(gsvInference ? { providers: [gsvInference] } : {});
    const processIdentity = parseProcessDurableObjectName(ctx.id.name);
    this.installationId = processIdentity.installationId;
    this.pid = processIdentity.pid;
    this.storage = createInstallationStorage(env.STORAGE, this.installationId);
    const killedTombstone = ctx.storage.kv.get<ProcessKilledTombstone | true>(
      PROCESS_KILLED_TOMBSTONE_KEY,
    );
    this.killedTombstone = killedTombstone && killedTombstone !== true ? killedTombstone : null;
    this.killed = killedTombstone === true || this.killedTombstone !== null;
    if (!this.killed) {
      runProcessSqlMigrations(ctx.storage);
    }
    this.tasks = new DurableTaskScheduler(
      ctx.storage,
      decodeProcessTask,
      this.run.runScheduledTask.bind(this.run),
    );
    this.store = new ProcessStore(ctx.storage.sql);
    this.runs = new ProcessRunRepository(this.store);
    this.ripgit = env.RIPGIT
      ? new RipgitClient(createInstallationRipgit(env.RIPGIT, this.installationId))
      : null;
    this.startup = recoverProcess(this).catch((error) => {
      console.warn("[Process] Recovery failed:", error);
    });
  }

  async alarm(): Promise<void> {
    await this.startup;
    await this.run.alarm();
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
    await this.startup;
    return await this.controller.recvFrame(frame);
  }

  handleRunStopped(runId: string): boolean {
    return (
      this.killed || this.lifecyclePhase !== "ready" || this.runs.active?.runId !== runId
    );
  }
}
