import {
  Connection,
  ConnectionContext,
  Agent as Host,
  getCurrentAgent,
  type WSMessage,
} from "agents";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
} from "agents/mcp/do-oauth-client-provider";
import type { MCPConnectionResult } from "agents/mcp/client";
import type { Frame, RequestFrame, ResponseFrame, SignalFrame } from "../protocol/frames";
import type {
  ConnectionIdentity,
  NetFetchArgs,
  NetFetchResult,
  PkgPublicListResult,
  ProcessIdentity,
  ScheduleRecord,
  ScheduleRunResult,
  SchedulerRunArgs,
  SchedulerRunResult,
  SysCliDownloadsResult,
  SysUpdateArgs,
  SysUpdateResult,
} from "@humansandmachines/gsv/protocol";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  BINARY_FRAME_ERROR,
  buildBinaryFrame,
  parseBinaryFrame,
  type BinaryFrame,
} from "@humansandmachines/gsv/protocol";
import type { SyscallName } from "../syscalls";
import type {
  AdapterOutboundMessage,
} from "../adapter-interface";
import { AuthStore } from "./auth-store";
import { CapabilityStore, hasCapability } from "./capabilities";
import { ConfigStore } from "./config";
import { DeviceRegistry } from "./devices";
import { RoutingTable, type RouteOrigin } from "./routing";
import { ShellSessionStore, type ShellSessionStatus } from "./shell-sessions";
import { ProcessRegistry, type ProcessState } from "./processes";
import { ConversationRegistry } from "./conversations";
import { AdapterStore } from "./adapter-store";
import { RunRouteStore, type AdapterRunRoute, type RunRoute } from "./run-routes";
import { OAuthStore } from "./oauth-store";
import { McpServerStore } from "./mcp-store";
import { SignalWatchStore, type SignalWatchRecord } from "./signal-watches";
import { isUserProcessSignal } from "./user-signals";
import { NotificationStore } from "./notifications";
import { IpcCallStore, type IpcCallRecord } from "./ipc-calls";
import {
  assertCanManageSchedule,
  computeNextRunAfterFinish,
  ScheduleStore,
  skippedScheduleResult,
} from "./scheduler";
import { APP_CLIENT_SESSION_TTL_MS, AppSessionStore } from "./app-sessions";
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
  handleSysUpdate as handleSysUpdateDirect,
  refreshCliDownloads,
} from "./sys/update";
import { completeOAuthCallback as completeOAuthCallbackFlow } from "./sys/oauth";
import type { McpAddConnectionInput, McpAddConnectionResult } from "./sys/mcp";
import { installMcpDiscoveryCompatibility } from "./mcp-compat";
import { oauthCallbackHtmlResponse } from "../oauth-http";
import { isInternalOnlySyscall } from "./syscall-exposure";
import {
  normalizeAdapterHilRequest,
  renderAdapterHilPrompt,
  resolveAdapterService,
  setAdapterActivityForKernel,
} from "./adapter-handlers";
import {
  PackageStore,
  type PackageEntrypoint,
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
import { isRepoPublic } from "./repo-visibility";
import { canReadRepo, canWriteRepo } from "./repo";
import { handleProcSpawn } from "./proc-handlers";
import { ensureDefaultConversationExecutor } from "./agents";
import { handleShellExec } from "../drivers/native/shell";
import { getVisibleTarget } from "./targets";
import { runKernelSqlMigrations } from "./schema/migrations";

const SERVER_VERSION = "0.3.3";
const KERNEL_BINARY_DEVICE_ID = "__gsv_kernel__";
const CLI_DOWNLOADS_REFRESHED_VERSION_KEY = "config/downloads/cli/refreshed_for_version";
const CLI_DOWNLOADS_REFRESH_ATTEMPT_KEY = "config/downloads/cli/refresh_attempt_at";
const CLI_DOWNLOADS_REFRESHED_AT_KEY = "config/downloads/cli/refreshed_at";
const CLI_DOWNLOADS_REFRESH_RETRY_MS = 15 * 60 * 1000;

type ConnectionState = {
  step: "pending" | "connected";
  identity?: ConnectionIdentity;
  clientId?: string;
  clientPlatform?: string;
};

type BinaryRoute = {
  requestId: string;
  origin: RouteOrigin;
  deviceId: string;
  kind: "relay" | "native-stream";
};

type PendingBinaryStream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timeoutId: ReturnType<typeof setTimeout>;
};

type ProcSendData = {
  runId?: string;
};

type ProcessNetFetchOptions = {
  ttlMs?: number;
  internalPurpose?: "model-transport";
};

