import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import {
  loadPackageArtifact,
  packageArtifactPublicBase,
  packageArtifactToWorkerCode,
  type PackageArtifactMetadata,
  type PackageRuntimeAccess,
} from "./kernel/packages";
import { encodeBase64Bytes } from "./shared/base64";
import {
  DEFAULT_APP_FRAME_TTL_MS,
  type AppFrameContext,
  type PackageAppSignalWatchInfo,
} from "./protocol/app-frame";
import { buildAppRunnerName } from "./protocol/app-session";
import type { RequestFrame, ResponseFrame } from "./protocol/frames";
import {
  AppRpcScheduleStore,
  type AppRpcSchedule,
  type AppRpcScheduleRecord,
  type AppRpcScheduleUpsertInput,
} from "./app-daemons";
import { runAppRunnerSqlMigrations } from "./app-runner/schema/migrations";
import {
  SHIP_KERNEL_NAME,
  userKernelUsername,
} from "./shared/kernel-names";
import {
  BinaryBodyChannel,
  type BinaryBody,
  type BinaryFrameDescriptor,
} from "@humansandmachines/gsv/protocol";

export type AppRunnerProps = {
  kernelName: string;
  packageId: string;
  packageName: string;
  routeBase: string;
  entrypointName: string;
  artifact: PackageArtifactMetadata;
  appFrame: AppFrameContext;
};

export type PreservedAppRuntimeDescriptor = {
  uid: number;
  username: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
};

export type PreservedAppRuntimeRefreshResult =
  | { ok: true; props: AppRunnerProps }
  | { ok: false };

type PreSplitAppFrameContext = Pick<
  AppFrameContext,
  | "uid"
  | "username"
  | "packageId"
  | "packageName"
  | "entrypointName"
  | "routeBase"
  | "issuedAt"
  | "expiresAt"
>;

type StoredAppRunnerProps = Omit<AppRunnerProps, "kernelName" | "appFrame"> & {
  kernelName?: string;
  appFrame: AppFrameContext | PreSplitAppFrameContext;
};

function preservedAppRuntimeDescriptor(
  props: StoredAppRunnerProps,
): PreservedAppRuntimeDescriptor {
  return {
    uid: props.appFrame.uid,
    username: props.appFrame.username,
    packageId: props.packageId,
    packageName: props.packageName,
    entrypointName: props.entrypointName,
    routeBase: props.routeBase,
  };
}

function matchesPreservedAppRuntime(
  props: StoredAppRunnerProps,
  descriptor: PreservedAppRuntimeDescriptor,
): boolean {
  return props.appFrame.uid === descriptor.uid
    && props.appFrame.username === descriptor.username
    && props.packageId === descriptor.packageId
    && props.packageName === descriptor.packageName
    && props.entrypointName === descriptor.entrypointName
    && props.routeBase === descriptor.routeBase;
}

type AppRunnerSignalInput = {
  signal: string;
  payload?: unknown;
  sourcePid?: string | null;
  watch: PackageAppSignalWatchInfo;
  appSession?: AppSessionInfo;
};

type AppSessionInfo = {
  sessionId: string;
  clientId: string;
  rpcBase: string;
  expiresAt: number;
};

export function isAppSessionCurrent(
  session: Pick<AppSessionInfo, "expiresAt">,
  now = Date.now(),
): boolean {
  return Number.isFinite(session.expiresAt) && session.expiresAt > now;
}

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
  body?: BinaryFrameDescriptor;
};

type AppResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: unknown;
      body?: BinaryFrameDescriptor;
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

type AppSocketResult = {
  data?: unknown;
  body?: BinaryBody;
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
  appDaemonRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame>;
  authorizeAppFrame(appFrame: AppFrameContext): Promise<boolean>;
  authorizeAppDaemonFrame(appFrame: AppFrameContext): Promise<boolean>;
  refreshPreservedAppRuntime(
    input: PreservedAppRuntimeDescriptor,
  ): Promise<PreservedAppRuntimeRefreshResult>;
};

type MasterKernelRouteStub = {
  resolvePreservedAppRuntimeRoute(
    input: Pick<PreservedAppRuntimeDescriptor, "uid" | "username">,
  ): Promise<{ ok: true; kernelName: string } | { ok: false }>;
};

