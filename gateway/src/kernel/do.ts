import {
  Connection,
  ConnectionContext,
  Agent as Host,
  type WSMessage,
} from "agents";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
} from "agents/mcp/do-oauth-client-provider";
import type { Frame, RequestFrame, ResponseFrame, SignalFrame } from "../protocol/frames";
import type {
  ConnectionIdentity,
  ProcessIdentity,
  SysTargetRegisterResult,
  SysSetupResult,
} from "@gsv/protocol/syscalls/system";
import type { ProcHilRequest } from "../syscalls/proc";
import type { SyscallName } from "../syscalls";
import type { PkgPublicListResult } from "@gsv/protocol/syscalls/packages";
import type {
  AdapterOutboundMessage,
} from "../adapter-interface";
import { AuthStore } from "./auth-store";
import { CapabilityStore, hasCapability } from "./capabilities";
import { ConfigStore } from "./config";
import { DeviceRegistry, type DeviceLifecycle, type DeviceRecord } from "./devices";
import { RoutingTable, type RouteOrigin } from "./routing";
import { ShellSessionStore, type ShellSessionStatus } from "./shell-sessions";
import { ProcessRegistry } from "./processes";
import { AdapterStore } from "./adapter-store";
import { RunRouteStore, type AdapterRunRoute, type RunRoute } from "./run-routes";
import { WorkspaceStore } from "./workspaces";
import { OAuthStore } from "./oauth-store";
import { McpServerStore } from "./mcp-store";
import { SignalWatchStore, type SignalWatchRecord } from "./signal-watches";
import { NotificationStore } from "./notifications";
import { IpcCallStore, type IpcCallRecord } from "./ipc-calls";
import {
  assertCanManageSchedule,
  computeNextRunAfterFinish,
  ScheduleStore,
  skippedScheduleResult,
} from "./scheduler";
import { AppSessionStore } from "./app-sessions";
import {
  ensureKernelBootstrapped,
  handleConnect,
  setupRequiredDetails,
  SETUP_REQUIRED_ERROR_CODE,
} from "./connect";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";
import { sendFrameToProcess } from "../shared/utils";
import { handleSysSetup as handleKernelSetup } from "./sys/setup";
import { buildAppRunnerName } from "../protocol/app-session";
import { handleSysSetupAssist } from "./sys/setup-assist";
import {
  completeOAuthCallback as completeOAuthCallbackFlow,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
} from "./sys/oauth";
import {
  canRediscoverMcpConnectionState,
  type McpAddConnectionInput,
  type McpAddConnectionResult,
} from "./sys/mcp";
import { oauthCallbackHtmlResponse } from "../oauth-http";
import { isInternalOnlySyscall } from "./syscall-exposure";
import {
  resolveAdapterServiceForKernel,
  setAdapterActivityForKernel,
} from "./adapter-handlers";
import {
  type InstalledPackageRecord,
  PackageStore,
  type PackageEntrypoint,
  packageRouteBase,
  type PackageArtifactMetadata,
  visiblePackageScopesForActor,
} from "./packages";
import {
  DEFAULT_APP_FRAME_TTL_MS,
  isAppFrameContextExpired,
  type AppFrameContext,
} from "../protocol/app-frame";
import type { AppClientSessionContext } from "../protocol/app-session";
import { listLocalPublicPackages } from "./pkg";
import { handleProcSpawn } from "./proc-handlers";
import type {
  ScheduleRecord,
  ScheduleRunResult,
  SchedulerRunArgs,
  SchedulerRunResult,
} from "../syscalls/scheduler";

const SERVER_VERSION = "0.1.6";
const APP_CLIENT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type ConnectionState = {
  step: "pending" | "connected";
  identity?: ConnectionIdentity;
  clientId?: string;
  providedTargets?: ProvidedTarget[];
};

type ProvidedTarget = {
  targetId: string;
};

type ProcSendData = {
  ok?: boolean;
  status?: string;
  runId?: string;
  queued?: boolean;
};

type ResolvePackageHttpInput = {
  packageName: string;
  username: string;
  token: string;
  clientId?: string;
};

