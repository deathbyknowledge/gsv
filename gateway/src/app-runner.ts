import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import {
  loadPackageArtifact,
  packageArtifactToWorkerCode,
  type PackageArtifactMetadata,
} from "./kernel/packages";
import type { AppFrameContext, PackageAppSignalWatchInfo } from "./protocol/app-frame";
import { buildAppRunnerName } from "./protocol/app-session";
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
  artifact: PackageArtifactMetadata;
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

export type AppRunnerCommandInput = {
  commandName: string;
  args: string[];
  cwd: string;
  uid: number;
  gid: number;
  username: string;
};

type KernelAppStub = {
  appRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame>;
};

type KernelBridgeStub = Rpc.RpcTargetBranded & {
  request(call: string, args?: unknown): Promise<unknown>;
};

type AppClientStub = Rpc.RpcTargetBranded & {
  onAppEvent(event: string, payload?: unknown): Promise<void>;
  dup?: () => AppClientStub;
  [Symbol.dispose]?: () => void;
};

type AppFetchEntrypointStub = Rpc.WorkerEntrypointBranded & {
  fetch(request: Request): Promise<Response>;
};

type AppCommandEntrypointStub = Rpc.WorkerEntrypointBranded & {
  run(input?: unknown): Promise<unknown>;
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
  packageSqlExec(statement: string, bindings?: unknown[]): Promise<unknown[]>;
  emitAppEvent(event: string, payload?: unknown, clientId?: string): Promise<{ delivered: number }>;
};

type GsvApiBindingProps = {
  appRunnerName: string;
};

const PROPS_KEY = "app-runner:props";
const RUNTIME_TTL_MS = 365 * 24 * 60 * 60 * 1000;

