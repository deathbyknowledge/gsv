import {
  Connection,
  ConnectionContext,
  Agent as Host,
  type WSMessage,
} from "agents";
import type { Frame, RequestFrame, ResponseFrame, SignalFrame } from "../protocol/frames";
import type {
  ConnectionIdentity,
  ProcessIdentity,
  SysSetupResult,
} from "@gsv/protocol/syscalls/system";
import type { ProcContextFile, ProcHilRequest, ProcHistoryMessage, ProcHistoryResult } from "../syscalls/proc";
import type { PkgPublicListResult } from "@gsv/protocol/syscalls/packages";
import type {
  AdapterOutboundMessage,
} from "../adapter-interface";
import { AuthStore } from "./auth-store";
import { CapabilityStore, hasCapability } from "./capabilities";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "./config";
import { DeviceRegistry } from "./devices";
import { RoutingTable, type RouteOrigin } from "./routing";
import { ProcessRegistry } from "./processes";
import { AdapterStore } from "./adapter-store";
import { RunRouteStore, type AdapterRunRoute, type RunRoute } from "./run-routes";
import { WorkspaceStore } from "./workspaces";
import { AutomationStore, type AutomationJobRecord } from "./automation";
import { SignalWatchStore, type SignalWatchRecord } from "./signal-watches";
import { NotificationStore } from "./notifications";
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
import { workspaceRootPath } from "../fs";

const SERVER_VERSION = "0.1.0";