type KernelAppRequestStub = Pick<KernelAppStub, "appRequest"> & {
  appDaemonRequest?: KernelAppStub["appDaemonRequest"];
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
  emitAppEvent(event: string, payload?: unknown, clientId?: string, sessionId?: string): Promise<{ delivered: number }>;
};

type GsvApiBindingProps = {
  appRunnerName: string;
  kernelName: string;
  appFrameAuthority: AppFrameContext;
  runtimeAccess?: PackageRuntimeAccess;
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
  return appClientKeyFor(session.sessionId, session.clientId);
}

function appClientKeyFor(sessionId: string, clientId: string): string {
  return `${sessionId}:${clientId}`;
}

const APP_SOCKET_TAG = "app-client";

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .flatMap((key) => {
          const normalized = stableJsonValue(record[key]);
          return normalized === undefined ? [] : [[key, normalized]];
        }),
    );
  }
  return value;
}

function sameAppFrameAuthority(left: AppFrameContext, right: AppFrameContext): boolean {
  return left.uid === right.uid
    && left.username === right.username
    && left.packageId === right.packageId
    && left.packageName === right.packageName
    && left.packageUpdatedAt === right.packageUpdatedAt
    && left.packageArtifactHash === right.packageArtifactHash
    && left.entrypointName === right.entrypointName
    && left.routeBase === right.routeBase;
}

export function appRunnerWorkerCodeKey(props: {
  appFrame: Pick<
    AppFrameContext,
    | "uid"
    | "packageName"
    | "packageUpdatedAt"
    | "entrypointName"
    | "routeBase"
  >;
  packageId: string;
  artifact: { hash: string; runtimeAccess?: PackageRuntimeAccess };
}): string {
  return [
    "app-runtime",
    String(props.appFrame.uid),
    props.packageId,
    encodeURIComponent(props.appFrame.packageName),
    String(props.appFrame.packageUpdatedAt),
    encodeURIComponent(props.appFrame.entrypointName),
    encodeURIComponent(props.appFrame.routeBase),
    props.artifact.hash,
    encodeURIComponent(JSON.stringify(stableJsonValue(props.artifact.runtimeAccess ?? null))),
  ].join(":");
}

class AppSocketError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AppSocketError";
  }
}

class AppRuntimeAuthorizationError extends Error {
  constructor() {
    super("Package runtime authorization expired");
    this.name = "AppRuntimeAuthorizationError";
  }
}

class AppRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppRuntimeUnavailableError";
  }
}

export class AppSocketBodyTransport {
  private readonly channels = new Map<WebSocket, BinaryBodyChannel>();

  receive(socket: WebSocket, descriptor: BinaryFrameDescriptor): BinaryBody {
    return this.channel(socket).receive(descriptor);
  }

  handleBinary(socket: WebSocket, message: ArrayBuffer): boolean {
    return this.channel(socket).handleFrame(message);
  }

  async send(socket: WebSocket, frame: AppSocketFrame, body?: BinaryBody): Promise<void> {
    if (!body) {
      socket.send(JSON.stringify(frame));
      return;
    }
    const outgoing = this.channel(socket).prepare(body);
    try {
      socket.send(JSON.stringify({
        ...frame,
        body: outgoing.descriptor,
      }));
    } catch (error) {
      await outgoing.cancel(error);
      throw error;
    }
    // Once the descriptor is sent, transfer failures are reported on the binary stream.
    await outgoing.send().catch(() => {});
  }

  close(socket: WebSocket, reason = "App socket closed"): void {
    this.channels.get(socket)?.close(new Error(reason));
    this.channels.delete(socket);
  }

  private channel(socket: WebSocket): BinaryBodyChannel {
    let channel = this.channels.get(socket);
    if (!channel) {
      channel = new BinaryBodyChannel({
        sendFrame: (binary) => socket.send(binary),
      });
      this.channels.set(socket, channel);
    }
    return channel;
  }
}

