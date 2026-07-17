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
import type {
  Frame,
  FrameBody,
  RequestFrame,
  ResponseOkFrame,
  ResponseFrame,
  SignalFrame,
} from "../protocol/frames";
import type {
  AdapterMedia,
  AdapterMediaPart,
  AdapterInboundResult,
  AdapterSurface,
  BinaryBody,
  ConnectionIdentity,
  NetFetchArgs,
  PkgPublicListResult,
  ProcessIdentity,
  ScheduleRecord,
  ScheduleRunResult,
  SchedulerRunArgs,
  SchedulerRunResult,
} from "@humansandmachines/gsv/protocol";
import {
  BinaryBodyChannel,
  REQUEST_CANCEL_SIGNAL,
  bundleAdapterMedia,
  cancelBinaryBody,
  type BinaryFrameDescriptor,
  type OutgoingBinaryBody,
} from "@humansandmachines/gsv/protocol";
import type { SyscallName } from "../syscalls";
import { AuthStore } from "./auth-store";
import { CapabilityStore, hasCapability } from "./capabilities";
import { ConfigStore } from "./config";
import { DeviceRegistry } from "./devices";
import {
  RoutingTable,
  type FailedDeviceRoute,
  type RouteOrigin,
} from "./routing";
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
import { bindStreamToAbort } from "../shared/streams";
import { raceWithAbort } from "../shared/abort";
import type { KernelContext } from "./context";
import { sendFrameToProcess } from "../shared/utils";
import { stableOpaqueId } from "../shared/stable-id";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../shared/message-media-limits";
import {
  agentArchiveMediaPath,
  isValidAgentArchiveMediaObject,
  processMediaPath,
  processMediaPrefix,
} from "../shared/process-media-path";
import { handleSysSetup as handleKernelSetup } from "./sys/setup";
import { buildAppRunnerName } from "../protocol/app-session";
import { handleSysSetupAssist } from "./sys/setup-assist";
import { completeOAuthCallback as completeOAuthCallbackFlow } from "./sys/oauth";
import type { McpAddConnectionInput, McpAddConnectionResult } from "./sys/mcp";
import { installMcpDiscoveryCompatibility } from "./mcp-compat";
import { oauthCallbackHtmlResponse } from "../oauth-http";
import { isInternalOnlySyscall } from "./syscall-exposure";
import {
  handleAdapterSend,
  deliverAdapterReply,
  normalizeAdapterHilRequest,
  renderAdapterHilPrompt,
  setAdapterActivityForKernel,
} from "./adapter-handlers";
import { assertAdapterMessageDestinationAccess } from "./adapter-destinations";
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
import type {
  ProcessScheduleDeliverRequestFrame,
  ProcessScheduleDeliverResponseFrame,
} from "../protocol/process-frames";
import { listLocalPublicPackages } from "./pkg";
import { isRepoPublic } from "./repo-visibility";
import { canReadRepo, canWriteRepo } from "./repo";
import { handleProcSpawn } from "./proc-handlers";
import { ensureDefaultConversationExecutor } from "./agents";
import { handleShellExec } from "../drivers/native/shell";
import { getVisibleTarget } from "./targets";
import { runKernelSqlMigrations } from "./schema/migrations";
import { SERVER_VERSION } from "../version";

const PROCESS_REQUEST_CANCEL_TTL_MS = 60_000;
const MAX_PROCESS_REQUEST_CANCELLATIONS = 1024;
const MAX_REQUEST_CANCEL_REASON_LENGTH = 512;
const MAX_ONE_SHOT_SCHEDULE_DELIVERY_ATTEMPTS = 10;
const MAX_ADAPTER_SIGNAL_DELIVERY_ATTEMPTS = 10;

type AdapterSignalDeliveryOutcome =
  | { state: "delivered" }
  | { state: "skipped" }
  | { state: "retryable" | "permanent" | "ambiguous"; error: string };

type AdapterSignalDeliveryRetry = {
  runId: string;
  processId: string;
  signal: string;
  payload: unknown;
  attempt: number;
};

type AdapterImmediateDeliveryRetry = {
  adapter: string;
  accountId: string;
  surface: AdapterSurface;
  deliveryId: string;
  text: string;
  replyToId?: string;
  attempt: number;
};

type ProcessDeliveryNoticeRetry = {
  noticeId: string;
  runId: string;
  processId: string;
  conversationId: string;
  deliveryKind: "hil" | "final";
  state: "permanent" | "ambiguous" | "exhausted";
  message: string;
  cleanupRunRoute: boolean;
};

class ScheduleTargetDispatchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ScheduleTargetDispatchError";
  }
}

class AdapterReplyMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterReplyMediaError";
  }
}

function scheduleDeliveryRetryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

function adapterSignalRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

type ConnectionState = {
  step: "pending" | "connected" | "superseded";
  identity?: ConnectionIdentity;
  clientId?: string;
  clientPlatform?: string;
};