type ResolvePackageHttpResult =
  | {
      ok: true;
      packageId: string;
      packageName: string;
      routeBase: string;
      artifact: PackageArtifactMetadata;
      appFrame: AppFrameContext;
      clientSession: AppClientSessionContext & { secret: string };
      auth: {
        uid: number;
        username: string;
        capabilities: string[];
      };
      hasRpc: boolean;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

type ResolvePackageAppRpcInput = {
  packageName: string;
  sessionId: string;
  secret: string;
};

type ResolvePackageAppRpcResult =
  | {
      ok: true;
      packageId: string;
      packageName: string;
      routeBase: string;
      artifact: PackageArtifactMetadata;
      appFrame: AppFrameContext;
      clientSession: AppClientSessionContext;
      auth: {
        uid: number;
        username: string;
        capabilities: string[];
      };
      hasRpc: boolean;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

type AuthorizeGitHttpInput = {
  owner: string;
  repo: string;
  write: boolean;
  username?: string;
  credential?: string;
};

type AuthorizeGitHttpResult =
  | {
      ok: true;
      username: string | null;
      uid: number;
      capabilities: string[];
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

export class Kernel extends Host<Env> {
  private readonly auth: AuthStore;
  private readonly caps: CapabilityStore;
  private readonly config: ConfigStore;
  private readonly devices: DeviceRegistry;
  private readonly routes: RoutingTable;
  private readonly shellSessions: ShellSessionStore;
  private readonly procs: ProcessRegistry;
  private readonly workspaces: WorkspaceStore;
  private readonly adapters: AdapterStore;
  private readonly runRoutes: RunRouteStore;
  private readonly signalWatches: SignalWatchStore;
  private readonly ipcCalls: IpcCallStore;
  private readonly notifications: NotificationStore;
  private readonly schedules: ScheduleStore;
  private readonly appSessions: AppSessionStore;
  private readonly packages: PackageStore;
  private readonly oauth: OAuthStore;
  private readonly mcpServers: McpServerStore;
  private readonly ready: Promise<void>;
  private readonly connections = new Map<string, Connection<ConnectionState>>();
  private readonly pendingAppResponses = new Map<string, (frame: ResponseFrame) => void>();
  private readonly pendingProcessSignals = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;

    this.auth = new AuthStore(sql);
    this.auth.init();

    this.caps = new CapabilityStore(sql);
    this.caps.init();
    this.caps.seed();

    this.config = new ConfigStore(sql);
    this.config.init();

    this.devices = new DeviceRegistry(sql);
    this.devices.init();

    this.routes = new RoutingTable(sql);
    this.routes.init();

    this.shellSessions = new ShellSessionStore(sql);
    this.shellSessions.init();

    this.procs = new ProcessRegistry(sql);
    this.procs.init();

    this.workspaces = new WorkspaceStore(sql);
    this.workspaces.init();

    this.adapters = new AdapterStore(sql);
    this.adapters.init();

    this.runRoutes = new RunRouteStore(sql);
    this.runRoutes.init();

    this.signalWatches = new SignalWatchStore(sql);
    this.signalWatches.init();

    this.ipcCalls = new IpcCallStore(sql);
    this.ipcCalls.init();

    this.notifications = new NotificationStore(sql);
    this.notifications.init();

    this.schedules = new ScheduleStore(sql);
    this.schedules.init();

    this.appSessions = new AppSessionStore(sql);
    this.appSessions.init();

    this.packages = new PackageStore(sql, env.STORAGE);
    this.packages.init();

    this.oauth = new OAuthStore(sql);
    this.oauth.init();

    this.mcpServers = new McpServerStore(sql);
    this.mcpServers.init();
    this.mcp.configureOAuthCallback({
      customHandler: (result) => oauthCallbackHtmlResponse(
        result.authSuccess
          ? {
            ok: true,
            account: {
              provider: "MCP server",
              label: result.serverId,
            },
          }
          : {
            ok: false,
            message: result.authError,
          },
      ),
    });

    this.ready = this.initialize();

    this.rehydrateConnections();
  }

  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    const provider = (
      new DurableObjectOAuthClientProvider(this.ctx.storage, this.name, callbackUrl)
    ) as AgentMcpOAuthProvider & { clientMetadataUrl?: string };
    const metadataUrl = `${new URL(callbackUrl).origin}/.well-known/oauth-client/gsv.json`;
    if (metadataUrl.startsWith("https://")) {
      provider.clientMetadataUrl = metadataUrl;
    }
    return provider;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/oauth/callback" || request.method !== "GET") {
      return new Response("Not Found", { status: 404 });
    }

    const result = await completeOAuthCallbackFlow({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
    }, this.oauth);
    return oauthCallbackHtmlResponse(result, result.ok ? 200 : result.status);
  }

  private async addMcpServerConnection(input: McpAddConnectionInput): Promise<McpAddConnectionResult> {
    const result = await this.addMcpServer(
      `u${input.uid}:${input.name}`,
      input.url,
      {
        callbackHost: input.callbackHost,
        callbackPath: "/oauth/callback",
        transport: {
          type: input.transport.type,
          ...(input.transport.headers ? { headers: input.transport.headers } : {}),
        },
      },
    );
    return {
      id: result.id,
      state: result.state,
      ...("authUrl" in result ? { authUrl: result.authUrl } : {}),
    };
  }

  private async removeMcpServerConnection(serverId: string): Promise<void> {
    await this.removeMcpServer(serverId);
  }

  private async refreshMcpServerConnection(serverId: string): Promise<void> {
    const connection = this.mcp.mcpConnections[serverId] as {
      connectionState?: unknown;
    } | undefined;
    if (canRediscoverMcpConnectionState(connection?.connectionState)) {
      await this.mcp.discoverIfConnected(serverId);
      return;
    }

    const result = await this.mcp.connectToServer(serverId);
    if (result.state === "connected") {
      await this.mcp.discoverIfConnected(serverId);
    }
  }

  private async callMcpTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.mcp.callTool({
      serverId,
      name: toolName,
      arguments: args,
    });
  }

  private async initialize(): Promise<void> {
    await this.packages.migrateArtifacts();
  }

  shouldSendProtocolMessages(_: Connection, __: ConnectionContext): boolean {
    return false;
  }

  onConnect(connection: Connection): void {
    const state: ConnectionState = { step: "pending" };
    connection.setState(state);
  }

  onClose(connection: Connection): void {
    const state = connection.state as ConnectionState | undefined;
    if (!state) return;

    this.connections.delete(connection.id);

    const identity = state.identity;

    if (identity?.role === "driver") {
      this.devices.setOnline(identity.device, false);
      this.broadcastDeviceStatus(identity.device, "disconnected");
      this.failRoutesForDevice(identity.device);
    }

    for (const target of state.providedTargets ?? []) {
      this.removeProvidedTarget(target.targetId);
    }

    this.failRoutesForConnection(connection.id);
    this.runRoutes.clearForConnection(connection.id);
  }

  async onMessage(connection: Connection<ConnectionState>, message: WSMessage): Promise<void> {
    await this.ready;
    if (typeof message !== "string") {
      // TODO: binary stream frames
      return;
    }

    let frame: Frame;
    try {
      frame = JSON.parse(message);
    } catch {
      this.sendError(connection, "?", 400, "Malformed JSON");
      return;
    }

    if (!frame.type || !["req", "res", "sig"].includes(frame.type)) {
      this.sendError(connection, "?", 400, "Invalid frame type");
      return;
    }

    switch (frame.type) {
      case "req":
        await this.handleReq(connection, frame);
        break;
      case "res":
        this.handleRes(connection, frame);
        break;
      case "sig":
        this.handleSig(connection, frame);
        break;
    }
  }

  /**
   * RPC method — called by Process DOs to send/receive frames.
   *
   * Returns a Frame if the request was handled synchronously (native syscall),
   * or null if deferred (forwarded to a device — result will arrive later
   * via process.recvFrame callback).
   */
  async recvFrame(processId: string, frame: Frame): Promise<Frame | null> {
    await this.ready;
    if (frame.type === "req") {
      return this.handleProcessReq(processId, frame);
    }

    if (frame.type === "res") {
      // Process responding to a kernel-initiated request (future use)
      return null;
    }

    if (frame.type === "sig") {
      await this.completeIpcCallsForProcessSignal(processId, frame);
      this.enqueueProcessSignal(processId, frame);
      return null;
    }

    return null;
  }

  /**
   * Service-binding RPC entrypoint.
   * Accepts the same frame format as WS connections/process RPC.
   */
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    await this.ready;
    if (frame.type !== "req") {
      return null;
    }

    return this.handleServiceReq(frame);
  }

  async appRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame> {
    await this.ready;
    if (isAppFrameContextExpired(appFrame)) {
      return errFrame(frame.id, 401, "App frame expired");
    }

    if (isInternalOnlySyscall(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const record = this.packages.resolve(
      appFrame.packageId,
      visiblePackageScopesForActor({ uid: appFrame.uid }),
    );
    if (!record || !record.enabled || record.manifest.name !== appFrame.packageName) {
      return errFrame(frame.id, 404, "Package app not found");
    }

    const entrypoint = findAppFrameEntrypoint(record.manifest.entrypoints, appFrame.entrypointName, appFrame.routeBase);
    if (!entrypoint) {
      return errFrame(frame.id, 404, "Package app entrypoint not found");
    }

    if (!entrypoint.syscalls?.includes(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const identity = this.buildAppBindingIdentity(appFrame, entrypoint.syscalls ?? []);
    if (!identity) {
      return errFrame(frame.id, 401, "Authentication failed");
    }

    if (!hasCapability(identity.capabilities, frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx = this.buildServiceContext(identity, appFrame);
    const origin: RouteOrigin = { type: "app", id: frame.id };
    const pending = this.createPendingAppResponse(frame.id);
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (!result.handled) {
      return await pending.promise;
    }

    pending.cleanup();
    this.applyPostDispatchEffects(frame, result.response);
    return result.response;
  }

  async resolvePackageHttpRoute(input: ResolvePackageHttpInput): Promise<ResolvePackageHttpResult> {
    await this.ready;
    const packageName = input.packageName.trim();
    const username = input.username.trim();
    const token = input.token.trim();

    if (!packageName) {
      return { ok: false, status: 400, message: "Package name is required" };
    }
    if (!username || !token) {
      return { ok: false, status: 401, message: "Authentication required" };
    }

    const auth = await this.auth.authenticateToken(username, token, { role: "user" });
    if (!auth.ok) {
      return { ok: false, status: 401, message: "Authentication failed" };
    }

    const routeBase = packageRouteBase(packageName);
    let record: InstalledPackageRecord | null = null;
    let entrypoint: PackageEntrypoint | null = null;

    for (const candidate of this.packages.list({
      enabled: true,
      name: packageName,
      runtime: "web-ui",
      scopes: visiblePackageScopesForActor({ uid: auth.identity.uid }),
    })) {
      const matched = candidate.manifest.entrypoints.find((candidateEntrypoint) => {
        return candidateEntrypoint.kind === "ui" && candidateEntrypoint.route === routeBase;
      });
      if (matched) {
        record = candidate;
        entrypoint = matched;
        break;
      }
    }

    if (!record || !entrypoint) {
      return { ok: false, status: 404, message: "Package app not found" };
    }

    const now = Date.now();
    const clientSession = await this.appSessions.issue({
      uid: auth.identity.uid,
      username: auth.identity.username,
      packageId: record.packageId,
      packageName: record.manifest.name,
      entrypointName: entrypoint.name,
      routeBase,
      clientId: input.clientId?.trim() || crypto.randomUUID(),
      ttlMs: APP_CLIENT_SESSION_TTL_MS,
    });

    return {
      ok: true,
      packageId: record.packageId,
      packageName: record.manifest.name,
      routeBase,
      artifact: record.artifact,
      appFrame: {
        uid: auth.identity.uid,
        username: auth.identity.username,
        packageId: record.packageId,
        packageName: record.manifest.name,
        entrypointName: entrypoint.name,
        routeBase,
        issuedAt: now,
        expiresAt: now + DEFAULT_APP_FRAME_TTL_MS,
      },
      clientSession,
      auth: {
        uid: auth.identity.uid,
        username: auth.identity.username,
        capabilities: this.caps.resolve(auth.identity.gids),
      },
      hasRpc: record.manifest.entrypoints.some((candidateEntrypoint) => candidateEntrypoint.kind === "rpc"),
    };
  }

  async resolvePackageAppRpcSession(input: ResolvePackageAppRpcInput): Promise<ResolvePackageAppRpcResult> {
    await this.ready;
    const packageName = input.packageName.trim();
    const sessionId = input.sessionId.trim();
    const secret = input.secret.trim();

    if (!packageName || !sessionId || !secret) {
      return { ok: false, status: 401, message: "Authentication required" };
    }

    const clientSession = await this.appSessions.resolve(sessionId, secret);
    if (!clientSession) {
      return { ok: false, status: 401, message: "Authentication failed" };
    }
    if (clientSession.packageName !== packageName) {
      return { ok: false, status: 404, message: "Package app session not found" };
    }

    const authUser = this.auth.getPasswdByUid(clientSession.uid);
    if (!authUser || authUser.username !== clientSession.username) {
      return { ok: false, status: 401, message: "Authentication failed" };
    }

    const capabilities = this.caps.resolve(this.auth.resolveGids(authUser.username, authUser.gid));
    const record = this.packages.resolve(
      clientSession.packageId,
      visiblePackageScopesForActor({ uid: clientSession.uid }),
    );
    if (!record || !record.enabled || record.manifest.name !== clientSession.packageName) {
      return { ok: false, status: 404, message: "Package app not found" };
    }

    return {
      ok: true,
      packageId: record.packageId,
      packageName: record.manifest.name,
      routeBase: clientSession.routeBase,
      artifact: record.artifact,
      appFrame: {
        uid: clientSession.uid,
        username: clientSession.username,
        packageId: record.packageId,
        packageName: record.manifest.name,
        entrypointName: clientSession.entrypointName,
        routeBase: clientSession.routeBase,
        issuedAt: clientSession.createdAt,
        expiresAt: clientSession.expiresAt,
      },
      clientSession,
      auth: {
        uid: clientSession.uid,
        username: clientSession.username,
        capabilities,
      },
      hasRpc: record.manifest.entrypoints.some((candidateEntrypoint) => candidateEntrypoint.kind === "rpc"),
    };
  }

  async authorizeGitHttp(input: AuthorizeGitHttpInput): Promise<AuthorizeGitHttpResult> {
    await this.ready;
    const owner = input.owner.trim();
    const repo = input.repo.trim();
    const username = input.username?.trim() ?? "";
    const credential = input.credential?.trim() ?? "";
    const isPublicRead = !input.write && this.config.get(`config/pkg/public-repos/${owner}/${repo}`) === "true";

    if (!owner || !repo) {
      return { ok: false, status: 401, message: "Authentication required" };
    }

    if (!input.write && (!username || !credential) && isPublicRead) {
      return {
        ok: true,
        username: null,
        uid: -1,
        capabilities: [],
      };
    }

    if (!username || !credential) {
      return { ok: false, status: 401, message: "Authentication required" };
    }

    const passwordAuth = await this.auth.authenticate(username, credential);
    const auth = passwordAuth.ok
      ? passwordAuth
      : await this.auth.authenticateToken(username, credential, { role: "user" });

    if (!auth.ok) {
      if (isPublicRead) {
        return {
          ok: true,
          username: null,
          uid: -1,
          capabilities: [],
        };
      }
      return { ok: false, status: 401, message: "Authentication failed" };
    }

    const capabilities = this.caps.resolve(auth.identity.gids);
    if (input.write) {
      if (owner === "system") {
        if (auth.identity.uid !== 0 && !hasCapability(capabilities, "*")) {
          return { ok: false, status: 403, message: "Only root may push system repositories" };
        }
      } else if (auth.identity.username !== owner && auth.identity.uid !== 0 && !hasCapability(capabilities, "*")) {
        return { ok: false, status: 403, message: "Forbidden" };
      }
    }

    return {
      ok: true,
      username: auth.identity.username,
      uid: auth.identity.uid,
      capabilities,
    };
  }

  async listPublicPackages(): Promise<PkgPublicListResult> {
    await this.ready;
    const serverName = this.config.get("config/server/name")?.trim() || "gsv";
    return {
      serverName,
      source: { kind: "local", name: serverName },
      packages: listLocalPublicPackages(this.config, this.packages),
    };
  }

  async completeOAuthCallback(input: OAuthCallbackInput): Promise<OAuthCallbackResult> {
    await this.ready;
    return completeOAuthCallbackFlow(input, this.oauth);
  }

  /**
   * Relay process signals using deterministic run route lookups.
   */
  private async handleProcessSignal(processId: string, frame: SignalFrame): Promise<void> {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      console.warn(`[Kernel] Signal from unknown process ${processId}`);
      return;
    }

    const runId = this.extractRunId(frame.payload);

    await this.dispatchSignalWatches(identity.uid, processId, frame);
    await this.completeIpcCallsFromSignal(identity.uid, processId, frame, runId);

    if (!frame.signal.startsWith("chat.")) return;

    if (!runId) {
      this.broadcastToUid(identity.uid, frame.signal, frame.payload);
      return;
    }

    const route = this.runRoutes.get(runId);
    if (!route) {
      this.broadcastToUid(identity.uid, frame.signal, frame.payload);
      return;
    }

    if (route.uid !== identity.uid) {
      this.runRoutes.delete(runId);
      return;
    }

    if (route.kind === "connection") {
      this.deliverSignalToConnection(route, frame, identity.uid);
      if (frame.signal === "chat.complete") {
        this.runRoutes.delete(runId);
      }
      return;
    }

    await this.deliverSignalToAdapter(route, frame);
    if (frame.signal === "chat.complete") {
      this.runRoutes.delete(runId);
    }
  }

  private enqueueProcessSignal(processId: string, frame: SignalFrame): void {
    const previous = this.pendingProcessSignals.get(processId) ?? Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(() => this.handleProcessSignal(processId, frame))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Kernel] process signal dispatch failed for ${processId}/${frame.signal}: ${message}`);
      })
      .finally(() => {
        if (this.pendingProcessSignals.get(processId) === queued) {
          this.pendingProcessSignals.delete(processId);
        }
      });
    this.pendingProcessSignals.set(processId, queued);
  }

  private async completeIpcCallsForProcessSignal(processId: string, frame: SignalFrame): Promise<void> {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      return;
    }
    const runId = this.extractRunId(frame.payload);
    await this.completeIpcCallsFromSignal(identity.uid, processId, frame, runId);
  }

  private async completeIpcCallsFromSignal(
    uid: number,
    processId: string,
    frame: SignalFrame,
    runId: string | null,
  ): Promise<void> {
    if (frame.signal !== "chat.complete" || !runId) {
      return;
    }

    const payload = frame.payload && typeof frame.payload === "object"
      ? frame.payload as Record<string, unknown>
      : {};
    const response = {
      text: typeof payload.text === "string" ? payload.text : null,
      usage: payload.usage ?? null,
    };
    const error = typeof payload.error === "string" ? payload.error : null;
    const completed = this.ipcCalls.completeByRun({
      uid,
      targetPid: processId,
      runId,
      response,
      error,
    });

    for (const call of completed) {
      await this.deliverIpcCallSignal("ipc.reply", call, {
        response,
        error,
      });
    }
  }

  private async deliverIpcCallSignal(
    signal: "ipc.reply" | "ipc.timeout",
    call: IpcCallRecord,
    extra?: { response?: unknown; error?: string | null },
  ): Promise<void> {
    await sendFrameToProcess(call.sourcePid, {
      type: "sig",
      signal,
      payload: {
        callId: call.callId,
        sourcePid: call.sourcePid,
        targetPid: call.targetPid,
        ...(call.targetRunId ? { runId: call.targetRunId } : {}),
        deadlineAt: call.deadlineAt,
        status: call.status,
        ...(extra?.response !== undefined ? { response: extra.response } : {}),
        ...(extra?.error ? { error: extra.error } : {}),
      },
    });
  }

  private deliverSignalToConnection(
    route: Extract<RunRoute, { kind: "connection" }>,
    frame: SignalFrame,
    uid: number,
  ): void {
    const conn = this.connections.get(route.connectionId);
    if (!conn) {
      this.broadcastToUid(uid, frame.signal, frame.payload);
      return;
    }

    conn.send(JSON.stringify(frame));
  }

  private async deliverSignalToAdapter(route: AdapterRunRoute, frame: SignalFrame): Promise<void> {
    if (frame.signal === "chat.hil") {
      const request = this.toProcHilRequest(frame.payload);
      if (!request) {
        return;
      }

      const surface = {
        kind: route.surfaceKind,
        id: route.surfaceId,
        threadId: route.threadId,
      } as const;

      await this.sendAdapterMessage(route.adapter, route.accountId, {
        surface,
        text: this.renderAdapterHilPrompt(request, route.surfaceKind),
      });
      await setAdapterActivityForKernel(
        this.env,
        route.adapter,
        route.accountId,
        surface,
        { kind: "typing", active: false },
      );
      return;
    }

    if (frame.signal !== "chat.complete") {
      return;
    }

    const payload =
      frame.payload && typeof frame.payload === "object"
        ? (frame.payload as Record<string, unknown>)
        : {};

    const text =
      typeof payload.error === "string" && payload.error.trim().length > 0
        ? `Error: ${payload.error}`
        : typeof payload.text === "string"
          ? payload.text
          : "";

    const surface = {
      kind: route.surfaceKind,
      id: route.surfaceId,
      threadId: route.threadId,
    } as const;

    if (text.trim()) {
      await this.sendAdapterMessage(route.adapter, route.accountId, {
        surface,
        text,
      });
    }

    await setAdapterActivityForKernel(
      this.env,
      route.adapter,
      route.accountId,
      surface,
      { kind: "typing", active: false },
    );
  }

  private async sendAdapterMessage(
    adapter: string,
    accountId: string,
    message: AdapterOutboundMessage,
  ): Promise<void> {
    const service = resolveAdapterServiceForKernel(this.env, adapter);
    if (!service || typeof service.adapterSend !== "function") {
      console.warn(`[Kernel] Adapter service unavailable for ${adapter}`);
      return;
    }

    try {
      const result = await service.adapterSend(accountId, message);
      if (!result.ok) {
        console.warn(`[Kernel] Adapter send failed (${adapter}/${accountId}): ${result.error}`);
      }
    } catch (err) {
      console.warn(`[Kernel] Adapter send threw (${adapter}/${accountId}):`, err);
    }
  }

  private toProcHilRequest(value: unknown): ProcHilRequest | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.requestId !== "string"
      || typeof record.runId !== "string"
      || typeof record.callId !== "string"
      || typeof record.toolName !== "string"
      || typeof record.syscall !== "string"
      || !record.args
      || typeof record.args !== "object"
    ) {
      return null;
    }
    return {
      requestId: record.requestId,
      runId: record.runId,
      callId: record.callId,
      toolName: record.toolName,
      syscall: record.syscall,
      args: record.args as Record<string, unknown>,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    };
  }

  private renderAdapterHilPrompt(
    request: ProcHilRequest,
    surfaceKind: AdapterRunRoute["surfaceKind"],
  ): string {
    const summary = this.summarizeHilRequest(request);
    const actionLine = surfaceKind === "dm"
      ? 'Reply "approve" to continue or "deny" to stop this action.'
      : "Open Chat to approve or deny this action.";
    return [
      "I need your confirmation before I can continue.",
      "",
      summary,
      "",
      actionLine,
    ].join("\n");
  }

  private summarizeHilRequest(request: ProcHilRequest): string {
    const args = request.args;
    const path = typeof args.path === "string" ? args.path : "";
    const command = typeof args.input === "string" ? args.input : "";

    if (request.syscall === "shell.exec") {
      return command
        ? `Requested action: run \`${command}\`.`
        : "Requested action: run a shell command.";
    }
    if (request.syscall === "fs.read") {
      return path
        ? `Requested action: read \`${path}\`.`
        : "Requested action: read a file.";
    }
    if (request.syscall === "fs.write") {
      return path
        ? `Requested action: write \`${path}\`.`
        : "Requested action: write a file.";
    }
    if (request.syscall === "fs.edit") {
      return path
        ? `Requested action: edit \`${path}\`.`
        : "Requested action: edit a file.";
    }
    if (request.syscall === "fs.delete") {
      return path
        ? `Requested action: delete \`${path}\`.`
        : "Requested action: delete a file.";
    }
    return `Requested action: ${request.toolName}.`;
  }

  private async handleProcessReq(processId: string, frame: RequestFrame): Promise<ResponseFrame | null> {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      return errFrame(frame.id, 404, "Unknown process");
    }

    const connIdentity: ConnectionIdentity = {
      role: "user",
      process: identity,
      capabilities: this.caps.resolve(identity.gids),
    };

    if (
      !isInternalOnlySyscall(frame.call) &&
      !hasCapability(connIdentity.capabilities, frame.call)
    ) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx: KernelContext = {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      workspaces: this.workspaces,
      packages: this.packages,
      oauth: this.oauth,
      mcp: this.mcp,
      mcpServers: this.mcpServers,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      shellSessions: this.shellSessions,
      signalWatches: this.signalWatches,
      ipcCalls: this.ipcCalls,
      notifications: this.notifications,
      schedules: this.schedules,
      connection: null as unknown as Connection,
      identity: connIdentity,
      processId,
      appFrame: undefined,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
      scheduleIpcCallTimeout: this.scheduleIpcCallTimeout.bind(this),
      scheduleScheduleWake: this.scheduleScheduleWake.bind(this),
      cancelScheduleWake: this.cancelScheduleWake.bind(this),
      runSchedules: this.runSchedules.bind(this),
      addMcpServerConnection: this.addMcpServerConnection.bind(this),
      removeMcpServerConnection: this.removeMcpServerConnection.bind(this),
      refreshMcpServerConnection: this.refreshMcpServerConnection.bind(this),
      callMcpTool: this.callMcpTool.bind(this),
    };

    const origin: RouteOrigin = { type: "process", id: processId };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (result.handled) {
      this.applyPostDispatchEffects(frame, result.response);
      return result.response;
    }

    return null;
  }

  private async handleServiceReq(frame: RequestFrame): Promise<ResponseFrame> {
    if (frame.call === "sys.connect" || frame.call === "sys.setup" || frame.call === "sys.setup.assist") {
      return errFrame(frame.id, 400, `${frame.call} is not supported via serviceFrame`);
    }

    if (isInternalOnlySyscall(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const identity = this.buildServiceBindingIdentity(frame);
    if (!hasCapability(identity.capabilities, frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx = this.buildServiceContext(identity);
    const origin: RouteOrigin = { type: "process", id: "__service_binding__" };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (!result.handled) {
      return errFrame(frame.id, 501, `${frame.call} requires unsupported async routing`);
    }

    this.applyPostDispatchEffects(frame, result.response);
    return result.response;
  }

  private buildContext(connection: Connection<ConnectionState>): KernelContext {
    const state = connection.state;
    if (!state) throw new Error("Connection state is missing");
    return {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      workspaces: this.workspaces,
      packages: this.packages,
      oauth: this.oauth,
      mcp: this.mcp,
      mcpServers: this.mcpServers,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      shellSessions: this.shellSessions,
      signalWatches: this.signalWatches,
      ipcCalls: this.ipcCalls,
      notifications: this.notifications,
      schedules: this.schedules,
      connection,
      identity: state.identity as ConnectionIdentity,
      processId: undefined,
      appFrame: undefined,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
      scheduleIpcCallTimeout: this.scheduleIpcCallTimeout.bind(this),
      scheduleScheduleWake: this.scheduleScheduleWake.bind(this),
      cancelScheduleWake: this.cancelScheduleWake.bind(this),
      runSchedules: this.runSchedules.bind(this),
      addMcpServerConnection: this.addMcpServerConnection.bind(this),
      removeMcpServerConnection: this.removeMcpServerConnection.bind(this),
      refreshMcpServerConnection: this.refreshMcpServerConnection.bind(this),
      callMcpTool: this.callMcpTool.bind(this),
    };
  }

  private buildServiceContext(identity: ConnectionIdentity, appFrame?: AppFrameContext): KernelContext {
    return {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      workspaces: this.workspaces,
      packages: this.packages,
      oauth: this.oauth,
      mcp: this.mcp,
      mcpServers: this.mcpServers,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      shellSessions: this.shellSessions,
      signalWatches: this.signalWatches,
      ipcCalls: this.ipcCalls,
      notifications: this.notifications,
      schedules: this.schedules,
      connection: null as unknown as Connection,
      identity,
      processId: undefined,
      appFrame,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
      scheduleIpcCallTimeout: this.scheduleIpcCallTimeout.bind(this),
      scheduleScheduleWake: this.scheduleScheduleWake.bind(this),
      cancelScheduleWake: this.cancelScheduleWake.bind(this),
      runSchedules: this.runSchedules.bind(this),
      addMcpServerConnection: this.addMcpServerConnection.bind(this),
      removeMcpServerConnection: this.removeMcpServerConnection.bind(this),
      refreshMcpServerConnection: this.refreshMcpServerConnection.bind(this),
      callMcpTool: this.callMcpTool.bind(this),
    };
  }

  private getAppRunner(uid: number, packageId: string): unknown {
    return this.ctx.exports.AppRunner.getByName(buildAppRunnerName(uid, packageId));
  }

  private buildDispatchDeps(): DispatchDeps {
    return {
      routingTable: this.routes,
      shellSessions: this.shellSessions,
      connections: this.connections,
      scheduleExpiry: (id: string, ttlMs: number) => {
        this.scheduleRouteExpiry(id, ttlMs);
      },
      requestDevice: this.requestDevice.bind(this),
    };
  }

  private scheduleRouteExpiry(routeId: string, ttlMs: number): void {
    this.schedule(
      ttlMs / 1000,
      "onRouteExpired",
      routeId,
    )
      .then((sched) => {
        const attached = this.routes.setScheduleId(routeId, sched.id);
        if (!attached) {
          this.cancelSchedule(sched.id).catch(() => {});
        }
      })
      .catch((error) => {
        console.warn(
          `[Kernel] Failed to schedule route expiry for ${routeId}:`,
          error,
        );
      });
  }

  private async requestDevice(
    deviceId: string,
    call: string,
    args: unknown,
    ttlMs = 60_000,
  ): Promise<unknown> {
    const device = this.devices.get(deviceId);
    if (!device || !device.online) {
      throw new Error(`Device offline: ${deviceId}`);
    }
    if (!this.devices.canHandle(deviceId, call)) {
      throw new Error(`Device ${deviceId} does not implement ${call}`);
    }

    const deviceConn = this.findDeviceConnection(deviceId);
    if (!deviceConn) {
      throw new Error(`No active connection for device: ${deviceId}`);
    }

    const id = crypto.randomUUID();
    const pending = this.createPendingAppResponse(id);

    this.routes.register(
      id,
      call as SyscallName,
      { type: "app", id },
      deviceId,
      { ttlMs },
    );

    try {
      try {
        deviceConn.send(JSON.stringify({
          type: "req",
          id,
          call,
          args,
        }));
      } catch (error) {
        this.routes.expire(id);
        throw error;
      }
      this.scheduleRouteExpiry(id, ttlMs);
      const frame = await pending.promise;
      if (!frame.ok) {
        throw new Error(frame.error.message);
      }
      return frame.data ?? {};
    } finally {
      pending.cleanup();
    }
  }

  private findDeviceConnection(deviceId: string): Connection<ConnectionState> | null {
    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (state?.identity?.role === "driver" && state.identity.device === deviceId) {
        return conn;
      }
      if (state?.providedTargets?.some((target) => target.targetId === deviceId)) {
        return conn;
      }
    }
    return null;
  }

  private async scheduleIpcCallTimeout(callId: string, delayMs: number): Promise<string> {
    const sched = await this.schedule(
      Math.max(1, delayMs / 1000),
      "onIpcCallTimeout",
      callId,
    );
    return sched.id;
  }

  private async scheduleScheduleWake(scheduleId: string, dueAtMs: number): Promise<string> {
    const wakeAt = new Date(ceilToSecondMs(Math.max(Date.now() + 1_000, dueAtMs)));
    const sched = await this.schedule(
      wakeAt,
      "onScheduleDue",
      scheduleId,
    );
    return sched.id;
  }

  private async cancelScheduleWake(wakeScheduleId: string): Promise<void> {
    await this.cancelSchedule(wakeScheduleId);
  }

  private async handleReq(connection: Connection<ConnectionState>, frame: RequestFrame): Promise<void> {
    const state = connection.state as ConnectionState | undefined;

    if (frame.call === "sys.connect") {
      if (state?.step === "connected") {
        this.sendError(connection, frame.id, 409, "Already connected");
        return;
      }
      await this.handleSysConnect(connection, frame);
      return;
    }

    if (frame.call === "sys.setup.assist") {
      await this.handleSysSetupAssist(connection, frame as RequestFrame<"sys.setup.assist">);
      return;
    }

    if (frame.call === "sys.setup") {
      await this.handleSysSetup(connection, frame as RequestFrame<"sys.setup">);
      return;
    }

    if (!state || state.step !== "connected" || !state.identity) {
      if (this.auth.isSetupMode()) {
        this.sendError(
          connection,
          frame.id,
          SETUP_REQUIRED_ERROR_CODE,
          "Setup required",
          setupRequiredDetails(),
        );
        return;
      }
      this.sendError(connection, frame.id, 403, "Must call sys.connect first");
      return;
    }

    if (isInternalOnlySyscall(frame.call)) {
      this.sendError(connection, frame.id, 403, `Permission denied: ${frame.call}`);
      return;
    }

    if (!hasCapability(state.identity.capabilities, frame.call)) {
      this.sendError(connection, frame.id, 403, `Permission denied: ${frame.call}`);
      return;
    }

    if (frame.call === "sys.target.register") {
      await this.handleSysTargetRegister(connection, frame as RequestFrame<"sys.target.register">);
      return;
    }

    const ctx = this.buildContext(connection);
    const origin: RouteOrigin = { type: "connection", id: connection.id };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (result.handled) {
      this.captureConnectionRunRoute(connection.id, state.identity, frame, result.response);
      this.applyPostDispatchEffects(frame, result.response);
      connection.send(JSON.stringify(result.response));
    }
    // If not handled, request was forwarded to a device.
    // Response will come back via handleRes when the device responds.
  }

  private captureConnectionRunRoute(
    connectionId: string,
    identity: ConnectionIdentity,
    frame: RequestFrame,
    response: ResponseFrame,
  ): void {
    if (identity.role !== "user") return;
    if (frame.call !== "proc.send") return;
    if (!response.ok) return;

    const data = (response as { data?: ProcSendData }).data;
    const runId = typeof data?.runId === "string" ? data.runId : null;
    if (!runId) return;

    this.runRoutes.setConnectionRoute(runId, identity.process.uid, connectionId);
  }

  private buildServiceBindingIdentity(frame: RequestFrame): ConnectionIdentity {
    const args = frame.args as Record<string, unknown>;
    const adapterHint =
      typeof args.adapter === "string" && args.adapter.trim().length > 0
        ? args.adapter.trim().toLowerCase()
        : "service-binding";

    const root = this.auth.getPasswdByUid(0);
    const process: ProcessIdentity = root
      ? {
          uid: root.uid,
          gid: root.gid,
          gids: this.auth.resolveGids(root.username, root.gid),
          username: root.username,
          home: root.home,
          cwd: root.home,
          workspaceId: null,
        }
      : {
          uid: 0,
          gid: 0,
          gids: [0],
          username: "root",
          home: "/root",
          cwd: "/root",
          workspaceId: null,
        };

    return {
      role: "service",
      process,
      capabilities: this.caps.resolve([102]),
      channel: adapterHint,
    };
  }

  private buildAppBindingIdentity(
    appFrame: AppFrameContext,
    appSyscalls: string[] = [],
  ): ConnectionIdentity | null {
    const user = this.auth.getPasswdByUid(appFrame.uid);
    if (!user || user.username !== appFrame.username) {
      return null;
    }

    const gids = this.auth.resolveGids(user.username, user.gid);
    const capabilities = Array.from(
      new Set([
        ...this.caps.resolve(gids),
        ...appSyscalls,
      ]),
    );
    return {
      role: "user",
      process: {
        uid: user.uid,
        gid: user.gid,
        gids,
        username: user.username,
        home: user.home,
        cwd: user.home,
        workspaceId: null,
      },
      capabilities,
    };
  }

  private applyPostDispatchEffects(frame: RequestFrame, response: ResponseFrame): void {
    if (!response.ok) return;

    if (
      frame.call === "pkg.add" ||
      frame.call === "pkg.create" ||
      frame.call === "pkg.sync" ||
      frame.call === "pkg.install" ||
      frame.call === "pkg.remove" ||
      frame.call === "pkg.checkout" ||
      frame.call === "sys.bootstrap"
    ) {
      const args = frame.args as {
        packageId?: unknown;
        ref?: unknown;
        name?: unknown;
      };
      const data = (response as {
        data?: {
          changed?: unknown;
          repo?: unknown;
          package?: {
            enabled?: unknown;
            name?: unknown;
            source?: {
              ref?: unknown;
            };
          };
          packages?: Array<{
            name?: unknown;
            source?: {
              ref?: unknown;
            };
          }>;
        };
      }).data;

      this.broadcastToRole("user", "pkg.changed", {
        action: frame.call === "pkg.install"
          ? "install"
          : frame.call === "pkg.create"
          ? "install"
          : frame.call === "pkg.add"
          ? "install"
          : frame.call === "pkg.remove"
            ? "remove"
            : frame.call === "pkg.checkout"
              ? "checkout"
              : frame.call === "sys.bootstrap"
                ? "sync"
              : "sync",
        packageId: typeof args.packageId === "string" ? args.packageId : null,
        ref: typeof data?.package?.source?.ref === "string"
          ? data.package.source.ref
          : typeof data?.packages?.[0]?.source?.ref === "string"
            ? data.packages[0].source.ref
            : typeof args.ref === "string"
              ? args.ref
              : null,
        changed: frame.call === "pkg.sync" || frame.call === "sys.bootstrap" ? true : data?.changed === true,
        enabled: typeof data?.package?.enabled === "boolean" ? data.package.enabled : null,
        name: typeof data?.package?.name === "string"
          ? data.package.name
          : typeof data?.packages?.[0]?.name === "string"
            ? data.packages[0].name
            : typeof args.name === "string"
              ? args.name
              : null,
        repo: typeof data?.repo === "string" ? data.repo : null,
      });
    }

    if (frame.call === "adapter.state.update") {
      const args = frame.args as {
        adapter?: unknown;
        accountId?: unknown;
        status?: unknown;
      };

      if (
        typeof args.adapter === "string" &&
        typeof args.accountId === "string" &&
        args.status &&
        typeof args.status === "object"
      ) {
        this.broadcastToRole("service", "adapter.status", {
          adapter: args.adapter,
          accountId: args.accountId,
          status: args.status,
        });
      }
    }
  }

  private async dispatchSignalWatches(
    uid: number,
    processId: string,
    frame: SignalFrame,
  ): Promise<void> {
    const watches = this.signalWatches.match(uid, frame.signal, processId);
    for (const watch of watches) {
      try {
        if (this.isLegacySignalWatchKey(watch.key)) {
          this.signalWatches.deleteHandled(watch.watchId);
          continue;
        }
        if (watch.targetKind === "app") {
          await this.invokePackageAppSignalHandler(watch, processId, frame);
        } else {
          await this.invokeProcessSignalWatch(watch, processId, frame);
        }
        if (watch.once) {
          this.signalWatches.deleteHandled(watch.watchId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.signalWatches.markFailed(watch.watchId, message);
        console.warn(`[Kernel] signal watch ${watch.watchId} failed: ${message}`);
      }
    }
  }

  private isLegacySignalWatchKey(key: string | null | undefined): boolean {
    return typeof key === "string" && (key.startsWith("live:") || key.startsWith("__gsv_live__:"));
  }

  private async invokePackageAppSignalHandler(
    watch: SignalWatchRecord,
    processId: string,
    frame: SignalFrame,
  ): Promise<void> {
    if (!watch.packageId || !watch.packageName || !watch.entrypointName || !watch.routeBase) {
      throw new Error(`App signal watch ${watch.watchId} is missing package metadata`);
    }
    const record = this.packages.resolve(
      watch.packageId,
      visiblePackageScopesForActor({ uid: watch.uid }),
    );
    if (!record || !record.enabled || record.manifest.name !== watch.packageName) {
      throw new Error(`Package app not found for watch ${watch.watchId}`);
    }

    const entrypoint = findUiEntrypoint(
      record.manifest.entrypoints,
      watch.entrypointName,
      watch.routeBase,
    );
    if (!entrypoint) {
      throw new Error(`UI entrypoint not found for watch ${watch.watchId}`);
    }

    const user = this.auth.getPasswdByUid(watch.uid);
    if (!user) {
      throw new Error(`User not found for watch ${watch.watchId}`);
    }

    const now = Date.now();
    const appFrame: AppFrameContext = {
      uid: user.uid,
      username: user.username,
      packageId: record.packageId,
      packageName: record.manifest.name,
      entrypointName: entrypoint.name,
      routeBase: watch.routeBase,
      issuedAt: now,
      expiresAt: now + DEFAULT_APP_FRAME_TTL_MS,
    };

    const runner = this.ctx.exports.AppRunner.getByName(buildAppRunnerName(user.uid, record.packageId));
    await runner.ensureRuntime({
      packageId: record.packageId,
      packageName: record.manifest.name,
      routeBase: watch.routeBase,
      entrypointName: entrypoint.name,
      artifact: record.artifact,
      appFrame,
    });

    await runner.deliverSignal({
      signal: frame.signal,
      payload: frame.payload,
      sourcePid: processId,
      watch: {
        id: watch.watchId,
        ...(watch.key ? { key: watch.key } : {}),
        ...(watch.state === undefined ? {} : { state: watch.state }),
        createdAt: watch.createdAt,
      },
    });
  }

  private async invokeProcessSignalWatch(
    watch: SignalWatchRecord,
    processId: string,
    frame: SignalFrame,
  ): Promise<void> {
    if (!watch.targetProcessId) {
      throw new Error(`Process signal watch ${watch.watchId} is missing target process`);
    }

    await sendFrameToProcess(watch.targetProcessId, {
      type: "sig",
      signal: frame.signal,
      payload: {
        watched: true,
        sourcePid: processId,
        watch: {
          id: watch.watchId,
          ...(watch.key ? { key: watch.key } : {}),
          ...(watch.state === undefined ? {} : { state: watch.state }),
          createdAt: watch.createdAt,
        },
        payload: frame.payload,
      },
    });
  }

  private async handleSysConnect(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.connect">,
  ): Promise<void> {
    const ctx = this.buildContext(connection);

    const outcome = await handleConnect(frame.args, ctx);

    if (!outcome.ok) {
      this.sendError(connection, frame.id, outcome.code, outcome.message, outcome.details);
      return;
    }

    const uid = outcome.identity.process.uid;
    const role = outcome.identity.role;
    const clientId = frame.args?.client?.id?.trim();
    if (clientId) {
      for (const [connId, existing] of this.connections) {
        const existingState = existing.state as ConnectionState | undefined;
        if (
          existingState?.step === "connected" &&
          existingState.identity?.process.uid === uid &&
          existingState.identity.role === role &&
          existingState.clientId === clientId &&
          connId !== ctx.connection.id &&
          existing !== connection
        ) {
          existing.close(1000, "Replaced by newer connection");
          this.connections.delete(connId);
        }
      }
    }

    const newState: ConnectionState = {
      step: "connected",
      identity: outcome.identity,
      clientId: clientId || undefined,
    };
    connection.setState(newState);
    this.connections.set(ctx.connection.id, connection);

    if (outcome.identity.role === "driver") {
      this.broadcastDeviceStatus(outcome.identity.device, "connected");
    }

    if (outcome.identity.role === "user") {
      const freshIdentity = outcome.identity.process;
      await this.ensureUserInitProcess(freshIdentity);
      this.reconcileIdentity(freshIdentity);
    }

    this.sendOk(connection, frame.id, outcome.result);
  }

  private async handleSysTargetRegister(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.target.register">,
  ): Promise<void> {
    const state = connection.state as ConnectionState | undefined;
    const identity = state?.identity;
    if (!identity || identity.role !== "user") {
      this.sendError(connection, frame.id, 403, "Only user clients can register targets");
      return;
    }

    const raw = asRecord(frame.args) ?? {};
    const implementsList = Array.isArray(raw.implements)
      ? Array.from(new Set(raw.implements
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)))
      : [];
    if (implementsList.length === 0) {
      this.sendError(connection, frame.id, 400, "sys.target.register requires implements");
      return;
    }

    const platform = normalizeTargetText(raw.platform, "browser-shell", 64);
    const version = normalizeTargetText(raw.version, SERVER_VERSION, 64);
    const label = normalizeTargetText(raw.label, "Browser Shell", 120);
    const description = normalizeTargetText(
      raw.description,
      `${label} target for ${identity.process.username}`,
      500,
    );
    const lifecycle: DeviceLifecycle = "ephemeral";
    const targetId = `browser:${connection.id}`;
    const registered = this.devices.register(
      targetId,
      identity.process.uid,
      identity.process.gid,
      implementsList,
      platform,
      version,
      { label, description, lifecycle },
    );
    if (!registered.ok) {
      this.sendError(connection, frame.id, 400, registered.error ?? "Failed to register target");
      return;
    }

    const nextTargets = [
      ...(state.providedTargets ?? []).filter((target) => target.targetId !== targetId),
      { targetId },
    ];
    connection.setState({ ...state, providedTargets: nextTargets });
    this.connections.set(connection.id, connection);
    this.broadcastDeviceStatus(targetId, "connected");

    const device = this.devices.get(targetId);
    if (!device) {
      this.sendError(connection, frame.id, 500, "Registered target was not persisted");
      return;
    }

    const result: SysTargetRegisterResult = {
      targetId,
      device: {
        deviceId: device.device_id,
        ownerUid: device.owner_uid,
        ownerUsername: this.auth.getPasswdByUid(device.owner_uid)?.username ?? null,
        label: device.label,
        description: device.description,
        platform: device.platform,
        version: device.version,
        lifecycle: device.lifecycle,
        online: device.online,
        lastSeenAt: device.last_seen_at,
        implements: device.implements,
        firstSeenAt: device.first_seen_at,
        connectedAt: device.connected_at,
        disconnectedAt: device.disconnected_at,
      },
    };
    this.sendOk(connection, frame.id, result);
  }

  private async handleSysSetup(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.setup">,
  ): Promise<void> {
    const state = connection.state as ConnectionState | undefined;
    if (state?.step === "connected") {
      this.sendError(connection, frame.id, 409, "Already connected");
      return;
    }

    const ctx = this.buildContext(connection);
    await ensureKernelBootstrapped(ctx);

    if (!this.auth.isSetupMode()) {
      this.sendError(connection, frame.id, 409, "System already initialized");
      return;
    }

    try {
      const data = await handleKernelSetup(frame.args, ctx);
      const setup = data as SysSetupResult;
      await this.ensureUserInitProcess(setup.user);
      this.sendOk(connection, frame.id, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(connection, frame.id, 400, message);
    }
  }

  private async handleSysSetupAssist(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.setup.assist">,
  ): Promise<void> {
    const state = connection.state as ConnectionState | undefined;
    if (state?.step === "connected") {
      this.sendError(connection, frame.id, 409, "Already connected");
      return;
    }

    const ctx = this.buildContext(connection);
    await ensureKernelBootstrapped(ctx);

    if (!this.auth.isSetupMode()) {
      this.sendError(connection, frame.id, 409, "System already initialized");
      return;
    }

    try {
      const data = await handleSysSetupAssist(frame.args, ctx);
      this.sendOk(connection, frame.id, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(connection, frame.id, 400, message);
    }
  }

  private handleRes(_connection: Connection, frame: ResponseFrame): void {
    const consumed = this.routes.consume(frame.id);
    if (!consumed) {
      return;
    }

    if (consumed.scheduleId) {
      this.cancelSchedule(consumed.scheduleId).catch(() => {});
    }

    if (consumed.call === "shell.exec") {
      this.recordShellSessionFromResponse(consumed.deviceId, frame);
    }

    this.deliverToOrigin(consumed.origin, frame);
  }

  private handleSig(connection: Connection<ConnectionState>, frame: SignalFrame): void {
    if (frame.signal !== "exec.status") {
      return;
    }

    const state = connection.state as ConnectionState | undefined;
    const targetId = state?.identity?.role === "driver"
      ? state.identity.device
      : state?.providedTargets?.[0]?.targetId;
    if (!targetId) {
      return;
    }

    const payload = asRecord(frame.payload);
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sessionId) {
      return;
    }

    const status = shellStatusFromEvent(typeof payload?.event === "string" ? payload.event : "");
    this.shellSessions.rememberDeviceSession(sessionId, targetId, status, {
      exitCode: typeof payload?.exitCode === "number" ? payload.exitCode : null,
      error: typeof payload?.signal === "string" ? payload.signal : null,
    });
  }

  private recordShellSessionFromResponse(deviceId: string, frame: ResponseFrame): void {
    if (!frame.ok) {
      return;
    }

    const data = asRecord(frame.data);
    const sessionId = typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) {
      return;
    }

    const status = shellStatusFromResult(typeof data?.status === "string" ? data.status : "");
    this.shellSessions.rememberDeviceSession(sessionId, deviceId, status, {
      exitCode: typeof data?.exitCode === "number" ? data.exitCode : null,
      error: typeof data?.error === "string" ? data.error : null,
    });
  }

  /**
   * Schedule callback — fired when a routing table entry expires.
   */
  async onRouteExpired(routeId: string): Promise<void> {
    await this.ready;
    const expired = this.routes.expire(routeId);
    if (!expired) return;

    const timeoutFrame: ResponseFrame = {
      type: "res",
      id: routeId,
      ok: false,
      error: { code: 504, message: `Syscall ${expired.call} timed out (device: ${expired.deviceId})` },
    };

    this.deliverToOrigin(expired.origin, timeoutFrame);
  }

  async onIpcCallTimeout(callId: string): Promise<void> {
    await this.ready;
    const timedOut = this.ipcCalls.timeout(callId);
    if (!timedOut) return;

    await this.deliverIpcCallSignal("ipc.timeout", timedOut, {
      error: timedOut.error,
    });
  }

  async onScheduleDue(scheduleId: string, wake?: { id?: unknown }): Promise<void> {
    await this.ready;
    const record = this.schedules.getStored(scheduleId);
    const wakeId = typeof wake?.id === "string" ? wake.id : null;
    if (wakeId && record?.wakeScheduleId !== wakeId) {
      return;
    }

    const result = await this.runSchedules({ id: scheduleId, mode: "due" });
    if (result.ran !== 0) {
      return;
    }

    const current = this.schedules.getStored(scheduleId);
    if (current?.enabled && current.state.nextRunAtMs !== null && current.state.nextRunAtMs > Date.now()) {
      const nextWakeId = await this.scheduleScheduleWake(current.id, current.state.nextRunAtMs);
      this.schedules.setWakeScheduleId(current.id, nextWakeId);
    }
  }

  private async runSchedules(
    args: SchedulerRunArgs,
    identity?: ConnectionIdentity,
  ): Promise<SchedulerRunResult> {
    const mode = args.mode ?? "due";
    if (mode === "force" && !args.id) {
      throw new Error("sched.run force requires an id");
    }

    const now = Date.now();
    const records = args.id
      ? [this.schedules.get(args.id)].filter((record): record is ScheduleRecord => record !== null)
      : this.schedules.listDue(now, identity && identity.process.uid !== 0 ? identity.process.uid : undefined);

    const results: ScheduleRunResult[] = [];
    for (const record of records) {
      if (identity) {
        assertCanManageSchedule(identity, record);
      }
      results.push(await this.runScheduleRecord(record, mode));
    }

    return {
      ran: results.filter((result) => result.status !== "skipped").length,
      results,
    };
  }

  private async runScheduleRecord(
    record: ScheduleRecord,
    mode: "due" | "force",
  ): Promise<ScheduleRunResult> {
    const now = Date.now();
    const scheduledAtMs = record.state.nextRunAtMs;

    if (mode === "due") {
      if (!record.enabled) {
        return skippedScheduleResult(record.id, "schedule is disabled");
      }
      if (scheduledAtMs === null || scheduledAtMs > now) {
        return skippedScheduleResult(record.id, "schedule is not due");
      }
    }

    if (record.state.runningAtMs !== null) {
      return skippedScheduleResult(record.id, "schedule is already running");
    }

    const startedAtMs = Date.now();
    const running = this.schedules.markRunning(record.id, startedAtMs);
    if (!running) {
      return skippedScheduleResult(record.id, "schedule is already running");
    }

    let status: "ok" | "error" = "ok";
    let error: string | undefined;
    let result: unknown;

    try {
      result = await this.dispatchScheduleTarget(record, scheduledAtMs, startedAtMs);
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
      result = { error };
    }

    const finishedAtMs = Date.now();
    const next = mode === "force"
      ? { enabled: record.enabled, nextRunAtMs: record.state.nextRunAtMs }
      : computeNextRunAfterFinish(record.expression, Math.max(finishedAtMs, scheduledAtMs ?? finishedAtMs));
    const updated = this.schedules.finishRun({
      scheduleId: record.id,
      ownerUid: record.ownerUid,
      scheduledAtMs: mode === "force" ? null : scheduledAtMs,
      startedAtMs,
      finishedAtMs,
      status,
      error,
      result,
      nextRunAtMs: next.nextRunAtMs,
      enabled: next.enabled,
    });

    if (updated?.enabled && updated.state.nextRunAtMs !== null && mode !== "force") {
      const wakeId = await this.scheduleScheduleWake(updated.id, updated.state.nextRunAtMs);
      this.schedules.setWakeScheduleId(updated.id, wakeId);
    } else if (updated && !updated.enabled) {
      this.schedules.setWakeScheduleId(updated.id, null);
    }

    return {
      scheduleId: record.id,
      status,
      ...(error ? { error } : {}),
      summary: scheduleResultSummary(record, result),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      nextRunAtMs: updated?.state.nextRunAtMs ?? null,
    };
  }

  private async dispatchScheduleTarget(
    record: ScheduleRecord,
    scheduledAtMs: number | null,
    firedAtMs: number,
  ): Promise<unknown> {
    const target = record.target;
    if (target.kind === "process.spawn") {
      const ctx = this.buildScheduleContext(record);
      const result = await handleProcSpawn({
        profile: target.profile ?? "cron",
        label: target.label ?? record.name,
        prompt: target.prompt,
        parentPid: target.parentPid,
        workspace: target.workspace,
        mounts: target.mounts,
        assignment: target.assignment,
      }, ctx);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        kind: "process.spawn",
        pid: result.pid,
        profile: result.profile,
      };
    }

    if (target.kind === "process.event") {
      const proc = this.procs.get(target.pid);
      if (!proc) {
        throw new Error(`Process not found: ${target.pid}`);
      }
      if (proc.uid !== record.ownerUid && record.ownerUid !== 0) {
        throw new Error(`Permission denied: schedule ${record.id} cannot access process ${target.pid}`);
      }

      await sendFrameToProcess(target.pid, {
        type: "sig",
        signal: "schedule.event",
        payload: {
          scheduleId: record.id,
          scheduleName: record.name,
          conversationId: target.conversationId,
          message: target.message,
          data: target.data,
          scheduledAtMs,
          firedAtMs,
        },
      });
      return {
        kind: "process.event",
        pid: target.pid,
        conversationId: target.conversationId ?? "default",
      };
    }

    return { kind: "unknown" };
  }

  private buildScheduleContext(record: ScheduleRecord): KernelContext {
    const process = this.resolveScheduleIdentity(record.ownerUid);
    const identity: ConnectionIdentity = {
      role: "user",
      process,
      capabilities: this.caps.resolve(process.gids),
    };

    return {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      workspaces: this.workspaces,
      packages: this.packages,
      oauth: this.oauth,
      mcp: this.mcp,
      mcpServers: this.mcpServers,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      shellSessions: this.shellSessions,
      signalWatches: this.signalWatches,
      ipcCalls: this.ipcCalls,
      notifications: this.notifications,
      schedules: this.schedules,
      connection: null as unknown as Connection,
      identity,
      processId: record.runAs.kind === "process" ? record.runAs.pid : undefined,
      appFrame: undefined,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
      scheduleIpcCallTimeout: this.scheduleIpcCallTimeout.bind(this),
      scheduleScheduleWake: this.scheduleScheduleWake.bind(this),
      cancelScheduleWake: this.cancelScheduleWake.bind(this),
      runSchedules: this.runSchedules.bind(this),
      addMcpServerConnection: this.addMcpServerConnection.bind(this),
      removeMcpServerConnection: this.removeMcpServerConnection.bind(this),
      refreshMcpServerConnection: this.refreshMcpServerConnection.bind(this),
      callMcpTool: this.callMcpTool.bind(this),
    };
  }

  private resolveScheduleIdentity(uid: number): ProcessIdentity {
    const initIdentity = this.procs.getIdentity(`init:${uid}`);
    if (initIdentity) {
      return initIdentity;
    }

    const user = this.auth.getPasswdByUid(uid);
    if (!user) {
      throw new Error(`Cannot resolve schedule owner uid ${uid}`);
    }
    return {
      uid: user.uid,
      gid: user.gid,
      gids: this.auth.resolveGids(user.username, user.gid),
      username: user.username,
      home: user.home,
      cwd: user.home,
      workspaceId: null,
    };
  }

  private deliverToOrigin(origin: RouteOrigin, frame: ResponseFrame): void {
    if (origin.type === "connection") {
      const conn = this.connections.get(origin.id);
      if (conn) {
        conn.send(JSON.stringify(frame));
      }
      return;
    }

    if (origin.type === "process") {
      sendFrameToProcess(origin.id, frame).catch((err: unknown) => {
        console.error(`[Kernel] Failed to deliver frame to process ${origin.id}:`, err);
      });
      return;
    }

    if (origin.type === "app") {
      const resolve = this.pendingAppResponses.get(origin.id);
      if (resolve) {
        this.pendingAppResponses.delete(origin.id);
        resolve(frame);
      }
    }
  }

  private createPendingAppResponse(id: string): {
    promise: Promise<ResponseFrame>;
    cleanup: () => void;
  } {
    let settled = false;
    const promise = new Promise<ResponseFrame>((resolve) => {
      this.pendingAppResponses.set(id, (frame) => {
        settled = true;
        resolve(frame);
      });
    });

    return {
      promise,
      cleanup: () => {
        if (!settled) {
          this.pendingAppResponses.delete(id);
        }
      },
    };
  }

  private failRoutesForDevice(deviceId: string): void {
    this.shellSessions.failForDevice(deviceId, "Device disconnected");
    const failed = this.routes.failForDevice(deviceId);
    for (const entry of failed) {
      if (entry.scheduleId) {
        this.cancelSchedule(entry.scheduleId).catch(() => {});
      }

      const errorFrame: ResponseFrame = {
        type: "res",
        id: entry.id,
        ok: false,
        error: { code: 503, message: `Device disconnected: ${deviceId}` },
      };
      this.deliverToOrigin(entry.origin, errorFrame);
    }
  }

  private removeProvidedTarget(targetId: string): void {
    const existing = this.devices.get(targetId);
    if (!existing) {
      return;
    }

    this.devices.setOnline(targetId, false);
    this.broadcastDeviceStatus(targetId, "disconnected");
    this.failRoutesForDevice(targetId);
    this.devices.remove(targetId);
  }

  private purgeStaleProvidedTargets(liveTargets = new Set<string>()): void {
    for (const device of this.devices.listForUser(0, [0])) {
      if (!isEphemeralDevice(device)) {
        continue;
      }
      if (liveTargets.has(device.device_id)) {
        continue;
      }
      this.removeProvidedTarget(device.device_id);
    }
  }

  private failRoutesForConnection(connectionId: string): void {
    const failed = this.routes.failForConnection(connectionId);
    for (const entry of failed) {
      if (entry.scheduleId) {
        this.cancelSchedule(entry.scheduleId).catch(() => {});
      }
    }
  }

  /**
   * Compare freshly-resolved identity from auth store against ProcessRegistry.
   * If there's drift (groups changed, home changed, etc.), update the
   * registry and send identity.changed signals to all processes for that uid.
   */
  private reconcileIdentity(fresh: ProcessIdentity): void {
    const existing = this.procs.getIdentity(`init:${fresh.uid}`);
    if (!existing) return;

    if (
      existing.gid === fresh.gid &&
      existing.home === fresh.home &&
      existing.username === fresh.username &&
      JSON.stringify(existing.gids) === JSON.stringify(fresh.gids)
    ) {
      return;
    }

    const processes = this.procs.list(fresh.uid);
    for (const proc of processes) {
      this.procs.updateIdentity(proc.processId, fresh);

      sendFrameToProcess(proc.processId, {
        type: "sig",
        signal: "identity.changed",
        payload: { identity: fresh },
      }).catch((err: unknown) => {
        console.error(`[Kernel] Failed to send identity.changed to ${proc.processId}:`, err);
      });
    }
  }

  /**
   * Broadcast a signal to all active WebSocket connections belonging to a UID.
   * Skips service connections — adapter traffic is explicit via adapter.send.
   */
  broadcastToUid(uid: number, signal: string, payload?: unknown): void {
    const frame: SignalFrame = {
      type: "sig",
      signal,
      payload,
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (!state) continue;
      if (state.identity?.role === "service") continue;
      if (state.identity?.process.uid === uid) {
        conn.send(json);
      }
    }
  }

  private broadcastToRole(role: ConnectionIdentity["role"], signal: string, payload?: unknown): void {
    const frame: SignalFrame = {
      type: "sig",
      signal,
      payload,
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (!state?.identity) continue;
      if (state.identity.role !== role) continue;
      conn.send(json);
    }
  }

  private broadcastDeviceStatus(
    deviceId: string,
    event: "connected" | "disconnected",
  ): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }

    const frame: SignalFrame = {
      type: "sig",
      signal: "device.status",
      payload: {
        event,
        device: {
          deviceId: device.device_id,
          ownerUid: device.owner_uid,
          label: device.label,
          description: device.description,
          platform: device.platform,
          version: device.version,
          lifecycle: device.lifecycle,
          online: device.online,
          firstSeenAt: device.first_seen_at,
          lastSeenAt: device.last_seen_at,
          connectedAt: device.connected_at,
          disconnectedAt: device.disconnected_at,
        },
      },
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (!state?.identity) continue;
      if (state.identity.role === "service") continue;

      if (state.identity.role === "user") {
        const proc = state.identity.process;
        if (!this.devices.canAccess(deviceId, proc.uid, [...proc.gids])) {
          continue;
        }
      } else if (state.identity.role === "driver") {
        if (state.identity.device !== deviceId) {
          continue;
        }
      }

      conn.send(json);
    }
  }

  /**
   * Rebuild in-memory connection index after hibernation/wake.
   * The Agent runtime restores Connection objects and their persisted state,
   * but our local maps must be reconstructed per constructor invocation.
   */
  private rehydrateConnections(): void {
    const live = this.getConnections<ConnectionState>();

    const onlineTargets = new Set<string>();

    for (const connection of live) {
      const state = connection.state;
      if (!state || state.step !== "connected" || !state.identity) continue;

      this.connections.set(connection.id, connection);
      if (state.identity.role === "driver") {
        onlineTargets.add(state.identity.device);
        this.devices.setOnline(state.identity.device, true);
      }
      for (const target of state.providedTargets ?? []) {
        onlineTargets.add(target.targetId);
        this.devices.setOnline(target.targetId, true);
      }
    }

    // Reconcile registered device online flags with live rehydrated sockets.
    for (const device of this.devices.listOnline()) {
      if (!onlineTargets.has(device.device_id)) {
        if (isEphemeralDevice(device)) {
          this.removeProvidedTarget(device.device_id);
        } else {
          this.devices.setOnline(device.device_id, false);
          this.broadcastDeviceStatus(device.device_id, "disconnected");
        }
      }
    }

    this.purgeStaleProvidedTargets(onlineTargets);
  }

  private async ensureUserInitProcess(identity: ProcessIdentity): Promise<string> {
    const { pid, created } = this.procs.ensureInit(identity);

    if (created) {
      await sendFrameToProcess(pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.setidentity",
        args: { pid, identity, profile: "init" },
      } as RequestFrame);
    }

    return pid;
  }

  private extractRunId(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const maybe = (payload as Record<string, unknown>).runId;
    return typeof maybe === "string" && maybe.trim().length > 0 ? maybe : null;
  }

  private sendOk(connection: Connection, id: string, data?: unknown): void {
    connection.send(JSON.stringify({ type: "res", id, ok: true, data }));
  }

  private sendError(
    connection: Connection,
    id: string,
    code: number,
    message: string,
    details?: unknown,
  ): void {
    connection.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
        },
      }),
    );
  }
}