export async function requestAppKernelFrame(
  kernel: KernelAppRequestStub,
  appFrame: AppFrameContext,
  call: string,
  args?: unknown,
  options: { body?: BinaryBody; daemon?: boolean } = {},
): Promise<{ data: unknown; body?: BinaryBody }> {
  try {
    if (options.daemon && !kernel.appDaemonRequest) {
      throw new Error("Package daemon request binding is unavailable");
    }
    const frame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
      ...(options.body ? { body: options.body } : {}),
    } as RequestFrame;
    const response = options.daemon
      ? await kernel.appDaemonRequest!(appFrame, frame)
      : await kernel.appRequest(appFrame, frame);
    if (!response.ok) {
      throw new AppSocketError(response.error.code, response.error.message);
    }
    return {
      data: response.data ?? {},
      ...(response.body ? { body: response.body } : {}),
    };
  } catch (error) {
    await cancelUnlockedBody(options.body, "App request failed");
    throw error;
  }
}

async function cancelUnlockedBody(body: BinaryBody | undefined, reason: string): Promise<void> {
  if (body && !body.stream.locked) {
    await body.stream.cancel(reason).catch(() => {});
  }
}

export class GsvApiBinding extends WorkerEntrypoint<Env, GsvApiBindingProps> {
  async kernelRequest(appFrame: AppFrameContext, call: string, args?: unknown): Promise<unknown> {
    const response = await this.kernelRequestFrame(appFrame, call, args);
    if (response.body) {
      await response.body.stream.cancel(`${call} returned a body`).catch(() => {});
      throw new Error(`${call} returned a body; use kernel.requestFrame()`);
    }
    return response.data;
  }

  async kernelRequestFrame(
    appFrame: AppFrameContext,
    call: string,
    args?: unknown,
    options: { body?: BinaryBody } = {},
  ): Promise<{ data: unknown; body?: BinaryBody }> {
    try {
      this.#assertAppFrameAuthority(appFrame);
    } catch (error) {
      await cancelUnlockedBody(options.body, "App request authority rejected");
      throw error;
    }
    const kernelName = this.ctx.props?.kernelName?.trim();
    if (!kernelName) {
      throw new Error("GSV_API requires kernelName");
    }
    const kernel = await getAgentByName(this.env.KERNEL, kernelName) as KernelAppStub;
    return await requestAppKernelFrame(kernel, appFrame, call, args, {
      ...options,
      daemon: this.ctx.props?.runtimeAccess?.daemon?.rpcSchedules === true,
    });
  }

  async upsertRpcSchedule(input: unknown): Promise<unknown> {
    this.#requireDaemonAccess();
    await this.#requireCurrentRuntime();
    return this.#getRunner().upsertRpcSchedule(input);
  }

  async removeRpcSchedule(key: string): Promise<{ removed: boolean }> {
    this.#requireDaemonAccess();
    await this.#requireCurrentRuntime();
    return this.#getRunner().removeRpcSchedule(key);
  }

  async listRpcSchedules(): Promise<unknown[]> {
    this.#requireDaemonAccess();
    await this.#requireCurrentRuntime();
    return this.#getRunner().listRpcSchedules();
  }

  async packageSqlExec(statement: string, bindings?: unknown[]): Promise<unknown[]> {
    this.#requireStorageSqlAccess();
    await this.#requireCurrentRuntime();
    return this.#getRunner().packageSqlExec(statement, bindings);
  }

  async emitAppEvent(
    event: string,
    payload?: unknown,
    clientId?: string,
    sessionId?: string,
  ): Promise<{ delivered: number }> {
    await this.#requireCurrentRuntime();
    return this.#getRunner().emitAppEvent(event, payload, clientId, sessionId);
  }