type ProcessNetFetchOptions = {
  ttlMs?: number;
  internalPurpose?: "model-transport";
  body?: FrameBody;
  requestId?: string;
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
  private readonly frameBodyChannels = new Map<string, BinaryBodyChannel>();
  private readonly routedBodies = new Map<
    string,
    { cancel(reason?: unknown): Promise<void> }
  >();
  private readonly activeRequests = new Map<
    string,
    { origin: RouteOrigin; controller: AbortController }
  >();
  private readonly cancelledProcessRequests = new Map<
    string,
    { expiresAt: number; reason: string }
  >();

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
    for (const callId of this.ipcCalls.recoverDeliveryIds()) {
      this.queueIpcCallDelivery(callId);
    }
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
      this.broadcastToUserUid(uid, "mcp.changed");
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
    this.closeFrameBodyChannel(connection.id);
    const state = connection.state as ConnectionState | undefined;
    if (!state) return;

    this.connections.delete(connection.id);
    const origin: RouteOrigin = { type: "connection", id: connection.id };
    for (const [requestId, request] of this.activeRequests) {
      if (sameRouteOrigin(request.origin, origin)) {
        this.cancelRequest(origin, requestId, "Origin disconnected", false);
      }
    }

    const identity = state.identity;

    if (identity?.role === "driver") {
      if (state.step === "connected" && !this.findDeviceConnection(identity.device)) {
        this.devices.setOnline(identity.device, false);
        this.broadcastDeviceStatus(identity.device, "disconnected");
        this.failRoutesForDevice(identity.device);
      } else {
        this.failRoutesForDriverConnection(connection.id);
      }
    }

    this.failRoutesForConnection(connection.id);
    this.runRoutes.clearForConnection(connection.id);
  }

  async onMessage(connection: Connection<ConnectionState>, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      this.handleBinaryMessage(connection, message);
      return;
    }

    let parsed: Frame;
    try {
      const value = JSON.parse(message) as unknown;
      if (!value || typeof value !== "object") {
        throw new Error("Invalid frame");
      }
      parsed = value as Frame;
    } catch {
      this.sendError(connection, "?", 400, "Malformed JSON");
      return;
    }

    const valid = parsed.type === "req"
      ? typeof parsed.id === "string" && typeof parsed.call === "string"
      : parsed.type === "res"
        ? typeof parsed.id === "string" && typeof parsed.ok === "boolean"
        : parsed.type === "sig" && typeof parsed.signal === "string";
    if (!valid) {
      this.sendError(connection, "?", 400, "Invalid frame");
      return;
    }

    switch (parsed.type) {
      case "req":
        await this.handleReq(connection, parsed);
        break;
      case "res":
        this.handleRes(connection, parsed);
        break;
      case "sig":
        if ((parsed as unknown as { body?: unknown }).body !== undefined) {
          this.sendError(connection, "?", 400, "Signals cannot carry bodies");
          return;
        }
        if (parsed.signal === REQUEST_CANCEL_SIGNAL) {
          this.handleRequestCancel(connection, parsed);
        } else {
          this.handleSig(connection, parsed);
        }
        break;
    }
  }

  private handleRequestCancel(
    connection: Connection<ConnectionState>,
    frame: SignalFrame,
  ): void {
    if (connection.state?.step !== "connected") {
      return;
    }
    const payload = asRecord(frame.payload);
    const requestId = typeof payload?.id === "string" ? payload.id : "";
    const reason = typeof payload?.reason === "string" ? payload.reason : undefined;
    this.cancelRequest(
      { type: "connection", id: connection.id },
      requestId,
      reason,
      false,
    );
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
      try {
        return await this.handleProcessReq(processId, frame);
      } finally {
        await cancelUnlockedBody(frame.body, "Process request completed");
      }
    }

    if (frame.type === "sig") {
      const runId = this.extractRunId(frame.payload);
      if (!this.updateProcessRuntimeFromSignal(processId, frame, runId)) {
        if (frame.signal === "proc.run.finished" && runId) {
          this.runRoutes.delete(runId);
        }
        return null;
      }
      const delivered = this.enqueueProcessSignal(processId, frame);
      this.completeIpcCallsForProcessSignal(processId, frame);
      if (
        frame.signal === "proc.run.finished"
        || frame.signal === "proc.run.hil.requested"
      ) {
        await delivered;
      } else {
        this.ctx.waitUntil(delivered.catch(() => undefined));
      }
      return null;
    }

    return null;
  }

  async requestProcessNetFetch(
    processId: string,
    target: string,
    args: NetFetchArgs,
    options: ProcessNetFetchOptions = {},
  ): Promise<ResponseOkFrame<"net.fetch">> {
    let controller: AbortController | null = null;
    const origin: RouteOrigin = { type: "process", id: processId };
    try {
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
      if (options.requestId) {
        controller = this.registerActiveRequest(origin, options.requestId);
      }
      const response = await this.requestDevice(
        device.targetId,
        "net.fetch",
        args,
        {
          ttlMs: options.ttlMs,
          ...(options.body ? { body: options.body } : {}),
          ...(options.requestId ? { id: options.requestId } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        },
      );
      return response as ResponseOkFrame<"net.fetch">;
    } finally {
      if (options.requestId && controller) {
        this.finishActiveRequest(options.requestId, controller);
      }
      await cancelUnlockedBody(options.body, "Process net.fetch completed");
    }
  }

  cancelProcessRequests(processId: string, requestIds: string[], reason?: string): number {
    if (!processId || !Array.isArray(requestIds)) {
      return 0;
    }
    const origin: RouteOrigin = { type: "process", id: processId };
    let cancelled = 0;
    for (const requestId of new Set(requestIds)) {
      if (this.cancelRequest(origin, requestId, reason, true)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /**
   * Service-binding RPC entrypoint.
   * Accepts the same frame format as WS connections/process RPC.
   */
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    const body = "body" in frame ? frame.body : undefined;
    try {
      if (frame.type !== "req") {
        return null;
      }
      return await this.handleServiceReq(frame);
    } finally {
      await cancelUnlockedBody(body, "Service request completed");
    }
  }

  async appRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame> {
    try {
      return await this.handleAppRequest(appFrame, frame);
    } finally {
      await cancelUnlockedBody(frame.body, "App request completed");
    }
  }

  private async handleAppRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame> {
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
    try {
      const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());
      if (!result.handled) {
        return await pending.promise;
      }

      this.applyPostDispatchEffects(frame, result.response);
      return result.response;
    } finally {
      pending.cleanup();
    }
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

    // Signal watches are scoped to the process owner, not the run-as account.
    // App runtimes register watches under the owning human uid, while the
    // emitting process may run as a personal/package agent.
    await this.dispatchSignalWatches(ownerUid, processId, frame);

    if (!isUserProcessSignal(frame.signal)) return;

    const isHilRequest = frame.signal === "proc.run.hil.requested";
    const route = runId ? this.runRoutes.get(runId) : null;

    // Client-facing process signals route by the owning human (owner_uid), not the
    // run-as identity (which may be the personal agent account).
    if (isHilRequest || !route) {
      this.broadcastToUserUid(ownerUid, frame.signal, frame.payload);
    }
    if (!runId || !route) {
      return;
    }

    if (route.uid !== ownerUid || route.processId !== processId) {
      this.runRoutes.delete(runId);
      return;
    }

    if (route.kind === "connection") {
      if (!isHilRequest) {
        this.deliverSignalToConnection(route, frame, ownerUid);
      }
      if (frame.signal === "proc.run.finished") {
        this.runRoutes.delete(runId);
      }
      return;
    }

    if (frame.signal === "proc.run.hil.requested") {
      // HIL admission waits only for a durable outbox write, never for provider
      // delivery. This prevents a Kernel crash during the first provider call
      // from losing the approval notification after Process has entered HIL.
      await this.queueAdapterSignalDelivery(route, frame, 1);
      return;
    }
    if (frame.signal === "proc.run.finished") {
      await this.attemptAdapterSignalDelivery(route, frame, 1);
      return;
    }
    await this.deliverSignalToAdapter(route, frame);
  }

  private async attemptAdapterSignalDelivery(
    route: AdapterRunRoute,
    frame: SignalFrame,
    attempt: number,
  ): Promise<void> {
    let outcome: AdapterSignalDeliveryOutcome;
    try {
      outcome = await this.deliverSignalToAdapter(route, frame);
    } catch (error) {
      outcome = {
        state: error instanceof AdapterReplyMediaError ? "permanent" : "retryable",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.state === "retryable" && attempt < MAX_ADAPTER_SIGNAL_DELIVERY_ATTEMPTS) {
      await this.queueAdapterSignalDelivery(route, frame, attempt + 1);
      return;
    }

    if (outcome.state === "delivered" || outcome.state === "skipped") {
      if (frame.signal === "proc.run.finished") {
        this.runRoutes.delete(route.runId);
      }
      return;
    }

    const terminalState = outcome.state === "retryable" ? "exhausted" : outcome.state;
    const deliveryError = outcome.error;
    const label = frame.signal === "proc.run.hil.requested"
      ? "approval notification"
      : "automatic reply";
    await this.queueProcessDeliveryNotice(route, frame, {
      state: terminalState,
      message: terminalState === "ambiguous"
        ? `The ${label} reached the adapter, but provider delivery is ambiguous. It was not retried to avoid a duplicate.`
        : terminalState === "permanent"
          ? `The ${label} could not be delivered: ${deliveryError}`
          : `The ${label} stopped after ${attempt} retry-safe delivery attempts: ${deliveryError}`,
    });
  }

  private async queueAdapterSignalDelivery(
    route: AdapterRunRoute,
    frame: SignalFrame,
    attempt: number,
  ): Promise<void> {
    await this.schedule(
      new Date(Date.now() + (attempt === 1 ? 10 : adapterSignalRetryDelayMs(attempt - 1))),
      "onAdapterSignalDelivery",
      {
        runId: route.runId,
        processId: route.processId,
        signal: frame.signal,
        payload: frame.payload,
        attempt,
      } satisfies AdapterSignalDeliveryRetry,
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  }

  async onAdapterSignalDelivery(input: AdapterSignalDeliveryRetry): Promise<void> {
    if (
      !input
      || typeof input.runId !== "string"
      || typeof input.processId !== "string"
      || typeof input.signal !== "string"
      || !Number.isSafeInteger(input.attempt)
      || input.attempt < 1
    ) {
      return;
    }
    const route = this.runRoutes.get(input.runId);
    if (!route || route.kind !== "adapter" || route.processId !== input.processId) {
      return;
    }
    await this.attemptAdapterSignalDelivery(route, {
      type: "sig",
      signal: input.signal,
      payload: input.payload,
    }, input.attempt);
  }

  private async queueProcessDeliveryNotice(
    route: AdapterRunRoute,
    frame: SignalFrame,
    outcome: { state: "permanent" | "ambiguous" | "exhausted"; message: string },
  ): Promise<void> {
    const payload = frame.payload && typeof frame.payload === "object"
      ? frame.payload as Record<string, unknown>
      : {};
    const deliveryKind = frame.signal === "proc.run.hil.requested" ? "hil" : "final";
    const noticeId = await stableOpaqueId("process-delivery-notice", [
      route.runId,
      deliveryKind,
      outcome.state,
    ]);
    await this.schedule(
      new Date(Date.now() + 10),
      "onProcessDeliveryNotice",
      {
        noticeId,
        runId: route.runId,
        processId: route.processId,
        conversationId: typeof payload.conversationId === "string"
          ? payload.conversationId
          : "default",
        deliveryKind,
        state: outcome.state,
        message: outcome.message,
        cleanupRunRoute: deliveryKind === "final",
      } satisfies ProcessDeliveryNoticeRetry,
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  }

  async onProcessDeliveryNotice(input: ProcessDeliveryNoticeRetry): Promise<void> {
    if (
      !input
      || typeof input.noticeId !== "string"
      || typeof input.runId !== "string"
      || typeof input.processId !== "string"
      || typeof input.conversationId !== "string"
      || typeof input.message !== "string"
    ) {
      return;
    }
    const route = this.runRoutes.get(input.runId);
    if (!route || route.kind !== "adapter" || route.processId !== input.processId) {
      return;
    }
    await sendFrameToProcess(input.processId, {
      type: "sig",
      signal: "proc.delivery.notice",
      payload: {
        noticeId: input.noticeId,
        runId: input.runId,
        conversationId: input.conversationId,
        deliveryKind: input.deliveryKind,
        state: input.state,
        message: input.message,
      },
    });
    if (input.cleanupRunRoute) {
      this.runRoutes.delete(input.runId);
    }
  }

  private async deliverAdapterInboundImmediateReplies(
    frame: RequestFrame,
    response: ResponseFrame,
  ): Promise<void> {
    if (!response.ok || !response.data || typeof response.data !== "object") return;
    const result = response.data as AdapterInboundResult;
    if (!result.ok) return;
    const args = frame.args && typeof frame.args === "object"
      ? frame.args as Record<string, unknown>
      : {};
    const inbound = args.message && typeof args.message === "object"
      ? args.message as Record<string, unknown>
      : {};
    const rawSurface = inbound.surface && typeof inbound.surface === "object"
      ? inbound.surface as Record<string, unknown>
      : {};
    const adapter = typeof args.adapter === "string" ? args.adapter.trim().toLowerCase() : "";
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : "";
    const surfaceId = typeof rawSurface.id === "string" ? rawSurface.id.trim() : "";
    const surfaceKind = rawSurface.kind;
    if (
      !adapter
      || !accountId
      || !surfaceId
      || (surfaceKind !== "dm" && surfaceKind !== "group" && surfaceKind !== "channel" && surfaceKind !== "thread")
    ) {
      return;
    }
    const surface: AdapterSurface = {
      kind: surfaceKind,
      id: surfaceId,
      ...(typeof rawSurface.threadId === "string" && rawSurface.threadId.trim()
        ? { threadId: rawSurface.threadId.trim() }
        : {}),
    };
    const providerMessageId = typeof inbound.messageId === "string"
      ? inbound.messageId.trim()
      : undefined;
    const jobs: AdapterImmediateDeliveryRetry[] = [];
    if (result.challenge?.prompt) {
      jobs.push({
        adapter,
        accountId,
        surface,
        deliveryId: result.challenge.deliveryId,
        text: result.challenge.prompt,
        ...(providerMessageId ? { replyToId: providerMessageId } : {}),
        attempt: 1,
      });
    }
    if (result.reply?.text) {
      jobs.push({
        adapter,
        accountId,
        surface,
        deliveryId: result.reply.deliveryId,
        text: result.reply.text,
        ...(result.reply.replyToId || providerMessageId
          ? { replyToId: result.reply.replyToId || providerMessageId }
          : {}),
        attempt: 1,
      });
    }
    for (const job of jobs) {
      await this.queueAdapterImmediateDelivery(job);
    }
  }

  private async attemptAdapterImmediateDelivery(
    job: AdapterImmediateDeliveryRetry,
    ctx: KernelContext,
  ): Promise<void> {
    const result = await handleAdapterSend({
      adapter: job.adapter,
      accountId: job.accountId,
      deliveryId: job.deliveryId,
      surface: job.surface,
      text: job.text,
      replyToId: job.replyToId,
    }, ctx);
    if (result.ok) {
      if (result.deliveryState === "ambiguous") {
        console.warn(`[Kernel] Adapter ingress reply ${job.deliveryId} has ambiguous delivery`);
      }
      return;
    }
    if (result.retryable && job.attempt < MAX_ADAPTER_SIGNAL_DELIVERY_ATTEMPTS) {
      await this.queueAdapterImmediateDelivery({ ...job, attempt: job.attempt + 1 });
      return;
    }
    console.warn(
      `[Kernel] Adapter ingress reply ${job.deliveryId} stopped after attempt ${job.attempt}: ${result.error}`,
    );
  }

  private async queueAdapterImmediateDelivery(
    job: AdapterImmediateDeliveryRetry,
  ): Promise<void> {
    await this.schedule(
      new Date(Date.now() + (job.attempt === 1 ? 100 : adapterSignalRetryDelayMs(job.attempt - 1))),
      "onAdapterImmediateDelivery",
      job,
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  }

  async onAdapterImmediateDelivery(input: AdapterImmediateDeliveryRetry): Promise<void> {
    if (
      !input
      || typeof input.adapter !== "string"
      || typeof input.accountId !== "string"
      || typeof input.deliveryId !== "string"
      || typeof input.text !== "string"
      || !input.surface
      || typeof input.surface.id !== "string"
      || !Number.isSafeInteger(input.attempt)
      || input.attempt < 1
    ) {
      return;
    }
    const identity = this.buildServiceBindingIdentity({
      type: "req",
      id: crypto.randomUUID(),
      call: "adapter.send",
      args: { adapter: input.adapter },
    } as RequestFrame);
    if (!identity) {
      console.warn(`[Kernel] Cannot resume adapter ingress reply ${input.deliveryId}: service identity unavailable`);
      return;
    }
    await this.attemptAdapterImmediateDelivery(
      input,
      this.buildKernelContext({ identity }),
    );
  }

  private updateProcessRuntimeFromSignal(
    processId: string,
    frame: SignalFrame,
    runId: string | null,
  ): boolean {
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
    const current = this.procs.get(processId);
    if (!current) {
      return false;
    }
    const runtimeSignal = frame.signal === "proc.changed" || frame.signal.startsWith("proc.run.");
    if (
      runtimeSignal
      && runId
      && frame.signal !== "proc.changed"
      && current.activeRunId !== runId
    ) {
      if (frame.signal === "proc.run.started") {
        if (timestamp < (current.lastActiveAt ?? Number.NEGATIVE_INFINITY)) {
          return false;
        }
      } else {
        return frame.signal === "proc.run.finished";
      }
    }

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
        patchForActive("running");
        return true;
      case "proc.run.tool.started":
        patchForActive("waiting_tool");
        return true;
      case "proc.run.hil.requested":
        patchForActive("waiting_hil");
        return true;
      case "proc.run.finished":
        this.procs.updateRuntimeState(processId, {
          state: queuedCount && queuedCount > 0 ? "queued" : "idle",
          activeRunId: null,
          activeConversationId: null,
          ...(queuedCount !== undefined ? { queuedCount } : {}),
          lastActiveAt: timestamp,
        });
        return true;
      case "proc.changed":
        if (
          runId
          && current.activeRunId === runId
          && Array.isArray(payload.changes)
          && payload.changes.includes("messages")
        ) {
          patchForActive("running");
          return true;
        }
        if (queuedCount !== undefined) {
          this.procs.updateRuntimeState(processId, {
            queuedCount,
            lastActiveAt: timestamp,
          });
        }
        return true;
      default:
        return true;
    }
  }

  private enqueueProcessSignal(processId: string, frame: SignalFrame): Promise<void> {
    const previous = this.pendingProcessSignals.get(processId) ?? Promise.resolve();
    const delivery = previous.then(() => this.handleProcessSignal(processId, frame));
    const queued = delivery
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
    return delivery;
  }

  private completeIpcCallsForProcessSignal(processId: string, frame: SignalFrame): void {
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
    const status = typeof payload.status === "string" ? payload.status : "ok";
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    const error = typeof payload.error === "string"
      ? payload.error
      : status === "aborted"
        ? `Target run was aborted${reason ? `: ${reason}` : ""}`
        : status === "error"
          ? "Target run failed"
          : null;
    if (status === "aborted") {
      this.ipcCalls.cancelBySourceRun({
        uid: ownerUid,
        sourcePid: processId,
        sourceRunId: runId,
      });
    }
    const completed = this.ipcCalls.completeByRun({
      uid: ownerUid,
      targetPid: processId,
      runId,
      response,
      error,
    });

    for (const callId of completed) {
      this.queueIpcCallDelivery(callId);
    }
  }

  private queueIpcCallDelivery(callId: string): void {
    this.ctx.waitUntil(this.schedule(
      new Date(Date.now() + 10),
      "onIpcCallDelivery",
      callId,
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    ).catch(() => this.deliverIpcCall(callId)));
  }

  private async deliverIpcCall(callId: string): Promise<void> {
    const call = this.ipcCalls.claimDelivery(callId);
    if (!call) {
      return;
    }
    try {
      await this.deliverIpcCallSignal(call);
      this.ipcCalls.remove(callId);
    } catch (error) {
      this.ipcCalls.releaseDelivery(callId);
      console.warn(`[Kernel] Failed to deliver IPC call ${callId}:`, error);
      await this.schedule(5, "onIpcCallDelivery", callId, {
        idempotent: false,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      });
    }
  }

  private async deliverIpcCallSignal(call: IpcCallRecord): Promise<void> {
    await sendFrameToProcess(call.sourcePid, {
      type: "sig",
      signal: call.status === "timed_out" ? "ipc.timeout" : "ipc.reply",
      payload: {
        callId: call.callId,
        sourcePid: call.sourcePid,
        ...(call.sourceRunId ? { sourceRunId: call.sourceRunId } : {}),
        targetPid: call.targetPid,
        runId: call.targetRunId,
        deadlineAt: call.deadlineAt,
        createdAt: call.createdAt,
        status: call.status,
        ...(call.status === "completed" ? { response: call.response } : {}),
        ...(call.error ? { error: call.error } : {}),
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
      this.broadcastToUserUid(uid, frame.signal, frame.payload);
      return;
    }

    conn.send(JSON.stringify(frame));
  }

  private async deliverSignalToAdapter(
    route: AdapterRunRoute,
    frame: SignalFrame,
  ): Promise<AdapterSignalDeliveryOutcome> {
    if (frame.signal === "proc.run.started") {
      await setAdapterActivityForKernel(
        this.env,
        route.adapter,
        route.accountId,
        {
          kind: route.surfaceKind,
          id: route.surfaceId,
          threadId: route.threadId,
        },
        { kind: "typing", active: true },
      );
      return { state: "delivered" };
    }

    if (frame.signal === "proc.run.hil.requested") {
      const request = normalizeAdapterHilRequest(frame.payload, "signal");
      if (!request) {
        await setAdapterActivityForKernel(
          this.env,
          route.adapter,
          route.accountId,
          {
            kind: route.surfaceKind,
            id: route.surfaceId,
            threadId: route.threadId,
          },
          { kind: "typing", active: false },
        ).catch(() => undefined);
        return { state: "skipped" };
      }

      const surface = {
        kind: route.surfaceKind,
        id: route.surfaceId,
        threadId: route.threadId,
      } as const;

      try {
        return await this.deliverAdapterRouteReply(route, {
          deliveryId: `${route.runId}:hil:${request.requestId}`,
          text: renderAdapterHilPrompt(request, route.surfaceKind, "initial"),
        });
      } finally {
        await setAdapterActivityForKernel(
          this.env,
          route.adapter,
          route.accountId,
          surface,
          { kind: "typing", active: false },
        ).catch((error) => {
          console.warn(`[Kernel] Failed to stop adapter typing for ${route.runId}:`, error);
        });
      }
    }

    if (frame.signal !== "proc.run.finished") {
      return { state: "skipped" };
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

    try {
      const attachmentBundle = await this.bundleProcessReplyMedia(
        route.processId,
        payload.media,
      );

      if (!text.trim() && attachmentBundle.media.length === 0) {
        return { state: "delivered" };
      }
      return await this.deliverAdapterRouteReply(route, {
        deliveryId: `${route.runId}:finished`,
        text,
        ...(attachmentBundle.media.length > 0 ? { media: attachmentBundle.media } : {}),
      }, attachmentBundle.body);
    } finally {
      await setAdapterActivityForKernel(
        this.env,
        route.adapter,
        route.accountId,
        surface,
        { kind: "typing", active: false },
      ).catch((error) => {
        console.warn(`[Kernel] Failed to stop adapter typing for ${route.runId}:`, error);
      });
    }
  }

  private async deliverAdapterRouteReply(
    route: AdapterRunRoute,
    message: {
      deliveryId: string;
      text: string;
      media?: AdapterMedia[];
      replyToId?: string;
    },
    body?: BinaryBody,
  ): Promise<AdapterSignalDeliveryOutcome> {
    const ctx = this.buildProcessContext(route.processId, route.runId);
    if (!ctx) {
      await cancelBinaryBody(body, "Reply route references a missing process");
      console.warn(`[Kernel] Reply route references missing process ${route.processId}`);
      return { state: "permanent", error: "Reply route references a missing process" };
    }

    const destination = {
      kind: "adapter",
      adapter: route.adapter,
      accountId: route.accountId,
      actorId: route.actorId,
      surface: {
        kind: route.surfaceKind,
        id: route.surfaceId,
        threadId: route.threadId,
      },
    } as const;
    try {
      assertAdapterMessageDestinationAccess(destination, route.uid, ctx);
    } catch (error) {
      await cancelBinaryBody(body, error);
      // Revocation is a permanent delivery outcome, not a transport outage.
      // A HIL signal was already broadcast to any connected GSV client, and a
      // terminal result must not retry forever after the user removes access.
      console.warn(
        `[Kernel] Dropping revoked adapter reply route ${route.runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        state: "permanent",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const result = await deliverAdapterReply(destination, route.uid, {
      ...message,
      replyToId: message.replyToId ?? route.replyToId,
    }, ctx, body);
    if (!result.ok) {
      const detail = `Adapter reply failed (${route.adapter}): ${result.error}`;
      if (result.retryable) {
        return { state: "retryable", error: detail };
      }
      console.warn(`[Kernel] Dropping permanent adapter delivery ${message.deliveryId}: ${detail}`);
      return { state: "permanent", error: detail };
    }
    if (result.deliveryState === "ambiguous") {
      return {
        state: "ambiguous",
        error: `Adapter delivery ${message.deliveryId} is ambiguous`,
      };
    }
    return { state: "delivered" };
  }

  private async bundleProcessReplyMedia(
    processId: string,
    value: unknown,
  ): Promise<{ media: AdapterMedia[]; body?: BinaryBody }> {
    if (value === undefined) {
      return { media: [] };
    }
    if (!Array.isArray(value)) {
      throw new AdapterReplyMediaError("Process reply media must be an array");
    }
    if (value.length > MAX_MESSAGE_MEDIA_ITEMS) {
      throw new AdapterReplyMediaError(
        `Process reply media exceeds item limit (${MAX_MESSAGE_MEDIA_ITEMS})`,
      );
    }
    const process = this.procs.get(processId);
    if (!process) {
      throw new AdapterReplyMediaError(`Unknown process for reply media: ${processId}`);
    }

    const prefix = processMediaPrefix(process.uid, processId);
    const parts: AdapterMediaPart[] = [];
    let totalBytes = 0;
    try {
      for (const raw of value) {
        if (!raw || typeof raw !== "object") {
          throw new AdapterReplyMediaError("Process reply media entries must be objects");
        }
        const item = raw as Record<string, unknown>;
        const key = typeof item.key === "string" ? item.key.trim() : "";
        const activePath = key.startsWith(prefix) ? processMediaPath(key) : null;
        const archivePath = key ? agentArchiveMediaPath(process.home, key) : null;
        const path = activePath ?? archivePath;
        if (!key || !path || item.path !== path) {
          throw new AdapterReplyMediaError("Process reply media key is outside the emitting process");
        }
        if (!(["image", "audio", "video", "document"] as unknown[]).includes(item.type)) {
          throw new AdapterReplyMediaError("Process reply media has an invalid type");
        }
        const mimeType = typeof item.mimeType === "string" ? item.mimeType.trim() : "";
        if (!mimeType) {
          throw new AdapterReplyMediaError("Process reply media requires mimeType");
        }
        const object = await this.env.STORAGE.get(key);
        if (!object) {
          throw new AdapterReplyMediaError(`Process reply media not found: ${key}`);
        }
        if (
          archivePath
          && !isValidAgentArchiveMediaObject({
            home: process.home,
            key,
            uid: process.uid,
            gid: process.gid,
            object,
            expectedContentType: mimeType,
          })
        ) {
          await object.body.cancel("Process reply archive metadata mismatch").catch(() => {});
          throw new AdapterReplyMediaError(
            `Process reply media archive metadata does not match the emitting process: ${key}`,
          );
        }
        if (object.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
          await object.body.cancel("Process reply media exceeds the per-item limit").catch(() => {});
          throw new AdapterReplyMediaError(
            `Process reply media exceeds per-item limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes)`,
          );
        }
        totalBytes += object.size;
        if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
          await object.body.cancel("Process reply media exceeds the total limit").catch(() => {});
          throw new AdapterReplyMediaError(
            `Process reply media exceeds total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
          );
        }
        const storedMimeType = object.httpMetadata?.contentType || "application/octet-stream";
        if (storedMimeType !== mimeType || item.size !== object.size) {
          await object.body.cancel("Process reply media descriptor mismatch").catch(() => {});
          throw new AdapterReplyMediaError(
            `Process reply media descriptor does not match stored data: ${key}`,
          );
        }
        parts.push({
          media: {
            type: item.type as AdapterMedia["type"],
            mimeType,
            size: object.size,
            ...(typeof item.filename === "string" && item.filename
              ? { filename: item.filename }
              : {}),
            ...(typeof item.duration === "number" && Number.isFinite(item.duration)
              ? { duration: item.duration }
              : {}),
            ...(typeof item.transcription === "string" && item.transcription
              ? { transcription: item.transcription }
              : {}),
          },
          body: { stream: object.body, length: object.size },
        });
      }
      return await bundleAdapterMedia(parts);
    } catch (error) {
      await Promise.all(parts.map((part) => cancelBinaryBody(part.body, error)));
      throw error;
    }
  }

  private async handleProcessReq(processId: string, frame: RequestFrame): Promise<ResponseFrame | null> {
    const ctx = this.buildProcessContext(processId, frame.runId);
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
    let controller: AbortController;
    try {
      controller = this.registerActiveRequest(origin, frame.id);
    } catch (error) {
      return errFrame(frame.id, 499, error instanceof Error ? error.message : String(error));
    }
    let result;
    try {
      frame = this.bindRequestBodyCancellation(frame, controller.signal);
      result = await dispatch(
        frame,
        origin,
        { ...ctx, requestSignal: controller.signal },
        this.buildDispatchDeps(),
      );
    } finally {
      this.finishActiveRequest(frame.id, controller);
    }

    if (result.handled) {
      this.applyPostDispatchEffects(frame, result.response);
      return result.response;
    }

    return null;
  }

  private buildProcessContext(processId: string, processRunId?: string): KernelContext | null {
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
      processRunId,
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
    if (frame.call === "adapter.inbound") {
      await this.deliverAdapterInboundImmediateReplies(frame, result.response);
    }
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
    processRunId?: string;
    requestSignal?: AbortSignal;
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
      processRunId: options.processRunId,
      requestSignal: options.requestSignal,
      callerOwnerUid: options.callerOwnerUid,
      appFrame: options.appFrame,
      serverVersion: SERVER_VERSION,
      broadcastToUserUid: this.broadcastToUserUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
      scheduleIpcCallTimeout: this.scheduleIpcCallTimeout.bind(this),
      failIpcCallsByTarget: this.failIpcCallsByTarget.bind(this),
      scheduleScheduleWake: this.scheduleScheduleWake.bind(this),
      cancelScheduleWake: async (wakeScheduleId) => {
        await this.cancelSchedule(wakeScheduleId);
      },
      runSchedules: this.runSchedules.bind(this),
      addMcpServerConnection: this.addMcpServerConnection.bind(this),
      removeMcpServerConnection: this.removeMcpServer.bind(this),
      refreshMcpServerConnection: this.refreshMcpServerConnection.bind(this),
      callMcpTool: (serverId, toolName, args, signal) => this.mcp.callTool(
        {
          serverId,
          name: toolName,
          arguments: args,
        },
        undefined,
        signal ? { signal } : undefined,
      ),
    };
  }

  private getAppRunner(uid: number, packageId: string): unknown {
    return this.ctx.exports.AppRunner.getByName(buildAppRunnerName(uid, packageId));
  }

  private buildDispatchDeps(): DispatchDeps {
    return {
      shellSessions: this.shellSessions,
      connections: this.connections,
      sendFrame: this.sendWebSocketFrame.bind(this),
      registerRoute: this.registerRouteWithExpiry.bind(this),
      requestDevice: this.requestDevice.bind(this),
      request: this.requestDispatchedFrame.bind(this),
    };
  }

  private async requestDispatchedFrame(
    frame: RequestFrame,
    ctx: KernelContext,
    signal?: AbortSignal,
  ): Promise<ResponseFrame> {
    if (isInternalOnlySyscall(frame.call)) {
      await cancelUnlockedBody(frame.body, "Dispatched request rejected");
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }
    if (!hasCapability(ctx.identity?.capabilities ?? [], frame.call)) {
      await cancelUnlockedBody(frame.body, "Dispatched request rejected");
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const requestSignal = ctx.requestSignal && signal && ctx.requestSignal !== signal
      ? AbortSignal.any([ctx.requestSignal, signal])
      : signal ?? ctx.requestSignal;
    if (requestSignal?.aborted) {
      await cancelUnlockedBody(frame.body, "Request cancelled");
      throw requestAbortError(requestSignal.reason);
    }

    const origin: RouteOrigin = { type: "app", id: frame.id };
    const pending = this.createPendingAppResponse(frame.id);
    const cancel = () => {
      this.cancelRequest(
        origin,
        frame.id,
        requestAbortError(requestSignal?.reason).message,
        false,
      );
    };

    try {
      if (requestSignal) {
        frame = this.bindRequestBodyCancellation(frame, requestSignal);
      }
      const result = await raceWithAbort(
        dispatch(
          frame,
          origin,
          { ...ctx, requestSignal },
          this.buildDispatchDeps(),
        ),
        requestSignal,
        {
          abortReason: () => requestAbortError(requestSignal?.reason),
          onAbort: cancel,
          onLateResolve: (late) => {
            if (late.handled && late.response.ok) {
              void cancelUnlockedBody(late.response.body, "Request was cancelled");
            }
          },
        },
      );
      const response = result.handled
        ? result.response
        : await raceWithAbort(
            pending.promise,
            requestSignal,
            {
              abortReason: () => requestAbortError(requestSignal?.reason),
              onAbort: cancel,
              onLateResolve: (late) => {
                if (late.ok) {
                  void cancelUnlockedBody(late.body, "Request was cancelled");
                }
              },
            },
          );
      this.applyPostDispatchEffects(frame, response);
      return response;
    } finally {
      pending.cleanup();
      await cancelUnlockedBody(frame.body, "Dispatched request completed");
    }
  }

  private async registerRouteWithExpiry(route: {
    id: string;
    call: SyscallName;
    origin: RouteOrigin;
    deviceId: string;
    driverConnectionId: string;
    ttlMs: number;
  }): Promise<{
    cancel: () => void;
    attachBody: (body: { cancel(reason?: unknown): Promise<void> }) => void;
  }> {
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
        route.driverConnectionId,
        { ttlMs: route.ttlMs, scheduleId },
      );
    } catch (error) {
      this.cancelSchedule(scheduleId).catch(() => {});
      throw error;
    }

    return {
      cancel: () => this.cancelRoute(route.id),
      attachBody: (body) => {
        const previous = this.routedBodies.get(route.id);
        this.routedBodies.set(route.id, body);
        void previous?.cancel("Routed body replaced");
      },
    };
  }

  private registerActiveRequest(origin: RouteOrigin, requestId: string): AbortController {
    if (!requestId || this.activeRequests.has(requestId) || this.routes.get(requestId)) {
      throw new Error(`Duplicate request: ${requestId}`);
    }
    if (origin.type === "process") {
      const key = `${origin.id}\0${requestId}`;
      const cancellation = this.cancelledProcessRequests.get(key);
      this.cancelledProcessRequests.delete(key);
      if (cancellation && cancellation.expiresAt > Date.now()) {
        throw new Error(cancellation.reason);
      }
    }
    const controller = new AbortController();
    this.activeRequests.set(requestId, { origin, controller });
    return controller;
  }

  private bindRequestBodyCancellation(
    frame: RequestFrame,
    signal: AbortSignal,
  ): RequestFrame {
    if (!frame.body) {
      return frame;
    }
    const body = frame.body;
    frame.body = {
      ...body,
      stream: bindStreamToAbort(body.stream, signal),
    };
    return frame;
  }

  private finishActiveRequest(requestId: string, controller: AbortController): void {
    if (this.activeRequests.get(requestId)?.controller === controller) {
      this.activeRequests.delete(requestId);
    }
  }

  private cancelRequest(
    origin: RouteOrigin,
    requestId: string,
    reason: string | undefined,
    rememberMissing: boolean,
  ): boolean {
    if (!requestId) {
      return false;
    }
    const active = this.activeRequests.get(requestId);
    const ownsActive = active !== undefined && sameRouteOrigin(active.origin, origin);
    if (active && !ownsActive) {
      return false;
    }

    const route = this.routes.get(requestId);
    const internalAppRoute = route !== null
      && ownsActive
      && route.origin.type === "app"
      && route.origin.id === requestId;
    const ownsRoute = route !== null && (
      sameRouteOrigin(route.origin, origin)
      || internalAppRoute
    );
    if (route && !ownsRoute) {
      return false;
    }

    const message = normalizeRequestCancelReason(reason);
    if (ownsActive) {
      active.controller.abort(new Error(message));
    }
    if (route && ownsRoute) {
      if (!internalAppRoute) {
        this.sendDeviceRequestCancel(
          route.deviceId,
          route.driverConnectionId,
          requestId,
          message,
        );
      }
      this.cancelRoute(requestId);
    }
    if (ownsActive || ownsRoute) {
      return true;
    }
    if (!rememberMissing || origin.type !== "process") {
      return false;
    }

    const now = Date.now();
    for (const [key, cancellation] of this.cancelledProcessRequests) {
      if (cancellation.expiresAt <= now) {
        this.cancelledProcessRequests.delete(key);
      }
    }
    if (this.cancelledProcessRequests.size >= MAX_PROCESS_REQUEST_CANCELLATIONS) {
      const oldest = this.cancelledProcessRequests.keys().next().value;
      if (oldest) {
        this.cancelledProcessRequests.delete(oldest);
      }
    }
    this.cancelledProcessRequests.set(`${origin.id}\0${requestId}`, {
      expiresAt: now + PROCESS_REQUEST_CANCEL_TTL_MS,
      reason: message,
    });
    return true;
  }

  private sendDeviceRequestCancel(
    deviceId: string,
    driverConnectionId: string | null,
    requestId: string,
    reason: string,
  ): void {
    const connection = driverConnectionId
      ? this.connections.get(driverConnectionId)
      : this.findDeviceConnection(deviceId);
    if (!connection || !this.isConnectionForDevice(connection, deviceId)) {
      return;
    }
    try {
      this.sendWebSocketFrame(connection, {
        type: "sig",
        signal: REQUEST_CANCEL_SIGNAL,
        payload: { id: requestId, reason },
      });
    } catch {}
  }

  private cancelRoute(routeId: string): void {
    const route = this.routes.remove(routeId);
    if (route?.scheduleId) {
      this.cancelSchedule(route.scheduleId).catch(() => {});
    }
    this.cancelRoutedBody(routeId, "Route cancelled");
  }

  private cancelRoutedBody(routeId: string, reason: string): void {
    const body = this.routedBodies.get(routeId);
    if (!body) {
      return;
    }
    this.routedBodies.delete(routeId);
    void body.cancel(reason);
  }

  private decodeWebSocketFrame(
    connection: Connection<ConnectionState>,
    frame: Frame,
  ): Frame {
    const descriptor = (frame as unknown as { body?: BinaryFrameDescriptor }).body;
    if (descriptor === undefined) {
      return frame;
    }
    if (frame.type === "sig" || (frame.type === "res" && !frame.ok)) {
      throw new Error("This frame type cannot carry a body");
    }
    return {
      ...frame,
      body: this.receiveFrameBody(connection, descriptor),
    } as Frame;
  }

  private receiveFrameBody(
    connection: Connection<ConnectionState>,
    descriptor: BinaryFrameDescriptor,
  ): FrameBody {
    return this.frameBodyChannel(connection).receive(descriptor);
  }

  private sendWebSocketFrame(connection: Connection, frame: Frame): OutgoingBinaryBody | null {
    const body = frame.type === "sig" || (frame.type === "res" && !frame.ok)
      ? undefined
      : frame.body;
    if (!body) {
      connection.send(JSON.stringify(frame));
      return null;
    }

    const outgoing: OutgoingBinaryBody = this.frameBodyChannel(connection).prepare(body);
    try {
      connection.send(JSON.stringify({
        ...frame,
        body: outgoing.descriptor,
      }));
    } catch (error) {
      void outgoing.cancel(error);
      throw error;
    }
    this.ctx.waitUntil(outgoing.send().catch(() => {}));
    return outgoing;
  }

  private frameBodyChannel(connection: Connection): BinaryBodyChannel {
    let channel = this.frameBodyChannels.get(connection.id);
    if (!channel) {
      channel = new BinaryBodyChannel({
        sendFrame: (binary) => connection.send(binary),
      });
      this.frameBodyChannels.set(connection.id, channel);
    }
    return channel;
  }

  private closeFrameBodyChannel(connectionId: string): void {
    this.frameBodyChannels.get(connectionId)?.close(new Error("Connection closed"));
    this.frameBodyChannels.delete(connectionId);
  }

  private async requestDevice(
    deviceId: string,
    call: string,
    args: unknown,
    options: {
      ttlMs?: number;
      body?: FrameBody;
      id?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Extract<ResponseFrame, { ok: true }>> {
    const id = options.id ?? crypto.randomUUID();
    let cleanupPending: (() => void) | null = null;
    let route: { cancel: () => void } | null = null;
    let outgoing: OutgoingBinaryBody | null = null;
    let onAbort: (() => void) | null = null;
    let requestSent = false;
    let completionReason: unknown = "Device request completed";

    try {
      if (options.signal?.aborted) {
        throw requestAbortError(options.signal.reason);
      }
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

      const pending = this.createPendingAppResponse(id);
      cleanupPending = pending.cleanup;
      route = await this.registerRouteWithExpiry({
        id,
        call: call as SyscallName,
        origin: { type: "app", id },
        deviceId,
        driverConnectionId: deviceConn.id,
        ttlMs: options.ttlMs ?? 60_000,
      });
      if (options.signal?.aborted) {
        throw requestAbortError(options.signal.reason);
      }

      outgoing = this.sendWebSocketFrame(deviceConn, {
        type: "req",
        id,
        call,
        args,
        ...(options.body ? { body: options.body } : {}),
      } as RequestFrame);
      requestSent = true;
      const frame = options.signal
        ? await Promise.race([
            pending.promise,
            new Promise<never>((_, reject) => {
              onAbort = () => {
                if (requestSent) {
                  this.sendDeviceRequestCancel(
                    deviceId,
                    deviceConn.id,
                    id,
                    normalizeRequestCancelReason(requestAbortError(options.signal?.reason).message),
                  );
                }
                reject(requestAbortError(options.signal?.reason));
              };
              options.signal?.addEventListener("abort", onAbort, { once: true });
              if (options.signal?.aborted) {
                onAbort();
              }
            }),
          ])
        : await pending.promise;
      if (!frame.ok) {
        throw new Error(frame.error.message);
      }
      return frame;
    } catch (error) {
      completionReason = error;
      throw error;
    } finally {
      if (onAbort) {
        options.signal?.removeEventListener("abort", onAbort);
      }
      cleanupPending?.();
      route?.cancel();
      const reason = options.signal?.aborted ? options.signal.reason : completionReason;
      if (outgoing) {
        await outgoing.cancel(reason);
      } else {
        await options.body?.stream.cancel(reason).catch(() => {});
      }
    }
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
    return state?.step === "connected" &&
      state.identity?.role === "driver" &&
      state.identity.device === deviceId;
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

  private async scheduleIpcCallTimeout(callId: string, deadlineAt: number): Promise<string> {
    const sched = await this.schedule(
      new Date(Math.ceil(Math.max(Date.now() + 1_000, deadlineAt) / 1_000) * 1_000),
      "onIpcCallTimeout",
      callId,
    );
    return sched.id;
  }

  private failIpcCallsByTarget(uid: number, targetPid: string, error: string): void {
    for (const callId of this.ipcCalls.failByTargetPid({ uid, targetPid, error })) {
      this.queueIpcCallDelivery(callId);
    }
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

  private async handleReq(
    connection: Connection<ConnectionState>,
    wireFrame: RequestFrame,
  ): Promise<void> {
    let frame: RequestFrame;
    try {
      frame = this.decodeWebSocketFrame(connection, wireFrame) as RequestFrame;
    } catch (error) {
      this.sendError(
        connection,
        wireFrame.id,
        400,
        error instanceof Error ? error.message : "Invalid frame body",
      );
      return;
    }

    try {
      const state = connection.state as ConnectionState | undefined;

      if (frame.call === "sys.connect") {
        if (state && state.step !== "pending") {
          this.sendError(
            connection,
            frame.id,
            409,
            state.step === "superseded" ? "Connection replaced" : "Already connected",
          );
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

      const origin: RouteOrigin = { type: "connection", id: connection.id };
      let controller: AbortController;
      try {
        controller = this.registerActiveRequest(origin, frame.id);
      } catch (error) {
        this.sendError(connection, frame.id, 409, error instanceof Error ? error.message : String(error));
        return;
      }
      let result;
      try {
        frame = this.bindRequestBodyCancellation(frame, controller.signal);
        result = await dispatch(
          frame,
          origin,
          { ...this.buildContext(connection), requestSignal: controller.signal },
          this.buildDispatchDeps(),
        );
      } finally {
        this.finishActiveRequest(frame.id, controller);
      }
      if (result.handled) {
        this.applyPostDispatchEffects(frame, result.response);
        this.sendWebSocketFrame(connection, result.response);
      }
      // Routed responses arrive asynchronously through handleRes.
    } finally {
      await cancelUnlockedBody(frame.body, "WebSocket request completed");
    }
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
      const data = (response as {
        data?: {
          package?: {
            scope?: { kind?: unknown; uid?: unknown };
          };
          packages?: Array<{
            scope?: { kind?: unknown; uid?: unknown };
          }>;
        };
      }).data;
      const scope = data?.package?.scope ?? data?.packages?.[0]?.scope;
      if (frame.call === "sys.bootstrap" || scope?.kind === "global") {
        this.broadcastToRole("user", "pkg.changed");
      } else if (scope?.kind === "user" && typeof scope.uid === "number") {
        this.broadcastToUserUid(scope.uid, "pkg.changed");
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

    const clientId = frame.args?.client?.id?.trim();
    const clientPlatform = frame.args?.client?.platform?.trim();
    const newState = {
      step: "connected",
      identity: outcome.identity,
      clientId: clientId || undefined,
      clientPlatform: clientPlatform || undefined,
    } satisfies ConnectionState & { step: "connected"; identity: ConnectionIdentity };
    this.activateConnection(connection, newState);

    if (outcome.identity.role === "driver") {
      this.broadcastDeviceStatus(outcome.identity.device, "connected");
    }

    if (outcome.identity.role === "user") {
      const freshIdentity = outcome.identity.process;
      await ensureDefaultConversationExecutor(ctx, freshIdentity);
      this.reconcileOwnedIdentities(freshIdentity.uid);
    }

    this.sendOk(connection, frame.id, outcome.result);
  }

  private activateConnection(
    connection: Connection<ConnectionState>,
    state: ConnectionState & { step: "connected"; identity: ConnectionIdentity },
  ): void {
    connection.setState(state);
    this.connections.set(connection.id, connection);

    if (!state.clientId) {
      return;
    }
    for (const [connectionId, existing] of this.connections) {
      const existingState = existing.state as ConnectionState | undefined;
      if (
        existing !== connection &&
        existingState?.step === "connected" &&
        existingState.identity?.process.uid === state.identity.process.uid &&
        existingState.identity.role === state.identity.role &&
        existingState.clientId === state.clientId
      ) {
        existing.setState({ ...existingState, step: "superseded" });
        this.connections.delete(connectionId);
        existing.close(1000, "Replaced by newer connection");
      }
    }
  }

  private async handleSysSetup(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.setup">,
  ): Promise<void> {
    const state = connection.state as ConnectionState | undefined;
    if (state && state.step !== "pending") {
      this.sendError(
        connection,
        frame.id,
        409,
        state.step === "superseded" ? "Connection replaced" : "Already connected",
      );
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
    if (state && state.step !== "pending") {
      this.sendError(
        connection,
        frame.id,
        409,
        state.step === "superseded" ? "Connection replaced" : "Already connected",
      );
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

  private handleRes(connection: Connection<ConnectionState>, wireFrame: ResponseFrame): void {
    const route = this.routes.get(wireFrame.id);
    if (!route) {
      if (wireFrame.ok) {
        const descriptor = (wireFrame as unknown as { body?: BinaryFrameDescriptor }).body;
        if (descriptor) {
          try {
            void this.receiveFrameBody(connection, descriptor).stream.cancel("Request is no longer pending");
          } catch {
            // The response is already stale; malformed descriptors have no consumer to fail.
          }
        }
      }
      return;
    }

    if (
      !this.isConnectionForDevice(connection, route.deviceId) ||
      (route.driverConnectionId !== null && route.driverConnectionId !== connection.id)
    ) {
      return;
    }

    let frame: ResponseFrame;
    try {
      frame = this.decodeWebSocketFrame(connection, wireFrame) as ResponseFrame;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid frame body";
      this.cancelRoute(wireFrame.id);
      this.deliverToOrigin(
        route.origin,
        errFrame(
          wireFrame.id,
          502,
          `Invalid response from device ${route.deviceId}: ${message}`,
        ),
      );
      this.sendError(
        connection,
        wireFrame.id,
        400,
        message,
      );
      return;
    }

    this.routes.remove(frame.id);
    this.cancelRoutedBody(frame.id, "Device response received");

    if (route.scheduleId) {
      this.cancelSchedule(route.scheduleId).catch(() => {});
    }

    if (route.call === "shell.exec") {
      this.recordShellSessionFromResponse(route.deviceId, frame);
    }

    this.deliverToOrigin(route.origin, frame);
  }

  private handleBinaryMessage(connection: Connection<ConnectionState>, message: WSMessage): void {
    this.frameBodyChannel(connection).handleFrame(message as ArrayBuffer | ArrayBufferView);
  }

  private handleSig(connection: Connection<ConnectionState>, frame: SignalFrame): void {
    const state = connection.state as ConnectionState | undefined;
    const targetId = state?.identity?.role === "driver"
      ? state.identity.device
      : null;
    if (!targetId || !this.isConnectionForDevice(connection, targetId)) {
      return;
    }

    if (frame.signal === "device.ping") {
      this.sendWebSocketFrame(connection, {
        type: "sig",
        signal: "device.pong",
        ...(frame.payload === undefined ? {} : { payload: frame.payload }),
        ...(frame.seq === undefined ? {} : { seq: frame.seq }),
      });
      return;
    }

    if (frame.signal !== "exec.status") {
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
    this.sendDeviceRequestCancel(
      expired.deviceId,
      expired.driverConnectionId,
      routeId,
      "Request timed out",
    );
    this.cancelRoutedBody(routeId, "Route expired");

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
    this.queueIpcCallDelivery(callId);
  }

  async onIpcCallDelivery(callId: string): Promise<void> {
    await this.deliverIpcCall(callId);
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
    let retryableFailure = false;
    const oneShot = running.expression.kind === "at" || running.expression.kind === "after";
    const occurrenceKey = this.schedules.occurrenceKey(
      running,
      mode,
      scheduledAtMs,
      startedAtMs,
    );
    const oneShotAttemptNumber = this.schedules.oneShotAttemptNumber(running, mode);

    try {
      result = await this.dispatchScheduleTarget(
        record,
        scheduledAtMs,
        startedAtMs,
        occurrenceKey,
      );
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
      retryableFailure = err instanceof ScheduleTargetDispatchError && err.retryable;
      result = { error };
    }

    const finishedAtMs = Date.now();
    const retryOneShot = mode === "due"
      && oneShot
      && status === "error"
      && retryableFailure
      && oneShotAttemptNumber !== null
      && oneShotAttemptNumber < MAX_ONE_SHOT_SCHEDULE_DELIVERY_ATTEMPTS;
    const next = mode === "force"
      ? { enabled: record.enabled, nextRunAtMs: record.state.nextRunAtMs }
      : retryOneShot
        ? {
            enabled: true,
            nextRunAtMs: finishedAtMs + scheduleDeliveryRetryDelayMs(oneShotAttemptNumber),
          }
        : computeNextRunAfterFinish(
            record.expression,
            Math.max(finishedAtMs, scheduledAtMs ?? finishedAtMs),
          );
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
      oneShotOccurrenceId: running.oneShotOccurrenceId,
      countOneShotAttempt: oneShotAttemptNumber !== null,
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
    occurrenceKey: string,
  ): Promise<unknown> {
    const target = record.target;
    const ctx = this.buildScheduleContext(record);
    if (target.kind === "command.exec") {
      if (!hasCapability(ctx.identity?.capabilities ?? [], "shell.exec")) {
        throw new Error("Permission denied: shell.exec");
      }
      const deps = this.buildDispatchDeps();
      const result = await handleShellExec(
        {
          input: target.command,
          cwd: target.cwd,
          timeout: target.timeoutMs,
        },
        ctx,
        {
          fsCopyTransport: deps,
          netFetchTransport: deps,
          request: (frame, signal) => deps.request(frame, ctx, signal),
        },
      );
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
      if (!hasCapability(ctx.identity?.capabilities ?? [], "proc.spawn")) {
        throw new Error("Permission denied: proc.spawn");
      }
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

    if (target.kind === "adapter.send") {
      if (!hasCapability(ctx.identity?.capabilities ?? [], "adapter.send")) {
        throw new Error("Permission denied: adapter.send");
      }
      const delivery = await deliverAdapterReply(
        target.destination,
        record.ownerUid,
        {
          deliveryId: await stableOpaqueId("adapter-delivery", [
            "schedule",
            record.id,
            occurrenceKey,
          ]),
          text: target.text,
        },
        ctx,
      );
      if (!delivery.ok) {
        throw new ScheduleTargetDispatchError(delivery.error, delivery.retryable === true);
      }
      return {
        kind: "adapter.send",
        adapter: delivery.adapter,
        accountId: delivery.accountId,
        surfaceId: delivery.surfaceId,
        messageId: delivery.messageId,
        deliveryState: delivery.deliveryState,
      };
    }

    if (target.kind === "process.event") {
      if (!hasCapability(ctx.identity?.capabilities ?? [], "proc.send")) {
        throw new Error("Permission denied: proc.send");
      }
      if (target.replyTo) {
        if (!hasCapability(ctx.identity?.capabilities ?? [], "adapter.send")) {
          throw new Error("Permission denied: adapter.send");
        }
        assertAdapterMessageDestinationAccess(target.replyTo, record.ownerUid, ctx);
      }
      const proc = this.procs.get(target.pid);
      if (!proc) {
        throw new Error(`Process not found: ${target.pid}`);
      }
      if (proc.ownerUid !== record.ownerUid && record.ownerUid !== 0) {
        throw new Error(`Permission denied: schedule ${record.id} cannot access process ${target.pid}`);
      }

      const runId = await stableOpaqueId("schedule-run", [record.id, occurrenceKey]);
      const delivery = target.replyTo;
      if (delivery) {
        this.runRoutes.setAdapterRoute({
          runId,
          processId: target.pid,
          uid: record.ownerUid,
          adapter: delivery.adapter,
          accountId: delivery.accountId,
          actorId: delivery.actorId,
          surfaceKind: delivery.surface.kind,
          surfaceId: delivery.surface.id,
          threadId: delivery.surface.threadId,
        });
      }
      const request: ProcessScheduleDeliverRequestFrame = {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.schedule.deliver",
        args: {
          runId,
          scheduleId: record.id,
          scheduleName: record.name,
          conversationId: target.conversationId,
          message: target.message,
          data: target.data,
          replyTo: target.replyTo,
          scheduledAtMs,
          firedAtMs,
        },
      };
      let admittedRunId = runId;
      let response: ProcessScheduleDeliverResponseFrame | null;
      try {
        response = await sendFrameToProcess(target.pid, request);
      } catch (error) {
        // As with adapter ingress, a thrown DO transport may have lost the
        // response after admission. Preserve a preallocated reply route so an
        // actually admitted run can still complete its delivery.
        throw new ScheduleTargetDispatchError(
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
      if (!response || response.type !== "res" || response.id !== request.id) {
        throw new ScheduleTargetDispatchError(
          "proc.schedule.deliver did not return a response",
          true,
        );
      }
      if (!response.ok) {
        throw new ScheduleTargetDispatchError(response.error.message, true);
      }
      admittedRunId = response.data.runId;
      if (delivery && response.data.runId !== runId) {
        this.runRoutes.delete(runId);
        throw new ScheduleTargetDispatchError(
          "proc.schedule.deliver admitted an unexpected reply run",
          false,
        );
      }
      return {
        kind: "process.event",
        pid: target.pid,
        conversationId: target.conversationId ?? "default",
        runId: admittedRunId,
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
    const body = frame.ok ? frame.body : undefined;
    if (origin.type === "connection") {
      const conn = this.connections.get(origin.id);
      if (conn) {
        this.sendWebSocketFrame(conn, frame);
      } else {
        void body?.stream.cancel("Origin disconnected").catch(() => {});
      }
      return;
    }

    if (origin.type === "process") {
      sendFrameToProcess(origin.id, frame).catch((err: unknown) => {
        void body?.stream.cancel(err).catch(() => {});
        console.error(`[Kernel] Failed to deliver frame to process ${origin.id}:`, err);
      });
      return;
    }

    if (origin.type === "app") {
      const resolve = this.pendingAppResponses.get(origin.id);
      if (resolve) {
        this.pendingAppResponses.delete(origin.id);
        resolve(frame);
      } else {
        void body?.stream.cancel("Request was cancelled").catch(() => {});
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
    this.failDeviceRoutes(this.routes.failForDevice(deviceId));
  }

  private failRoutesForDriverConnection(connectionId: string): void {
    this.failDeviceRoutes(this.routes.failForDriverConnection(connectionId));
  }

  private failDeviceRoutes(failed: FailedDeviceRoute[]): void {
    for (const entry of failed) {
      this.cancelRoutedBody(entry.id, "Device disconnected");
      if (entry.scheduleId) {
        this.cancelSchedule(entry.scheduleId).catch(() => {});
      }

      const errorFrame: ResponseFrame = {
        type: "res",
        id: entry.id,
        ok: false,
        error: { code: 503, message: `Device disconnected: ${entry.deviceId}` },
      };
      this.deliverToOrigin(entry.origin, errorFrame);
    }
  }

  private failRoutesForConnection(connectionId: string): void {
    const failed = this.routes.failForConnection(connectionId);
    for (const entry of failed) {
      this.sendDeviceRequestCancel(
        entry.deviceId,
        entry.driverConnectionId,
        entry.id,
        "Origin disconnected",
      );
      this.cancelRoutedBody(entry.id, "Origin disconnected");
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
   * Broadcast a signal to active user WebSockets belonging to a UID.
   */
  broadcastToUserUid(uid: number, signal: string, payload?: unknown): void {
    const frame: SignalFrame = {
      type: "sig",
      signal,
      payload,
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (!state) continue;
      if (state.identity?.role !== "user") continue;
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

async function cancelUnlockedBody(body: FrameBody | undefined, reason: string): Promise<void> {
  if (body && !body.stream.locked) {
    await body.stream.cancel(reason).catch(() => {});
  }
}

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function requestAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("Device request cancelled");
}

function sameRouteOrigin(left: RouteOrigin, right: RouteOrigin): boolean {
  return left.type === right.type && left.id === right.id;
}

function normalizeRequestCancelReason(reason: string | undefined): string {
  const normalized = reason?.trim();
  return (normalized || "Request cancelled").slice(0, MAX_REQUEST_CANCEL_REASON_LENGTH);
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
  if (record.target.kind === "adapter.send") {
    if (value?.deliveryState === "ambiguous") {
      return `message delivery through ${record.target.destination.adapter} is ambiguous`;
    }
    if (value?.deliveryState === "deduplicated") {
      return `message through ${record.target.destination.adapter} was already delivered`;
    }
    return `sent message through ${record.target.destination.adapter}`;
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
