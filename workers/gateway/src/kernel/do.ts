import {
  cancelUnlockedBody,
} from "./do-shared";
import {
  RequestCancelledError,
  errFrame,
  requestAbortError,
} from "./do-shared";
import type {
  TargetRequestOptions,
} from "./do-shared";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  MCPClientManager,
} from "agents/mcp/client";
import type {
  Frame,
  FrameBody,
  RequestFrame,
  ResponseOkFrame,
  ResponseFrame,
} from "../protocol/frames";
import { consumeProcessRunStream } from "../protocol/process-run-stream";
import type {
  AdapterLinkedPeerContext,
  BinaryBody,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailReference,
  UnlinkManagedAdapterIdentityInput,
  UnlinkManagedAdapterIdentityResult,
  UnlinkManagedTelegramIdentityInput,
  UnlinkManagedTelegramIdentityResult,
  NetFetchArgs,
  ProcessIdentity,
  SysTargetDeleteResult,
} from "@humansandmachines/gsv/protocol";
import type { ConnectionIdentity } from "./identity";
import {
  adapterSurfaceSchema,
} from "@humansandmachines/gsv/protocol";
import { AuthStore } from "./auth-store";
import { CapabilityStore, hasCapability } from "./capabilities";
import { ConfigStore } from "./config";
import { TargetRegistry } from "./target-registry";
import {
  RoutingTable,
  type RouteOrigin,
} from "./routing";
import { ShellSessionStore } from "./shell-sessions";
import {
  ProcessRegistry,
} from "./processes";
import { ConversationRegistry } from "./conversations";
import { AdapterStore } from "./adapter-store";
import { RunRouteStore } from "./run-routes";
import { OAuthStore } from "./oauth-store";
import { McpServerStore } from "./mcp-store";
import { MailboxStore } from "./mailbox-store";
import { SignalWatchStore } from "./signal-watches";
import { isUserProcessSignal } from "./user-signals";
import { IpcCallStore } from "./ipc-calls";
import {
  ScheduleStore,
} from "./scheduler";
import { dispatch, type DispatchDeps } from "./dispatch";
import { raceWithAbort } from "../shared/abort";
import type { KernelContext } from "./context";
import {
  connectedPeerContext,
  delegatedAdapterPeerContext,
  peerAllowsCall,
  type PeerContext,
  processPeerContext,
  servicePeerContext,
  type ServicePeerProfile,
} from "./peer";
import { completeOAuthCallback as completeOAuthCallbackFlow } from "./sys/oauth";
import { installMcpDiscoveryCompatibility } from "./mcp-compat";
import { oauthCallbackHtmlResponse } from "../oauth-http";
import { isInternalOnlySyscall } from "./syscall-exposure";
import {
  assertAdapterMessageDestinationAccess,
  identityLinkRouteGeneration,
} from "./adapter-destinations";
import type { InternalResponseFrame } from "../protocol/process-frames";
import type {
  ProcessOutboundFrame,
} from "../protocol/process-frames";
import { isRepoPublic } from "./repo-visibility";
import { canReadRepo, canWriteRepo } from "./repo";
import {
  ResponsibilityStore,
} from "./responsibility-store";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";
import {
  recordAdapterStatusTransition,
} from "./lifecycle-responsibilities";
import { FederationStore } from "./federation-store";
import { FederationIdentity } from "./federation-crypto";
import {
  handleFederationHttpRequest,
  isFederationPublicPath,
  MAX_FEDERATION_RECOVERABLE_INBOX,
  MAX_FEDERATION_RECOVERABLE_OUTBOX,
} from "./federation";
import {
  acceptManagedInboundMail as acceptKernelManagedInboundMail,
  completeManagedInboundMail as completeKernelManagedInboundMail,
} from "./mailbox";
import {
  claimManagedOutboundMail as claimKernelManagedOutboundMail,
  completeManagedOutboundMail as completeKernelManagedOutboundMail,
  recoverManagedOutboundEnqueue,
} from "./outbound-mail";
import { getVisibleTarget } from "./targets";
import { runKernelSqlMigrations } from "./schema/migrations";
import { SERVER_VERSION } from "../version";
import { parseInstallationId } from "../installation/identity";
import type { InstallationIdentity } from "../installation/identity";
import { createInstallationStorage } from "../installation/storage";
import { createInstallationRipgit } from "../installation/ripgit";
import {
  DurableTaskScheduler,
  type DurableTask,
  type DurableTaskOptions,
} from "../shared/durable-tasks";
import type { GatewayEnv } from "../runtime-env";
import {
  acceptKernelWebSocket,
  KernelConnection,
  type KernelConnectionState as ConnectionState,
  type KernelWebSocketMessage,
} from "./connection";