  #getRunner(): AppRunnerDaemonStub {
    const runnerName = this.ctx.props?.appRunnerName?.trim();
    const appFrame = this.ctx.props?.appFrameAuthority;
    if (
      !runnerName
      || !appFrame
      || runnerName !== buildAppRunnerName(appFrame.uid, appFrame.packageId)
    ) {
      throw new Error("GSV_API requires appRunnerName");
    }
    return this.ctx.exports.AppRunner.getByName(runnerName) as unknown as AppRunnerDaemonStub;
  }

  #requireDaemonAccess(): void {
    if (this.ctx.props?.runtimeAccess?.daemon?.rpcSchedules !== true) {
      throw new Error("Package daemon capability is not approved");
    }
  }

  #requireStorageSqlAccess(): void {
    if (this.ctx.props?.runtimeAccess?.storage?.sql !== true) {
      throw new Error("Package storage sql capability is not approved");
    }
  }

  #assertAppFrameAuthority(appFrame: AppFrameContext): void {
    const authority = this.ctx.props?.appFrameAuthority;
    if (!authority || !sameAppFrameAuthority(appFrame, authority)) {
      throw new Error("Package runtime authority does not match the request");
    }
  }

  async #requireCurrentRuntime(): Promise<void> {
    const kernelName = this.ctx.props?.kernelName?.trim();
    const authority = this.ctx.props?.appFrameAuthority;
    if (!kernelName || !authority) {
      throw new Error("GSV_API runtime authority is missing");
    }
    const now = Date.now();
    const appFrame: AppFrameContext = {
      ...authority,
      issuedAt: now,
      expiresAt: now + DEFAULT_APP_FRAME_TTL_MS,
    };
    delete appFrame.sessionId;
    delete appFrame.clientId;
    const kernel = await getAgentByName(this.env.KERNEL, kernelName) as KernelAppStub;
    const authorized = this.ctx.props?.runtimeAccess?.daemon?.rpcSchedules === true
      ? await kernel.authorizeAppDaemonFrame(appFrame)
      : await kernel.authorizeAppFrame(appFrame);
    if (!authorized) {
      throw new AppRuntimeAuthorizationError();
    }
  }
}