type RegisteredAppClient = {
  client: AppClientStub;
  session: AppSessionInfo;
  registeredAt: number;
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
 * Keep the public browser-facing surface to a single generic `invoke(...)`.
 * App-specific methods still belong to the package backend surface; AppRunner
 * just forwards them after registering the connected client.
 */
class AppRunnerBackendTarget extends RpcTarget {
  constructor(
    private readonly runner: AppRunner,
    private readonly runtime: AppRuntimeContext,
    private readonly client: AppClientStub | null,
  ) {
    super();
  }

  async invoke(method: string, args?: unknown): Promise<unknown> {
    if (this.client && this.runtime.appSession) {
      this.runner.registerAppClient(this.runtime.appSession, this.client);
    }
    console.log(`[app-runner] backend invoke method=${method} clientId=${this.runtime.appSession?.clientId ?? ""}`);
    return this.runner.invokeAppRpc(method, args, this.runtime);
  }
}

export class GsvApiBinding extends WorkerEntrypoint<Env, GsvApiBindingProps> {
  async kernelRequest(appFrame: AppFrameContext, call: string, args?: unknown): Promise<unknown> {
    const kernel = await getAgentByName(this.env.KERNEL, "singleton") as unknown as KernelAppStub;
    const frame: RequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
    } as RequestFrame;
    const response = await kernel.appRequest(appFrame, frame);
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return response.data;
  }

  async upsertRpcSchedule(input: unknown): Promise<unknown> {
    return this.#getRunner().upsertRpcSchedule(input);
  }

  async removeRpcSchedule(key: string): Promise<{ removed: boolean }> {
    return this.#getRunner().removeRpcSchedule(key);
  }

  async listRpcSchedules(): Promise<unknown[]> {
    return this.#getRunner().listRpcSchedules();
  }

  async packageSqlExec(statement: string, bindings?: unknown[]): Promise<unknown[]> {
    return this.#getRunner().packageSqlExec(statement, bindings);
  }

  async emitAppEvent(event: string, payload?: unknown, clientId?: string): Promise<{ delivered: number }> {
    console.log(`[gsv-api] emitAppEvent event=${event} clientId=${clientId ?? "*"}`);
    return this.#getRunner().emitAppEvent(event, payload, clientId);
  }

  #getRunner(): AppRunnerDaemonStub {
    const runnerName = this.ctx.props?.appRunnerName?.trim();
    if (!runnerName) {
      throw new Error("GSV_API requires appRunnerName");
    }
    return this.ctx.exports.AppRunner.getByName(runnerName) as unknown as AppRunnerDaemonStub;
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
  private readonly appClients = new Map<string, RegisteredAppClient>();

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

  async getBackend(appSession: AppSessionInfo, client?: AppClientStub | null): Promise<AppRunnerBackendTarget> {
    if (client) {
      this.registerAppClient(appSession, client);
    }
    console.log(`[app-runner] getBackend clientId=${appSession.clientId} hasClient=${Boolean(client)}`);
    return new AppRunnerBackendTarget(this, this.#defaultRuntime(appSession), client ?? null);
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    const runtime = this.#runtimeForSignal(input);
    console.log(`[app-runner] deliverSignal signal=${input.signal} watchId=${input.watch.id} key=${input.watch.key ?? ""} sourcePid=${input.sourcePid ?? ""}`);
    await this.#getSignalEntrypoint(runtime, input).run(input.signal);
  }

  async invokeAppRpc(method: string, args: unknown, runtime: AppRuntimeContext): Promise<unknown> {
    return this.#getRpcEntrypoint(runtime).invoke(method, args);
  }

  async runCommand(input: AppRunnerCommandInput): Promise<unknown> {
    const props = this.#getProps();
    const now = Date.now();
    const runtime = this.#runtimeForAppFrame({
      uid: input.uid,
      username: input.username,
      packageId: props.packageId,
      packageName: props.packageName,
      entrypointName: input.commandName,
      routeBase: props.routeBase,
      issuedAt: now,
      expiresAt: now + RUNTIME_TTL_MS,
    });
    return this.#getCommandEntrypoint(runtime, input.commandName).run({
      commandName: input.commandName,
      args: input.args,
      cwd: input.cwd,
      uid: input.uid,
      gid: input.gid,
      username: input.username,
    });
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

  async packageSqlExec(statement: string, bindings?: unknown[]): Promise<unknown[]> {
    const normalizedStatement = typeof statement === "string" ? statement.trim() : "";
    if (!normalizedStatement) {
      throw new Error("package sql statement is required");
    }
    const normalizedBindings = Array.isArray(bindings)
      ? bindings.map((value) => this.#normalizeSqlBindingValue(value))
      : [];
    const rows = this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
      normalizedStatement,
      ...normalizedBindings,
    ).toArray();
    return rows.map((row) => this.#serializeSqlRow(row));
  }

  async emitAppEvent(event: string, payload?: unknown, clientId?: string): Promise<{ delivered: number }> {
    const normalizedEvent = typeof event === "string" ? event.trim() : "";
    if (!normalizedEvent) {
      throw new Error("app event name is required");
    }
    const targetClientId = typeof clientId === "string" && clientId.trim().length > 0
      ? clientId.trim()
      : null;
    console.log(`[app-runner] emitAppEvent event=${normalizedEvent} targetClientId=${targetClientId ?? "*"} registeredClients=${this.appClients.size}`);
    const delivered = await this.#emitAppEventToClients(normalizedEvent, payload, targetClientId);
    return { delivered };
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
    return this.#runtimeForAppFrame(this.#runtimeAppFrame(this.#getProps()), appSession, daemonTrigger);
  }

  #runtimeForAppFrame(
    appFrame: AppFrameContext,
    appSession?: AppSessionInfo,
    daemonTrigger?: AppRuntimeContext["daemonTrigger"],
  ): AppRuntimeContext {
    return {
      appFrame,
      ...(appSession ? { appSession } : {}),
      ...(daemonTrigger ? { daemonTrigger } : {}),
    };
  }

  #runtimeForSignal(input: AppRunnerSignalInput): AppRuntimeContext {
    const state = input.watch.state && typeof input.watch.state === "object"
      ? input.watch.state as Record<string, unknown>
      : null;
    const clientId = typeof state?.clientId === "string" && state.clientId.trim().length > 0
      ? state.clientId.trim()
      : null;
    const appSession = clientId ? this.appClients.get(clientId)?.session : undefined;
    if (clientId) {
      console.log(`[app-runner] runtimeForSignal clientId=${clientId} hasSession=${Boolean(appSession)}`);
    }
    return this.#defaultRuntime(appSession);
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

  registerAppClient(appSession: AppSessionInfo, client: AppClientStub): void {
    const clientId = appSession.clientId?.trim();
    if (!clientId) {
      throw new Error("app client registration requires clientId");
    }
    const retainedClient = typeof client.dup === "function"
      ? client.dup()
      : client;
    const previous = this.appClients.get(clientId);
    if (previous) {
      try {
        previous.client[Symbol.dispose]?.();
      } catch {
      }
    }
    this.appClients.set(clientId, {
      client: retainedClient,
      session: appSession,
      registeredAt: Date.now(),
    });
    console.log(`[app-runner] registerAppClient clientId=${clientId} sessionId=${appSession.sessionId} totalClients=${this.appClients.size}`);
  }

  async #emitAppEventToClients(event: string, payload: unknown, clientId: string | null): Promise<number> {
    const targets = clientId
      ? [...this.appClients.entries()].filter(([id]) => id === clientId)
      : [...this.appClients.entries()];
    console.log(`[app-runner] fanout event=${event} targetCount=${targets.length} requestedClientId=${clientId ?? "*"}`);
    let delivered = 0;
    for (const [targetClientId, registration] of targets) {
      try {
        console.log(`[app-runner] fanout -> clientId=${targetClientId} sessionId=${registration.session.sessionId}`);
        await registration.client.onAppEvent(event, payload);
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[app-runner] app event delivery failed for ${targetClientId}: ${message}`);
        this.#removeAppClient(targetClientId);
      }
    }
    return delivered;
  }

  #removeAppClient(clientId: string): void {
    const registration = this.appClients.get(clientId);
    if (!registration) {
      return;
    }
    this.appClients.delete(clientId);
    console.log(`[app-runner] removeAppClient clientId=${clientId} remainingClients=${this.appClients.size}`);
    try {
      registration.client[Symbol.dispose]?.();
    } catch {
    }
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
    return this.env.LOADER.get(
      this.#codeKey(props),
      async () => packageArtifactToWorkerCode(await loadPackageArtifact(this.env.STORAGE, props.artifact.hash), {
        PACKAGE_NAME: props.packageName,
        PACKAGE_ID: props.packageId,
        PACKAGE_ROUTE_BASE: props.routeBase,
        GSV_API: this.ctx.exports.GsvApiBinding({
          props: {
            appRunnerName: buildAppRunnerName(props.appFrame.uid, props.packageId),
          },
        }),
        GSV_PACKAGE_NAME: props.packageName,
        GSV_PACKAGE_ID: props.packageId,
        GSV_ROUTE_BASE: props.routeBase,
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
      ...(extras ?? {}),
    };
  }

  #getAppEntrypoint(runtime: AppRuntimeContext): AppFetchEntrypointStub {
    const worker = this.#loadWorker(this.#getProps());
    return worker.getEntrypoint<AppFetchEntrypointStub>(undefined, {
      props: this.#entrypointProps(runtime),
    });
  }

  #getCommandEntrypoint(runtime: AppRuntimeContext, commandName: string): AppCommandEntrypointStub {
    const worker = this.#loadWorker(this.#getProps());
    return worker.getEntrypoint<AppCommandEntrypointStub>("GsvCommandEntrypoint", {
      props: this.#entrypointProps(runtime, {
        commandName,
      }),
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

  #normalizeSqlBindingValue(value: unknown): string | number | null {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
    ) {
      return value;
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    throw new Error("package sql bindings must be string, number, boolean, or null");
  }

  #serializeSqlRow(row: Record<string, SqlStorageValue>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, this.#serializeSqlValue(value)]),
    );
  }

  #serializeSqlValue(value: unknown): unknown {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return btoa(String.fromCharCode(...new Uint8Array(value)));
    }
    if (ArrayBuffer.isView(value)) {
      return btoa(String.fromCharCode(...new Uint8Array(value.buffer)));
    }
    return String(value);
  }
}
