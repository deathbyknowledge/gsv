import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import {
  loadPackageArtifact,
  packageArtifactPublicBase,
  packageArtifactToWorkerCode,
  type PackageArtifactMetadata,
} from "./kernel/packages";
import { encodeBase64Bytes } from "./shared/base64";
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

type AppSocketContext = {
  session: AppSessionInfo;
  appFrame: AppFrameContext;
};

type AppSocketAttachment = {
  kind: "app-client";
  connected: boolean;
  session?: AppSessionInfo;
  appFrame?: AppFrameContext;
  connectedAt?: number;
};

type AppRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args?: unknown;
};

type AppResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: unknown;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: {
        code: number;
        message: string;
        details?: unknown;
      };
    };

type AppSignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
};

type AppSocketFrame = AppRequestFrame | AppResponseFrame | AppSignalFrame;

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
  socket: WebSocket;
  session: AppSessionInfo;
  appFrame: AppFrameContext;
  registeredAt: number;
};

function appClientKey(session: AppSessionInfo): string {
  return `${session.sessionId}:${session.clientId}`;
}

const APP_SOCKET_TAG = "app-client";

class AppSocketError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AppSocketError";
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
    this.#restoreAppClients();
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
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#acceptAppSocket(request);
    }
    const response = await this.gsvFetch(await serializeAppHttpRequest(request));
    return deserializeAppHttpResponse(response);
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    const runtime = this.#runtimeForSignal(input);
    await this.#getSignalEntrypoint(runtime, input).run(input.signal);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.#closeSocket(ws, 1003, "App socket only accepts text frames");
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      this.#closeSocket(ws, 1003, "Invalid JSON frame");
      return;
    }

    if (!this.#isAppRequestFrame(frame)) {
      this.#closeSocket(ws, 1003, "Expected app request frame");
      return;
    }

    try {
      const data = await this.#handleAppSocketRequest(ws, frame);
      this.#sendSocketFrame(ws, {
        type: "res",
        id: frame.id,
        ok: true,
        ...(data === undefined ? {} : { data }),
      });
    } catch (error) {
      const { code, message: errorMessage } = this.#frameError(error);
      this.#sendSocketFrame(ws, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code,
          message: errorMessage,
        },
      });
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.#removeAppClientBySocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.#removeAppClientBySocket(ws);
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
    const delivered = await this.#emitAppEventToClients(normalizedEvent, payload, targetClientId);
    return { delivered };
  }

  async closeAppSession(sessionId: string): Promise<{ closed: number }> {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) {
      return { closed: 0 };
    }

    this.#restoreAppClients();
    let closed = 0;
    for (const [key, registration] of [...this.appClients.entries()]) {
      if (registration.session.sessionId !== normalizedSessionId) {
        continue;
      }
      this.appClients.delete(key);
      try {
        registration.socket.close(1000, "app session closed");
      } catch {
      }
      closed += 1;
    }
    return { closed };
  }

  #acceptAppSocket(request: Request): Response {
    const context = this.#appSocketContextFromRequest(request);
    if (!context) {
      return new Response("App socket context is missing or invalid", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }

    const pair = new WebSocketPair();
    const server = pair[0];
    const client = pair[1];
    this.ctx.acceptWebSocket(server, [APP_SOCKET_TAG]);
    this.#registerAppSocket(server, context.session, context.appFrame);
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async #handleAppSocketRequest(ws: WebSocket, frame: AppRequestFrame): Promise<unknown> {
    switch (frame.call) {
      case "backend.invoke":
        return this.#invokeBackendFromSocket(ws, frame.args);
      case "app.ping":
        return { ok: true, timestamp: Date.now() };
      default:
        throw new AppSocketError(404, `Unknown app call: ${frame.call}`);
    }
  }

  async #invokeBackendFromSocket(ws: WebSocket, args: unknown): Promise<unknown> {
    const client = this.#clientForSocket(ws);
    if (!client) {
      throw new AppSocketError(401, "App socket is not connected");
    }
    const record = this.#record(args);
    const method = typeof record?.method === "string" ? record.method.trim() : "";
    if (!method) {
      throw new AppSocketError(400, "backend.invoke requires method");
    }
    const runtime = this.#runtimeForAppFrame(client.appFrame, client.session);
    return this.invokeAppRpc(method, record?.args, runtime);
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
    const sessionId = typeof state?.appSessionId === "string" && state.appSessionId.trim().length > 0
      ? state.appSessionId.trim()
      : null;
    const clientId = typeof state?.clientId === "string" && state.clientId.trim().length > 0
      ? state.clientId.trim()
      : null;
    if (clientId) {
      this.#restoreAppClients();
    }
    const appSession = clientId ? this.#appSessionForClientId(clientId, sessionId) : undefined;
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

  #registerAppSocket(ws: WebSocket, session: AppSessionInfo, appFrame: AppFrameContext): void {
    const key = appClientKey(session);
    const previous = this.appClients.get(key);
    if (previous && previous.socket !== ws) {
      this.#closeSocket(previous.socket, 1000, "Replaced by newer app connection");
    }
    ws.serializeAttachment({
      kind: "app-client",
      connected: true,
      session,
      appFrame,
      connectedAt: Date.now(),
    } satisfies AppSocketAttachment);
    this.appClients.set(key, {
      socket: ws,
      session,
      appFrame,
      registeredAt: Date.now(),
    });
  }

  #restoreAppClients(): void {
    this.appClients.clear();
    for (const socket of this.ctx.getWebSockets(APP_SOCKET_TAG)) {
      const attachment = this.#getSocketAttachment(socket);
      if (!attachment?.connected || !attachment.session || !attachment.appFrame) {
        continue;
      }
      this.appClients.set(appClientKey(attachment.session), {
        socket,
        session: attachment.session,
        appFrame: attachment.appFrame,
        registeredAt: attachment.connectedAt ?? Date.now(),
      });
    }
  }

  async #emitAppEventToClients(event: string, payload: unknown, clientId: string | null): Promise<number> {
    this.#restoreAppClients();
    const targets = clientId
      ? [...this.appClients.entries()].filter(([, registration]) => registration.session.clientId === clientId)
      : [...this.appClients.entries()];
    let delivered = 0;
    for (const [key, registration] of targets) {
      try {
        this.#sendSocketFrame(registration.socket, {
          type: "sig",
          signal: event,
          payload,
        });
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[app-runner] app event delivery failed for ${registration.session.clientId}: ${message}`);
        this.#removeAppClient(key);
      }
    }
    return delivered;
  }

  #removeAppClient(key: string): void {
    const registration = this.appClients.get(key);
    if (!registration) {
      return;
    }
    this.appClients.delete(key);
    try {
      registration.socket.close(1011, "app client removed");
    } catch {
    }
  }

  #removeAppClientBySocket(socket: WebSocket): void {
    for (const [key, registration] of this.appClients) {
      if (registration.socket === socket) {
        this.appClients.delete(key);
      }
    }
  }

  #clientForSocket(socket: WebSocket): RegisteredAppClient | null {
    const attachment = this.#getSocketAttachment(socket);
    if (!attachment?.connected || !attachment.session || !attachment.appFrame) {
      return null;
    }
    const key = appClientKey(attachment.session);
    const existing = this.appClients.get(key);
    if (existing?.socket === socket) {
      return existing;
    }
    const restored = {
      socket,
      session: attachment.session,
      appFrame: attachment.appFrame,
      registeredAt: attachment.connectedAt ?? Date.now(),
    };
    this.appClients.set(key, restored);
    return restored;
  }

  #appSessionForClientId(clientId: string, sessionId?: string | null): AppSessionInfo | undefined {
    for (const registration of this.appClients.values()) {
      if (
        registration.session.clientId === clientId &&
        (!sessionId || registration.session.sessionId === sessionId)
      ) {
        return registration.session;
      }
    }
    return undefined;
  }

  #sendSocketFrame(socket: WebSocket, frame: AppSocketFrame): void {
    socket.send(JSON.stringify(frame));
  }

  #closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.#removeAppClientBySocket(socket);
    try {
      socket.close(code, reason);
    } catch {
    }
  }

  #getSocketAttachment(socket: WebSocket): AppSocketAttachment | null {
    const attachment = socket.deserializeAttachment();
    return this.#isAppSocketAttachment(attachment) ? attachment : null;
  }

  #appSocketContextFromRequest(request: Request): AppSocketContext | null {
    const raw = request.headers.get("x-gsv-app-socket-context");
    if (!raw) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
    return this.#isAppSocketContext(parsed) ? parsed : null;
  }

  #isAppRequestFrame(value: unknown): value is AppRequestFrame {
    const record = this.#record(value);
    return record?.type === "req" &&
      typeof record.id === "string" &&
      record.id.trim().length > 0 &&
      typeof record.call === "string" &&
      record.call.trim().length > 0;
  }

  #isAppSocketAttachment(value: unknown): value is AppSocketAttachment {
    const record = this.#record(value);
    if (record?.kind !== "app-client" || typeof record.connected !== "boolean") {
      return false;
    }
    if (!record.connected) {
      return true;
    }
    return this.#isAppSessionInfo(record.session) && this.#isAppFrameContext(record.appFrame);
  }

  #isAppSocketContext(value: unknown): value is AppSocketContext {
    const record = this.#record(value);
    return Boolean(
      record &&
      this.#isAppSessionInfo(record.session) &&
      this.#isAppFrameContext(record.appFrame),
    );
  }

  #isAppSessionInfo(value: unknown): value is AppSessionInfo {
    const session = this.#record(value);
    return Boolean(
      session &&
      typeof session.sessionId === "string" &&
      typeof session.clientId === "string" &&
      typeof session.rpcBase === "string" &&
      typeof session.expiresAt === "number",
    );
  }

  #isAppFrameContext(value: unknown): value is AppFrameContext {
    const appFrame = this.#record(value);
    return Boolean(
      appFrame &&
      typeof appFrame.uid === "number" &&
      typeof appFrame.username === "string" &&
      typeof appFrame.packageId === "string" &&
      typeof appFrame.packageName === "string" &&
      typeof appFrame.entrypointName === "string" &&
      typeof appFrame.routeBase === "string" &&
      typeof appFrame.issuedAt === "number" &&
      typeof appFrame.expiresAt === "number",
    );
  }

  #record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  }

  #frameError(error: unknown): { code: number; message: string } {
    if (error instanceof AppSocketError) {
      return { code: error.code, message: error.message };
    }
    return {
      code: 500,
      message: error instanceof Error ? error.message : String(error),
    };
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
        GSV_PACKAGE_PUBLIC_BASE: packageArtifactPublicBase(props.artifact.hash),
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
      return encodeBase64Bytes(value);
    }
    if (ArrayBuffer.isView(value)) {
      return encodeBase64Bytes(value);
    }
    return String(value);
  }
}
