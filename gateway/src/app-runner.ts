import { DurableObject, RpcTarget } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { packageArtifactToWorkerCode, type PackageArtifact } from "./kernel/packages";
import type { AppFrameContext, PackageAppSignalWatchInfo } from "./protocol/app-frame";
import type { RequestFrame, ResponseFrame } from "./protocol/frames";
import {
  AppRpcScheduleStore,
  type AppRpcSchedule,
  type AppRpcScheduleRecord,
  type AppRpcScheduleUpsertInput,
} from "./app-daemons";

type AppRunnerProps = {
  packageId: string;
  packageName: string;
  routeBase: string;
  entrypointName: string;
  artifact: PackageArtifact;
  appFrame: AppFrameContext;
};

type AppRunnerSignalInput = {
  signal: string;
  payload?: unknown;
  sourcePid?: string | null;
  watch: PackageAppSignalWatchInfo;
};

type AppSessionInfo = {
  sessionId: string;
  clientId: string;
  rpcBase: string;
  expiresAt: number;
};

type AppRuntimeContext = {
  appFrame: AppFrameContext;
  appSession?: AppSessionInfo;
  daemonTrigger?: {
    kind: "schedule";
    key: string;
    scheduledAt: number;
    firedAt: number;
  };
};

export type AppHttpRequest = {
  url: string;
  method: string;
  headers: string[][];
  body?: ArrayBuffer | null;
};

export type AppHttpResponse = {
  status: number;
  statusText: string;
  headers: string[][];
  body?: ArrayBuffer | null;
};

type KernelAppStub = {
  appRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame>;
};

type KernelBridgeStub = Rpc.RpcTargetBranded & {
  request(call: string, args?: unknown): Promise<unknown>;
};

type SignalSinkStub = Rpc.RpcTargetBranded & {
  onSignal(signal: string, envelope: unknown): Promise<void>;
  dup?: () => SignalSinkStub;
  [Symbol.dispose]?: () => void;
};

type AppFetchEntrypointStub = Rpc.WorkerEntrypointBranded & {
  fetch(request: Request): Promise<Response>;
};

type AppRpcEntrypointStub = Rpc.WorkerEntrypointBranded & {
  invoke(method: string, args: unknown): Promise<unknown>;
};

type AppSignalEntrypointStub = Rpc.WorkerEntrypointBranded & {
  run(signalName?: string): Promise<void>;
};

type AppRunnerDaemonStub = Rpc.RpcTargetBranded & {
  upsertRpcSchedule(input: unknown): Promise<unknown>;
  removeRpcSchedule(key: string): Promise<{ removed: boolean }>;
  listRpcSchedules(): Promise<unknown[]>;
};

const PROPS_KEY = "app-runner:props";
const RUNTIME_TTL_MS = 365 * 24 * 60 * 60 * 1000;

type LiveSignalSubscription = {
  sink: SignalSinkStub;
  watchKeys: string[];
  processId: string | null;
  signals: string[];
};

class KernelBridge extends RpcTarget {
  constructor(
    private readonly kernelNamespace: Env["KERNEL"],
    private readonly appFrame: AppFrameContext,
  ) {
    super();
  }

  async request(call: string, args?: unknown): Promise<unknown> {
    const kernel = await getAgentByName(this.kernelNamespace, "singleton") as unknown as KernelAppStub;
    const frame: RequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
    } as RequestFrame;
    const response = await kernel.appRequest(this.appFrame, frame);
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return response.data;
  }
}

/**
 * Browser-facing RPC shim for package backends.
 *
 * Keep the public browser-facing surface to a single generic `invoke(...)`
 * plus the reserved live-signal helpers. App-specific methods still belong to
 * the package backend surface; AppRunner just forwards them.
 */
class AppRunnerBackendTarget extends RpcTarget {
  constructor(
    private readonly runner: AppRunner,
    private readonly runtime: AppRuntimeContext,
  ) {
    super();
  }