type ConnectionState = {
  step: "pending" | "connected";
  identity?: ConnectionIdentity;
  clientId?: string;
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

type ProcessHistorySnapshot = {
  messages: ProcHistoryMessage[];
  messageCount: number;
};

const ARCHIVIST_MIN_INPUT_TOKENS = 12_000;
const ARCHIVIST_MIN_ESTIMATED_TOKENS = 9_000;
const ARCHIVIST_MIN_MESSAGE_COUNT = 16;
const ARCHIVIST_MIN_MESSAGE_DELTA = 8;
const ARCHIVIST_MIN_TOKEN_DELTA = 4_000;
const ARCHIVIST_MIN_INPUT_TOKEN_DELTA = 4_000;
const DEFAULT_ARCHIVIST_MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CURATOR_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CURATOR_BATCH_SIZE = 5;
const AUTOMATION_CURATOR_SWEEP_AT_KEY = "curatorSweepAt";

export class Kernel extends Host<Env> {
  private readonly auth: AuthStore;
  private readonly caps: CapabilityStore;
  private readonly config: ConfigStore;
  private readonly devices: DeviceRegistry;
  private readonly routes: RoutingTable;
  private readonly procs: ProcessRegistry;
  private readonly workspaces: WorkspaceStore;
  private readonly adapters: AdapterStore;
  private readonly runRoutes: RunRouteStore;
  private readonly automation: AutomationStore;
  private readonly signalWatches: SignalWatchStore;
  private readonly notifications: NotificationStore;
  private readonly appSessions: AppSessionStore;
  private readonly packages: PackageStore;
  private readonly ready: Promise<void>;
  private readonly connections = new Map<string, Connection<ConnectionState>>();
  private readonly pendingAppResponses = new Map<string, (frame: ResponseFrame) => void>();

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
    this.config.seed(SYSTEM_CONFIG_DEFAULTS);

    this.devices = new DeviceRegistry(sql);
    this.devices.init();

    this.routes = new RoutingTable(sql);
    this.routes.init();

    this.procs = new ProcessRegistry(sql);
    this.procs.init();

    this.workspaces = new WorkspaceStore(sql);
    this.workspaces.init();

    this.adapters = new AdapterStore(sql);
    this.adapters.init();

    this.runRoutes = new RunRouteStore(sql);
    this.runRoutes.init();

    this.automation = new AutomationStore(sql);
    this.automation.init();

    this.signalWatches = new SignalWatchStore(sql);
    this.signalWatches.init();

    this.notifications = new NotificationStore(sql);
    this.notifications.init();

    this.appSessions = new AppSessionStore(sql);
    this.appSessions.init();

    this.packages = new PackageStore(sql, env.STORAGE);
    this.packages.init();
    this.ready = this.initialize();

    this.rehydrateConnections();
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
        // TODO: inbound signals
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
    await this.ensureCuratorSweepScheduled();
    if (frame.type === "req") {
      return this.handleProcessReq(processId, frame);
    }

    if (frame.type === "res") {
      // Process responding to a kernel-initiated request (future use)
      return null;
    }

    if (frame.type === "sig") {
      await this.handleProcessSignal(processId, frame);
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

    const entrypoint = findUiEntrypoint(record.manifest.entrypoints, appFrame.entrypointName, appFrame.routeBase);
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
      ttlMs: 30 * 60 * 1000,
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
    let automationJob: AutomationJobRecord | null = null;
    if (runId) {
      automationJob = this.automation.getByRunId(runId);
      if (automationJob) {
        await this.handleAutomationSignal(automationJob, frame);
      }
    }

    await this.dispatchSignalWatches(identity.uid, processId, frame);

    if (!frame.signal.startsWith("chat.")) return;
    if (automationJob) {
      return;
    }

    if (frame.signal === "chat.complete") {
      await this.maybeScheduleAutomation(processId, frame);
    }

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

  private async handleAutomationSignal(job: AutomationJobRecord, frame: SignalFrame): Promise<void> {
    if (frame.signal === "chat.hil") {
      if (job.runId) {
        this.automation.failForRun(
          job.runId,
          "Automation worker requested interactive confirmation",
        );
      } else {
        this.automation.markFailed(
          job.jobId,
          "Automation worker requested interactive confirmation",
        );
      }
      if (job.workerPid) {
        await this.stopAutomationWorker(job.workerPid);
      }
      return;
    }

    if (frame.signal === "chat.complete") {
      const payload =
        frame.payload && typeof frame.payload === "object"
          ? frame.payload as Record<string, unknown>
          : {};
      const error =
        typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : payload.aborted === true
            ? "Automation run aborted"
            : null;
      if (error) {
        if (job.runId) {
          this.automation.failForRun(job.runId, error);
        } else {
          this.automation.markFailed(job.jobId, error);
        }
      } else if (job.runId) {
        this.automation.completeForRun(job.runId);
      }

      if (job.workerPid) {
        await this.stopAutomationWorker(job.workerPid);
      }
    }
  }

  private async maybeScheduleAutomation(processId: string, frame: SignalFrame): Promise<void> {
    const proc = this.procs.get(processId);
    if (!proc) {
      return;
    }
    if (proc.profile === "archivist" || proc.profile === "curator") {
      return;
    }
    if (proc.profile !== "task" && proc.profile !== "init") {
      return;
    }
    if (!proc.workspaceId) {
      return;
    }

    const payload =
      frame.payload && typeof frame.payload === "object"
        ? frame.payload as Record<string, unknown>
        : {};
    if (payload.aborted === true) {
      return;
    }
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return;
    }

    const history = await this.fetchProcessHistory(processId, 40);
    const inputTokens = parseInputTokens(frame.payload);
    const estimatedTokens = estimateHistoryTokens(history.messages);
    const dedupeKey = `archivist:compact:${proc.workspaceId}`;
    const archivistMinIntervalMs = this.resolveAutomationIntervalMs(
      "config/automation/archivist/min_interval_ms",
      DEFAULT_ARCHIVIST_MIN_INTERVAL_MS,
    );

    if (!shouldScheduleArchivistJob(
      this.automation.getLatestCompletedByDedupe(dedupeKey),
      history.messageCount,
      estimatedTokens,
      inputTokens,
      archivistMinIntervalMs,
    )) {
      return;
    }

    const assignmentContextFiles = this.buildArchivistAssignment(
      proc.processId,
      proc.workspaceId,
      history.messages,
    );
    const { created } = this.automation.enqueue({
      uid: proc.uid,
      profile: "archivist",
      triggerSignal: frame.signal,
      dedupeKey,
      sourcePid: proc.processId,
      workspaceId: proc.workspaceId,
      label: `archivist (${proc.workspaceId})`,
      sourceMessageCount: history.messageCount,
      sourceEstimatedTokens: estimatedTokens,
      sourceInputTokens: inputTokens,
      assignmentContextFiles,
    });
    if (created) {
      await this.dispatchQueuedAutomationJobs();
    }
  }

  private async fetchProcessHistory(
    pid: string,
    limit: number,
  ): Promise<ProcessHistorySnapshot> {
    const response = await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.history",
      args: { pid, limit },
    });
    if (!response || response.type !== "res" || !response.ok) {
      return { messages: [], messageCount: 0 };
    }
    const data = (response.data ?? null) as ProcHistoryResult | null;
    if (!data || !("messages" in data) || !Array.isArray(data.messages)) {
      return { messages: [], messageCount: 0 };
    }
    return {
      messages: data.messages,
      messageCount: typeof data.messageCount === "number" ? data.messageCount : data.messages.length,
    };
  }

  private buildArchivistAssignment(
    sourcePid: string,
    workspaceId: string,
    history: ProcHistoryMessage[],
  ): ProcContextFile[] {
    const recentHistory = history
      .slice(-40)
      .map((message) => formatHistoryMessage(message))
      .filter((line) => line.length > 0)
      .join("\n\n");

    const files: ProcContextFile[] = [
      {
        name: "00-assignment.md",
        text: [
          "You are running a background archival pass.",
          `Source process: ${sourcePid}`,
          `Workspace: ${workspaceRootPath(workspaceId)}`,
          "",
          "Goals:",
          "- Rewrite workspace continuity files under `.gsv/context.d/`.",
          "- Preserve a concise current summary, unresolved open loops, and durable recent decisions.",
          "- Stage durable knowledge candidates under `~/knowledge/personal/inbox/` only when they are likely to matter beyond this workspace run.",
          "",
          "Preferred outputs:",
          "- `.gsv/context.d/10-summary.md`",
          "- `.gsv/context.d/20-open-loops.md`",
          "- `.gsv/context.d/30-decisions.md`",
          "",
          "Restrictions:",
          "- Do not modify canonical knowledge pages under `~/knowledge/*/pages/`.",
          "- Do not address the user directly.",
          "- It is valid to emit no inbox notes if there are no durable candidates worth staging.",
          "- Prefer filesystem tools over shell commands unless shell is clearly required.",
          "- Rewrite context files cleanly instead of appending logs or stale bullet lists.",
        ].join("\n"),
      },
    ];

    if (recentHistory.trim().length > 0) {
      files.push({
        name: "10-recent-history.md",
        text: [
          "Recent source history:",
          "",
          recentHistory,
        ].join("\n"),
      });
    }

    return files;
  }

  private buildCuratorAssignment(
    db: string,
    batchSize: number,
  ): ProcContextFile[] {
    return [
      {
        name: "00-assignment.md",
        text: [
          "You are running a background curation pass.",
          `Knowledge database: ${db}`,
          `Inbox scope: ~/knowledge/${db}/inbox/`,
          `Batch size: ${batchSize}`,
          "",
          "Goals:",
          "- Review staged inbox notes conservatively.",
          "- Promote, merge, defer, or discard candidates based on the inbox note and the current canonical pages.",
          "- If the inbox is empty or nothing is clear enough to promote, make no changes and exit.",
          "",
          "Restrictions:",
          "- Do not address the user directly.",
          "- Prefer precise, minimal edits over broad rewrites.",
          "- Preserve readable markdown history and keep ambiguous notes deferred.",
          "- Only touch canonical pages that are clearly relevant to the candidate under review.",
        ].join("\n"),
      },
    ];
  }

  private async ensureCuratorSweepScheduled(): Promise<void> {
    const intervalMs = this.resolveAutomationIntervalMs(
      "config/automation/curator/interval_ms",
      DEFAULT_CURATOR_INTERVAL_MS,
    );
    if (intervalMs <= 0) {
      this.automation.deleteMeta(AUTOMATION_CURATOR_SWEEP_AT_KEY);
      return;
    }

    const existing = Number.parseInt(
      this.automation.getMeta(AUTOMATION_CURATOR_SWEEP_AT_KEY) ?? "",
      10,
    );
    if (Number.isFinite(existing) && existing > Date.now()) {
      return;
    }

    const dueAt = Date.now() + intervalMs;
    await this.schedule(
      Math.max(1, intervalMs / 1000),
      "onAutomationSweep",
      dueAt,
    );
    this.automation.setMeta(AUTOMATION_CURATOR_SWEEP_AT_KEY, String(dueAt));
  }

  async onAutomationSweep(dueAt: number): Promise<void> {
    await this.ready;
    const expected = Number.parseInt(
      this.automation.getMeta(AUTOMATION_CURATOR_SWEEP_AT_KEY) ?? "",
      10,
    );
    if (!Number.isFinite(expected) || expected !== dueAt) {
      return;
    }

    this.automation.deleteMeta(AUTOMATION_CURATOR_SWEEP_AT_KEY);
    await this.maybeScheduleCuratorJobs();
    await this.dispatchQueuedAutomationJobs();
    await this.ensureCuratorSweepScheduled();
  }

  private async maybeScheduleCuratorJobs(): Promise<void> {
    const batchSize = this.resolveAutomationIntervalMs(
      "config/automation/curator/batch_size",
      DEFAULT_CURATOR_BATCH_SIZE,
      1,
    );

    const initProcesses = this.procs.listByProfile("init");
    for (const initProc of initProcesses) {
      this.automation.enqueue({
        uid: initProc.uid,
        profile: "curator",
        triggerSignal: "automation.sweep",
        dedupeKey: `curator:${initProc.uid}:personal`,
        sourcePid: initProc.processId,
        workspaceId: null,
        label: `curator (${initProc.username})`,
        assignmentContextFiles: this.buildCuratorAssignment("personal", batchSize),
      });
    }
  }

  private resolveAutomationIntervalMs(
    key: string,
    fallback: number,
    minValue = 0,
  ): number {
    const raw = this.config.get(key);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(minValue, parsed);
  }

  private async dispatchQueuedAutomationJobs(): Promise<void> {
    const jobs = this.automation.listQueued();
    for (const job of jobs) {
      const sourceProc = job.sourcePid ? this.procs.get(job.sourcePid) : null;
      if (!sourceProc) {
        this.automation.markFailed(job.jobId, "Source process not found");
        continue;
      }

      const workerPid = crypto.randomUUID();
      const identity: ProcessIdentity = {
        uid: sourceProc.uid,
        gid: sourceProc.gid,
        gids: sourceProc.gids,
        username: sourceProc.username,
        home: sourceProc.home,
        cwd: job.workspaceId ? workspaceRootPath(job.workspaceId) : sourceProc.home,
        workspaceId: job.workspaceId,
      };

      this.procs.spawn(workerPid, identity, {
        parentPid: job.sourcePid ?? `init:${job.uid}`,
        profile: job.profile,
        label: job.label ?? job.profile,
        cwd: identity.cwd,
        workspaceId: identity.workspaceId,
        contextFiles: job.assignmentContextFiles,
      });

      const response = await sendFrameToProcess(workerPid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.setidentity",
        args: {
          pid: workerPid,
          identity,
          profile: job.profile,
          assignment: {
            contextFiles: job.assignmentContextFiles,
            autoStart: true,
          },
        },
      });

      if (!response || response.type !== "res" || !response.ok) {
        this.procs.kill(workerPid);
        this.automation.markFailed(job.jobId, "Failed to initialize automation worker");
        continue;
      }

      const data = response.data as { ok?: boolean; startedRunId?: string } | undefined;
      if (!data?.startedRunId) {
        this.procs.kill(workerPid);
        this.automation.markFailed(job.jobId, "Automation worker did not start a run");
        continue;
      }

      this.automation.markRunning(job.jobId, workerPid, data.startedRunId);
    }
  }

  private async stopAutomationWorker(pid: string): Promise<void> {
    await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.kill",
      args: { pid, archive: false },
    });
    this.procs.kill(pid);
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
    const command = typeof args.command === "string" ? args.command : "";

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
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      automation: this.automation,
      signalWatches: this.signalWatches,
      notifications: this.notifications,
      connection: null as unknown as Connection,
      identity: connIdentity,
      processId,
      appFrame: undefined,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
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
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      automation: this.automation,
      signalWatches: this.signalWatches,
      notifications: this.notifications,
      connection,
      identity: state.identity as ConnectionIdentity,
      processId: undefined,
      appFrame: undefined,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
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
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      automation: this.automation,
      signalWatches: this.signalWatches,
      notifications: this.notifications,
      connection: null as unknown as Connection,
      identity,
      processId: undefined,
      appFrame,
      serverVersion: SERVER_VERSION,
      broadcastToUid: this.broadcastToUid.bind(this),
      getAppRunner: this.getAppRunner.bind(this),
    };
  }

  private getAppRunner(uid: number, packageId: string): unknown {
    return this.ctx.exports.AppRunner.getByName(buildAppRunnerName(uid, packageId));
  }

  private buildDispatchDeps(): DispatchDeps {
    return {
      routingTable: this.routes,
      connections: this.connections,
      scheduleExpiry: async (id: string, ttlMs: number) => {
        const sched = await this.schedule(
          ttlMs / 1000,
          "onRouteExpired",
          id,
        );
        return sched.id;
      },
    };
  }

  private async handleReq(connection: Connection<ConnectionState>, frame: RequestFrame): Promise<void> {
    await this.ensureCuratorSweepScheduled();
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
    if (!consumed) return;

    if (consumed.scheduleId) {
      this.cancelSchedule(consumed.scheduleId).catch(() => {});
    }

    this.deliverToOrigin(consumed.origin, frame);
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

    const onlineDrivers = new Set<string>();

    for (const connection of live) {
      const state = connection.state;
      if (!state || state.step !== "connected" || !state.identity) continue;

      this.connections.set(connection.id, connection);
      if (state.identity.role === "driver") {
        onlineDrivers.add(state.identity.device);
        this.devices.setOnline(state.identity.device, true);
      }
    }

    // Reconcile persistent device online flags with live rehydrated sockets.
    for (const device of this.devices.listOnline()) {
      if (!onlineDrivers.has(device.device_id)) {
        this.devices.setOnline(device.device_id, false);
        this.broadcastDeviceStatus(device.device_id, "disconnected");
      }
    }
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

function formatHistoryMessage(message: ProcHistoryMessage): string {
  const timestamp = typeof message.timestamp === "number"
    ? new Date(message.timestamp).toISOString()
    : "";
  const prefix = timestamp ? `[${timestamp}] ${message.role}` : message.role;
  const content = typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content, null, 2);
  return `${prefix}\n${content}`.trim();
}

