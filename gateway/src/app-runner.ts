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
import type { AppFrameContext, PackageAppSignalWatchInfo } from "./protocol/app-frame";
import { buildAppRunnerName } from "./protocol/app-session";
import type { RequestFrame, ResponseFrame } from "./protocol/frames";
import {
  AppRpcScheduleStore,
  type AppRpcSchedule,
  type AppRpcScheduleRecord,
  type AppRpcScheduleUpsertInput,
} from "./app-daemons";
import { runAppRunnerSqlMigrations } from "./app-runner/schema/migrations";
import { WebSocketAdmission, webSocketMessageSize } from "./kernel/websocket-admission";
import {
  BinaryBodyChannel,
  MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
  validateManagedRestoreControl,
  validateManagedSnapshotRequest,
  type BinaryBody,
  type BinaryFrameDescriptor,
  type ManagedObjectRestoreControl,
  type ManagedObjectSnapshotRequest,
  type ManagedObjectDescriptor,
} from "@humansandmachines/gsv/protocol";
import {
  prepareManagedRestoreTarget,
  readManagedRestoreTarget,
  restoreManagedOwner,
  snapshotManagedOwner,
} from "./managed/do-portability";

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
  appSession?: AppSessionInfo;
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
  connectionId?: string;
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
  kernelRequestFrameFromRuntime(
    runtimeEpoch: number,
    appFrame: AppFrameContext,
    call: string,
    args?: unknown,
    options?: { body?: BinaryBody },
  ): Promise<{ data: unknown; body?: BinaryBody }>;
  upsertRpcSchedule(runtimeEpoch: number, input: unknown): Promise<unknown>;
  removeRpcSchedule(runtimeEpoch: number, key: string): Promise<{ removed: boolean }>;
  listRpcSchedules(runtimeEpoch: number): Promise<unknown[]>;
  packageSqlExec(runtimeEpoch: number, statement: string, bindings?: unknown[]): Promise<unknown[]>;
  emitAppEvent(runtimeEpoch: number, event: string, payload?: unknown, clientId?: string, sessionId?: string): Promise<{ delivered: number }>;
};

type GsvApiBindingProps = {
  appRunnerName: string;
  runtimeEpoch: number;
  runtimeAccess?: PackageRuntimeAccess;
};

const PROPS_KEY = "app-runner:props";
const MANAGED_PAUSED_KEY = "__gsv:managed:paused";
const MANAGED_EPOCH_KEY = "__gsv:managed:epoch";
const MANAGED_ERASED_KEY = "__gsv:managed:erased";
const MANAGED_LOGICAL_NAME_KEY = "__gsv:managed:logicalName";
const RUNTIME_TTL_MS = 365 * 24 * 60 * 60 * 1000;