  async invoke(method: string, args?: unknown): Promise<unknown> {
    if (method === "gsvSubscribeSignal") {
      return this.runner.subscribeSignal(args, this.runtime);
    }
    if (method === "gsvUnsubscribeSignal") {
      return this.runner.unsubscribeSignal(args, this.runtime);
    }
    return this.runner.invokeAppRpc(method, args, this.runtime);
  }
}

class AppRunnerDaemonTarget extends RpcTarget {
  constructor(private readonly runner: AppRunner) {
    super();
  }

  async upsertRpcSchedule(input: unknown): Promise<unknown> {
    return this.runner.upsertRpcSchedule(input);
  }

  async removeRpcSchedule(key: string): Promise<{ removed: boolean }> {
    return this.runner.removeRpcSchedule(key);
  }

  async listRpcSchedules(): Promise<unknown[]> {
    return this.runner.listRpcSchedules();
  }
}

export async function serializeAppHttpRequest(request: Request): Promise<AppHttpRequest> {
  let body: ArrayBuffer | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.clone().arrayBuffer();
  }
  return {
    url: request.url,
    method: request.method,
    headers: Array.from(request.headers.entries()),
    body,
  };
}

export function deserializeAppHttpResponse(response: AppHttpResponse): Response {
  return new Response(response.body ?? null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function deserializeAppHttpRequest(request: AppHttpRequest): Request {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
  }
  return new Request(request.url, init);
}

async function serializeAppHttpResponseValue(response: Response): Promise<AppHttpResponse> {
  let body: ArrayBuffer | null = null;
  if (response.body) {
    body = await response.clone().arrayBuffer();
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body,
  };
}

export class AppRunner extends DurableObject<Env> {
  private readonly daemonSchedules: AppRpcScheduleStore;
  private readonly liveSignalSubscriptions = new Map<string, LiveSignalSubscription>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.daemonSchedules = new AppRpcScheduleStore(ctx.storage.sql);
    this.daemonSchedules.init();
  }

  async ensureRuntime(props: AppRunnerProps): Promise<void> {
    const previous = this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY);
    if (
      previous
      && previous.packageId === props.packageId
      && previous.packageName === props.packageName
      && previous.routeBase === props.routeBase
      && previous.entrypointName === props.entrypointName
      && previous.artifact.hash === props.artifact.hash
      && previous.appFrame.uid === props.appFrame.uid
      && previous.appFrame.routeBase === props.appFrame.routeBase
      && previous.appFrame.entrypointName === props.appFrame.entrypointName
    ) {
      return;
    }
    this.ctx.storage.kv.put(PROPS_KEY, props);
  }

  async gsvFetch(request: AppHttpRequest): Promise<AppHttpResponse> {
    return this.#gsvFetch(request, this.#defaultRuntime());
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.gsvFetch(await serializeAppHttpRequest(request));
    return deserializeAppHttpResponse(response);
  }

  async getBackend(appSession: AppSessionInfo): Promise<AppRunnerBackendTarget> {
    return new AppRunnerBackendTarget(this, this.#defaultRuntime(appSession));
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    const runtime = this.#defaultRuntime();
    await this.#getSignalEntrypoint(runtime, input).run(input.signal);
    await this.#forwardSignalToLiveSubscriber(input, runtime);
  }

  async invokeAppRpc(method: string, args: unknown, runtime: AppRuntimeContext): Promise<unknown> {
    return this.#getRpcEntrypoint(runtime).invoke(method, args);
  }

  async upsertRpcSchedule(input: unknown): Promise<unknown> {
    const record = this.daemonSchedules.upsert(this.#normalizeRpcScheduleInput(input));
    await this.#syncDaemonAlarm();
    return this.#serializeDaemonRecord(record);
  }

  async removeRpcSchedule(key: string): Promise<{ removed: boolean }> {
    const removed = this.daemonSchedules.remove(key);
    await this.#syncDaemonAlarm();
    return { removed };
  }

  async listRpcSchedules(): Promise<unknown[]> {
    return this.daemonSchedules.list().map((record) => this.#serializeDaemonRecord(record));
  }

  async subscribeSignal(args: unknown, runtime: AppRuntimeContext): Promise<unknown> {
    const input = this.#normalizeSignalSubscriptionArgs(args);
    if (!input.sink) {
      throw new Error("signal sink must implement onSignal()");
    }
    if (input.signals.length === 0) {
      throw new Error("signal subscription requires at least one signal");
    }
    const kernel = this.#createKernelBridge(runtime.appFrame);
    const subscriptionId = crypto.randomUUID();
    const watchKeys: string[] = [];
    for (const signal of input.signals) {
      const key = `live:${subscriptionId}:${signal}`;
      await kernel.request("signal.watch", {
        signal,
        ...(input.processId ? { processId: input.processId } : {}),
        key,
        state: { subscriptionId },
        once: false,
      });
      watchKeys.push(key);
    }
    const retainedSink = typeof input.sink.dup === "function"
      ? input.sink.dup()
      : input.sink;
    this.liveSignalSubscriptions.set(subscriptionId, {
      sink: retainedSink,
      watchKeys,
      processId: input.processId,
      signals: input.signals,
    });
    return { subscriptionId };
  }

  async unsubscribeSignal(args: unknown, runtime: AppRuntimeContext): Promise<unknown> {
    const subscriptionId =
      typeof (args as { subscriptionId?: unknown } | null)?.subscriptionId === "string"
        ? ((args as { subscriptionId: string }).subscriptionId.trim() || null)
        : null;
    if (!subscriptionId) {
      throw new Error("signal unsubscription requires subscriptionId");
    }
    const removed = await this.#removeLiveSignalSubscription(subscriptionId, this.#createKernelBridge(runtime.appFrame));
    return { removed };
  }

  async #gsvFetch(request: AppHttpRequest, runtime: AppRuntimeContext): Promise<AppHttpResponse> {
    const response = await this.#getAppEntrypoint(runtime).fetch(deserializeAppHttpRequest(request));
    return serializeAppHttpResponseValue(response);
  }

  async alarm(): Promise<void> {
    const due = this.daemonSchedules.due(Date.now());
    for (const record of due) {
      await this.#runDueRpcSchedule(record);
    }
    await this.#syncDaemonAlarm();
  }

  #defaultRuntime(
    appSession?: AppSessionInfo,
    daemonTrigger?: AppRuntimeContext["daemonTrigger"],
  ): AppRuntimeContext {
    const props = this.#getProps();
    return {
      appFrame: this.#runtimeAppFrame(props),
      ...(appSession ? { appSession } : {}),
      ...(daemonTrigger ? { daemonTrigger } : {}),
    };
  }

  #runtimeAppFrame(props: AppRunnerProps): AppFrameContext {
    const now = Date.now();
    return {
      ...props.appFrame,
      issuedAt: now,
      expiresAt: now + RUNTIME_TTL_MS,
    };
  }

  #createKernelBridge(appFrame: AppFrameContext): KernelBridge {
    return new KernelBridge(this.env.KERNEL, appFrame);
  }

  #createDaemonBridge(): AppRunnerDaemonTarget {
    return new AppRunnerDaemonTarget(this);
  }

  #normalizeSignalSubscriptionArgs(args: unknown): {
    processId: string | null;
    signals: string[];
    sink: SignalSinkStub | null;
  } {
    const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const processId = typeof record.processId === "string" && record.processId.trim().length > 0
      ? record.processId.trim()
      : null;
    const signals = Array.isArray(record.signals)
      ? Array.from(new Set(record.signals
        .map((value) => typeof value === "string" ? value.trim() : "")
        .filter((value) => value.length > 0)))
      : [];
    const sink = record.sink && (typeof record.sink === "object" || typeof record.sink === "function")
      ? record.sink as SignalSinkStub
      : null;
    return {
      processId,
      signals,
      sink,
    };
  }

  async #forwardSignalToLiveSubscriber(input: AppRunnerSignalInput, runtime: AppRuntimeContext): Promise<void> {
    const state = input.watch.state && typeof input.watch.state === "object"
      ? input.watch.state as Record<string, unknown>
      : null;
    const subscriptionId = typeof state?.subscriptionId === "string"
      ? state.subscriptionId
      : this.#parseSubscriptionIdFromKey(input.watch.key);
    if (!subscriptionId) {
      if (this.#isLegacyLiveSignalWatchKey(input.watch.key)) {
        await this.#cleanupLegacyLiveSignalWatch(input, runtime);
      }
      return;
    }
    const subscription = this.liveSignalSubscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }
    try {
      await subscription.sink.onSignal(input.signal, {
        payload: input.payload,
        sourcePid: input.sourcePid ?? null,
        watch: input.watch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[app-runner] signal sink failed for ${subscriptionId}: ${message}`);
      await this.#removeLiveSignalSubscription(subscriptionId, this.#createKernelBridge(runtime.appFrame));
    }
  }

  #parseSubscriptionIdFromKey(key: string | undefined): string | null {
    if (!key || !key.startsWith("live:")) {
      return null;
    }
    const parts = key.split(":");
    return parts.length >= 3 && parts[1] ? parts[1] : null;
  }

  #isLegacyLiveSignalWatchKey(key: string | undefined): boolean {
    return typeof key === "string" && key.startsWith("__gsv_live__:");
  }

  async #cleanupLegacyLiveSignalWatch(input: AppRunnerSignalInput, runtime: AppRuntimeContext): Promise<void> {
    const key = input.watch.key;
    if (!this.#isLegacyLiveSignalWatchKey(key)) {
      return;
    }
    try {
      await this.#createKernelBridge(runtime.appFrame).request("signal.unwatch", { key });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[app-runner] legacy signal unwatch failed for ${key}: ${message}`);
    }
  }

  async #removeLiveSignalSubscription(subscriptionId: string, kernel: KernelBridge): Promise<number> {
    const subscription = this.liveSignalSubscriptions.get(subscriptionId);
    if (!subscription) {
      return 0;
    }
    this.liveSignalSubscriptions.delete(subscriptionId);
    try {
      subscription.sink[Symbol.dispose]?.();
    } catch {
    }
    let removed = 0;
    await Promise.all(subscription.watchKeys.map(async (key) => {
      try {
        await kernel.request("signal.unwatch", { key });
        removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[app-runner] signal unwatch failed for ${subscriptionId} (${key}): ${message}`);
      }
    }));
    return removed;
  }

  #getProps(): AppRunnerProps {
    const props = this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY);
    if (!props) {
      throw new Error("AppRunner is not initialized");
    }
    if (!props.packageId || !props.packageName || !props.routeBase || !props.entrypointName || !props.artifact || !props.appFrame) {
      throw new Error("AppRunner props are incomplete");
    }
    return props;
  }

  #loadWorker(props: AppRunnerProps): WorkerStub {
    const appFrame = this.#runtimeAppFrame(props);
    return this.env.LOADER.get(
      this.#codeKey(props),
      () => packageArtifactToWorkerCode(props.artifact, {
        PACKAGE_NAME: props.packageName,
        PACKAGE_ID: props.packageId,
        PACKAGE_ROUTE_BASE: props.routeBase,
        GSV_PACKAGE_NAME: props.packageName,
        GSV_PACKAGE_ID: props.packageId,
        GSV_ROUTE_BASE: props.routeBase,
        GSV_APP_FRAME: appFrame,
      }),
    );
  }

  #entrypointProps(
    runtime: AppRuntimeContext,
    extras?: Record<string, unknown>,
  ): Record<string, unknown> {
    const props = this.#getProps();
    return {
      packageId: props.packageId,
      packageName: props.packageName,
      routeBase: props.routeBase,
      appFrame: runtime.appFrame,
      ...(runtime.appSession ? { appSession: runtime.appSession } : {}),
      ...(runtime.daemonTrigger ? { daemonTrigger: runtime.daemonTrigger } : {}),
      kernel: this.#createKernelBridge(runtime.appFrame),
      daemon: this.#createDaemonBridge(),
      ...(extras ?? {}),
    };
  }

  #getAppEntrypoint(runtime: AppRuntimeContext): AppFetchEntrypointStub {
    const worker = this.#loadWorker(this.#getProps());
    return worker.getEntrypoint<AppFetchEntrypointStub>(undefined, {
      props: this.#entrypointProps(runtime),
    });
  }

  #getRpcEntrypoint(runtime: AppRuntimeContext): AppRpcEntrypointStub {
    const worker = this.#loadWorker(this.#getProps());
    return worker.getEntrypoint<AppRpcEntrypointStub>("GsvAppRpcEntrypoint", {
      props: this.#entrypointProps(runtime),
    });
  }

  #getSignalEntrypoint(runtime: AppRuntimeContext, input: AppRunnerSignalInput): AppSignalEntrypointStub {
    const worker = this.#loadWorker(this.#getProps());
    return worker.getEntrypoint<AppSignalEntrypointStub>("GsvAppSignalEntrypoint", {
      props: this.#entrypointProps(runtime, {
        signal: input.signal,
        payload: input.payload,
        sourcePid: input.sourcePid ?? null,
        watch: input.watch,
      }),
    });
  }

  #codeKey(props: AppRunnerProps): string {
    return [
      "app-runtime",
      String(props.appFrame.uid),
      props.packageId,
      props.entrypointName,
      props.artifact.hash,
    ].join(":");
  }

  async #runDueRpcSchedule(record: AppRpcScheduleRecord): Promise<void> {
    const firedAt = Date.now();
    const running = this.daemonSchedules.markRunning(record.key, record.version, firedAt);
    if (!running) {
      return;
    }
    const trigger = {
      kind: "schedule" as const,
      key: record.key,
      scheduledAt: record.nextRunAt ?? firedAt,
      firedAt,
    };
    const runtime = this.#defaultRuntime(undefined, trigger);
    const startedAt = Date.now();
    let status: "ok" | "error" = "ok";
    let errorMessage: string | null = null;
    try {
      await this.#getRpcEntrypoint(runtime).invoke(record.rpcMethod, record.payload);
    } catch (error) {
      status = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[app-runner] daemon rpc ${record.rpcMethod} (${record.key}) failed: ${errorMessage}`);
    }
    this.daemonSchedules.finishRun({
      key: record.key,
      version: record.version,
      finishedAt: Date.now(),
      status,
      error: errorMessage,
      durationMs: Date.now() - startedAt,
    });
  }

  async #syncDaemonAlarm(): Promise<void> {
    const nextAlarmAt = this.daemonSchedules.nextAlarmAt();
    if (nextAlarmAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  #normalizeRpcScheduleInput(input: unknown): AppRpcScheduleUpsertInput {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : null;
    const key = typeof record?.key === "string" ? record.key.trim() : "";
    if (!key) {
      throw new Error("daemon schedule key is required");
    }
    const rpcMethod = typeof record?.rpcMethod === "string" ? record.rpcMethod.trim() : "";
    if (!rpcMethod) {
      throw new Error("daemon schedule rpcMethod is required");
    }
    if (!record?.schedule || typeof record.schedule !== "object") {
      throw new Error("daemon schedule is required");
    }
    const enabled = record.enabled === undefined
      ? undefined
      : Boolean(record.enabled);
    return {
      key,
      rpcMethod,
      schedule: record.schedule as AppRpcSchedule,
      payload: record.payload,
      ...(enabled === undefined ? {} : { enabled }),
    };
  }

  #serializeDaemonRecord(record: AppRpcScheduleRecord): Record<string, unknown> {
    return {
      key: record.key,
      rpcMethod: record.rpcMethod,
      schedule: record.schedule,
      ...(record.payload === undefined ? {} : { payload: record.payload }),
      enabled: record.enabled,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nextRunAt: record.nextRunAt,
      runningAt: record.runningAt,
      lastRunAt: record.lastRunAt,
      lastStatus: record.lastStatus,
      lastError: record.lastError,
      lastDurationMs: record.lastDurationMs,
    };
  }
}