export function findAppFrameEntrypoint(
  entrypoints: readonly PackageEntrypoint[],
  entrypointName: string,
  routeBase: string,
): PackageEntrypoint | null {
  return entrypoints.find((entrypoint) => {
    if (entrypoint.kind === "ui") {
      return entrypoint.name === entrypointName && entrypoint.route === routeBase;
    }
    if (entrypoint.kind === "command") {
      return (entrypoint.command?.trim() || entrypoint.name) === entrypointName;
    }
    return false;
  }) ?? null;
}

function findUiEntrypoint(
  entrypoints: readonly PackageEntrypoint[],
  entrypointName: string,
  routeBase: string,
): PackageEntrypoint | null {
  return entrypoints.find((entrypoint) => {
    return entrypoint.kind === "ui" && entrypoint.name === entrypointName && entrypoint.route === routeBase;
  }) ?? null;
}

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function normalizeTargetText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function isEphemeralDevice(device: DeviceRecord): boolean {
  return device.lifecycle === "ephemeral";
}

function ceilToSecondMs(value: number): number {
  return Math.ceil(value / 1_000) * 1_000;
}

function scheduleResultSummary(record: ScheduleRecord, result: unknown): string {
  const value = asRecord(result);
  if (record.target.kind === "process.spawn" && typeof value?.pid === "string") {
    return `spawned process ${value.pid}`;
  }
  if (record.target.kind === "process.event") {
    return `delivered event to process ${record.target.pid}`;
  }
  return "schedule ran";
}

function shellStatusFromResult(status: string): ShellSessionStatus {
  if (status === "completed" || status === "failed") {
    return status;
  }
  return "running";
}

function shellStatusFromEvent(event: string): ShellSessionStatus {
  if (event === "finished") {
    return "completed";
  }
  if (event === "failed" || event === "timed_out") {
    return "failed";
  }
  return "running";
}