type RegisteredAppClient = {
  socket: WebSocket;
  connectionId: string;
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

export type AppSocketLifetime = {
  sessionExpiresAt: number;
  appFrameExpiresAt: number;
};

export type AppSocketAdmissionResult =
  | { admitted: true }
  | {
      admitted: false;
      reason: "expired" | "connection_limit" | "frame_too_large" | "message_rate";
    };

/** Applies the same connection, frame, and rate limits as the Kernel socket boundary. */
export class AppSocketAdmission {
  private readonly admission = new WebSocketAdmission();

  open(
    connectionId: string,
    lifetime: AppSocketLifetime,
    now = Date.now(),
  ): AppSocketAdmissionResult {
    if (!this.canDeliver(lifetime, now)) {
      return { admitted: false, reason: "expired" };
    }
    return this.admission.open(connectionId, now);
  }

  admit(
    connectionId: string,
    lifetime: AppSocketLifetime,
    kind: "json" | "binary",
    bytes: number,
    now = Date.now(),
  ): AppSocketAdmissionResult {
    if (!this.canDeliver(lifetime, now)) {
      return { admitted: false, reason: "expired" };
    }
    return this.admission.admit(connectionId, "connected", kind, bytes, now);
  }

  canDeliver(lifetime: AppSocketLifetime, now = Date.now()): boolean {
    return Number.isSafeInteger(lifetime.sessionExpiresAt) &&
      Number.isSafeInteger(lifetime.appFrameExpiresAt) &&
      lifetime.sessionExpiresAt > now &&
      lifetime.appFrameExpiresAt > now;
  }

  close(connectionId: string): void {
    this.admission.close(connectionId);
  }
}

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

export function appRunnerWorkerCodeKey(props: {
  appFrame: { uid: number };
  packageId: string;
  artifact: { hash: string; runtimeAccess?: PackageRuntimeAccess };
  runtimeEpoch?: number;
}): string {
  return [
    "app-runtime",
    String(props.appFrame.uid),
    props.packageId,
    props.artifact.hash,
    encodeURIComponent(JSON.stringify(stableJsonValue(props.artifact.runtimeAccess ?? null))),
    `epoch-${props.runtimeEpoch ?? 0}`,
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

export class AppSocketBodyTransport {
  private readonly channels = new Map<WebSocket, BinaryBodyChannel>();

  constructor(
    private readonly canSend: (socket: WebSocket) => boolean = () => true,
  ) {}

  receive(socket: WebSocket, descriptor: BinaryFrameDescriptor): BinaryBody {
    return this.channel(socket).receive(descriptor);
  }

  handleBinary(socket: WebSocket, message: ArrayBuffer): boolean {
    return this.channel(socket).handleFrame(message);
  }

  async send(socket: WebSocket, frame: AppSocketFrame, body?: BinaryBody): Promise<void> {
    if (!body) {
      this.sendFrame(socket, JSON.stringify(frame));
      return;
    }
    const outgoing = this.channel(socket).prepare(body);
    try {
      this.sendFrame(socket, JSON.stringify({
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

  closeAll(reason = "App sockets closed"): void {
    for (const channel of this.channels.values()) {
      channel.close(new Error(reason));
    }
    this.channels.clear();
  }

  private channel(socket: WebSocket): BinaryBodyChannel {
    let channel = this.channels.get(socket);
    if (!channel) {
      channel = new BinaryBodyChannel({
        sendFrame: (binary) => this.sendFrame(socket, binary),
      });
      this.channels.set(socket, channel);
    }
    return channel;
  }

  private sendFrame(socket: WebSocket, frame: string | ArrayBuffer): void {
    if (!this.canSend(socket)) {
      throw new Error("App socket delivery is no longer allowed");
    }
    socket.send(frame);
  }
}

export async function requestAppKernelFrame(
  kernel: KernelAppStub,
  appFrame: AppFrameContext,
  call: string,
  args?: unknown,
  options: { body?: BinaryBody } = {},
): Promise<{ data: unknown; body?: BinaryBody }> {
  const response = await kernel.appRequest(appFrame, {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
    ...(options.body ? { body: options.body } : {}),
  } as RequestFrame);
  if (!response.ok) {
    throw new AppSocketError(response.error.code, response.error.message);
  }
  return {
    data: response.data ?? {},
    ...(response.body ? { body: response.body } : {}),
  };
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
    return this.#getRunner().kernelRequestFrameFromRuntime(
      this.#runtimeEpoch(),
      appFrame,
      call,
      args,
      options,
    );
  }

  async upsertRpcSchedule(input: unknown): Promise<unknown> {
    this.#requireDaemonAccess();
    return this.#getRunner().upsertRpcSchedule(this.#runtimeEpoch(), input);
  }

  async removeRpcSchedule(key: string): Promise<{ removed: boolean }> {
    this.#requireDaemonAccess();
    return this.#getRunner().removeRpcSchedule(this.#runtimeEpoch(), key);
  }

  async listRpcSchedules(): Promise<unknown[]> {
    this.#requireDaemonAccess();
    return this.#getRunner().listRpcSchedules(this.#runtimeEpoch());
  }

  async packageSqlExec(statement: string, bindings?: unknown[]): Promise<unknown[]> {
    this.#requireStorageSqlAccess();
    return this.#getRunner().packageSqlExec(this.#runtimeEpoch(), statement, bindings);
  }

  async emitAppEvent(
    event: string,
    payload?: unknown,
    clientId?: string,
    sessionId?: string,
  ): Promise<{ delivered: number }> {
    return this.#getRunner().emitAppEvent(
      this.#runtimeEpoch(),
      event,
      payload,
      clientId,
      sessionId,
    );
  }

  #getRunner(): AppRunnerDaemonStub {
    const runnerName = this.ctx.props?.appRunnerName?.trim();
    if (!runnerName) {
      throw new Error("GSV_API requires appRunnerName");
    }
    return this.env.APP_RUNNER.getByName(runnerName) as unknown as AppRunnerDaemonStub;
  }

  #runtimeEpoch(): number {
    const epoch = this.ctx.props?.runtimeEpoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error("GSV_API requires a valid runtime epoch");
    }
    return epoch;
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
}

export class AppRunner extends DurableObject<Env> {
  private readonly daemonSchedules: AppRpcScheduleStore;
  private readonly appClients = new Map<string, RegisteredAppClient>();
  private readonly appSocketAdmission = new AppSocketAdmission();
  private readonly appSocketBodies = new AppSocketBodyTransport(
    (socket) => this.#canDeliverToSocket(socket),
  );
  private appClientsRestored = false;
  private erased = false;
  private managedPaused = false;
  private managedEpoch = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    runAppRunnerSqlMigrations(ctx.storage);
    this.daemonSchedules = new AppRpcScheduleStore(ctx.storage.sql);
    this.erased = ctx.storage.kv.get(MANAGED_ERASED_KEY) === true;
    this.managedPaused = ctx.storage.kv.get(MANAGED_PAUSED_KEY) === true;
    const storedManagedEpoch = ctx.storage.kv.get<number>(MANAGED_EPOCH_KEY);
    this.managedEpoch = Number.isSafeInteger(storedManagedEpoch) && storedManagedEpoch! >= 0
      ? storedManagedEpoch!
      : 0;
    if (this.erased) {
      this.#closeManagedSockets("Tenant runtime is being erased");
    } else if (this.managedPaused) {
      this.#closeManagedSockets("Tenant runtime is being updated");
    } else {
      this.#restoreAppClients();
    }
  }

  async ensureRuntime(props: AppRunnerProps): Promise<void> {
    this.#requireActive();
    const previous = this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY);
    if (
      previous
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
    this.ctx.storage.kv.put(PROPS_KEY, props);
  }

  async gsvFetch(request: Request): Promise<Response> {
    return this.#runInActiveEpoch(
      () => this.#getAppEntrypoint(this.#defaultRuntime()).fetch(request),
      undefined,
      async (response) => response.body?.cancel("Tenant runtime was superseded"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.#requireActive();
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#acceptAppSocket(request);
    }
    return this.gsvFetch(request);
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    await this.#runInActiveEpoch(async () => {
      const runtime = this.#runtimeForSignal(input);
      await this.#getSignalEntrypoint(runtime, input).run(input.signal);
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.erased || this.managedPaused) {
      this.#closeSocket(
        ws,
        1001,
        this.erased ? "AppRunner no longer exists" : "Tenant runtime is being updated",
      );
      return;
    }
    this.#restoreAppClients();
    const client = this.#clientForSocket(ws);
    if (!client) {
      this.#closeSocket(ws, 1008, "App socket is not connected");
      return;
    }
    const messageSize = webSocketMessageSize(message);
    const admission = this.appSocketAdmission.admit(
      client.connectionId,
      this.#appSocketLifetime(client.session, client.appFrame),
      messageSize.kind,
      messageSize.bytes,
    );
    if (!admission.admitted) {
      this.#closeSocketForAdmission(ws, admission.reason);
      return;
    }
    const runtimeEpoch = this.managedEpoch;
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
      if (!this.#isActiveEpoch(runtimeEpoch)) {
        await cancelUnlockedBody(response.body, "Tenant runtime was superseded");
        return;
      }
      if (!this.#canDeliverToSocket(ws)) {
        await cancelUnlockedBody(response.body, "App session expired");
        return;
      }
      await this.appSocketBodies.send(ws, {
        type: "res",
        id: frame.id,
        ok: true,
        ...(response.data === undefined ? {} : { data: response.data }),
      }, response.body);
    } catch (error) {
      if (!this.#isActiveEpoch(runtimeEpoch)) {
        return;
      }
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
    this.#forgetAppSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.appSocketBodies.close(ws, "App socket failed");
    this.#forgetAppSocket(ws);
  }

  async invokeAppRpc(method: string, args: unknown, runtime: AppRuntimeContext): Promise<unknown> {
    return this.#runInActiveEpoch(
      () => this.#getRpcEntrypoint(runtime).invoke(method, args),
    );
  }

  async runCommand(input: AppRunnerCommandInput): Promise<unknown> {
    return this.#runInActiveEpoch(() => {
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
    });
  }

  async kernelRequestFrameFromRuntime(
    runtimeEpoch: number,
    appFrame: AppFrameContext,
    call: string,
    args?: unknown,
    options: { body?: BinaryBody } = {},
  ): Promise<{ data: unknown; body?: BinaryBody }> {
    let response: { data: unknown; body?: BinaryBody } | undefined;
    try {
      return await this.#runInActiveEpoch(async () => {
        const kernel = await getAgentByName(this.env.KERNEL, "singleton") as KernelAppStub;
        response = await requestAppKernelFrame(kernel, appFrame, call, args, options);
        return response;
      }, runtimeEpoch);
    } catch (error) {
      await cancelUnlockedBody(response?.body, "Tenant runtime was superseded");
      throw error;
    }
  }

  async upsertRpcSchedule(runtimeEpoch: number, input: unknown): Promise<unknown> {
    this.#requireActive(runtimeEpoch);
    const record = this.daemonSchedules.upsert(this.#normalizeRpcScheduleInput(input));
    await this.#syncDaemonAlarm(runtimeEpoch);
    this.#requireActive(runtimeEpoch);
    return this.#serializeDaemonRecord(record);
  }

  async removeRpcSchedule(runtimeEpoch: number, key: string): Promise<{ removed: boolean }> {
    this.#requireActive(runtimeEpoch);
    const removed = this.daemonSchedules.remove(key);
    await this.#syncDaemonAlarm(runtimeEpoch);
    this.#requireActive(runtimeEpoch);
    return { removed };
  }

  async listRpcSchedules(runtimeEpoch: number): Promise<unknown[]> {
    this.#requireActive(runtimeEpoch);
    return this.daemonSchedules.list().map((record) => this.#serializeDaemonRecord(record));
  }

  async packageSqlExec(
    runtimeEpoch: number,
    statement: string,
    bindings?: unknown[],
  ): Promise<unknown[]> {
    this.#requireActive(runtimeEpoch);
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
    runtimeEpoch: number,
    event: string,
    payload?: unknown,
    clientId?: string,
    sessionId?: string,
  ): Promise<{ delivered: number }> {
    this.#requireActive(runtimeEpoch);
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
    this.#requireActive(runtimeEpoch);
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

  #acceptAppSocket(request: Request): Response {
    const context = this.#appSocketContextFromRequest(request);
    if (!context) {
      return new Response("App socket context is missing or invalid", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }

    this.#restoreAppClients();
    const previous = this.appClients.get(appClientKey(context.session));
    if (previous) {
      this.#closeSocket(previous.socket, 1000, "Replaced by newer app connection");
    }
    const connectionId = crypto.randomUUID();
    const admission = this.appSocketAdmission.open(
      connectionId,
      this.#appSocketLifetime(context.session, context.appFrame),
    );
    if (!admission.admitted) {
      return new Response(
        admission.reason === "expired" ? "App socket context has expired" : "Too many app sockets",
        {
          status: admission.reason === "expired" ? 401 : 429,
          headers: { "cache-control": "no-store" },
        },
      );
    }

    const [client, server] = Object.values(new WebSocketPair());
    try {
      this.ctx.acceptWebSocket(server, [APP_SOCKET_TAG]);
      this.#registerAppSocket(server, connectionId, context.session, context.appFrame);
    } catch (error) {
      this.appSocketAdmission.close(connectionId);
      try {
        server.close(1011, "App socket setup failed");
      } catch {
      }
      throw error;
    }
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
    const kernel = await getAgentByName(this.env.KERNEL, "singleton") as KernelAppStub;
    return await requestAppKernelFrame(kernel, client.appFrame, call, record?.args, { body });
  }

  async alarm(): Promise<void> {
    if (this.erased || this.managedPaused) {
      return;
    }
    const runtimeEpoch = this.managedEpoch;
    const due = this.daemonSchedules.due(Date.now());
    for (const record of due) {
      if (!this.#isActiveEpoch(runtimeEpoch)) {
        return;
      }
      await this.#runDueRpcSchedule(record, runtimeEpoch);
    }
    await this.#syncDaemonAlarm(runtimeEpoch);
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

  #registerAppSocket(
    ws: WebSocket,
    connectionId: string,
    session: AppSessionInfo,
    appFrame: AppFrameContext,
  ): void {
    const key = appClientKey(session);
    const previous = this.appClients.get(key);
    if (previous && previous.socket !== ws) {
      this.#closeSocket(previous.socket, 1000, "Replaced by newer app connection");
    }
    const registeredAt = Date.now();
    ws.serializeAttachment({
      kind: "app-client",
      connected: true,
      connectionId,
      session,
      appFrame,
      connectedAt: registeredAt,
    } satisfies AppSocketAttachment);
    this.appClients.set(key, {
      socket: ws,
      connectionId,
      session,
      appFrame,
      registeredAt,
    });
  }

  #restoreAppClients(): void {
    if (this.appClientsRestored) {
      return;
    }
    this.appClientsRestored = true;
    this.appClients.clear();
    const now = Date.now();
    const usedConnectionIds = new Set<string>();
    const candidates: RegisteredAppClient[] = [];
    for (const socket of this.ctx.getWebSockets(APP_SOCKET_TAG)) {
      const attachment = this.#getSocketAttachment(socket);
      if (!attachment?.connected || !attachment.session || !attachment.appFrame) {
        this.#closeSocket(socket, 1008, "Invalid app socket attachment");
        continue;
      }
      let connectionId = attachment.connectionId;
      if (!connectionId || usedConnectionIds.has(connectionId)) {
        connectionId = crypto.randomUUID();
      }
      usedConnectionIds.add(connectionId);
      const registeredAt = Number.isSafeInteger(attachment.connectedAt) && attachment.connectedAt! >= 0
        ? attachment.connectedAt!
        : now;
      if (connectionId !== attachment.connectionId || registeredAt !== attachment.connectedAt) {
        try {
          socket.serializeAttachment({
            ...attachment,
            connectionId,
            connectedAt: registeredAt,
          } satisfies AppSocketAttachment);
        } catch {
          this.#closeSocket(socket, 1008, "Invalid app socket attachment");
          continue;
        }
      }
      candidates.push({
        socket,
        connectionId,
        session: attachment.session,
        appFrame: attachment.appFrame,
        registeredAt,
      });
    }

    candidates.sort((left, right) =>
      right.registeredAt - left.registeredAt || left.connectionId.localeCompare(right.connectionId)
    );
    const restoredKeys = new Set<string>();
    for (const candidate of candidates) {
      const key = appClientKey(candidate.session);
      if (restoredKeys.has(key)) {
        this.#closeSocket(candidate.socket, 1000, "Replaced by newer app connection");
        continue;
      }
      const admission = this.appSocketAdmission.open(
        candidate.connectionId,
        this.#appSocketLifetime(candidate.session, candidate.appFrame),
        now,
      );
      if (!admission.admitted) {
        this.#closeSocketForAdmission(candidate.socket, admission.reason);
        continue;
      }
      restoredKeys.add(key);
      this.appClients.set(key, candidate);
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
        if (!this.#sendSocketFrame(registration.socket, {
          type: "sig",
          signal: event,
          payload,
        })) {
          continue;
        }
        delivered += 1;
      } catch {
        console.warn(JSON.stringify({ event: "app_event_delivery", outcome: "failed" }));
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
    const registered = this.#registrationForSocket(socket);
    if (registered) {
      if (this.#canDeliverToClient(registered)) {
        return registered;
      }
      this.#closeSocketForAdmission(socket, "expired");
      return null;
    }
    const attachment = this.#getSocketAttachment(socket);
    if (
      !attachment?.connected ||
      !attachment.connectionId ||
      !attachment.session ||
      !attachment.appFrame
    ) {
      return null;
    }
    const key = appClientKey(attachment.session);
    const existing = this.appClients.get(key);
    if (existing) {
      this.#closeSocket(socket, 1000, "Replaced by newer app connection");
      return null;
    }
    const restored: RegisteredAppClient = {
      socket,
      connectionId: attachment.connectionId,
      session: attachment.session,
      appFrame: attachment.appFrame,
      registeredAt: attachment.connectedAt ?? Date.now(),
    };
    const admission = this.appSocketAdmission.open(
      restored.connectionId,
      this.#appSocketLifetime(restored.session, restored.appFrame),
    );
    if (!admission.admitted) {
      this.#closeSocketForAdmission(socket, admission.reason);
      return null;
    }
    this.appClients.set(key, restored);
    return restored;
  }

  #appSessionForClientId(clientId: string, sessionId?: string | null): AppSessionInfo | undefined {
    for (const registration of [...this.appClients.values()]) {
      if (!this.#canDeliverToClient(registration)) {
        this.#closeSocketForAdmission(registration.socket, "expired");
        continue;
      }
      if (
        registration.session.clientId === clientId &&
        (!sessionId || registration.session.sessionId === sessionId)
      ) {
        return registration.session;
      }
    }
    return undefined;
  }

  #sendSocketFrame(socket: WebSocket, frame: AppSocketFrame): boolean {
    if (!this.#canDeliverToSocket(socket)) {
      return false;
    }
    socket.send(JSON.stringify(frame));
    return true;
  }

  #closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.appSocketBodies.close(socket, reason);
    this.#forgetAppSocket(socket);
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

  #forgetAppSocket(socket: WebSocket): void {
    const registration = this.#registrationForSocket(socket);
    const connectionId = registration?.connectionId ?? this.#getSocketAttachment(socket)?.connectionId;
    if (connectionId) {
      this.appSocketAdmission.close(connectionId);
    }
    this.#removeAppClientBySocket(socket);
  }

  #registrationForSocket(socket: WebSocket): RegisteredAppClient | undefined {
    for (const registration of this.appClients.values()) {
      if (registration.socket === socket) {
        return registration;
      }
    }
    return undefined;
  }

  #canDeliverToSocket(socket: WebSocket): boolean {
    return this.#clientForSocket(socket) !== null;
  }

  #canDeliverToClient(client: RegisteredAppClient, now = Date.now()): boolean {
    return this.appSocketAdmission.canDeliver(
      this.#appSocketLifetime(client.session, client.appFrame),
      now,
    );
  }

  #appSocketLifetime(session: AppSessionInfo, appFrame: AppFrameContext): AppSocketLifetime {
    return {
      sessionExpiresAt: session.expiresAt,
      appFrameExpiresAt: appFrame.expiresAt,
    };
  }

  #closeSocketForAdmission(
    socket: WebSocket,
    reason: Exclude<AppSocketAdmissionResult, { admitted: true }>["reason"],
  ): void {
    switch (reason) {
      case "expired":
        this.#closeSocket(socket, 1008, "App session expired");
        return;
      case "frame_too_large":
        this.#closeSocket(socket, 1009, "App socket frame too large");
        return;
      case "message_rate":
        this.#closeSocket(socket, 1008, "App socket message rate exceeded");
        return;
      case "connection_limit":
        this.#closeSocket(socket, 1008, "App socket connection limit exceeded");
    }
  }

  #getSocketAttachment(socket: WebSocket): AppSocketAttachment | null {
    try {
      const attachment = socket.deserializeAttachment();
      return this.#isAppSocketAttachment(attachment) ? attachment : null;
    } catch {
      return null;
    }
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
    return this.#isAppSessionInfo(record.session) &&
      this.#isAppFrameContext(record.appFrame) &&
      (record.connectionId === undefined || (
        typeof record.connectionId === "string" && record.connectionId.trim().length > 0
      )) &&
      (record.connectedAt === undefined || (
        Number.isSafeInteger(record.connectedAt) && (record.connectedAt as number) >= 0
      ));
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
      typeof session.sessionId === "string" && session.sessionId.trim().length > 0 &&
      typeof session.clientId === "string" && session.clientId.trim().length > 0 &&
      typeof session.rpcBase === "string" && session.rpcBase.trim().length > 0 &&
      Number.isSafeInteger(session.expiresAt) && (session.expiresAt as number) >= 0,
    );
  }

  #isAppFrameContext(value: unknown): value is AppFrameContext {
    const appFrame = this.#record(value);
    return Boolean(
      appFrame &&
      Number.isSafeInteger(appFrame.uid) && (appFrame.uid as number) >= 0 &&
      typeof appFrame.username === "string" && appFrame.username.trim().length > 0 &&
      typeof appFrame.packageId === "string" && appFrame.packageId.trim().length > 0 &&
      typeof appFrame.packageName === "string" && appFrame.packageName.trim().length > 0 &&
      typeof appFrame.entrypointName === "string" && appFrame.entrypointName.trim().length > 0 &&
      typeof appFrame.routeBase === "string" && appFrame.routeBase.trim().length > 0 &&
      Number.isSafeInteger(appFrame.issuedAt) && (appFrame.issuedAt as number) >= 0 &&
      Number.isSafeInteger(appFrame.expiresAt) &&
      (appFrame.expiresAt as number) >= (appFrame.issuedAt as number),
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
            runtimeEpoch: this.managedEpoch,
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
    return appRunnerWorkerCodeKey({ ...props, runtimeEpoch: this.managedEpoch });
  }

  async #runDueRpcSchedule(record: AppRpcScheduleRecord, runtimeEpoch: number): Promise<void> {
    if (!this.#isActiveEpoch(runtimeEpoch)) {
      return;
    }
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
      if (this.#isActiveEpoch(runtimeEpoch)) {
        console.warn(JSON.stringify({ event: "app_daemon_rpc", outcome: "failed" }));
      }
    }
    if (!this.#isActiveEpoch(runtimeEpoch)) {
      return;
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

  async #syncDaemonAlarm(runtimeEpoch: number = this.managedEpoch): Promise<void> {
    if (!this.#isActiveEpoch(runtimeEpoch)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const nextAlarmAt = this.daemonSchedules.nextAlarmAt();
    if (nextAlarmAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(nextAlarmAt);
    if (!this.#isActiveEpoch(runtimeEpoch)) {
      await this.ctx.storage.deleteAlarm();
    }
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

  async managedErase(): Promise<void> {
    if (!this.erased) this.#advanceManagedEpoch();
    const erasedEpoch = this.managedEpoch;
    const props = this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY);
    const logicalName = this.ctx.storage.kv.get<string>(MANAGED_LOGICAL_NAME_KEY)
      ?? (props ? buildAppRunnerName(props.appFrame.uid, props.packageId) : null);
    this.erased = true;
    this.#closeManagedSockets("Tenant runtime is being erased");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(MANAGED_ERASED_KEY, true);
    this.ctx.storage.kv.put(MANAGED_EPOCH_KEY, erasedEpoch);
    if (logicalName) this.ctx.storage.kv.put(MANAGED_LOGICAL_NAME_KEY, logicalName);
  }

  async managedPause(): Promise<void> {
    if (this.erased) {
      return;
    }
    if (!this.managedPaused) {
      this.#advanceManagedEpoch();
      this.managedPaused = true;
      this.ctx.storage.kv.put(MANAGED_PAUSED_KEY, true);
    }
    this.daemonSchedules.releaseRunning(Date.now());
    this.#closeManagedSockets("Tenant runtime is being updated");
    await this.ctx.storage.deleteAlarm();
  }

  async managedResume(): Promise<void> {
    if (this.erased || !this.managedPaused) {
      return;
    }
    this.#advanceManagedEpoch();
    this.managedPaused = false;
    this.ctx.storage.kv.delete(MANAGED_PAUSED_KEY);
  }

  managedDescriptor(): ManagedObjectDescriptor {
    if (this.erased) {
      return {
        schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
        kind: "app_runner",
        providerId: this.ctx.id.toString(),
        logicalName: this.ctx.storage.kv.get<string>(MANAGED_LOGICAL_NAME_KEY) ?? null,
        classification: "erased",
        lifecycle: { status: "erased", epoch: this.managedEpoch },
      };
    }
    const props = this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY);
    if (!props) {
      return {
        schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
        kind: "app_runner",
        providerId: this.ctx.id.toString(),
        logicalName: null,
        classification: "uninitialized",
        lifecycle: { status: "uninitialized", epoch: this.managedEpoch },
      };
    }
    return {
      schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
      kind: "app_runner",
      providerId: this.ctx.id.toString(),
      logicalName: buildAppRunnerName(props.appFrame.uid, props.packageId),
      classification: "initialized",
      lifecycle: {
        status: this.managedPaused ? "paused" : "active",
        epoch: this.managedEpoch,
      },
    };
  }

  managedSnapshot(input: ManagedObjectSnapshotRequest): ReadableStream<Uint8Array> {
    const request = validateManagedSnapshotRequest(input);
    this.assertManagedPortableIdentity(
      request.component,
      request.kind,
      request.logicalName,
      request.providerId,
      request.fenceEpoch,
    );
    const descriptor = this.managedDescriptor();
    if (
      descriptor.classification !== "initialized"
      || descriptor.logicalName !== request.logicalName
      || descriptor.lifecycle.status !== "paused"
    ) {
      throw new Error("Managed app runner is not a paused initialized snapshot source");
    }
    return snapshotManagedOwner(this.ctx.storage, {
      objectId: request.objectId,
      assertFenced: () => this.assertManagedPortableFence(request.fenceEpoch),
    });
  }

  async managedRestore(
    control: ManagedObjectRestoreControl,
    stream: ReadableStream<Uint8Array>,
  ): Promise<{
    status: "applied" | "replayed";
    providerId: string;
    frameCount: string;
    bodyBytes: string;
    semanticSha256: string;
  }> {
    try {
      control = validateManagedRestoreControl(control);
      this.assertManagedTargetIdentity(control);
      const restoreTarget = readManagedRestoreTarget(this.ctx.storage);
      if (!restoreTarget) {
        if (this.erased || this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY)) {
          throw new Error("Managed app runner restore target is not fresh");
        }
        if (!this.managedPaused) {
          if (control.fenceEpoch !== this.managedEpoch + 1) {
            throw new Error("Managed app runner restore fence epoch is invalid");
          }
          this.#advanceManagedEpoch();
          this.managedPaused = true;
          this.ctx.storage.kv.put(MANAGED_PAUSED_KEY, true);
        }
        this.ctx.storage.kv.put(MANAGED_LOGICAL_NAME_KEY, control.logicalName);
        this.#closeManagedSockets("Tenant runtime is being restored");
        await this.ctx.storage.deleteAlarm();
      }
      this.assertManagedPortableFence(control.fenceEpoch);
      await prepareManagedRestoreTarget(this.ctx.storage, control);
      const result = await restoreManagedOwner(
        this.ctx.storage,
        stream,
        control,
        () => this.assertManagedPortableFence(control.fenceEpoch),
      );
      const descriptor = this.managedDescriptor();
      if (
        descriptor.classification !== "initialized"
        || descriptor.logicalName !== control.logicalName
        || descriptor.providerId !== this.ctx.id.toString()
      ) {
        throw new Error("Restored app runner identity does not match its target");
      }
      return { ...result, providerId: descriptor.providerId };
    } catch (error) {
      if (!stream.locked) await stream.cancel(error).catch(() => {});
      throw error;
    }
  }

  private assertManagedTargetIdentity(control: ManagedObjectRestoreControl): void {
    if (
      control.component !== "gateway"
      || control.kind !== "app_runner"
      || this.env.APP_RUNNER.idFromName(control.logicalName).toString() !== this.ctx.id.toString()
    ) {
      throw new Error("Managed app runner restore identity is invalid");
    }
  }

  private assertManagedPortableIdentity(
    component: string,
    kind: string,
    logicalName: string,
    providerId: string,
    fenceEpoch: number,
  ): void {
    if (
      component !== "gateway"
      || kind !== "app_runner"
      || providerId !== this.ctx.id.toString()
      || this.env.APP_RUNNER.idFromName(logicalName).toString() !== providerId
    ) {
      throw new Error("Managed app runner portable identity is invalid");
    }
    this.assertManagedPortableFence(fenceEpoch);
  }

  private assertManagedPortableFence(fenceEpoch: number): void {
    if (this.erased || !this.managedPaused || this.managedEpoch !== fenceEpoch) {
      throw new Error("Managed app runner portable operation lost its exact pause fence");
    }
  }

  async managedActivate(): Promise<void> {
    this.#requireActive();
    await this.#syncDaemonAlarm();
  }

  #closeManagedSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets(APP_SOCKET_TAG)) {
      this.#closeSocket(socket, 1001, reason);
    }
    this.appClients.clear();
    this.appClientsRestored = true;
    this.appSocketBodies.closeAll(reason);
  }

  #isActiveEpoch(runtimeEpoch: number): boolean {
    return !this.erased && !this.managedPaused && runtimeEpoch === this.managedEpoch;
  }

  #advanceManagedEpoch(): void {
    this.managedEpoch += 1;
    this.ctx.storage.kv.put(MANAGED_EPOCH_KEY, this.managedEpoch);
  }

  async #runInActiveEpoch<T>(
    action: (runtimeEpoch: number) => Promise<T>,
    expectedEpoch?: number,
    discard?: (result: T) => Promise<unknown>,
  ): Promise<T> {
    this.#requireActive(expectedEpoch);
    const runtimeEpoch = this.managedEpoch;
    const result = await action(runtimeEpoch);
    if (!this.#isActiveEpoch(runtimeEpoch)) {
      await discard?.(result).catch(() => {});
      this.#requireActive(runtimeEpoch);
    }
    return result;
  }

  #requireActive(expectedEpoch?: number): void {
    if (this.erased) {
      throw new Error("AppRunner no longer exists");
    }
    if (this.managedPaused) {
      throw new Error("Tenant runtime is being updated");
    }
    if (expectedEpoch !== undefined && expectedEpoch !== this.managedEpoch) {
      throw new Error("Package runtime was superseded");
    }
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