import { McpConnections } from "./mcp-connections";
import { ManagedOnboarding } from "./managed-onboarding";
import {
  MANAGED_ONBOARDING_COMPLETION_KEY,
} from "./do-shared";
import type {
  PendingManagedOnboardingCompletion,
} from "./do-shared";
import { ScheduleRuntime } from "./schedule-runtime";
import { IpcRuntime } from "./ipc-runtime";
import {
  ipcCallTimeoutPayloadSchema,
  userProcessSignalFrameSchema,
} from "./do-shared";
import type {
  IpcCallTimeout,
} from "./do-shared";
import { ResponsibilityRuntime } from "./responsibility-runtime";
import { FederationRuntime } from "./federation-runtime";
import { ProcessOutput } from "./process-output";
import { AdapterDelivery } from "./adapter-delivery";
import type {
  AdapterRouteDeliveryRetry,
  ProcessDeliveryNoticeRetry,
} from "./do-shared";
import { ConnectionRuntime } from "./connection-runtime";
import { Transport } from "./transport";
type ProcessNetFetchOptions = {
  ttlMs?: number;
  internalPurpose?: "model-transport";
  body?: FrameBody;
  requestId?: string;
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

type StoredInstallationIdentity = Omit<InstallationIdentity, "installationId">;

type KernelTask =
  | { callback: "onAdapterRouteDelivery"; payload: AdapterRouteDeliveryRetry }
  | { callback: "onIpcCallDelivery"; payload: string }
  | { callback: "onIpcCallTimeout"; payload: IpcCallTimeout }
  | { callback: "onManagedOutboundEnqueue"; payload: string }
  | { callback: "onFederationDelivery"; payload: string }
  | {
      callback: "onFederationInbox";
      payload: { contactId: string; contactGeneration: string; deliveryId: string };
    }
  | { callback: "onProcessDeliveryNotice"; payload: ProcessDeliveryNoticeRetry }
  | { callback: "onRouteExpired"; payload: string }
  | { callback: "onScheduleDue"; payload: string }
  | {
      callback: "onResponsibilityWake";
      payload: { ownerUid: number; generation: number };
    };

type KernelTaskCallback = KernelTask["callback"];

const adapterDeliveryRouteSchema = z.object({
  kind: z.literal("adapter"),
  runId: z.string(),
  processId: z.string(),
  uid: z.number().int().nonnegative(),
  destination: z.object({
    kind: z.literal("adapter"),
    adapter: z.string(),
    accountId: z.string(),
    actorId: z.string(),
    surface: adapterSurfaceSchema,
  }),
  replyToId: z.string().optional(),
  routeGeneration: z.string().optional(),
});

const KERNEL_TASK_SCHEMA = z.discriminatedUnion("callback", [
  z.object({
    callback: z.literal("onAdapterRouteDelivery"),
    payload: z.object({
      runId: z.string(),
      processId: z.string(),
      route: adapterDeliveryRouteSchema.optional(),
      event: z.string(),
      payload: z.json().optional(),
      attempt: z.number().int().positive(),
    }),
  }),
  z.object({ callback: z.literal("onIpcCallDelivery"), payload: z.string() }),
  z.object({
    callback: z.literal("onIpcCallTimeout"),
    payload: ipcCallTimeoutPayloadSchema,
  }),
  z.object({ callback: z.literal("onManagedOutboundEnqueue"), payload: z.string() }),
  z.object({ callback: z.literal("onFederationDelivery"), payload: z.string() }),
  z.object({
    callback: z.literal("onFederationInbox"),
    payload: z.object({
      contactId: z.string(),
      contactGeneration: z.string(),
      deliveryId: z.string(),
    }),
  }),
  z.object({
    callback: z.literal("onProcessDeliveryNotice"),
    payload: z.object({
      noticeId: z.string(),
      runId: z.string(),
      processId: z.string(),
      deliveryKind: z.enum(["hil", "message", "final"]),
      deliveryId: z.string().optional(),
      requestId: z.string().optional(),
      state: z.enum(["permanent", "ambiguous", "exhausted"]),
      message: z.string(),
      route: adapterDeliveryRouteSchema.optional(),
      cleanupRunRoute: z.boolean().optional(),
    }),
  }),
  z.object({ callback: z.literal("onRouteExpired"), payload: z.string() }),
  z.object({ callback: z.literal("onScheduleDue"), payload: z.string() }),
  z.object({
    callback: z.literal("onResponsibilityWake"),
    payload: z.object({
      ownerUid: z.number().int().nonnegative(),
      generation: z.number().int().nonnegative(),
    }),
  }),
]);
const processMessageStreamSignalSchema = z.object({
  type: z.literal("sig"),
  signal: z.literal("proc.message.stream"),
  payload: z.object({
    pid: z.string(),
    runId: z.string(),
    conversationId: z.string().optional(),
    messageId: z.string(),
    phase: z.enum(["started", "delta", "aborted", "silenced"]),
    delta: z.string().optional(),
    reason: z.string().optional(),
    timestamp: z.number(),
  }),
});
const processSignalFrameSchema = z.object({
  type: z.literal("sig"),
  signal: z.string(),
  payload: z.json().optional(),
  seq: z.number().optional(),
});
const managedTelegramUnlinkSchema = z.object({
  installationId: z.string(),
  operationId: z.string().min(1),
  actorId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  surfaceId: z.string(),
  expectedLocalUid: z.number().int().nonnegative(),
  expectedGeneration: z.string().min(1),
});
const managedAdapterUnlinkSchema = z.object({
  operationId: z.string().min(1),
  accountId: z.string().trim().min(1).max(200),
  actorId: z.string().trim().min(1).max(200),
  surfaceId: z.string().trim().min(1).max(200),
  expectedLocalUid: z.number().int().nonnegative(),
  expectedGeneration: z.string().min(1),
});

const serviceBindingArgsSchema = z.object({
  adapter: z.string().trim().min(1).optional(),
});
const servicePeerProfileSchema = z.object({
  id: z.string().trim().min(1),
  calls: z.array(z.string().trim().min(1)),
});

/**
 * Kernel DO — the composition root for the installation control plane.
 *
 * The class owns Durable Object lifecycle, the stores, context construction,
 * the shared syscall dispatcher preamble, the RPC surface used by the Worker,
 * Processes, and adapters, and the durable task router. Runtime modules own
 * the rest: Transport carries WebSocket frames, bodies, routes, and request
 * cancellation; ConnectionRuntime owns peer sessions and user broadcasts;
 * AdapterDelivery owns routed adapter delivery and delivery notices;
 * ProcessOutput relays Process signals, message streams, and commits;
 * FederationRuntime and ResponsibilityRuntime own their durable wakes;
 * IpcRuntime owns delegated call supervision; ScheduleRuntime executes
 * schedules; ManagedOnboarding owns setup and managed lifecycle gating; and
 * McpConnections owns MCP client sessions. Each module is bound to one Kernel
 * host and reaches the others through it.
 */
export function kernelRuntimes(host: Kernel) {
  return {
    transport: new Transport(host),
    connectionRuntime: new ConnectionRuntime(host),
    adapterDelivery: new AdapterDelivery(host),
    processOutput: new ProcessOutput(host),
    federationRuntime: new FederationRuntime(host),
    responsibilityRuntime: new ResponsibilityRuntime(host),
    ipc: new IpcRuntime(host),
    scheduleRuntime: new ScheduleRuntime(host),
    onboarding: new ManagedOnboarding(host),
    mcpConnections: new McpConnections(host),
  };
}

export class Kernel extends DurableObject<GatewayEnv> {
  readonly installationId: string;
  installationIdentity?: InstallationIdentity;
  readonly installationStorage: R2Bucket;
  readonly installationEnv: GatewayEnv;
  readonly auth: AuthStore;
  readonly caps: CapabilityStore;
  readonly config: ConfigStore;
  readonly targets: TargetRegistry;
  readonly routes: RoutingTable;
  readonly shellSessions: ShellSessionStore;
  readonly procs: ProcessRegistry;
  readonly conversations: ConversationRegistry;
  readonly adapters: AdapterStore;
  readonly runRoutes: RunRouteStore;
  readonly signalWatches: SignalWatchStore;
  readonly ipcCalls: IpcCallStore;
  readonly schedules: ScheduleStore;
  readonly mailboxes: MailboxStore;
  readonly responsibilities: ResponsibilityStore;
  readonly responsibilitySources: ResponsibilitySourcePolicyStore;
  readonly federation: FederationStore;
  readonly federationIdentity: FederationIdentity;
  readonly oauth: OAuthStore;
  readonly mcpServers: McpServerStore;
  readonly connections = new Map<string, KernelConnection<ConnectionState>>();
  readonly tasks: DurableTaskScheduler<KernelTask>;
  mcp: MCPClientManager;
                      readonly ctx: DurableObjectState<{}>;
  readonly env: GatewayEnv;
  declare readonly mcpConnections: McpConnections;
  declare readonly onboarding: ManagedOnboarding;
  declare readonly scheduleRuntime: ScheduleRuntime;
  declare readonly ipc: IpcRuntime;
  declare readonly responsibilityRuntime: ResponsibilityRuntime;
  declare readonly federationRuntime: FederationRuntime;
  declare readonly processOutput: ProcessOutput;
  declare readonly adapterDelivery: AdapterDelivery;
  declare readonly connectionRuntime: ConnectionRuntime;
  declare readonly transport: Transport;

  constructor(ctx: DurableObjectState<{}>, env: GatewayEnv) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    Object.assign(this, kernelRuntimes(this));
    this.installationId = parseInstallationId(ctx.id.name);
    const sql = ctx.storage.sql;
    runKernelSqlMigrations(ctx.storage);

    const identity = ctx.storage.kv.get<StoredInstallationIdentity>("install_identity");
    this.installationIdentity = identity
      ? { ...identity, installationId: this.installationId }
      : undefined;
    this.onboarding.pendingManagedOnboarding = ctx.storage.kv.get<PendingManagedOnboardingCompletion>(
      MANAGED_ONBOARDING_COMPLETION_KEY,
    );
    this.installationStorage = createInstallationStorage(
      env.STORAGE,
      this.installationId,
    );
    this.installationEnv = envWithInstallationResources(
      env,
      this.installationStorage,
      env.RIPGIT
        ? createInstallationRipgit(env.RIPGIT, this.installationId)
        : undefined,
    );

    this.auth = new AuthStore(sql);

    this.caps = new CapabilityStore(sql);
    this.caps.seed();

    this.config = new ConfigStore(sql);

    this.targets = new TargetRegistry(sql);

    this.routes = new RoutingTable(sql);

    this.shellSessions = new ShellSessionStore(sql);

    this.procs = new ProcessRegistry(sql);

    this.conversations = new ConversationRegistry(sql);

    this.adapters = new AdapterStore(sql);

    this.runRoutes = new RunRouteStore(sql);

    this.signalWatches = new SignalWatchStore(sql);

    this.ipcCalls = new IpcCallStore(sql);

    this.schedules = new ScheduleStore(sql);

    this.mailboxes = new MailboxStore(sql);

    this.responsibilities = new ResponsibilityStore(ctx.storage);
    this.responsibilitySources = new ResponsibilitySourcePolicyStore(sql);
    this.federation = new FederationStore(ctx.storage);
    this.federationIdentity = new FederationIdentity(ctx.storage);

    this.oauth = new OAuthStore(sql);

    this.mcpServers = new McpServerStore(sql);
    this.tasks = new DurableTaskScheduler(
      ctx.storage,
      decodeKernelTask,
      this.runScheduledTask.bind(this),
    );
    this.mcp = new MCPClientManager("GSV Kernel", SERVER_VERSION, {
      storage: ctx.storage,
      createAuthProvider: (callbackUrl) => this.mcpConnections.createMcpOAuthProvider(callbackUrl),
    });
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
      this.mcpConnections.broadcastMcpChanged();
    });
    ctx.blockConcurrencyWhile(async () => {
      await this.mcp.restoreConnectionsFromStorage(ctx.id.name ?? this.installationId);
    });

    this.connectionRuntime.rehydrateConnections();
    for (const callId of this.ipcCalls.recoverDeliveryIds()) {
      this.ipc.queueIpcCallDelivery(callId);
    }
    ctx.waitUntil(this.responsibilityRuntime.recoverResponsibilityWakes().catch((error) => {
      console.warn(
        "[Kernel] Failed to recover responsibility wakes:",
        error instanceof Error ? error.message : String(error),
      );
    }));
    ctx.blockConcurrencyWhile(async () => {
      for (const delivery of this.federation.recoverableOutbox(
        MAX_FEDERATION_RECOVERABLE_OUTBOX,
      )) {
        await this.federationRuntime.scheduleFederationDelivery(
          delivery.deliveryId,
          delivery.nextAttemptAtMs ?? Date.now(),
          true,
        );
      }
      for (const inbox of this.federation.recoverableInbox(
        MAX_FEDERATION_RECOVERABLE_INBOX,
      )) {
        await this.federationRuntime.scheduleFederationInbox(
          inbox.contactId,
          inbox.contactGeneration,
          inbox.deliveryId,
          Date.now(),
          true,
        );
      }
    });
  }

    async ensureInstallationIdentity(input: InstallationIdentity) {
    if (input.installationId !== this.installationId) {
      throw new Error("installation identity conflicts with Kernel name");
    }

    if (!this.installationIdentity) {
      const identity: StoredInstallationIdentity = {
        canonicalOrigin: input.canonicalOrigin,
      };
      if (input.handle !== undefined) identity.handle = input.handle;
      this.ctx.storage.kv.put("install_identity", identity);
      this.installationIdentity = {
        ...identity,
        installationId: this.installationId,
      };
      return this.installationIdentity;
    }

    const existing = this.installationIdentity;
    if (
      existing.installationId !== input.installationId
      || existing.handle !== input.handle
      || existing.canonicalOrigin !== input.canonicalOrigin
    ) {
      throw new Error("installation identity conflicts with persisted Kernel identity");
    }
    return existing;
  }

  async getInstallationIdentity(): Promise<InstallationIdentity | null> {
    return this.installationIdentity ?? null;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (isFederationPublicPath(url.pathname)) {
      return await handleFederationHttpRequest(request, this.buildKernelContext({}));
    }
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (
        request.method !== "GET"
        || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const accepted = acceptKernelWebSocket<ConnectionState>(
        this.ctx,
        request,
        { step: "pending" } satisfies ConnectionState,
      );
      this.connectionRuntime.onConnect(accepted.connection);
      return accepted.response;
    }

    if (this.mcp.isCallbackRequest(request)) {
      const result = await this.mcp.handleCallbackRequest(request);
      if (result.authSuccess) {
        this.ctx.waitUntil(this.mcp.establishConnection(result.serverId));
      }
      this.mcpConnections.broadcastMcpChanged();
      const customHandler = this.mcp.getOAuthCallbackConfig()?.customHandler;
      return customHandler
        ? customHandler(result)
        : Response.redirect(url.origin);
    }
    return await this.onRequest(request);
  }

  async webSocketMessage(
    socket: WebSocket,
    message: KernelWebSocketMessage,
  ): Promise<void> {
    const connection = this.connectionRuntime.connectionForSocket(socket);
    if (!connection) {
      socket.close(1011, "Connection state unavailable");
      return;
    }
    await this.transport.onMessage(connection, message);
  }

  webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    const connection = this.connectionRuntime.connectionForSocket(socket);
    if (connection) this.connectionRuntime.onClose(connection);
  }

  webSocketError(socket: WebSocket): void {
    const connection = this.connectionRuntime.connectionForSocket(socket);
    if (connection) this.connectionRuntime.onClose(connection);
  }

  async alarm(): Promise<void> {
    await this.tasks.alarm();
  }

  schedule(
    when: Date | number,
    callback: KernelTaskCallback,
    payload: KernelTask["payload"],
    options?: DurableTaskOptions,
  ) {
    const task = KERNEL_TASK_SCHEMA.parse({ callback, payload });
    return this.tasks.schedule(when, task, options);
  }

  cancelSchedule(id: string): Promise<boolean> {
    return this.tasks.cancel(id);
  }

  async runScheduledTask(
    task: DurableTask<KernelTask>,
  ): Promise<void> {
    switch (task.callback) {
      case "onAdapterRouteDelivery":
        await this.adapterDelivery.onAdapterRouteDelivery(task.payload);
        return;
      case "onIpcCallDelivery":
        await this.ipc.onIpcCallDelivery(task.payload);
        return;
      case "onIpcCallTimeout":
        await this.ipc.onIpcCallTimeout(task.payload, task);
        return;
      case "onManagedOutboundEnqueue":
        await this.onManagedOutboundEnqueue(task.payload);
        return;
      case "onFederationDelivery":
        await this.federationRuntime.onFederationDelivery(task.payload);
        return;
      case "onFederationInbox":
        await this.federationRuntime.onFederationInbox(task.payload);
        return;
      case "onProcessDeliveryNotice":
        await this.adapterDelivery.onProcessDeliveryNotice(task.payload);
        return;
      case "onRouteExpired":
        await this.transport.onRouteExpired(task.payload);
        return;
      case "onScheduleDue":
        await this.scheduleRuntime.onScheduleDue(task.payload, task);
        return;
      case "onResponsibilityWake":
        await this.responsibilityRuntime.onResponsibilityWake(task.payload, task);
        return;
    }
  }

                  /**
   * RPC method — called by Process DOs to send/receive frames.
   *
   * Returns a Frame if the request was handled synchronously (native syscall),
   * or null if deferred (forwarded to a device — result will arrive later
   * via process.recvFrame callback).
   */
  async recvFrame(
    processId: string,
    frame: ProcessOutboundFrame,
  ): Promise<Frame | InternalResponseFrame<"proc.message.commit"> | null> {
    if (frame.type === "req") {
      if (frame.call === "proc.message.commit") {
        try {
          return {
            type: "res",
            id: frame.id,
            ok: true,
            data: {
              message: await this.processOutput.commitProcessMessage(processId, frame.args),
            },
          };
        } catch (error) {
          return errFrame(
            frame.id,
            500,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      try {
        return await this.handleProcessReq(processId, frame);
      } finally {
        await cancelUnlockedBody(frame.body, "Process request completed");
      }
    }

    if (frame.type === "sig") {
      if (frame.signal === "proc.message.stream") {
        const parsed = processMessageStreamSignalSchema.safeParse(frame);
        if (!parsed.success) return null;
        await this.processOutput.deliverProcessMessageStream(processId, parsed.data);
        return null;
      }
      const parsed = processSignalFrameSchema.safeParse(frame);
      if (!parsed.success) return null;
      const processFrame = parsed.data;
      const userFrame = isUserProcessSignal(processFrame.signal)
        ? userProcessSignalFrameSchema.safeParse(processFrame)
        : null;
      if (userFrame && !userFrame.success) return null;
      const typedUserFrame = userFrame?.data;
      const runId = typedUserFrame?.payload?.runId?.trim() || null;
      if (
        typedUserFrame
        && !this.processOutput.updateProcessRuntimeFromSignal(processId, typedUserFrame, runId)
      ) {
        if (frame.signal === "proc.run.finished" && runId) {
          this.runRoutes.delete(runId);
        }
        return null;
      }
      const delivered = this.processOutput.enqueueProcessSignal(processId, processFrame, typedUserFrame);
      if (typedUserFrame) {
        this.ipc.completeIpcCallsForProcessSignal(processId, typedUserFrame);
      }
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

      async acceptProcessRunStream(
    processId: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<boolean> {
    if (!this.procs.get(processId)) {
      await stream.cancel("Unknown process").catch(() => {});
      return false;
    }
    void consumeProcessRunStream(
      processId,
      stream,
      async (frame) => {
        await this.recvFrame(processId, frame);
      },
    ).catch(() => {
      console.warn("[Kernel] Process run stream ended before completion");
    });
    return true;
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
      if (options.requestId) {
        controller = this.transport.registerActiveRequest(origin, options.requestId);
      }
      const requestOptions: TargetRequestOptions = {};
      if (options.ttlMs !== undefined) requestOptions.ttlMs = options.ttlMs;
      if (options.body !== undefined) requestOptions.body = options.body;
      if (options.requestId !== undefined) requestOptions.id = options.requestId;
      if (controller) requestOptions.signal = controller.signal;
      const response = await this.transport.requestTarget(
        device.targetId,
        "net.fetch",
        args,
        requestOptions,
      );
      // SAFETY: requestTarget preserves the result type for the net.fetch call.
      return response as ResponseOkFrame<"net.fetch">;
    } finally {
      if (options.requestId && controller) {
        this.transport.finishActiveRequest(options.requestId, controller);
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
      if (this.transport.cancelRequest(origin, requestId, reason, true)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /**
   * Service-binding RPC entrypoint.
   * Accepts the same frame format as WS connections/process RPC.
   */
  async peerFrame(profile: ServicePeerProfile, frame: Frame): Promise<Frame | null> {
    const body = "body" in frame ? frame.body : undefined;
    try {
      if (frame.type !== "req") {
        return null;
      }
      const parsedProfile = servicePeerProfileSchema.safeParse(profile);
      if (!parsedProfile.success) {
        return errFrame(frame.id, 403, "Service peer profile is invalid");
      }
      const gate = await this.onboarding.managedWorkGate();
      if (!gate.allowed) {
        return errFrame(frame.id, gate.code, gate.message);
      }
      return await this.handleServiceReq(parsedProfile.data, frame);
    } finally {
      await cancelUnlockedBody(body, "Service request completed");
    }
  }

  /**
   * Interaction-scoped request carrier for a human linked through an adapter.
   * The adapter binding fixes the service identity; Kernel state derives the
   * local uid and intersects the one allowed call with that human's grant.
   */
  async linkedAdapterPeerFrame(
    profile: ServicePeerProfile,
    interaction: AdapterLinkedPeerContext,
    frame: Frame,
  ): Promise<Frame | null> {
    const body = "body" in frame ? frame.body : undefined;
    try {
      if (frame.type !== "req") return null;
      const parsedProfile = servicePeerProfileSchema.safeParse(profile);
      if (!parsedProfile.success) {
        return errFrame(frame.id, 403, "Service peer profile is invalid");
      }
      if (frame.call !== "proc.hil") {
        return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
      }
      const gate = await this.onboarding.managedWorkGate();
      if (!gate.allowed) return errFrame(frame.id, gate.code, gate.message);

      const adapter = parsedProfile.data.id;
      const link = this.adapters.identityLinks.get(
        adapter,
        interaction.accountId,
        interaction.actorId,
      );
      if (!link) return errFrame(frame.id, 403, "Adapter identity is not linked");
      const currentGeneration = identityLinkRouteGeneration(link, interaction.surface);
      if ((interaction.routeGeneration ?? "") !== (currentGeneration ?? "")) {
        return errFrame(frame.id, 409, "Adapter route changed before request");
      }

      const account = this.auth.getPasswdByUid(link.uid);
      if (!account) return errFrame(frame.id, 403, "Linked user no longer exists");
      const identity: ProcessIdentity = {
        uid: account.uid,
        gid: account.gid,
        gids: this.auth.resolveGids(account.username, account.gid),
        username: account.username,
        home: account.home,
        cwd: account.home,
      };
      const calls = ["proc.hil"].filter((call) =>
        hasCapability(this.caps.resolve(identity.gids), call)
      );
      const peer = delegatedAdapterPeerContext({
        installationId: this.installationId,
        serviceId: adapter,
        accountId: interaction.accountId,
        actorId: interaction.actorId,
        surface: interaction.surface,
        sessionId: `adapter:${adapter}:${interaction.interactionId}`,
        identity,
        calls,
      });
      const ctx = this.buildKernelContext({
        identity: peer.identity,
        peer,
        callerOwnerUid: link.uid,
      });
      try {
        assertAdapterMessageDestinationAccess({
          kind: "adapter",
          adapter,
          accountId: interaction.accountId,
          actorId: interaction.actorId,
          surface: interaction.surface,
        }, link.uid, ctx);
      } catch {
        return errFrame(frame.id, 403, "Adapter destination is no longer authorized");
      }
      return await this.dispatchPeerRequest(
        frame,
        { type: "kernel", id: interaction.interactionId },
        ctx,
        { awaitRouted: true },
      ) ?? errFrame(frame.id, 500, "Linked adapter request produced no response");
    } finally {
      await cancelUnlockedBody(body, "Linked adapter request completed");
    }
  }

  async acceptManagedInboundMail(
    metadata: ManagedInboundMailMetadata,
    body: BinaryBody,
  ): Promise<ManagedInboundMailAccepted> {
    try {
      const gate = await this.onboarding.managedWorkGate();
      if (!gate.allowed) throw new Error(gate.message);
      return await acceptKernelManagedInboundMail(
        metadata,
        body,
        this.buildKernelContext({}),
      );
    } finally {
      await cancelUnlockedBody(body, "Managed mail request completed");
    }
  }

  async completeManagedInboundMail(
    completion: ManagedInboundMailCompletion,
  ): Promise<void> {
    const gate = await this.onboarding.managedWorkGate();
    if (!gate.allowed) throw new Error(gate.message);
    await completeKernelManagedInboundMail(
      completion,
      this.buildKernelContext({}),
    );
  }

  async claimManagedOutboundMail(
    reference: ManagedOutboundMailReference,
  ): Promise<ManagedOutboundMailClaimOutcome> {
    const gate = await this.onboarding.managedWorkGate();
    if (!gate.allowed) throw new Error(gate.message);
    return await claimKernelManagedOutboundMail(
      reference,
      this.buildKernelContext({}),
    );
  }

  async completeManagedOutboundMail(
    completion: ManagedOutboundMailCompletion,
  ): Promise<void> {
    completeKernelManagedOutboundMail(
      completion,
      this.buildKernelContext({}),
    );
  }

  async unlinkManagedTelegramIdentity(
    input: UnlinkManagedTelegramIdentityInput,
  ): Promise<UnlinkManagedTelegramIdentityResult> {
    const parsed = managedTelegramUnlinkSchema.parse(input);
    if (parsed.installationId !== this.installationId) {
      throw new Error("Managed Telegram installation identity mismatch");
    }
    if (parsed.surfaceId !== parsed.actorId) {
      throw new Error("Managed Telegram unlink input is invalid");
    }
    return await this.unlinkManagedAdapterIdentity("telegram", {
      operationId: parsed.operationId,
      accountId: "managed",
      actorId: parsed.actorId,
      surfaceId: parsed.surfaceId,
      expectedLocalUid: parsed.expectedLocalUid,
      expectedGeneration: parsed.expectedGeneration,
    });
  }

  async unlinkManagedAdapterIdentity(
    adapter: string,
    input: UnlinkManagedAdapterIdentityInput,
  ): Promise<UnlinkManagedAdapterIdentityResult> {
    const normalizedAdapter = adapter.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalizedAdapter)) {
      throw new Error("Managed adapter identity is invalid");
    }
    const parsed = managedAdapterUnlinkSchema.parse(input);
    const link = this.adapters.identityLinks.get(
      normalizedAdapter,
      parsed.accountId,
      parsed.actorId,
    );
    if (
      !link
      || link.uid !== parsed.expectedLocalUid
      || link.metadata?.managed !== true
      || link.metadata?.surfaceId !== parsed.surfaceId
      || link.metadata?.routeGeneration !== parsed.expectedGeneration
    ) {
      return { removed: false };
    }
    const previousStatus = this.adapters.status.get(
      normalizedAdapter,
      parsed.accountId,
    );
    const removed = this.adapters.identityLinks.unlink(
      normalizedAdapter,
      parsed.accountId,
      parsed.actorId,
    );
    if (!removed) return { removed: false };

    const remainingLinks = this.adapters.identityLinks.listByAccount(
      normalizedAdapter,
      parsed.accountId,
    );
    if (!previousStatus) {
      this.adapters.status.setOwner(normalizedAdapter, parsed.accountId, link.uid);
    }
    const currentStatus = this.adapters.status.upsert(
      normalizedAdapter,
      parsed.accountId,
      {
        accountId: parsed.accountId,
        connected: previousStatus?.connected ?? false,
        authenticated: remainingLinks.length > 0,
        mode: previousStatus?.mode ?? "managed-shared",
        lastActivity: Date.now(),
        error: previousStatus?.error,
        extra: previousStatus?.extra,
      },
    );
    recordAdapterStatusTransition(
      previousStatus,
      currentStatus,
      this.buildKernelContext({}),
      {
        suppressAuthenticationRequired: true,
        intentionalDisconnect: remainingLinks.length === 0,
      },
    );

    const notifiedUids = new Set([0, link.uid]);
    if (currentStatus.ownerUid !== null) notifiedUids.add(currentStatus.ownerUid);
    for (const remainingLink of remainingLinks) notifiedUids.add(remainingLink.uid);
    for (const uid of notifiedUids) {
      this.connectionRuntime.broadcastToUserUid(uid, "adapter.status", {
        adapter: normalizedAdapter,
        accountId: parsed.accountId,
      });
    }
    return { removed: true };
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
        : await this.auth.authenticateToken(username, credential, { kind: "human" });

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

                                      async handleProcessReq(processId: string, frame: RequestFrame): Promise<ResponseFrame | null> {
    const ctx = this.buildProcessContext(processId, frame.runId);
    if (!ctx) {
      return errFrame(frame.id, 404, "Unknown process");
    }

    return await this.dispatchPeerRequest(
      frame,
      { type: "process", id: processId },
      ctx,
      { awaitRouted: false },
    );
  }

  buildProcessContext(processId: string, processRunId?: string): KernelContext | null {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      return null;
    }

    return this.buildKernelContext({
      peer: processPeerContext({
        installationId: this.installationId,
        processId,
        identity,
        calls: this.caps.resolve(identity.gids),
      }),
      processId,
      processRunId,
    });
  }

  async handleServiceReq(
    profile: ServicePeerProfile,
    frame: RequestFrame,
  ): Promise<ResponseFrame> {
    if (frame.call === "sys.connect" || frame.call === "sys.setup" || frame.call === "sys.setup.assist") {
      return errFrame(frame.id, 400, `${frame.call} is not supported via serviceFrame`);
    }

    const identity = this.buildServiceBindingIdentity(profile);
    if (!identity) {
      return errFrame(frame.id, 503, "Service identity is not configured");
    }
    const args = serviceBindingArgsSchema.safeParse(frame.args);
    if (args.success && args.data.adapter && args.data.adapter.toLowerCase() !== profile.id) {
      return errFrame(frame.id, 403, "Service peer cannot act as another adapter");
    }
    const peer = servicePeerContext({
      installationId: this.installationId,
      profile,
      sessionId: `service:${profile.id}`,
      identity,
    });
    const ctx = this.buildKernelContext({ peer });
    return await this.dispatchPeerRequest(
      frame,
      { type: "kernel", id: frame.id },
      ctx,
      { awaitRouted: true },
    ) ?? errFrame(frame.id, 500, "Service request did not produce a response");
  }

  buildContext(connection: KernelConnection<ConnectionState>): KernelContext {
    const state = connection.state;
    if (!state) throw new Error("Connection state is missing");
    const peer = state.peer
      ? connectedPeerContext({
          installationId: this.installationId,
          peer: state.peer,
          credential: state.credentialMethod ?? "token",
        })
      : undefined;
    return this.buildKernelContext({ connection, peer });
  }

  buildKernelContext(options: {
    connection?: KernelConnection<ConnectionState> | null;
    peer?: PeerContext;
    identity?: ConnectionIdentity;
    processId?: string;
    processRunId?: string;
    requestSignal?: AbortSignal;
    callerOwnerUid?: number;
  }): KernelContext {
    const installationIdentity = this.installationIdentity ?? null;
    return {
      env: this.bindings,
      installationId: this.installationId,
      installationIdentity,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      targets: this.targets,
      procs: this.procs,
      conversations: this.conversations,
      oauth: this.oauth,
      mcp: this.mcp,
      mcpServers: this.mcpServers,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      shellSessions: this.shellSessions,
      signalWatches: this.signalWatches,
      ipcCalls: this.ipcCalls,
      schedules: this.schedules,
      mailboxes: this.mailboxes,
      responsibilities: this.responsibilities,
      responsibilitySources: this.responsibilitySources,
      federation: this.federation,
      federationIdentity: this.federationIdentity,
      connection: options.connection ?? null,
      peer: options.peer,
      identity: options.identity ?? options.peer?.identity,
      processId: options.processId,
      processRunId: options.processRunId,
      requestSignal: options.requestSignal,
      callerOwnerUid: options.callerOwnerUid,
      serverVersion: SERVER_VERSION,
      defer: (promise) => this.ctx.waitUntil(promise),
      broadcastToUserUid: this.connectionRuntime.broadcastToUserUid.bind(this.connectionRuntime),
      scheduleIpcCallTimeout: this.ipc.scheduleIpcCallTimeout.bind(this.ipc),
      failIpcCallsByTarget: this.ipc.failIpcCallsByTarget.bind(this.ipc),
      scheduleScheduleWake: this.scheduleRuntime.scheduleScheduleWake.bind(this.scheduleRuntime),
      cancelScheduleWake: async (wakeScheduleId) => {
        await this.cancelSchedule(wakeScheduleId);
      },
      reconcileResponsibilityWake: this.responsibilityRuntime.reconcileResponsibilityWake.bind(this.responsibilityRuntime),
      scheduleManagedOutboundEnqueue: async (outboundId, dueAtMs) => {
        await this.scheduleManagedOutboundEnqueue(outboundId, dueAtMs);
      },
      scheduleFederationDelivery: this.federationRuntime.scheduleFederationDelivery.bind(this.federationRuntime),
      scheduleFederationInbox: this.federationRuntime.scheduleFederationInbox.bind(this.federationRuntime),
      coordinateFederationInbound: this.federationRuntime.coordinateFederationInbound.bind(this.federationRuntime),
      coordinateFederationContact: this.federationRuntime.coordinateFederationContact.bind(this.federationRuntime),
      runSchedules: this.scheduleRuntime.runSchedules.bind(this.scheduleRuntime),
      addMcpServerConnection: (input) => this.mcpConnections.addMcpServerConnection({
        ...input,
        callbackHost: input.callbackHost
          ?? (options.connection ? new URL(options.connection.uri).origin : undefined),
      }),
      removeMcpServerConnection: this.mcpConnections.removeMcpServer.bind(this.mcpConnections),
      refreshMcpServerConnection: this.mcpConnections.refreshMcpServerConnection.bind(this.mcpConnections),
      callMcpTool: (serverId, toolName, args, signal) => this.mcp.callTool(
        {
          serverId,
          name: toolName,
          arguments: args,
        },
        undefined,
        signal ? { signal } : undefined,
      ),
      request: this.requestDispatchedFrame.bind(this),
    };
  }

  get bindings(): GatewayEnv {
    return this.installationEnv ?? this.env;
  }

  get storage(): R2Bucket {
    return this.installationStorage ?? this.env.STORAGE;
  }

  buildDispatchDeps(): DispatchDeps {
    return {
      shellSessions: this.shellSessions,
      connections: this.connections,
      sendFrame: this.transport.sendWebSocketFrame.bind(this.transport),
      registerRoute: this.transport.registerRouteWithExpiry.bind(this.transport),
      requestTarget: this.transport.requestTarget.bind(this.transport),
      request: this.requestDispatchedFrame.bind(this),
    };
  }

  async requestDispatchedFrame(
    frame: RequestFrame,
    ctx: KernelContext,
    signal?: AbortSignal,
  ): Promise<ResponseFrame> {
    try {
      const response = await this.dispatchPeerRequest(
        frame,
        { type: "kernel", id: frame.id },
        ctx,
        { awaitRouted: true, signal, throwOnCancel: true },
      );
      return response ?? errFrame(frame.id, 500, "Dispatched request did not produce a response");
    } finally {
      await cancelUnlockedBody(frame.body, "Dispatched request completed");
    }
  }

  async dispatchPeerRequest(
    inputFrame: RequestFrame,
    origin: RouteOrigin,
    ctx: KernelContext,
    options: {
      awaitRouted: boolean;
      signal?: AbortSignal;
      throwOnCancel?: boolean;
    },
  ): Promise<ResponseFrame | null> {
    const peer = ctx.peer;
    if (!peer) {
      return errFrame(inputFrame.id, 403, "Request has no authenticated peer");
    }
    // Internal-only syscalls are reachable solely through Process provenance;
    // every other call is gated by the peer's grant.
    const allowed = isInternalOnlySyscall(inputFrame.call)
      ? peer.provenance.kind === "process-registry"
      : peerAllowsCall(peer, inputFrame.call);
    if (!allowed) {
      return errFrame(inputFrame.id, 403, `Permission denied: ${inputFrame.call}`);
    }

    const callerSignal = ctx.requestSignal && options.signal && ctx.requestSignal !== options.signal
      ? AbortSignal.any([ctx.requestSignal, options.signal])
      : options.signal ?? ctx.requestSignal;
    if (callerSignal?.aborted) {
      if (options.throwOnCancel) throw requestAbortError(callerSignal.reason);
      return null;
    }

    let controller: AbortController;
    try {
      controller = this.transport.registerActiveRequest(origin, inputFrame.id);
    } catch (error) {
      return errFrame(
        inputFrame.id,
        error instanceof RequestCancelledError ? 499 : 409,
        error instanceof Error ? error.message : String(error),
      );
    }
    const requestSignal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    const pending = options.awaitRouted
      ? this.transport.createPendingKernelResponse(inputFrame.id)
      : null;
    const cancel = () => {
      this.transport.cancelRequest(
        origin,
        inputFrame.id,
        requestAbortError(requestSignal.reason).message,
        false,
      );
    };
    let frame = this.transport.bindRequestBodyCancellation(inputFrame, requestSignal);

    try {
      const result = await raceWithAbort(
        dispatch(
          frame,
          origin,
          { ...ctx, requestSignal },
          this.buildDispatchDeps(),
        ),
        requestSignal,
        {
          abortReason: () => requestAbortError(requestSignal.reason),
          onAbort: cancel,
          onLateResolve: (late) => {
            if (late.handled && late.response.ok) {
              void cancelUnlockedBody(late.response.body, "Request was cancelled");
            }
          },
        },
      );
      let response: ResponseFrame | null = result.handled ? result.response : null;
      if (!response && pending) {
        response = await raceWithAbort(
          pending.promise,
          requestSignal,
          {
            abortReason: () => requestAbortError(requestSignal.reason),
            onAbort: cancel,
            onLateResolve: (late) => {
              if (late.ok) {
                void cancelUnlockedBody(late.body, "Request was cancelled");
              }
            },
          },
        );
      }
      if (response) this.applyPostDispatchEffects(frame, response);
      return response;
    } catch (error) {
      if (!requestSignal.aborted || options.throwOnCancel) throw error;
      return null;
    } finally {
      pending?.cleanup();
      this.transport.finishActiveRequest(frame.id, controller);
    }
  }

                                                      async scheduleManagedOutboundEnqueue(
    outboundId: string,
    dueAtMs: number,
  ): Promise<void> {
    await this.schedule(
      new Date(Math.max(Date.now() + 10, dueAtMs)),
      "onManagedOutboundEnqueue",
      outboundId,
      {
        idempotent: false,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  }

            buildServiceBindingIdentity(profile: ServicePeerProfile): ConnectionIdentity | null {
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
      channel: profile.id,
    };
  }

  applyPostDispatchEffects(frame: RequestFrame, response: ResponseFrame): void {
    if (!response.ok) return;

    if (frame.call === "sys.target.delete") {
      // SAFETY: dispatch preserves the syscall's request/result correlation.
      const data = response.data as SysTargetDeleteResult | undefined;
      if (data?.deleted) {
        this.connectionRuntime.disconnectTargetConnections(data.targetId, "Machine forgotten");
      }
    }

  }

                                          async onManagedOutboundEnqueue(outboundId: string): Promise<void> {
    await recoverManagedOutboundEnqueue(
      outboundId,
      this.buildKernelContext({}),
      true,
    );
  }

                                                      }

function decodeKernelTask(callback: string, payloadJson: string): KernelTask {
  return KERNEL_TASK_SCHEMA.parse({
    callback,
    payload: JSON.parse(payloadJson),
  });
}

function envWithInstallationResources(
  env: GatewayEnv,
  storage: R2Bucket,
  ripgit: Fetcher | undefined,
): GatewayEnv {
  return new Proxy(env, {
    get(target, property) {
      if (property === "STORAGE") return storage;
      if (property === "RIPGIT") return ripgit;
      // SAFETY: Proxy keys outside these overrides are ordinary Env properties.
      return target[property as keyof GatewayEnv];
    },
  });
}