function parseInputTokens(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input = (usage as { input?: unknown }).input;
  return typeof input === "number" && Number.isFinite(input) && input > 0
    ? Math.floor(input)
    : null;
}

function estimateHistoryTokens(messages: ProcHistoryMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.role.length + 4;
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    try {
      chars += JSON.stringify(message.content).length;
    } catch {
      chars += 64;
    }
  }
  return Math.ceil(chars / 4);
}

function shouldScheduleArchivistJob(
  lastCompleted: AutomationJobRecord | null,
  messageCount: number,
  estimatedTokens: number,
  inputTokens: number | null,
  minIntervalMs: number,
): boolean {
  const hasPressure =
    messageCount >= ARCHIVIST_MIN_MESSAGE_COUNT
    || estimatedTokens >= ARCHIVIST_MIN_ESTIMATED_TOKENS
    || (inputTokens !== null && inputTokens >= ARCHIVIST_MIN_INPUT_TOKENS);

  if (!hasPressure) {
    return false;
  }

  if (!lastCompleted) {
    return true;
  }

  const withinCooldown = Date.now() - lastCompleted.updatedAt < minIntervalMs;
  if (!withinCooldown) {
    return true;
  }

  const messageDelta = messageCount - lastCompleted.sourceMessageCount;
  const estimatedTokenDelta = estimatedTokens - lastCompleted.sourceEstimatedTokens;
  const inputTokenDelta =
    inputTokens !== null && lastCompleted.sourceInputTokens !== null
      ? inputTokens - lastCompleted.sourceInputTokens
      : null;

  return messageDelta >= ARCHIVIST_MIN_MESSAGE_DELTA
    || estimatedTokenDelta >= ARCHIVIST_MIN_TOKEN_DELTA
    || (inputTokenDelta !== null && inputTokenDelta >= ARCHIVIST_MIN_INPUT_TOKEN_DELTA);
}