type ResolvePackageAppRpcInput = {
  packageName?: string;
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
  private readonly conversations: ConversationRegistry;
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
  private readonly connections = new Map<string, Connection<ConnectionState>>();
  private readonly pendingAppResponses = new Map<string, (frame: ResponseFrame) => void>();
  private readonly pendingProcessSignals = new Map<string, Promise<void>>();
  private readonly binaryRoutes = new Map<number, BinaryRoute>();
  private readonly binaryRoutesByRequest = new Map<string, Set<number>>();
  private readonly pendingBinaryStreams = new Map<number, PendingBinaryStream>();
  private cliDownloadsRefresh: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    runKernelSqlMigrations(ctx.storage);

    this.auth = new AuthStore(sql);

    this.caps = new CapabilityStore(sql);
    this.caps.seed();

    this.config = new ConfigStore(sql);

    this.devices = new DeviceRegistry(sql);

    this.routes = new RoutingTable(sql);

    this.shellSessions = new ShellSessionStore(sql);

    this.procs = new ProcessRegistry(sql);

    this.conversations = new ConversationRegistry(sql);

    this.adapters = new AdapterStore(sql);

    this.runRoutes = new RunRouteStore(sql);

    this.signalWatches = new SignalWatchStore(sql);

    this.ipcCalls = new IpcCallStore(sql);

    this.notifications = new NotificationStore(sql);

    this.schedules = new ScheduleStore(sql);

    this.appSessions = new AppSessionStore(sql);

    this.packages = new PackageStore(sql, env.STORAGE);

    this.oauth = new OAuthStore(sql);

    this.mcpServers = new McpServerStore(sql);
    installMcpDiscoveryCompatibility(this.mcp);
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
    this.mcp.onServerStateChanged(() => {
      this.broadcastMcpChanged();
    });

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
    const serverName = `u${input.uid}:${input.name}`;
    const serverId = `mcp-${crypto.randomUUID()}`;
    let callbackHost = input.callbackHost;
    if (!callbackHost) {
      const { request, connection } = getCurrentAgent();
      const activeUrl = request?.url ?? connection?.uri;
      callbackHost = activeUrl ? new URL(activeUrl).origin : undefined;
    }
    const callbackUrl = callbackHost
      ? `${callbackHost.replace(/\/$/, "")}/oauth/callback`
      : undefined;
    const authProvider = callbackUrl ? this.createMcpOAuthProvider(callbackUrl) : undefined;
    if (authProvider) {
      authProvider.serverId = serverId;
    }

    await this.mcp.registerServer(serverId, {
      url: input.url,
      name: serverName,
      callbackUrl,
      transport: {
        authProvider,
        type: input.transport.type,
        ...(input.transport.headers
          ? { requestInit: { headers: input.transport.headers } }
          : {}),
      },
    });

    let result: MCPConnectionResult;
    try {
      result = await this.mcp.connectToServer(serverId);
      if (result.state === "failed") {
        throw new Error(
          `Failed to connect to MCP server at ${input.url}: ${result.error}`,
        );
      }
    } catch (error) {
      try {
        await this.removeMcpServer(serverId);
      } catch (cleanupError) {
        console.warn(
          `[Kernel] Failed to clean up MCP server ${serverId} after add failure:`,
          cleanupError,
        );
      }
      throw error;
    }

    if (result.state === "connected") {
      await this.mcp.discoverIfConnected(serverId);
    }
    return { id: serverId };
  }

  private async refreshMcpServerConnection(serverId: string): Promise<void> {
    const connection = this.mcp.mcpConnections[serverId];
    if (connection?.connectionState === "connected" || connection?.connectionState === "ready") {
      await this.mcp.discoverIfConnected(serverId);
      return;
    }
    if (
      connection?.connectionState === "authenticating"
      || connection?.connectionState === "connecting"
      || connection?.connectionState === "discovering"
    ) {
      return;
    }

    if (connection) {
      connection.connectionError = null;
    }
    const result = await this.mcp.connectToServer(serverId);
    if (result.state === "connected") {
      await this.mcp.discoverIfConnected(serverId);
    } else if (result.state === "failed") {
      const failedConnection = this.mcp.mcpConnections[serverId];
      if (failedConnection) {
        failedConnection.connectionError = result.error;
      }
      this.broadcastMcpChanged();
    }
  }

  private broadcastMcpChanged(): void {
    const uids = new Set(this.mcpServers.list().map((record) => record.uid));
    for (const uid of uids) {
      this.broadcastToUid(uid, "mcp.changed");
    }
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

    this.failRoutesForConnection(connection.id);
    this.runRoutes.clearForConnection(connection.id);
  }

  async onMessage(connection: Connection<ConnectionState>, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      this.handleBinaryMessage(connection, message);
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
    if (frame.type === "req") {
      return this.handleProcessReq(processId, frame);
    }

    if (frame.type === "sig") {
      await this.completeIpcCallsForProcessSignal(processId, frame);
      this.enqueueProcessSignal(processId, frame);
      return null;
    }

    return null;
  }

  async requestProcessNetFetch(
    processId: string,
    target: string,
    args: NetFetchArgs,
    options: ProcessNetFetchOptions = {},
  ): Promise<NetFetchResult> {
    const ctx = this.buildProcessContext(processId);
    if (!ctx) {
      throw new Error("Unknown process");
    }
    if (
      options.internalPurpose !== "model-transport" &&
      !hasCapability(ctx.identity!.capabilities, "net.fetch")
    ) {
      throw new Error("Permission denied: net.fetch");
    }

    const device = getVisibleTarget(ctx, target, { includeOffline: true });
    if (!device) {
      throw new Error(`Access denied to device: ${target}`);
    }
    if (device.providerId !== "device" || device.route.kind !== "connection") {
      throw new Error(`Target does not support device requests: ${target}`);
    }
    return await this.requestDevice(
      device.targetId,
      "net.fetch",
      args,
      options.ttlMs,
    ) as NetFetchResult;
  }

  /**
   * Service-binding RPC entrypoint.
   * Accepts the same frame format as WS connections/process RPC.
   */
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    if (frame.type !== "req") {
      return null;
    }

    return this.handleServiceReq(frame);
  }

  async appRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame> {
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

    const identity = this.buildAppBindingIdentity(appFrame);
    if (!identity) {
      return errFrame(frame.id, 401, "Authentication failed");
    }

    if (!hasCapability(identity.capabilities, frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx = this.buildKernelContext({ identity, appFrame });
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

  async resolvePackageAppRpcSession(input: ResolvePackageAppRpcInput): Promise<ResolvePackageAppRpcResult> {
    return this.resolvePackageAppRpcSessionByMode(input, "resolve");
  }

  async refreshPackageAppRpcSession(input: ResolvePackageAppRpcInput): Promise<ResolvePackageAppRpcResult> {
    return this.resolvePackageAppRpcSessionByMode(input, "refresh");
  }

  private async resolvePackageAppRpcSessionByMode(
    input: ResolvePackageAppRpcInput,
    mode: "resolve" | "refresh",
  ): Promise<ResolvePackageAppRpcResult> {
    const packageName = input.packageName?.trim() ?? "";
    const sessionId = input.sessionId.trim();
    const secret = input.secret.trim();

    if (!sessionId || !secret) {
      return { ok: false, status: 401, message: "Authentication required" };
    }

    const clientSession = mode === "refresh"
      ? await this.appSessions.refresh(sessionId, secret, APP_CLIENT_SESSION_TTL_MS)
      : await this.appSessions.resolve(sessionId, secret);
    if (!clientSession) {
      return { ok: false, status: 401, message: "Authentication failed" };
    }
    if (packageName && clientSession.packageName !== packageName) {
      return { ok: false, status: 404, message: "Package app session not found" };
    }

    return this.resolvePackageAppSessionContext(clientSession);
  }

  private resolvePackageAppSessionContext(clientSession: AppClientSessionContext): ResolvePackageAppRpcResult {
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
    const owner = input.owner.trim();
    const repo = input.repo.trim();
    const username = input.username?.trim() ?? "";
    const credential = input.credential?.trim() ?? "";
    const isPublicRead = !input.write && isRepoPublic({ owner, repo }, this.config);

    if (!owner || !repo) {
      return { ok: false, status: 401, message: "Authentication required" };
    }

    if (!username || !credential) {
      if (!isPublicRead) {
        return { ok: false, status: 401, message: "Authentication required" };
      }
    } else {
      const passwordAuth = await this.auth.authenticate(username, credential);
      const auth = passwordAuth.ok
        ? passwordAuth
        : await this.auth.authenticateToken(username, credential, { role: "user" });

      if (auth.ok) {
        const capabilities = this.caps.resolve(auth.identity.gids);
        const identity: ConnectionIdentity = {
          role: "user",
          process: {
            ...auth.identity,
            cwd: auth.identity.home,
          },
          capabilities,
        };
        const repoRef = `${owner}/${repo}`;
        const repoCtx = this.buildKernelContext({ identity });

        if (input.write) {
          if (!canWriteRepo(repoRef, repoCtx)) {
            return { ok: false, status: 403, message: "Forbidden" };
          }
        } else if (!canReadRepo(repoRef, repoCtx)) {
          return { ok: false, status: 403, message: "Forbidden" };
        }

        return {
          ok: true,
          username: auth.identity.username,
          uid: auth.identity.uid,
          capabilities,
        };
      }
      if (!isPublicRead) {
        return { ok: false, status: 401, message: "Authentication failed" };
      }
    }

    return {
      ok: true,
      username: null,
      uid: -1,
      capabilities: [],
    };
  }

  async listPublicPackages(): Promise<PkgPublicListResult> {
    const serverName = this.config.get("config/server/name")?.trim() || "gsv";
    return {
      serverName,
      source: { kind: "local", name: serverName },
      packages: listLocalPublicPackages(this.config, this.packages),
    };
  }

  /**
   * Relay process signals using deterministic run route lookups.
   */
  private async handleProcessSignal(processId: string, frame: SignalFrame): Promise<void> {
    const ownerUid = this.procs.getOwnerUid(processId);
    if (ownerUid === null) {
      console.warn(`[Kernel] Signal from unknown process ${processId}`);
      return;
    }

    const runId = this.extractRunId(frame.payload);
    this.updateProcessRuntimeFromSignal(processId, frame, runId);

    // Signal watches are scoped to the process owner, not the run-as account.
    // App runtimes register watches under the owning human uid, while the
    // emitting process may run as a personal/package agent.
    await this.dispatchSignalWatches(ownerUid, processId, frame);

    if (!isUserProcessSignal(frame.signal)) return;

    // Client-facing process signals route by the owning human (owner_uid), not the
    // run-as identity (which may be the personal agent account).
    if (!runId) {
      this.broadcastToUid(ownerUid, frame.signal, frame.payload);
      return;
    }

    const route = this.runRoutes.get(runId);
    if (!route) {
      this.broadcastToUid(ownerUid, frame.signal, frame.payload);
      return;
    }

    if (route.uid !== ownerUid) {
      this.runRoutes.delete(runId);
      return;
    }

    if (route.kind === "connection") {
      this.deliverSignalToConnection(route, frame, ownerUid);
      if (frame.signal === "proc.run.finished") {
        this.runRoutes.delete(runId);
      }
      return;
    }

    await this.deliverSignalToAdapter(route, frame);
    if (frame.signal === "proc.run.finished") {
      this.runRoutes.delete(runId);
    }
  }

  private updateProcessRuntimeFromSignal(
    processId: string,
    frame: SignalFrame,
    runId: string | null,
  ): void {
    const payload = frame.payload && typeof frame.payload === "object"
      ? frame.payload as Record<string, unknown>
      : {};
    const conversationId = typeof payload.conversationId === "string"
      ? payload.conversationId
      : null;
    const queuedCount = typeof payload.queuedCount === "number" && Number.isFinite(payload.queuedCount)
      ? payload.queuedCount
      : undefined;
    const timestamp = typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
      ? payload.timestamp
      : Date.now();

    const patchForActive = (state: ProcessState) => {
      this.procs.updateRuntimeState(processId, {
        state,
        ...(runId ? { activeRunId: runId } : {}),
        ...(conversationId ? { activeConversationId: conversationId } : {}),
        ...(queuedCount !== undefined ? { queuedCount } : {}),
        lastActiveAt: timestamp,
      });
    };

    switch (frame.signal) {
      case "proc.run.started":
      case "proc.run.stream":
      case "proc.run.retrying":
      case "proc.run.output":
      case "proc.run.tool.finished":
        patchForActive("running");
        return;
      case "proc.run.tool.started":
        patchForActive("waiting_tool");
        return;
      case "proc.run.hil.requested":
        patchForActive("waiting_hil");
        return;
      case "proc.run.finished":
        this.procs.updateRuntimeState(processId, {
          state: queuedCount && queuedCount > 0 ? "queued" : "idle",
          activeRunId: null,
          activeConversationId: null,
          ...(queuedCount !== undefined ? { queuedCount } : {}),
          lastActiveAt: timestamp,
        });
        return;
      case "proc.changed":
        if (queuedCount !== undefined) {
          this.procs.updateRuntimeState(processId, {
            queuedCount,
            lastActiveAt: timestamp,
          });
        }
        return;
      default:
        return;
    }
  }

  private enqueueProcessSignal(processId: string, frame: SignalFrame): void {
    const previous = this.pendingProcessSignals.get(processId) ?? Promise.resolve();
    const queued = previous
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
    if (frame.signal !== "proc.run.finished") {
      return;
    }
    const runId = this.extractRunId(frame.payload);
    if (!runId) {
      return;
    }
    const ownerUid = this.procs.getOwnerUid(processId);
    if (ownerUid === null) {
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
      uid: ownerUid,
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
    if (frame.signal === "proc.run.hil.requested") {
      const request = normalizeAdapterHilRequest(frame.payload, "signal");
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
        text: renderAdapterHilPrompt(request, route.surfaceKind, "initial"),
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

    if (frame.signal !== "proc.run.finished") {
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
    const service = resolveAdapterService(this.env, adapter);
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

  private async handleProcessReq(processId: string, frame: RequestFrame): Promise<ResponseFrame | null> {
    const ctx = this.buildProcessContext(processId);
    if (!ctx) {
      return errFrame(frame.id, 404, "Unknown process");
    }

    if (
      !isInternalOnlySyscall(frame.call) &&
      !hasCapability(ctx.identity!.capabilities, frame.call)
    ) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const origin: RouteOrigin = { type: "process", id: processId };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (result.handled) {
      this.applyPostDispatchEffects(frame, result.response);
      return result.response;
    }

    return null;
  }

  private buildProcessContext(processId: string): KernelContext | null {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      return null;
    }

    const connIdentity: ConnectionIdentity = {
      role: "user",
      process: identity,
      capabilities: this.caps.resolve(identity.gids),
    };

    return this.buildKernelContext({
      identity: connIdentity,
      processId,
    });
  }

  private async handleServiceReq(frame: RequestFrame): Promise<ResponseFrame> {
    if (frame.call === "sys.connect" || frame.call === "sys.setup" || frame.call === "sys.setup.assist") {
      return errFrame(frame.id, 400, `${frame.call} is not supported via serviceFrame`);
    }

    if (isInternalOnlySyscall(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const identity = this.buildServiceBindingIdentity(frame);
    if (!identity) {
      return errFrame(frame.id, 503, "Service identity is not configured");
    }
    if (!hasCapability(identity.capabilities, frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx = this.buildKernelContext({ identity });
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
    return this.buildKernelContext({
      connection,
      identity: state.identity as ConnectionIdentity | undefined,
    });
  }

  private buildKernelContext(options: {
    connection?: Connection | null;
    identity?: ConnectionIdentity;
    processId?: string;
    callerOwnerUid?: number;
    appFrame?: AppFrameContext;
  }): KernelContext {
    return {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      conversations: this.conversations,
      packages: this.packages,
      oauth: this.oauth,
      mcp: this.mcp,
      mcpServers: this.mcpServers,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      shellSessions: this.shellSessions,
      appSessions: this.appSessions,
      signalWatches: this.signalWatches,
      ipcCalls: this.ipcCalls,
      notifications: this.notifications,
      schedules: this.schedules,
      connection: options.connection ?? null,
      identity: options.identity,
      processId: options.processId,
      callerOwnerUid: options.callerOwnerUid,
      appFrame: options.appFrame,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
      scheduleIpcCallTimeout: this.scheduleIpcCallTimeout.bind(this),
      scheduleScheduleWake: this.scheduleScheduleWake.bind(this),
      cancelScheduleWake: async (wakeScheduleId) => {
        await this.cancelSchedule(wakeScheduleId);
      },
      runSchedules: this.runSchedules.bind(this),
      addMcpServerConnection: this.addMcpServerConnection.bind(this),
      removeMcpServerConnection: this.removeMcpServer.bind(this),
      refreshMcpServerConnection: this.refreshMcpServerConnection.bind(this),
      callMcpTool: (serverId, toolName, args) => this.mcp.callTool({
        serverId,
        name: toolName,
        arguments: args,
      }),
    };
  }

  private getAppRunner(uid: number, packageId: string): unknown {
    return this.ctx.exports.AppRunner.getByName(buildAppRunnerName(uid, packageId));
  }

  private buildDispatchDeps(): DispatchDeps {
    return {
      shellSessions: this.shellSessions,
      connections: this.connections,
      registerRoute: this.registerRouteWithExpiry.bind(this),
      registerBinaryRoute: this.registerBinaryRoute.bind(this),
      requestDevice: this.requestDevice.bind(this),
      allocateBinaryStreamId: this.allocateBinaryStreamId.bind(this),
      startDeviceRequest: this.startDeviceRequest.bind(this),
      registerBinaryRelay: this.registerBinaryRelay.bind(this),
      receiveDeviceBinaryStream: this.receiveDeviceBinaryStream.bind(this),
      receiveBinaryStream: this.receiveBinaryStream.bind(this),
      sendDeviceBinaryFrame: this.sendDeviceBinaryFrame.bind(this),
      handleSysUpdate: this.handleSysUpdate.bind(this),
    };
  }

  private async registerRouteWithExpiry(route: {
    id: string;
    call: SyscallName;
    origin: RouteOrigin;
    deviceId: string;
    ttlMs: number;
  }): Promise<{ cancel: () => void }> {
    const scheduleId = (await this.schedule(
      route.ttlMs / 1000,
      "onRouteExpired",
      route.id,
    )).id;

    try {
      this.routes.register(
        route.id,
        route.call,
        route.origin,
        route.deviceId,
        { ttlMs: route.ttlMs, scheduleId },
      );
    } catch (error) {
      this.cancelSchedule(scheduleId).catch(() => {});
      throw error;
    }

    return {
      cancel: () => this.cancelRoute(route.id),
    };
  }

  private cancelRoute(routeId: string): void {
    const route = this.routes.remove(routeId);
    if (route?.scheduleId) {
      this.cancelSchedule(route.scheduleId).catch(() => {});
    }
    this.clearBinaryRoutesForRequest(routeId);
  }

  private registerBinaryRoute(route: {
    requestId: string;
    streamId: number;
    origin: RouteOrigin;
    deviceId: string;
    ttlMs: number;
    kind?: "relay" | "native-stream";
  }): { cancel: () => void } {
    if (this.binaryRoutes.has(route.streamId)) {
      throw new Error(`Binary stream id already active: ${route.streamId}`);
    }
    this.binaryRoutes.set(route.streamId, {
      requestId: route.requestId,
      origin: route.origin,
      deviceId: route.deviceId,
      kind: route.kind ?? "relay",
    });

    const streamIds = this.binaryRoutesByRequest.get(route.requestId) ?? new Set<number>();
    streamIds.add(route.streamId);
    this.binaryRoutesByRequest.set(route.requestId, streamIds);

    return {
      cancel: () => this.clearBinaryRoute(route.streamId),
    };
  }

  private clearBinaryRoute(streamId: number): void {
    const route = this.binaryRoutes.get(streamId);
    if (!route) {
      return;
    }
    this.binaryRoutes.delete(streamId);
    const streamIds = this.binaryRoutesByRequest.get(route.requestId);
    if (streamIds) {
      streamIds.delete(streamId);
      if (streamIds.size === 0) {
        this.binaryRoutesByRequest.delete(route.requestId);
      }
    }
    this.rejectPendingBinaryStream(streamId, new Error("Binary transfer route closed"));
  }

  private clearBinaryRoutesForRequest(requestId: string): void {
    const streamIds = this.binaryRoutesByRequest.get(requestId);
    if (!streamIds) {
      return;
    }
    for (const streamId of [...streamIds]) {
      this.clearBinaryRoute(streamId);
    }
  }

  private allocateBinaryStreamId(): number {
    const values = new Uint32Array(1);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      crypto.getRandomValues(values);
      const streamId = values[0];
      if (
        streamId > 0 &&
        !this.binaryRoutes.has(streamId) &&
        !this.pendingBinaryStreams.has(streamId)
      ) {
        return streamId;
      }
    }
    throw new Error("Unable to allocate binary stream id");
  }

  private createPendingBinaryStream(streamId: number, ttlMs: number): {
    stream: ReadableStream<Uint8Array>;
    cleanup: () => void;
  } {
    if (this.pendingBinaryStreams.has(streamId)) {
      throw new Error(`Binary stream id already waiting: ${streamId}`);
    }

    let settled = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timeoutId = setTimeout(() => {
          settled = true;
          this.rejectPendingBinaryStream(
            streamId,
            new Error(`Binary transfer timed out: ${streamId}`),
          );
          this.clearBinaryRoute(streamId);
        }, ttlMs);
        this.pendingBinaryStreams.set(streamId, { controller, timeoutId });
      },
      cancel: () => {
        if (!settled) {
          this.clearPendingBinaryStream(streamId);
          this.clearBinaryRoute(streamId);
        }
      },
    });

    return {
      stream,
      cleanup: () => {
        if (!settled) {
          this.rejectPendingBinaryStream(streamId, new Error("Binary transfer cancelled"));
          this.clearBinaryRoute(streamId);
        }
      },
    };
  }

  private clearPendingBinaryStream(streamId: number): PendingBinaryStream | null {
    const pending = this.pendingBinaryStreams.get(streamId);
    if (!pending) {
      return null;
    }
    this.pendingBinaryStreams.delete(streamId);
    clearTimeout(pending.timeoutId);
    return pending;
  }

  private closePendingBinaryStream(streamId: number): void {
    const pending = this.clearPendingBinaryStream(streamId);
    if (pending) {
      pending.controller.close();
    }
  }

  private rejectPendingBinaryStream(streamId: number, error: Error): void {
    const pending = this.clearPendingBinaryStream(streamId);
    if (pending) {
      pending.controller.error(error);
    }
  }

  private receiveBinaryStream(route: {
    requestId: string;
    streamId: number;
    origin: RouteOrigin;
    ttlMs: number;
  }): { stream: ReadableStream<Uint8Array>; cancel: () => void } {
    if (route.origin.type !== "connection") {
      throw new Error("Native binary transfer requires an active WebSocket connection");
    }

    const pending = this.createPendingBinaryStream(route.streamId, route.ttlMs);
    let binaryRoute: { cancel: () => void };
    try {
      binaryRoute = this.registerBinaryRoute({
        requestId: route.requestId,
        streamId: route.streamId,
        origin: route.origin,
        deviceId: KERNEL_BINARY_DEVICE_ID,
        ttlMs: route.ttlMs,
        kind: "native-stream",
      });
    } catch (error) {
      pending.cleanup();
      throw error;
    }

    return {
      stream: pending.stream,
      cancel: () => {
        pending.cleanup();
        binaryRoute.cancel();
      },
    };
  }

  private async requestDevice(
    deviceId: string,
    call: string,
    args: unknown,
    ttlMs = 60_000,
  ): Promise<unknown> {
    const request = await this.startDeviceRequest(deviceId, call, args, ttlMs);
    return await request.promise;
  }

  private async startDeviceRequest(
    deviceId: string,
    call: string,
    args: unknown,
    ttlMs = 60_000,
  ): Promise<{ requestId: string; promise: Promise<unknown>; cancel: () => void }> {
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
    let route: { cancel: () => void } | null = null;

    try {
      route = await this.registerRouteWithExpiry({
        id,
        call: call as SyscallName,
        origin: { type: "app", id },
        deviceId,
        ttlMs,
      });

      deviceConn.send(JSON.stringify({
        type: "req",
        id,
        call,
        args,
      }));
    } catch (error) {
      route?.cancel();
      pending.cleanup();
      throw error;
    }

    const promise = pending.promise.then((frame) => {
      if (!frame.ok) {
        throw new Error(frame.error.message);
      }
      return frame.data ?? {};
    }).finally(() => {
      pending.cleanup();
    });

    return {
      requestId: id,
      promise,
      cancel: () => {
        route?.cancel();
        pending.cleanup();
      },
    };
  }

  private registerBinaryRelay(route: {
    requestId: string;
    streamId: number;
    sourceDeviceId: string;
    destinationDeviceId: string;
    ttlMs?: number;
  }): { cancel: () => void } {
    const destinationConn = this.findDeviceConnection(route.destinationDeviceId);
    if (!destinationConn) {
      throw new Error(`No active connection for device: ${route.destinationDeviceId}`);
    }
    return this.registerBinaryRoute({
      requestId: route.requestId,
      streamId: route.streamId,
      origin: { type: "connection", id: destinationConn.id },
      deviceId: route.sourceDeviceId,
      ttlMs: route.ttlMs ?? 60_000,
    });
  }

  private receiveDeviceBinaryStream(route: {
    requestId: string;
    streamId: number;
    sourceDeviceId: string;
    ttlMs?: number;
  }): { stream: ReadableStream<Uint8Array>; cancel: () => void } {
    const ttlMs = route.ttlMs ?? 60_000;
    const pending = this.createPendingBinaryStream(route.streamId, ttlMs);
    let binaryRoute: { cancel: () => void };
    try {
      binaryRoute = this.registerBinaryRoute({
        requestId: route.requestId,
        streamId: route.streamId,
        origin: { type: "app", id: route.requestId },
        deviceId: route.sourceDeviceId,
        ttlMs,
        kind: "native-stream",
      });
    } catch (error) {
      pending.cleanup();
      throw error;
    }

    return {
      stream: pending.stream,
      cancel: () => {
        pending.cleanup();
        binaryRoute.cancel();
      },
    };
  }

  private sendDeviceBinaryFrame(
    deviceId: string,
    streamId: number,
    flags: number,
    payload?: Uint8Array,
  ): void {
    const deviceConn = this.findDeviceConnection(deviceId);
    if (!deviceConn) {
      throw new Error(`No active connection for device: ${deviceId}`);
    }
    deviceConn.send(buildBinaryFrame(streamId, flags, payload));
  }

  private findDeviceConnection(deviceId: string): Connection<ConnectionState> | null {
    for (const [, conn] of this.connections) {
      if (this.isConnectionForDevice(conn, deviceId)) {
        return conn;
      }
    }
    return null;
  }

  private isConnectionForDevice(connection: Connection<ConnectionState>, deviceId: string): boolean {
    const state = connection.state;
    return state?.identity?.role === "driver" && state.identity.device === deviceId;
  }

  private disconnectDeviceConnections(deviceId: string, reason: string): void {
    let closed = false;
    for (const [connId, conn] of Array.from(this.connections)) {
      if (!this.isConnectionForDevice(conn, deviceId)) {
        continue;
      }

      closed = true;
      conn.close(1000, reason);
      this.connections.delete(connId);
      this.runRoutes.clearForConnection(connId);
    }

    if (closed) {
      this.failRoutesForDevice(deviceId);
    }
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
    const wakeAt = new Date(Math.ceil(Math.max(Date.now() + 1_000, dueAtMs) / 1_000) * 1_000);
    const sched = await this.schedule(
      wakeAt,
      "onScheduleDue",
      scheduleId,
    );
    return sched.id;
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

  private buildServiceBindingIdentity(frame: RequestFrame): ConnectionIdentity | null {
    const args = frame.args as Record<string, unknown>;
    const adapterHint =
      typeof args.adapter === "string" && args.adapter.trim().length > 0
        ? args.adapter.trim().toLowerCase()
        : "service-binding";

    const root = this.auth.getPasswdByUid(0);
    if (!root) {
      return null;
    }

    return {
      role: "service",
      process: {
        uid: root.uid,
        gid: root.gid,
        gids: this.auth.resolveGids(root.username, root.gid),
        username: root.username,
        home: root.home,
        cwd: root.home,
      },
      capabilities: this.caps.resolve([102]),
      channel: adapterHint,
    };
  }

  private buildAppBindingIdentity(
    appFrame: AppFrameContext,
  ): ConnectionIdentity | null {
    const user = this.auth.getPasswdByUid(appFrame.uid);
    if (!user || user.username !== appFrame.username) {
      return null;
    }

    const gids = this.auth.resolveGids(user.username, user.gid);
    return {
      role: "user",
      process: {
        uid: user.uid,
        gid: user.gid,
        gids,
        username: user.username,
        home: user.home,
        cwd: user.home,
      },
      capabilities: this.caps.resolve(gids),
    };
  }

  private applyPostDispatchEffects(frame: RequestFrame, response: ResponseFrame): void {
    if (!response.ok) return;

    if (frame.call === "sys.device.delete") {
      const data = (response as {
        data?: {
          deleted?: unknown;
          deviceId?: unknown;
        };
      }).data;
      if (data?.deleted === true && typeof data.deviceId === "string") {
        this.disconnectDeviceConnections(data.deviceId, "Machine forgotten");
      }
    }

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
        action: frame.call === "pkg.remove"
          ? "remove"
          : frame.call === "pkg.checkout"
            ? "checkout"
            : frame.call === "pkg.sync" || frame.call === "sys.bootstrap"
              ? "sync"
              : "install",
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
        if (watch.targetKind === "app") {
          const appClientSession = this.getActiveAppSignalWatchClient(watch);
          if (watch.appSessionId && watch.appClientId && !appClientSession) {
            this.signalWatches.deleteHandled(watch.watchId);
            continue;
          }
          await this.invokePackageAppSignalHandler(watch, processId, frame, appClientSession);
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

  private getActiveAppSignalWatchClient(watch: SignalWatchRecord): AppClientSessionContext | null {
    if (!watch.appSessionId || !watch.appClientId) {
      return null;
    }
    const session = this.appSessions.getActiveForUid(watch.uid, watch.appSessionId);
    if (
      !session ||
      session.packageId !== watch.packageId ||
      session.packageName !== watch.packageName ||
      session.entrypointName !== watch.entrypointName ||
      session.routeBase !== watch.routeBase
    ) {
      return null;
    }
    return session.clients.find((client) => client.clientId === watch.appClientId) ?? null;
  }

  private async invokePackageAppSignalHandler(
    watch: SignalWatchRecord,
    processId: string,
    frame: SignalFrame,
    appClientSession: AppClientSessionContext | null,
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

    const entrypoint = record.manifest.entrypoints.find((candidate) => (
      candidate.kind === "ui" &&
      candidate.name === watch.entrypointName &&
      candidate.route === watch.routeBase
    ));
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
      ...(appClientSession
        ? {
            appSession: {
              sessionId: appClientSession.sessionId,
              clientId: appClientSession.clientId,
              rpcBase: appClientSession.rpcBase,
              expiresAt: appClientSession.expiresAt,
            },
          }
        : {}),
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
    const clientPlatform = frame.args?.client?.platform?.trim();
    if (clientId) {
      for (const [connId, existing] of this.connections) {
        const existingState = existing.state as ConnectionState | undefined;
        if (
          existingState?.step === "connected" &&
          existingState.identity?.process.uid === uid &&
          existingState.identity.role === role &&
          existingState.clientId === clientId &&
          connId !== connection.id &&
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
      clientPlatform: clientPlatform || undefined,
    };
    connection.setState(newState);
    this.connections.set(connection.id, connection);

    if (outcome.identity.role === "driver") {
      this.broadcastDeviceStatus(outcome.identity.device, "connected");
    }

    if (outcome.identity.role === "user") {
      const freshIdentity = outcome.identity.process;
      await ensureDefaultConversationExecutor(ctx, freshIdentity);
      this.reconcileOwnedIdentities(freshIdentity.uid);
      this.scheduleCliDownloadsRefreshForVersion();
    }

    this.sendOk(connection, frame.id, outcome.result);
  }

  private scheduleCliDownloadsRefreshForVersion(): void {
    if (this.config.get(CLI_DOWNLOADS_REFRESHED_VERSION_KEY) === SERVER_VERSION) {
      return;
    }
    if (this.cliDownloadsRefresh) {
      return;
    }

    const lastAttemptAt = Number(this.config.get(CLI_DOWNLOADS_REFRESH_ATTEMPT_KEY) ?? "0");
    if (Number.isFinite(lastAttemptAt) && Date.now() - lastAttemptAt < CLI_DOWNLOADS_REFRESH_RETRY_MS) {
      return;
    }

    this.config.set(CLI_DOWNLOADS_REFRESH_ATTEMPT_KEY, String(Date.now()));
    const refresh = this.withCliDownloadsRefreshSlot(() => this.refreshCliDownloadsForVersion());
    this.ctx.waitUntil(refresh);
  }

  private async handleSysUpdate(
    args: SysUpdateArgs | undefined,
    ctx: KernelContext,
  ): Promise<SysUpdateResult> {
    const result = await this.withCliDownloadsRefreshSlot(
      () => handleSysUpdateDirect(args, ctx),
      { waitForExisting: true },
    );
    this.recordCliDownloadsRefresh(result.cli);
    return result;
  }

  private async withCliDownloadsRefreshSlot<T>(
    run: () => Promise<T>,
    options: { waitForExisting?: boolean } = {},
  ): Promise<T> {
    const previousRefresh = options.waitForExisting ? this.cliDownloadsRefresh : null;
    let releaseSlot: () => void = () => {};
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    const trackedSlot = slot.finally(() => {
      if (this.cliDownloadsRefresh === trackedSlot) {
        this.cliDownloadsRefresh = null;
      }
    });
    this.cliDownloadsRefresh = trackedSlot;

    try {
      if (previousRefresh) {
        await previousRefresh;
      }
      return await run();
    } finally {
      releaseSlot();
    }
  }

  private recordCliDownloadsRefresh(result: SysCliDownloadsResult): void {
    this.config.set(CLI_DOWNLOADS_REFRESHED_VERSION_KEY, SERVER_VERSION);
    this.config.set(CLI_DOWNLOADS_REFRESHED_AT_KEY, String(result.refreshedAt));
  }

  private async refreshCliDownloadsForVersion(): Promise<void> {
    try {
      const result = await refreshCliDownloads(this.env.STORAGE);
      this.recordCliDownloadsRefresh(result);
      console.info(
        `[Kernel] refreshed hosted CLI downloads for ${SERVER_VERSION} channels=${result.mirroredChannels.join(",")} default=${result.defaultChannel}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Kernel] hosted CLI refresh for ${SERVER_VERSION} failed: ${message}`);
    }
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
      await ensureDefaultConversationExecutor(ctx, data.user);
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

  private handleRes(connection: Connection<ConnectionState>, frame: ResponseFrame): void {
    const route = this.routes.get(frame.id);
    if (!route) {
      return;
    }

    if (!this.isConnectionForDevice(connection, route.deviceId)) {
      return;
    }

    this.routes.remove(frame.id);

    this.clearBinaryRoutesForRequest(frame.id);

    if (route.scheduleId) {
      this.cancelSchedule(route.scheduleId).catch(() => {});
    }

    if (route.call === "shell.exec") {
      this.recordShellSessionFromResponse(route.deviceId, frame);
    }

    this.deliverToOrigin(route.origin, frame);
  }

  private handleBinaryMessage(connection: Connection<ConnectionState>, message: WSMessage): void {
    const frame = parseBinaryFrame(message as ArrayBuffer | ArrayBufferView);
    if (!frame) {
      return;
    }

    const route = this.binaryRoutes.get(frame.streamId);
    if (!route) {
      return;
    }

    if (route.kind === "native-stream") {
      this.deliverBinaryToNativeStream(connection, route, frame);
      return;
    }

    if (this.isConnectionForDevice(connection, route.deviceId)) {
      this.deliverBinaryFromDevice(route, frame);
      return;
    }

    if (route.origin.type === "connection" && route.origin.id === connection.id) {
      const deviceConn = this.findDeviceConnection(route.deviceId);
      if (deviceConn) {
        deviceConn.send(buildBinaryFrame(frame.streamId, frame.flags, frame.payload));
      }
    }
  }

  private deliverBinaryToNativeStream(
    connection: Connection<ConnectionState>,
    route: BinaryRoute,
    frame: BinaryFrame,
  ): void {
    const fromOriginConnection =
      route.deviceId === KERNEL_BINARY_DEVICE_ID &&
      route.origin.type === "connection" &&
      route.origin.id === connection.id;
    const fromDeviceConnection =
      route.deviceId !== KERNEL_BINARY_DEVICE_ID &&
      this.isConnectionForDevice(connection, route.deviceId);

    if (!fromOriginConnection && !fromDeviceConnection) {
      return;
    }

    const pending = this.pendingBinaryStreams.get(frame.streamId);
    if (!pending) {
      return;
    }

    if ((frame.flags & BINARY_FRAME_ERROR) !== 0) {
      const message = new TextDecoder().decode(frame.payload) || "Binary transfer failed";
      this.rejectPendingBinaryStream(frame.streamId, new Error(message));
      this.clearBinaryRoute(frame.streamId);
      return;
    }

    if ((frame.flags & BINARY_FRAME_DATA) !== 0 && frame.payload.byteLength > 0) {
      pending.controller.enqueue(frame.payload);
    }

    if ((frame.flags & BINARY_FRAME_END) !== 0) {
      this.closePendingBinaryStream(frame.streamId);
      this.clearBinaryRoute(frame.streamId);
    }
  }

  private deliverBinaryFromDevice(route: BinaryRoute, frame: BinaryFrame): void {
    if (route.origin.type === "connection") {
      const conn = this.connections.get(route.origin.id);
      if (conn) {
        conn.send(buildBinaryFrame(frame.streamId, frame.flags, frame.payload));
      }
      return;
    }
  }

  private handleSig(connection: Connection<ConnectionState>, frame: SignalFrame): void {
    if (frame.signal !== "exec.status") {
      return;
    }

    const state = connection.state as ConnectionState | undefined;
    const targetId = state?.identity?.role === "driver"
      ? state.identity.device
      : null;
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
    const expired = this.routes.remove(routeId);
    if (!expired) return;
    this.clearBinaryRoutesForRequest(routeId);

    const timeoutFrame: ResponseFrame = {
      type: "res",
      id: routeId,
      ok: false,
      error: { code: 504, message: `Syscall ${expired.call} timed out (device: ${expired.deviceId})` },
    };

    this.deliverToOrigin(expired.origin, timeoutFrame);
  }

  async onIpcCallTimeout(callId: string): Promise<void> {
    const timedOut = this.ipcCalls.timeout(callId);
    if (!timedOut) return;

    await this.deliverIpcCallSignal("ipc.timeout", timedOut, {
      error: timedOut.error,
    });
  }

  async onScheduleDue(scheduleId: string, wake?: { id?: unknown }): Promise<void> {
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
    callerOwnerUid = identity?.process.uid,
  ): Promise<SchedulerRunResult> {
    const mode = args.mode ?? "due";
    if (mode === "force" && !args.id) {
      throw new Error("sched.run force requires an id");
    }

    const now = Date.now();
    const records = args.id
      ? [this.schedules.get(args.id)].filter((record): record is ScheduleRecord => record !== null)
      : this.schedules.listDue(now, callerOwnerUid !== undefined && callerOwnerUid !== 0 ? callerOwnerUid : undefined);

    const results: ScheduleRunResult[] = [];
    for (const record of records) {
      if (identity) {
        assertCanManageSchedule(identity, record, callerOwnerUid);
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
    const ctx = this.buildScheduleContext(record);
    if (target.kind === "command.exec") {
      if (!hasCapability(ctx.identity?.capabilities ?? [], "shell.exec")) {
        throw new Error("Permission denied: shell.exec");
      }
      const result = await handleShellExec({
        input: target.command,
        cwd: target.cwd,
        timeout: target.timeoutMs,
      }, ctx);
      if (result.status !== "completed") {
        throw new Error(result.status === "failed" ? result.error : `Command ${result.status}`);
      }
      return {
        kind: "command.exec",
        command: target.command,
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        truncated: result.truncated === true,
      };
    }

    if (target.kind === "process.spawn") {
      const runAs = this.resolveScheduledSpawnRunAs(record, target.runAs);
      const result = await handleProcSpawn({
        interactive: false,
        label: target.label ?? record.name,
        prompt: target.prompt,
        parentPid: target.parentPid,
        cwd: target.cwd,
        assignment: target.assignment,
        ...(runAs ? { runAs } : {}),
      }, ctx);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        kind: "process.spawn",
        pid: result.pid,
      };
    }

    if (target.kind === "process.event") {
      const proc = this.procs.get(target.pid);
      if (!proc) {
        throw new Error(`Process not found: ${target.pid}`);
      }
      if (proc.ownerUid !== record.ownerUid && record.ownerUid !== 0) {
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
    const process = this.resolveScheduleIdentity(record);
    const identity: ConnectionIdentity = {
      role: "user",
      process,
      capabilities: this.caps.resolve(process.gids),
    };

    return this.buildKernelContext({
      identity,
      callerOwnerUid: record.ownerUid,
    });
  }

  private resolveScheduleIdentity(record: ScheduleRecord): ProcessIdentity {
    const uid = record.runAs.uid;
    const account = this.auth.getPasswdByUid(uid);
    if (!account) {
      throw new Error(`Cannot resolve schedule run-as uid ${uid}`);
    }

    return {
      uid: account.uid,
      gid: account.gid,
      gids: this.auth.resolveGids(account.username, account.gid),
      username: account.username,
      home: account.home,
      cwd: account.home,
    };
  }

  private resolveScheduledSpawnRunAs(record: ScheduleRecord, targetRunAs?: string): string | undefined {
    if (targetRunAs) {
      return targetRunAs;
    }
    // A process-principal schedule records a run-as account and an origin pid.
    // Execution must keep the account without depending on that pid still being
    // alive as the spawn parent.
    return record.runAs.kind === "process" || record.runAs.kind === "service"
      ? record.runAs.username
      : undefined;
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
      this.clearBinaryRoutesForRequest(entry.id);
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

  private failRoutesForConnection(connectionId: string): void {
    const failed = this.routes.failForConnection(connectionId);
    for (const entry of failed) {
      this.clearBinaryRoutesForRequest(entry.id);
      if (entry.scheduleId) {
        this.cancelSchedule(entry.scheduleId).catch(() => {});
      }
    }
  }

  /**
   * Reconcile the run-as identity of every process owned by `ownerUid` against
   * the auth store. Each process keeps its run-as account (preserving the
   * personal-agent split); only group/home/gid drift for that account is
   * refreshed, and identity.changed is emitted when it changes.
   */
  private reconcileOwnedIdentities(ownerUid: number): void {
    for (const proc of this.procs.list(ownerUid)) {
      const entry = this.auth.getPasswdByUsername(proc.username);
      if (!entry) continue;

      const fresh: ProcessIdentity = {
        uid: entry.uid,
        gid: entry.gid,
        gids: this.auth.resolveGids(entry.username, entry.gid),
        username: entry.username,
        home: entry.home,
        cwd: proc.cwd,
      };

      if (
        proc.gid === fresh.gid &&
        proc.home === fresh.home &&
        proc.username === fresh.username &&
        JSON.stringify(proc.gids) === JSON.stringify(fresh.gids)
      ) {
        continue;
      }

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
    }

    // Reconcile registered device online flags with live rehydrated sockets.
    for (const device of this.devices.listOnline()) {
      if (!onlineTargets.has(device.device_id)) {
        this.devices.setOnline(device.device_id, false);
        this.broadcastDeviceStatus(device.device_id, "disconnected");
      }
    }
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

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function scheduleResultSummary(record: ScheduleRecord, result: unknown): string {
  const value = asRecord(result);
  if (record.target.kind === "command.exec") {
    return typeof value?.exitCode === "number"
      ? `command exited ${value.exitCode}`
      : "command failed";
  }
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