export class AppRunner extends DurableObject<Env> {
  private readonly daemonSchedules: AppRpcScheduleStore;
  private readonly appClients = new Map<string, RegisteredAppClient>();
  private readonly appSocketBodies = new AppSocketBodyTransport();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    runAppRunnerSqlMigrations(ctx.storage);
    this.daemonSchedules = new AppRpcScheduleStore(ctx.storage.sql);
    this.#restoreAppClients();
  }

  async ensureRuntime(props: AppRunnerProps): Promise<void> {
    this.#assertValidProps(props);
    const previous = this.#getStoredPropsOrNull();
    const previousKernelName = previous && !this.#isBoundProps(previous)
      ? SHIP_KERNEL_NAME
      : previous?.kernelName;
    if (
      previous
      && previousKernelName === props.kernelName
      && previous.packageId === props.packageId
      && previous.packageName === props.packageName
      && previous.routeBase === props.routeBase
      && previous.entrypointName === props.entrypointName
      && previous.artifact.hash === props.artifact.hash
      && JSON.stringify(previous.artifact.runtimeAccess ?? null) === JSON.stringify(props.artifact.runtimeAccess ?? null)
      && previous.appFrame.uid === props.appFrame.uid
      && previous.appFrame.routeBase === props.appFrame.routeBase
      && previous.appFrame.entrypointName === props.appFrame.entrypointName
    ) {
      return;
    }
    if (
      previousKernelName === SHIP_KERNEL_NAME
      && userKernelUsername(props.kernelName) !== null
    ) {
      this.#closeAllAppSockets("App runtime moved to its user Kernel");
    }
    this.ctx.storage.kv.put(PROPS_KEY, props);
  }

  async gsvFetch(request: Request): Promise<Response> {
    const runtime = this.#defaultRuntime();
    await this.#requireCurrentRuntime(runtime);
    return this.#getAppEntrypoint(runtime).fetch(request);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#acceptAppSocket(request);
    }
    return this.gsvFetch(request);
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    const runtime = this.#runtimeForSignal(input);
    await this.#requireCurrentRuntime(runtime);
    await this.#getSignalEntrypoint(runtime, input).run(input.signal);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message instanceof ArrayBuffer) {
      if (!this.appSocketBodies.handleBinary(ws, message)) {
        this.#closeSocket(ws, 1003, "Invalid binary app frame");
      }
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

    let body: BinaryBody | undefined;
    try {
      body = frame.body ? this.appSocketBodies.receive(ws, frame.body) : undefined;
      const response = await this.#handleAppSocketRequest(ws, frame, body);
      await this.appSocketBodies.send(ws, {
        type: "res",
        id: frame.id,
        ok: true,
        ...(response.data === undefined ? {} : { data: response.data }),
      }, response.body);
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
    } finally {
      await cancelUnlockedBody(body, "App request completed");
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.appSocketBodies.close(ws);
    this.#removeAppClientBySocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.appSocketBodies.close(ws, "App socket failed");
    this.#removeAppClientBySocket(ws);
  }

  async invokeAppRpc(method: string, args: unknown, runtime: AppRuntimeContext): Promise<unknown> {
    await this.#requireCurrentRuntime(runtime);
    return this.#getRpcEntrypoint(runtime).invoke(method, args);
  }

  async runCommand(input: AppRunnerCommandInput): Promise<unknown> {
    const props = this.#getProps();
    const now = Date.now();
    const appFrame: AppFrameContext = {
      ...props.appFrame,
      uid: input.uid,
      username: input.username,
      entrypointName: input.commandName,
      issuedAt: now,
      expiresAt: now + RUNTIME_TTL_MS,
    };
    delete appFrame.sessionId;
    delete appFrame.clientId;
    const runtime = this.#runtimeForAppFrame(appFrame);
    await this.#requireCurrentRuntime(runtime);
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

  async emitAppEvent(
    event: string,
    payload?: unknown,
    clientId?: string,
    sessionId?: string,
  ): Promise<{ delivered: number }> {
    const normalizedEvent = typeof event === "string" ? event.trim() : "";
    if (!normalizedEvent) {
      throw new Error("app event name is required");
    }
    const targetClientId = typeof clientId === "string" && clientId.trim().length > 0
      ? clientId.trim()
      : null;
    const targetSessionId = typeof sessionId === "string" && sessionId.trim().length > 0
      ? sessionId.trim()
      : null;
    const delivered = await this.#emitAppEventToClients(normalizedEvent, payload, targetClientId, targetSessionId);
    return { delivered };
  }

  async closeAppSession(sessionId: string): Promise<{ closed: number }> {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) {
      return { closed: 0 };
    }

    this.#restoreAppClients();
    let closed = 0;
    for (const registration of [...this.appClients.values()]) {
      if (registration.session.sessionId !== normalizedSessionId) {
        continue;
      }
      this.#closeSocket(registration.socket, 1000, "app session closed");
      closed += 1;
    }
    return { closed };
  }

  async closeAppClient(sessionId: string, clientId: string): Promise<{ closed: number }> {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    const normalizedClientId = typeof clientId === "string" ? clientId.trim() : "";
    if (!normalizedSessionId || !normalizedClientId) {
      return { closed: 0 };
    }

    this.#restoreAppClients();
    const key = appClientKeyFor(normalizedSessionId, normalizedClientId);
    const registration = this.appClients.get(key);
    if (!registration) {
      return { closed: 0 };
    }
    this.#closeSocket(registration.socket, 1000, "app client detached");
    return { closed: 1 };
  }

  async #acceptAppSocket(request: Request): Promise<Response> {
    const context = this.#appSocketContextFromRequest(request);
    if (!context || !isAppSessionCurrent(context.session)) {
      return new Response("App socket context is missing or invalid", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    if (
      context.appFrame.sessionId !== context.session.sessionId
      || context.appFrame.clientId !== context.session.clientId
      || context.appFrame.expiresAt > context.session.expiresAt
    ) {
      return new Response("App socket authority does not match its session", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }

    try {
      await this.#requireCurrentRuntime(this.#runtimeForAppFrame(
        context.appFrame,
        context.session,
      ));
    } catch {
      return new Response("Authentication failed", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [APP_SOCKET_TAG]);
    this.#registerAppSocket(server, context.session, context.appFrame);
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async #handleAppSocketRequest(
    ws: WebSocket,
    frame: AppRequestFrame,
    body?: BinaryBody,
  ): Promise<AppSocketResult> {
    switch (frame.call) {
      case "backend.invoke":
        if (body) {
          throw new AppSocketError(400, "backend.invoke does not accept a body");
        }
        return { data: await this.#invokeBackendFromSocket(ws, frame.args) };
      case "kernel.request":
        return this.#kernelRequestFromSocket(ws, frame.args, body);
      case "app.ping":
        if (body) {
          throw new AppSocketError(400, "app.ping does not accept a body");
        }
        return { data: { ok: true, timestamp: Date.now() } };
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

  async #kernelRequestFromSocket(
    ws: WebSocket,
    args: unknown,
    body?: BinaryBody,
  ): Promise<AppSocketResult> {
    const client = this.#clientForSocket(ws);
    if (!client) {
      throw new AppSocketError(401, "App socket is not connected");
    }
    const record = this.#record(args);
    const call = typeof record?.call === "string" ? record.call.trim() : "";
    if (!call) {
      throw new AppSocketError(400, "kernel.request requires call");
    }
    const kernel = await getAgentByName(this.env.KERNEL, this.#getProps().kernelName) as KernelAppStub;
    return await requestAppKernelFrame(kernel, client.appFrame, call, record?.args, { body });
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
    if (this.#isAppSessionInfo(input.appSession)) {
      return this.#defaultRuntime(input.appSession);
    }

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
      if (!isAppSessionCurrent(attachment.session)) {
        this.#closeSocket(socket, 1008, "app session expired");
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

  async #emitAppEventToClients(
    event: string,
    payload: unknown,
    clientId: string | null,
    sessionId: string | null,
  ): Promise<number> {
    this.#restoreAppClients();
    let targets: Array<[string, RegisteredAppClient]>;
    if (clientId) {
      if (!sessionId) {
        throw new Error("targeted app events require an app session id");
      }
      const key = appClientKeyFor(sessionId, clientId);
      const registration = this.appClients.get(key);
      targets = registration ? [[key, registration]] : [];
    } else {
      targets = sessionId
        ? [...this.appClients.entries()].filter(([, registration]) => registration.session.sessionId === sessionId)
        : [...this.appClients.entries()];
    }
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
    this.#closeSocket(registration.socket, 1011, "app client removed");
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
    if (!isAppSessionCurrent(attachment.session)) {
      this.#closeSocket(socket, 1008, "app session expired");
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
    this.appSocketBodies.close(socket, reason);
    this.#removeAppClientBySocket(socket);
    try {
      socket.serializeAttachment({
        kind: "app-client",
        connected: false,
      } satisfies AppSocketAttachment);
    } catch {
    }
    try {
      socket.close(code, reason);
    } catch {
    }
  }

  #closeAllAppSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets(APP_SOCKET_TAG)) {
      this.#closeSocket(socket, 1012, reason);
    }
    this.appClients.clear();
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
      typeof session.sessionId === "string" && session.sessionId.length > 0 &&
      typeof session.clientId === "string" && session.clientId.length > 0 &&
      typeof session.rpcBase === "string" && session.rpcBase.length > 0 &&
      typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt),
    );
  }

  #isAppFrameContext(value: unknown): value is AppFrameContext {
    const appFrame = this.#record(value);
    return Boolean(
      appFrame &&
      Number.isSafeInteger(appFrame.uid) && (appFrame.uid as number) >= 0 &&
      typeof appFrame.username === "string" && appFrame.username.length > 0 &&
      (appFrame.sessionId === undefined || typeof appFrame.sessionId === "string") &&
      (appFrame.clientId === undefined || typeof appFrame.clientId === "string") &&
      (appFrame.sessionId === undefined) === (appFrame.clientId === undefined) &&
      typeof appFrame.packageId === "string" && appFrame.packageId.length > 0 &&
      typeof appFrame.packageName === "string" && appFrame.packageName.length > 0 &&
      Number.isSafeInteger(appFrame.packageUpdatedAt) && (appFrame.packageUpdatedAt as number) > 0 &&
      typeof appFrame.packageArtifactHash === "string" && appFrame.packageArtifactHash.length > 0 &&
      typeof appFrame.entrypointName === "string" && appFrame.entrypointName.length > 0 &&
      typeof appFrame.routeBase === "string" && appFrame.routeBase.length > 0 &&
      Number.isSafeInteger(appFrame.issuedAt) && (appFrame.issuedAt as number) > 0 &&
      Number.isSafeInteger(appFrame.expiresAt) &&
      (appFrame.expiresAt as number) > (appFrame.issuedAt as number),
    );
  }

  #isPreSplitAppFrameContext(value: unknown): value is PreSplitAppFrameContext {
    const appFrame = this.#record(value);
    return Boolean(
      appFrame
      && !Object.prototype.hasOwnProperty.call(appFrame, "sessionId")
      && !Object.prototype.hasOwnProperty.call(appFrame, "clientId")
      && !Object.prototype.hasOwnProperty.call(appFrame, "packageUpdatedAt")
      && !Object.prototype.hasOwnProperty.call(appFrame, "packageArtifactHash")
      && Number.isSafeInteger(appFrame.uid) && (appFrame.uid as number) >= 0
      && typeof appFrame.username === "string" && appFrame.username.length > 0
      && typeof appFrame.packageId === "string" && appFrame.packageId.length > 0
      && typeof appFrame.packageName === "string" && appFrame.packageName.length > 0
      && typeof appFrame.entrypointName === "string" && appFrame.entrypointName.length > 0
      && typeof appFrame.routeBase === "string" && appFrame.routeBase.length > 0
      && Number.isSafeInteger(appFrame.issuedAt) && (appFrame.issuedAt as number) > 0
      && Number.isSafeInteger(appFrame.expiresAt)
      && (appFrame.expiresAt as number) > (appFrame.issuedAt as number),
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
    const stored = this.#getStoredPropsOrNull();
    if (!stored) {
      throw new Error("AppRunner is not initialized");
    }
    if (!this.#isBoundProps(stored)) {
      throw new AppRuntimeUnavailableError(
        "Preserved AppRunner runtime requires current authorization",
      );
    }
    return stored;
  }

  #getStoredPropsOrNull(): StoredAppRunnerProps | null {
    const stored = this.ctx.storage.kv.get<unknown>(PROPS_KEY);
    if (stored === undefined) {
      return null;
    }
    if (!stored || typeof stored !== "object") {
      throw new Error("AppRunner props are incomplete or inconsistent");
    }
    const props = stored as StoredAppRunnerProps;
    if (Object.prototype.hasOwnProperty.call(props, "kernelName")) {
      this.#assertValidProps(props as AppRunnerProps);
    } else {
      this.#assertValidUnboundProps(props);
    }
    return props;
  }

  #isBoundProps(props: StoredAppRunnerProps): props is AppRunnerProps {
    return Object.prototype.hasOwnProperty.call(props, "kernelName");
  }

  #assertValidUnboundProps(props: StoredAppRunnerProps): void {
    const currentFrame = this.#isAppFrameContext(props.appFrame)
      ? props.appFrame
      : null;
    const preSplitFrame = currentFrame === null
      && this.#isPreSplitAppFrameContext(props.appFrame);
    if (
      !props.packageId?.trim()
      || !props.packageName?.trim()
      || !props.routeBase?.trim()
      || !props.entrypointName?.trim()
      || !props.artifact?.hash?.trim()
      || (currentFrame === null && !preSplitFrame)
      || props.packageId !== props.appFrame.packageId
      || props.packageName !== props.appFrame.packageName
      || props.routeBase !== props.appFrame.routeBase
      || props.entrypointName !== props.appFrame.entrypointName
      || (currentFrame !== null
        && props.artifact.hash !== currentFrame.packageArtifactHash)
    ) {
      throw new Error("AppRunner props are incomplete or inconsistent");
    }
  }

  #assertValidProps(props: AppRunnerProps): void {
    const ownerUsername = typeof props.kernelName === "string"
      ? userKernelUsername(props.kernelName)
      : null;
    if (
      ownerUsername === null
      || !props.packageId?.trim()
      || !props.packageName?.trim()
      || !props.routeBase?.trim()
      || !props.entrypointName?.trim()
      || !props.artifact?.hash?.trim()
      || !this.#isAppFrameContext(props.appFrame)
      || props.packageId !== props.appFrame.packageId
      || props.packageName !== props.appFrame.packageName
      || props.routeBase !== props.appFrame.routeBase
      || props.entrypointName !== props.appFrame.entrypointName
      || props.artifact.hash !== props.appFrame.packageArtifactHash
    ) {
      throw new Error("AppRunner props are incomplete or inconsistent");
    }
  }

  async #requireCurrentRuntime(runtime: AppRuntimeContext): Promise<void> {
    const props = await this.#resolveLegacyRuntimePlacement();
    const kernel = await getAgentByName(this.env.KERNEL, props.kernelName) as KernelAppStub;
    const authorized = runtime.daemonTrigger
      ? await kernel.authorizeAppDaemonFrame(runtime.appFrame)
      : await kernel.authorizeAppFrame(runtime.appFrame);
    if (!authorized) {
      throw new AppRuntimeAuthorizationError();
    }
  }

  async #resolveLegacyRuntimePlacement(): Promise<AppRunnerProps> {
    const stored = this.#getStoredPropsOrNull();
    if (!stored) {
      throw new Error("AppRunner is not initialized");
    }
    if (this.#isBoundProps(stored)) {
      return stored;
    }

    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelRouteStub;
    const descriptor = preservedAppRuntimeDescriptor(stored);
    const route = await master.resolvePreservedAppRuntimeRoute({
      uid: descriptor.uid,
      username: descriptor.username,
    });
    if (!route.ok) {
      throw new AppRuntimeUnavailableError("Package runtime placement is unavailable");
    }
    if (userKernelUsername(route.kernelName) === null) {
      throw new AppRuntimeAuthorizationError();
    }
    if (!this.#isAppFrameContext(stored.appFrame)) {
      const kernel = await getAgentByName(
        this.env.KERNEL,
        route.kernelName,
      ) as KernelAppStub;
      const refreshed = await kernel.refreshPreservedAppRuntime(descriptor);
      if (!refreshed.ok) {
        throw new AppRuntimeAuthorizationError();
      }
      try {
        this.#assertValidProps(refreshed.props);
      } catch {
        throw new AppRuntimeAuthorizationError();
      }
      if (
        refreshed.props.kernelName !== route.kernelName
        || !matchesPreservedAppRuntime(refreshed.props, descriptor)
        || refreshed.props.appFrame.sessionId !== undefined
        || refreshed.props.appFrame.clientId !== undefined
      ) {
        throw new AppRuntimeAuthorizationError();
      }

      const current = this.#getStoredPropsOrNull();
      if (!current) {
        throw new Error("AppRunner is not initialized");
      }
      if (this.#isBoundProps(current)) {
        return current;
      }
      if (!matchesPreservedAppRuntime(current, descriptor)) {
        throw new AppRuntimeAuthorizationError();
      }
      await this.ensureRuntime(refreshed.props);
      return refreshed.props;
    }

    // Another request may have refreshed these props while placement was being
    // resolved. Rebind the current record so an old alarm can never restore a
    // stale package revision.
    const current = this.#getStoredPropsOrNull();
    if (!current) {
      throw new Error("AppRunner is not initialized");
    }
    if (this.#isBoundProps(current)) {
      return current;
    }
    if (
      !matchesPreservedAppRuntime(current, descriptor)
      || !this.#isAppFrameContext(current.appFrame)
    ) {
      throw new AppRuntimeAuthorizationError();
    }
    const rebound: AppRunnerProps = {
      ...current,
      kernelName: route.kernelName,
      appFrame: current.appFrame,
    };
    await this.ensureRuntime(rebound);
    return rebound;
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
            kernelName: props.kernelName,
            appFrameAuthority: props.appFrame,
            runtimeAccess: props.artifact.runtimeAccess,
          },
        }),
        GSV_PACKAGE_NAME: props.packageName,
        GSV_PACKAGE_ID: props.packageId,
        GSV_ROUTE_BASE: props.routeBase,
        GSV_PACKAGE_PUBLIC_BASE: packageArtifactPublicBase(props.artifact.hash),
      }, props.artifact.runtimeAccess),
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
      ...(props.artifact.runtimeAccess ? { runtimeAccess: props.artifact.runtimeAccess } : {}),
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
    return appRunnerWorkerCodeKey(props);
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
    const startedAt = Date.now();
    let status: "ok" | "error" = "ok";
    let errorMessage: string | null = null;
    let disable = false;
    try {
      const props = await this.#resolveLegacyRuntimePlacement();
      const runtime = this.#runtimeForAppFrame(
        this.#runtimeAppFrame(props),
        undefined,
        trigger,
      );
      await this.#requireCurrentRuntime(runtime);
      await this.#getRpcEntrypoint(runtime).invoke(record.rpcMethod, record.payload);
    } catch (error) {
      status = "error";
      disable = error instanceof AppRuntimeAuthorizationError;
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
      disable,
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
