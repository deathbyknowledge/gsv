import {
  Connection,
  ConnectionContext,
  Agent as Host,
  getAgentByName,
  getCurrentAgent,
  type WSMessage,
} from "agents";
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
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
  AccountGetResult,
  ConnectArgs,
  ConnectionIdentity,
  NetFetchArgs,
  PkgPublicListResult,
  ProcessIdentity,
  RepoListResult,
  ScheduleRecord,
  ScheduleRunResult,
  SchedulerRunArgs,
  SchedulerRunResult,
  SysCapListResult,
  SysConfigGetResult,
} from "@humansandmachines/gsv/protocol";
import {
  BinaryBodyChannel,
  REQUEST_CANCEL_SIGNAL,
  type BinaryFrameDescriptor,
  type OutgoingBinaryBody,
} from "@humansandmachines/gsv/protocol";
import type { SyscallName } from "../syscalls";
import type {
  AdapterOutboundMessage,
} from "../adapter-interface";
import { AuthStore, type AuthenticatedCredential } from "./auth-store";
import { CapabilityStore, hasCapability } from "./capabilities";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "./config";
import { DeviceRegistry } from "./devices";
import {
  RoutingTable,
  type FailedDeviceRoute,
  type RouteOrigin,
} from "./routing";
import { ShellSessionStore, type ShellSessionStatus } from "./shell-sessions";
import {
  ProcessRegistry,
  type ProcessRecord,
  type ProcessState,
} from "./processes";
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
  type StoredScheduleRecord,
} from "./scheduler";
import { APP_CLIENT_SESSION_TTL_MS, AppSessionStore } from "./app-sessions";
import {
  authenticateConnectionIdentity,
  ensureKernelBootstrapped,
  handleConnect,
  setupRequiredDetails,
  SETUP_REQUIRED_ERROR_CODE,
} from "./connect";
import { dispatch, type DispatchDeps } from "./dispatch";
import { bindStreamToAbort } from "../shared/streams";
import { raceWithAbort } from "../shared/abort";
import {
  resolveCallerOwnerUid,
  type KernelContext,
  type RunAsAccountResult,
  type RunnableAccount,
} from "./context";
import { sendFrameToProcess } from "../shared/utils";
import {
  handleSysSetup as handleKernelSetup,
  isSetupCommissioningPending,
} from "./sys/setup";
import {
  buildAppRunnerName,
  buildRoutedAppSessionId,
  buildRoutedAppSessionSigningInput,
  parseRoutedAppSessionId,
  type AppClientSessionContext,
} from "../protocol/app-session";
import { handleSysSetupAssist } from "./sys/setup-assist";
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
  packageScopeKey,
  type InstalledPackageRecord,
  type PackageEntrypoint,
  type PackageArtifactMetadata,
  type PackageInstallScope,
  visiblePackageScopesForActor,
} from "./packages";
import {
  DEFAULT_APP_FRAME_TTL_MS,
  isAppFrameContextExpired,
  type AppFrameContext,
} from "../protocol/app-frame";
import type {
  AppRunnerProps,
  PreservedAppRuntimeDescriptor,
  PreservedAppRuntimeRefreshResult,
} from "../app-runner";
import type { ProcessScheduleDeliverRequestFrame } from "../protocol/process-frames";
import { listLocalPublicPackages } from "./pkg";
import { isRepoPublic } from "./repo-visibility";
import {
  authorizeAuthoritativeRepoOperation,
  canReadRepo,
  canWriteRepo,
  isAuthoritativeRepoOperationCall,
  type AuthoritativeRepoOperationCall,
} from "./repo";
import {
  applyRepoMetadataMutation,
  normalizeRepoMetadataMutation,
  selectRepoMetadataProjection,
  type RepoMetadataMutation,
  type RepoMetadataMutationResult,
} from "./repo-metadata";
import { handleProcSpawn } from "./proc-handlers";
import { ensureDefaultConversationExecutor, handleAccountGet } from "./agents";
import { canReadSysConfig, handleSysConfigGet } from "./sys/config";
import { handleSysCapList } from "./sys/cap";
import { handleRepoList } from "./repo";
import { handleShellExec } from "../drivers/native/shell";
import { getVisibleTarget } from "./targets";
import { runKernelSqlMigrations } from "./schema/migrations";
import { SERVER_VERSION } from "../version";
import {
  deriveLoginSourceScope,
  normalizeLoginSourceScope,
  UNAVAILABLE_LOGIN_SOURCE_SCOPE,
  type LoginSourceScope,
} from "./login-source";
import {
  isProcessIdentity,
  processIdentityEquals,
  type ProcessAuthorityResult,
} from "../shared/process-authority";
import { isLocked } from "../auth/shadow";
import { serializeGroup } from "../auth/group";
import { canOwnerDelegateRunAs, canOwnerRunAsAccount } from "./account-access";
import {
  findPackageAgentAccount,
  isPackageAgentRuntimeAuthorized,
  packageAgentAccessGroup,
  packageAgentRuntimeSecurityRevision,
  packageAgentSecurityRevision,
  packageAgentSecuritySurface,
  packageAgentSecurityRevisionKey,
  reconcilePackageAgentEntitlements,
  resolvePackageAgentRunAs,
} from "./package-agents";
import { canonicalizeLoginUsername } from "../auth/login";
import { accountIdentity } from "./accounts";
import { isSharedSystemConfigKey } from "./config-access";
import {
  isMasterKernelName,
  SHIP_KERNEL_NAME,
  USER_KERNEL_LOGIN_SOURCE_HEADER,
  userKernelName,
  userKernelUsername,
} from "../shared/kernel-names";
import {
  adapterInboundRouteMetadata,
} from "../shared/adapter-inbound-route";
import {
  USER_KERNEL_INSTANCE_STORAGE_KEY,
  UserKernelRegistry,
  type UserKernelInstanceMarker,
  type UserKernelLifecycle,
  type UserKernelRecord,
} from "./user-kernels";
import {
  isMasterOwnedSyscall,
} from "./master-syscalls";
import {
  buildUserMcpOAuthCallbackPath,
  matchUserMcpOAuthCallbackPath,
  parseRoutedOAuthState,
} from "../shared/callback-routes";
import {
  TokenRevocationStore,
  type TokenRevocationNotice,
  type TokenRevocationOutboxRecord,
} from "./token-revocations";

const PROCESS_REQUEST_CANCEL_TTL_MS = 60_000;
const MAX_PROCESS_REQUEST_CANCELLATIONS = 1024;
const MAX_REQUEST_CANCEL_REASON_LENGTH = 512;
const GIT_REPO_SEGMENT_MAX_CHARACTERS = 128;
const APP_SESSION_ROUTE_SECRET_KEY = "gsv/app-session-route-secret/v1";
const APP_SESSION_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APP_SESSION_ROUTE_SECRET_BYTES = 32;
const PROCESS_ROLLBACK_AUTHORIZATION_TTL_MS = 30_000;
const MASTER_USER_SIGNAL_AUTHORIZATION_TTL_MS = 30_000;
const TEXT_ENCODER = new TextEncoder();
const PACKAGE_AUTHORITY_MUTATIONS = new Set<SyscallName>([
  "sys.bootstrap",
  "account.create",
  "pkg.add",
  "pkg.create",
  "pkg.sync",
  "pkg.checkout",
  "pkg.install",
  "pkg.review.approve",
  "pkg.remove",
  "pkg.public.set",
]);

type ConnectionState = {
  step: "pending" | "connected" | "superseded";
  loginSourceScope?: LoginSourceScope;
  identity?: ConnectionIdentity;
  credential?: AuthenticatedCredential;
  credentialExpiryScheduleId?: string;
  clientId?: string;
  clientPlatform?: string;
};

type UserKernelRouteResult =
  | {
      ok: true;
      kernelName: string;
      loginSourceScope: LoginSourceScope;
    }
  | { ok: false };

type UserKernelAuthenticationInput = {
  sourceKernelName: string;
  username: string;
  args: ConnectArgs;
  loginSourceScope: LoginSourceScope;
};

type MasterRpcValue =
  | null
  | boolean
  | number
  | string
  | MasterRpcValue[]
  | { [key: string]: MasterRpcValue };

type MasterSyscallInput = {
  sourceKernelName: string;
  callerOwnerUid: number;
  identity: ConnectionIdentity;
  frame: {
    type: "req";
    id: string;
    call: SyscallName;
    args: MasterRpcValue;
    runId?: string;
  };
};

type MasterRepoMetadataMutationInput = {
  sourceKernelName: string;
  callerOwnerUid: number;
  identity: ConnectionIdentity;
  mutation: RepoMetadataMutation;
};

type UserRepoOperationAuthorizationInput = {
  sourceKernelName: string;
  callerOwnerUid: number;
  identity: ConnectionIdentity;
  call: AuthoritativeRepoOperationCall;
  repo?: string;
  requestedOwner?: string;
};

type UserRepoOperationAuthorizationResult =
  | { ok: true; repoList?: RepoListResult }
  | { ok: false; error: { code: number; message: string } };

type UserKernelProvisioningTargetInput = {
  sourceKernelName: string;
  username: string;
  uid: number;
  /** Master-resolved runtime payload; the target holds no Master state. */
  ownerIdentity: ProcessIdentity;
  personalAgent?: ProcessIdentity;
  capabilities: string[];
};

type UserKernelActivationTargetInput = {
  sourceKernelName: string;
  username: string;
  uid: number;
};

type ProcessRollbackAuthorizationInput = {
  authorization: string;
  processId: string;
};

type MasterSyscallResult = {
  response:
    | { type: "res"; id: string; ok: true; data?: MasterRpcValue }
    | { type: "res"; id: string; ok: false; error: { code: number; message: string; details?: MasterRpcValue } };
  tokenRevocations?: TokenRevocationNotice[];
};

type UserKernelDeviceRevocationInput = {
  sourceKernelName: string;
  ownerUid: number;
  deviceId: string;
};

type MasterTokenRevocationDeliveryInput = {
  sourceKernelName: string;
  username: string;
  uid: number;
  notice: TokenRevocationNotice;
};

type TokenRevocationConfirmationInput = {
  sourceKernelName: string;
  username: string;
  uid: number;
  notice: TokenRevocationNotice;
};

type AdapterInboundDeliveryInput = {
  sourceKernelName: string;
  ownerUid: number;
  linkGeneration: number;
  frame: RequestFrame<"adapter.inbound">;
};

type AdapterRunRouteAuthorizationInput = {
  sourceKernelName: string;
  ownerUid: number;
  adapter: string;
  accountId: string;
  actorId: string;
  linkGeneration: number;
};

type UserKernelPlacementProof = {
  sourceKernelName: string;
  uid: number;
};

type PackageRuntimeAuthorizationInput = UserKernelPlacementProof & {
  ownerUid: number;
  runAs: ProcessIdentity;
  packageSecurityRevision: string | null;
  requiredCall?: string;
};

type ProcessIdentityResolutionInput = UserKernelPlacementProof & {
  ownerUid: number;
  runAs: ProcessIdentity;
};

type ProcessIdentityResolutionResult =
  | {
      ok: true;
      runAs: ProcessIdentity;
      owner: ProcessIdentity;
    }
  | { ok: false; error: string };

type AccountIdentityResolutionInput = UserKernelPlacementProof & {
  ownerUid: number;
  actorUid: number;
};

type AccountIdentityResolutionResult =
  | { ok: true; identity: ProcessIdentity; capabilities: string[] }
  | { ok: false; error: string };

type RunAsAccountResolutionInput = UserKernelPlacementProof & {
  ownerUid: number;
  callerUid: number;
  selector?: string;
};

type RunnableAccountListInput = UserKernelPlacementProof & {
  ownerUid: number;
  callerUid: number;
};

type AdapterServiceIdentityInput = UserKernelPlacementProof & {
  ownerUid: number;
  channel: string;
};

type AppFrameAuthorizationInput = UserKernelPlacementProof & {
  appFrame: AppFrameContext;
  requiredCall?: string;
};

type AppFrameAuthorizationResult =
  | {
      ok: true;
      identity: ConnectionIdentity;
      entrypointKind: PackageEntrypoint["kind"];
    }
  | { ok: false };

type PreservedAppRuntimeAuthorityInput = UserKernelPlacementProof & {
  ownerUid: number;
  runtime: PreservedAppRuntimeDescriptor;
};

type PreservedAppRuntimeAuthorityResult =
  | {
      ok: true;
      identity: ProcessIdentity;
      packageId: string;
      packageName: string;
      packageUpdatedAt: number;
      artifact: PackageArtifactMetadata;
      entrypointName: string;
      routeBase: string;
    }
  | { ok: false };

type MasterUserSignalAuthorizationInput = {
  authorization: string;
  targetKernelName: string;
  username: string;
  uid: number;
  signal: string;
  payloadJson?: string;
};

type MasterUserSignalTargetInput = Omit<
  MasterUserSignalAuthorizationInput,
  "targetKernelName"
> & {
  sourceKernelName: string;
};

type MasterKernelControlStub = {
  authenticateUserKernelConnection: (
    input: UserKernelAuthenticationInput,
  ) => Promise<import("./context").KernelAuthenticationResult>;
  masterReadAuthFile: (input: {
    sourceKernelName: string;
    requesterUid: number;
    kind: "passwd" | "group" | "shadow";
  }) => Promise<{ content: string }>;
  masterPackagesList: (input: {
    sourceKernelName: string;
    requesterUid: number;
    enabled?: boolean;
  }) => Promise<{ packages: InstalledPackageRecord[] }>;
  validatePackageRuntime: (
    input: PackageRuntimeAuthorizationInput,
  ) => Promise<boolean>;
  resolveProcessIdentity: (
    input: ProcessIdentityResolutionInput,
  ) => Promise<ProcessIdentityResolutionResult>;
  resolveAccountIdentity: (
    input: AccountIdentityResolutionInput,
  ) => Promise<AccountIdentityResolutionResult>;
  resolveRunAsAccount: (
    input: RunAsAccountResolutionInput,
  ) => Promise<RunAsAccountResult>;
  listRunnableAccounts: (
    input: RunnableAccountListInput,
  ) => Promise<RunnableAccount[]>;
  resolveAdapterServiceIdentity: (
    input: AdapterServiceIdentityInput,
  ) => Promise<ConnectionIdentity | null>;
  validateAppFrame: (
    input: AppFrameAuthorizationInput,
  ) => Promise<AppFrameAuthorizationResult>;
  validateAppDaemonFrame: (
    input: AppFrameAuthorizationInput,
  ) => Promise<AppFrameAuthorizationResult>;
  authorizePreservedAppRuntime: (
    input: PreservedAppRuntimeAuthorityInput,
  ) => Promise<PreservedAppRuntimeAuthorityResult>;
  dispatchMasterSyscall: (input: MasterSyscallInput) => Promise<MasterSyscallResult>;
  revokeUserKernelDeviceCredentials: (
    input: UserKernelDeviceRevocationInput,
  ) => Promise<TokenRevocationNotice[]>;
  confirmTokenRevocationDelivery: (
    input: TokenRevocationConfirmationInput,
  ) => Promise<boolean>;
  mutateUserRepoMetadata: (
    input: MasterRepoMetadataMutationInput,
  ) => Promise<RepoMetadataMutationResult>;
  authorizeUserRepoOperation: (
    input: UserRepoOperationAuthorizationInput,
  ) => Promise<UserRepoOperationAuthorizationResult>;
  receiveAdapterInbound: (
    frame: RequestFrame<"adapter.inbound">,
  ) => Promise<ResponseFrame>;
  authorizeAdapterRunRoute: (
    input: AdapterRunRouteAuthorizationInput,
  ) => Promise<boolean>;
  consumeMasterUserSignalAuthorization: (
    input: MasterUserSignalAuthorizationInput,
  ) => Promise<boolean>;
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
  trustedSourceAddress?: string;
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

const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 30_000;

class BoundedMcpOAuthProvider extends DurableObjectOAuthClientProvider {
  private readonly callbackEpochContext = new AsyncLocalStorage<number>();
  private nextCallbackEpoch = 0;
  private currentCallbackEpoch = 0;
  private callbackOperationSignal: AbortSignal | undefined;

  setCallbackOperationSignal(signal?: AbortSignal): void {
    this.callbackOperationSignal = signal;
  }

  protected assertCallbackWriteCurrent(): void {
    const epoch = this.callbackEpochContext.getStore();
    if (epoch !== undefined && epoch !== this.currentCallbackEpoch) {
      throw new Error("MCP OAuth session is no longer active");
    }
  }

  override async runWithCodeVerifierState<T>(
    state: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const epoch = ++this.nextCallbackEpoch;
    this.currentCallbackEpoch = epoch;
    const timeout = new AbortController();
    const timeoutId = setTimeout(() => {
      timeout.abort(new Error("MCP OAuth callback timed out"));
    }, MCP_OAUTH_CALLBACK_TIMEOUT_MS);
    const signal = this.callbackOperationSignal
      ? AbortSignal.any([this.callbackOperationSignal, timeout.signal])
      : timeout.signal;
    try {
      return await super.runWithCodeVerifierState(state, () => {
        const pending = this.callbackEpochContext.run(epoch, callback);
        return raceWithAbort(pending, signal, {
          onAbort: () => {
            if (this.currentCallbackEpoch === epoch) {
              this.currentCallbackEpoch = 0;
            }
          },
        });
      });
    } finally {
      clearTimeout(timeoutId);
      if (this.currentCallbackEpoch === epoch) {
        this.currentCallbackEpoch = 0;
      }
    }
  }

  override async saveClientInformation(
    information: Parameters<
      DurableObjectOAuthClientProvider["saveClientInformation"]
    >[0],
  ): Promise<void> {
    this.assertCallbackWriteCurrent();
    await super.saveClientInformation(information);
    this.assertCallbackWriteCurrent();
  }

  override async saveTokens(
    tokens: Parameters<DurableObjectOAuthClientProvider["saveTokens"]>[0],
  ): Promise<void> {
    this.assertCallbackWriteCurrent();
    await super.saveTokens(tokens);
    this.assertCallbackWriteCurrent();
  }
}

class UserKernelMcpOAuthProvider extends BoundedMcpOAuthProvider {
  constructor(
    storage: DurableObjectStorage,
    clientName: string,
    callbackUrl: string,
    private readonly expectedUsername: string,
    private readonly authorizeCommit: () => boolean,
  ) {
    super(storage, clientName, callbackUrl);
  }

  override async saveTokens(
    tokens: Parameters<DurableObjectOAuthClientProvider["saveTokens"]>[0],
  ): Promise<void> {
    this.assertCallbackWriteCurrent();
    if (!this.authorizeCommit()) {
      throw new Error("User Kernel is not active");
    }
    await this.storage.transaction(async (transaction) => {
      const marker = parseUserKernelInstanceMarker(
        await transaction.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
      );
      if (
        !marker
        || marker.lifecycle !== "active"
        || marker.username !== this.expectedUsername
        || !this.authorizeCommit()
      ) {
        throw new Error("User Kernel is not active");
      }
      await transaction.put(this.tokenKey(this.clientId), tokens);
    });
    this.assertCallbackWriteCurrent();
  }
}

/**
 * Workers RPC exposes every function and accessor on a Durable Object's class
 * prototype. TypeScript's `private` modifier is erased at runtime, so bind all
 * non-RPC Kernel helpers onto the instance where Workers RPC cannot reach
 * them. Keep this allowlist deliberately small and auditable.
 */
const KERNEL_RPC_METHOD_ALLOWLIST = new Set([
  // Durable Object / PartyServer runtime handlers.
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
  "setName",
  // Exact Master provisioning operations.
  "provisionUserKernel",
  "activateProvisionedUserKernel",
  // Scoped Gateway ingress and direct Master-to-user adapter delivery.
  "receiveAdapterInbound",
  "serviceAdapterFrame",
  "consumeMasterUserSignalAuthorization",
  "receiveMasterUserSignal",
  // Master-to-user notices that confirm authoritative Master state.
  "onUserKernelScheduleRearmRecoveryDue",
  "receiveMasterTokenRevocation",
  // Placement-authenticated user-Kernel Master operations.
  "authorizeAdapterRunRoute",
  "authenticateUserKernelConnection",
  "masterReadAuthFile",
  "masterPackagesList",
  "validatePackageRuntime",
  "resolveProcessIdentity",
  "resolveAccountIdentity",
  "resolveRunAsAccount",
  "listRunnableAccounts",
  "resolveAdapterServiceIdentity",
  "validateAppFrame",
  "validateAppDaemonFrame",
  "authorizePreservedAppRuntime",
  "revokeUserKernelDeviceCredentials",
  "confirmTokenRevocationDelivery",
  "dispatchMasterSyscall",
  "mutateUserRepoMetadata",
  "authorizeUserRepoOperation",
  // Gateway HTTP routing and public read seams.
  "resolveUserKernelRoute",
  "resolveUserKernelCallbackRoute",
  "resolvePreservedAppRuntimeRoute",
  "authorizeGitHttp",
  "listPublicPackages",
  // Process-DO RPC, authenticated today by Kernel namespace plus registry pid.
  "recvFrame",
  "resolveProcessAuthority",
  "resolveProcessTeardownAuthority",
  "consumeProcessRollbackAuthorization",
  "requestProcessNetFetch",
  "cancelProcessRequests",
  // Scoped gateway service-binding RPC; the Kernel namespace is its capability.
  "serviceFrame",
  // AppRunner/package RPC; session-bearing calls also reauthorize local state.
  "appRequest",
  "appDaemonRequest",
  "authorizeAppFrame",
  "authorizeAppDaemonFrame",
  "refreshPreservedAppRuntime",
  "authorizeAppSessionRoute",
  "resolvePackageAppRpcSession",
  "refreshPackageAppRpcSession",
]);

function privatizeKernelRpcSurface(kernel: object): void {
  let prototype = Object.getPrototypeOf(kernel) as object | null;
  while (
    prototype
    && prototype !== DurableObject.prototype
    && prototype !== Object.prototype
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (
        name === "constructor"
        || KERNEL_RPC_METHOD_ALLOWLIST.has(name)
        || Object.prototype.hasOwnProperty.call(kernel, name)
      ) {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor) continue;
      if (typeof descriptor.value === "function") {
        Object.defineProperty(kernel, name, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: descriptor.value.bind(kernel),
        });
        continue;
      }
      if (descriptor.get || descriptor.set) {
        Object.defineProperty(kernel, name, {
          configurable: false,
          enumerable: false,
          ...(descriptor.get ? { get: descriptor.get.bind(kernel) } : {}),
          ...(descriptor.set ? { set: descriptor.set.bind(kernel) } : {}),
        });
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
}

export class Kernel extends Host<Env> {
  static options = { sendIdentityOnConnect: false };

  private readonly auth: AuthStore;
  private readonly tokenRevocations: TokenRevocationStore;
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
  private readonly userKernels: UserKernelRegistry;
  private userKernelMarker: UserKernelInstanceMarker | null | undefined;
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
  private readonly activeScheduleRuns = new Map<string, AbortController>();
  private readonly revokedProcessTeardowns = new Map<string, Promise<void>>();
  private readonly deferredCredentialClosures = new Set<string>();
  private tokenRevocationFlush: Promise<void> | null = null;
  private readonly processRollbackAuthorizations = new Map<
    string,
    { expiresAt: number; processId: string }
  >();
  private readonly masterUserSignalAuthorizations = new Map<
    string,
    {
      expiresAt: number;
      signal: Omit<MasterUserSignalAuthorizationInput, "authorization">;
    }
  >();
  private readonly cancelledProcessRequests = new Map<
    string,
    { expiresAt: number; reason: string }
  >();
  private transitioningUserKernels = new Set<string>();
  private activeMasterUserOperations = new Map<
    string,
    { count: number; waiters: Set<() => void> }
  >();
  private readonly userKernelProvisioningFlights = new Map<
    string,
    Promise<UserKernelRecord>
  >();
  private readonly confirmedUserKernelActivations = new Map<string, number>();
  private userKernelScheduleRearmRecoveryQueued = false;
  private userKernelScheduleRearmRecoveryAttempt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Agent's request wrapper dispatches MCP OAuth through a private runtime
    // method before onRequest(). Shadow that hook so callback mutation crosses
    // the same per-owner lifecycle barrier as every other Kernel operation.
    Object.defineProperty(this, "handleMcpOAuthCallback", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: this.handleAuthorizedMcpOAuthCallback.bind(this),
    });
    privatizeKernelRpcSurface(this);
    if (this.instanceKind === "master") {
      // The Agents SDK restores persisted MCP transports before Kernel.onStart.
      // Those rows predate the runtime split and belong to the old singleton
      // user runtime, not to the Master control plane. Leave them stored for
      // recovery, but never reconnect them from the Master object.
      this.mcp.restoreConnectionsFromStorage = async () => {};
      this.mcp.getRpcServersFromStorage = () => [];
    }
    const sql = ctx.storage.sql;
    runKernelSqlMigrations(ctx.storage);

    this.auth = new AuthStore(sql);
    this.tokenRevocations = new TokenRevocationStore(sql);
    this.userKernels = new UserKernelRegistry(sql);
    if (this.instanceKind === "user") {
      this.userKernelMarker = parseUserKernelInstanceMarker(
        this.ctx.storage.kv.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
      );
    }

    this.caps = new CapabilityStore(sql);
    if (this.instanceKind === "master") {
      this.caps.seed();
    }

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
    if (this.instanceKind === "user") {
      this.schedules.releaseInterruptedRuns("User Kernel runtime was interrupted");
    }

    this.appSessions = new AppSessionStore(
      sql,
      (input) => this.issueAppSessionId(input),
    );

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
    if (
      this.instanceKind === "user"
      && this.userKernelMarker?.lifecycle === "active"
    ) {
      this.ctx.waitUntil(this.rearmInterruptedScheduleRuns().catch(() => {
        this.queueUserKernelScheduleRearmRecovery();
      }));
    }
    if (this.instanceKind === "master" && this.tokenRevocations.nextAttemptAt() !== null) {
      this.ctx.waitUntil(this.schedule(
        1,
        "onTokenRevocationOutboxDue",
      ).then(() => undefined));
    }
    if (this.instanceKind === "user") {
      for (const callId of this.ipcCalls.recoverDeliveryIds()) {
        this.queueIpcCallDelivery(callId);
      }
    }
  }

  private get instanceKind(): "master" | "user" {
    return isMasterKernelName(this.name) ? "master" : "user";
  }

  private get instanceUsername(): string | null {
    return userKernelUsername(this.name);
  }

  private assertMasterKernel(): void {
    if (this.instanceKind !== "master") {
      throw new Error("Operation is master-only");
    }
  }

  private isActiveUserKernelPlacement(
    placement: UserKernelRecord | null,
  ): placement is UserKernelRecord {
    return Boolean(
      placement
      && placement.lifecycle === "active"
      && !this.transitioningUserKernels?.has(placement.username),
    );
  }

  private beginMasterUserOperation(username: string): (() => void) | null {
    const transitions = this.transitioningUserKernels ??= new Set<string>();
    const operations = this.activeMasterUserOperations ??= new Map();
    if (transitions.has(username)) {
      return null;
    }
    const active = operations.get(username) ?? {
      count: 0,
      waiters: new Set<() => void>(),
    };
    active.count += 1;
    operations.set(username, active);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.count -= 1;
      if (active.count !== 0) return;
      operations.delete(username);
      for (const resolve of active.waiters) resolve();
      active.waiters.clear();
    };
  }

  private async waitForMasterUserOperations(username: string): Promise<void> {
    const active = this.activeMasterUserOperations?.get(username);
    if (!active || active.count === 0) return;
    await new Promise<void>((resolve) => active.waiters.add(resolve));
  }

  private async loadUserKernelMarker(): Promise<UserKernelInstanceMarker | null> {
    if (this.instanceKind !== "user" || !this.instanceUsername) {
      return null;
    }
    if (this.userKernelMarker !== undefined) {
      return this.userKernelMarker;
    }
    const raw = await this.ctx.storage.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY);
    this.userKernelMarker = parseUserKernelInstanceMarker(raw);
    return this.userKernelMarker;
  }

  private async requireActiveUserKernel(): Promise<UserKernelInstanceMarker> {
    if (this.instanceKind !== "user") {
      throw new Error("User Kernel is not active");
    }
    const marker = await this.loadUserKernelMarker();
    if (
      !marker
      || marker.lifecycle !== "active"
    ) {
      throw new Error("User Kernel is not active");
    }
    return marker;
  }


  private authorizeUserKernelSource(proof: UserKernelPlacementProof): UserKernelRecord | null {
    this.assertMasterKernel();
    const username = userKernelUsername(proof.sourceKernelName);
    const placement = username ? this.userKernels.get(username) : null;
    // Active placements are the steady state; provisioning placements are
    // mid-flight Master-initiated provisioning and equally bound to this
    // fleet (only gateway code can reach these stubs).
    if (
      !username
      || !placement
      || (placement.lifecycle !== "active" && placement.lifecycle !== "provisioning")
      || placement.uid !== proof.uid
    ) {
      return null;
    }
    const current = this.userKernels.get(username);
    return current
      && (current.lifecycle === "active" || current.lifecycle === "provisioning")
      && sameUserKernelPlacement(current, placement)
      ? current
      : null;
  }

  private async authorizeCurrentPackageAgentRuntime(
    ownerUid: number,
    runAs: ProcessIdentity,
    packageSecurityRevision: string | null,
    requiredCall?: string,
    processId?: string,
  ): Promise<boolean> {
    if (this.instanceKind === "user") {
      let marker: UserKernelInstanceMarker | null = null;
      try {
        marker = await this.requireActiveUserKernel();
      } catch {
        // Authorization fails closed below.
      }
      if (!marker || marker.uid !== ownerUid) {
        if (processId) {
          this.queueRevokedProcessTeardown(processId, "Process owner is no longer active");
        }
        return false;
      }
      const master = this.env.KERNEL.get(
        this.env.KERNEL.idFromName(SHIP_KERNEL_NAME),
      ) as unknown as MasterKernelControlStub;
      const authorized = await master.validatePackageRuntime({
        sourceKernelName: this.name,
        uid: marker.uid,
        ownerUid,
        runAs,
        packageSecurityRevision,
        ...(requiredCall === undefined ? {} : { requiredCall }),
      });
      if (!authorized && processId) {
        this.queueRevokedProcessTeardown(processId, "Package agent authority was revoked");
      }
      return authorized;
    }

    const localAccount = this.auth.getPasswdByUid(runAs.uid);
    const localGids = localAccount
      ? this.auth.resolveGids(localAccount.username, localAccount.gid)
      : [];
    const locallyCurrent = Boolean(
      localAccount
      && localAccount.username === runAs.username
      && localAccount.gid === runAs.gid
      && localAccount.home === runAs.home
      && localGids.length === runAs.gids.length
      && localGids.every((gid) => runAs.gids.includes(gid)),
    );
    if (!locallyCurrent) {
      if (processId) this.queueRevokedProcessTeardown(processId, "Process identity was revoked");
      return false;
    }

    if (
      !localAccount
      || !canOwnerRunAsAccount(this.auth, ownerUid, localAccount, ownerUid === 0)
    ) {
      if (processId) this.queueRevokedProcessTeardown(processId, "Process delegation was revoked");
      return false;
    }

    const authorized = await isPackageAgentRuntimeAuthorized(
      {
        auth: this.auth,
        caps: this.caps,
        config: this.config,
        packages: this.packages,
      },
      {
        ownerUid,
        runAsUid: runAs.uid,
        runAsUsername: runAs.username,
        packageSecurityRevision,
        requiredCall,
      },
    );
    if (!authorized && processId) {
      this.queueRevokedProcessTeardown(processId, "Package agent authority was revoked");
    }
    return authorized;
  }

  private async authorizeRegisteredProcessRuntime(
    processId: string,
    requiredCall?: string,
  ): Promise<boolean> {
    const record = this.procs.get(processId);
    if (!record) return false;
    return this.authorizeCurrentPackageAgentRuntime(
      record.ownerUid,
      {
        uid: record.uid,
        gid: record.gid,
        gids: record.gids,
        username: record.username,
        home: record.home,
        cwd: record.cwd,
      },
      record.packageSecurityRevision,
      requiredCall,
      processId,
    );
  }

  private async issueAppSessionId(input: {
    uid: number;
    username: string;
  }): Promise<string> {
    if (
      !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || canonicalizeLoginUsername(input.username) !== input.username
    ) {
      throw new Error("App session actor is invalid");
    }

    const marker = await this.requireActiveUserKernel();
    if (!marker || this.name !== userKernelName(marker.username)) {
      throw new Error("App sessions require an active user Kernel");
    }
    const route = {
      username: marker.username,
      uid: marker.uid,
      expiresAt: Date.now() + APP_SESSION_ROUTE_TTL_MS,
      nonce: crypto.randomUUID(),
    };
    const signature = await this.signAppSessionRoute(
      buildRoutedAppSessionSigningInput(route),
    );
    const current = await this.requireActiveUserKernel();
    if (
      !current
      || current.username !== marker.username
      || current.uid !== marker.uid
      || this.name !== userKernelName(current.username)
    ) {
      throw new Error("App session route issuance denied");
    }
    return buildRoutedAppSessionId(route, signature);
  }
  private storedAppSessionRouteSecret(): Uint8Array | null {
    const existing = this.ctx.storage.kv.get<string>(APP_SESSION_ROUTE_SECRET_KEY);
    if (existing === undefined) {
      return null;
    }
    if (!/^[a-f0-9]{64}$/.test(existing)) {
      throw new Error("App session route secret is invalid");
    }
    return hexToBytes(existing);
  }

  private appSessionRouteSecret(): Uint8Array {
    const existing = this.storedAppSessionRouteSecret();
    if (existing) return existing;
    const secret = crypto.getRandomValues(
      new Uint8Array(APP_SESSION_ROUTE_SECRET_BYTES),
    );
    this.ctx.storage.kv.put(APP_SESSION_ROUTE_SECRET_KEY, bytesToHex(secret));
    return secret;
  }

  private async appSessionRouteKey(
    secret: Uint8Array = this.appSessionRouteSecret(),
  ): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  private async signAppSessionRoute(signingInput: string): Promise<string> {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.appSessionRouteKey(),
      TEXT_ENCODER.encode(signingInput),
    );
    return bytesToBase64Url(new Uint8Array(signature));
  }

  private async verifyAppSessionRoute(
    signingInput: string,
    signature: string,
  ): Promise<boolean> {
    const secret = this.storedAppSessionRouteSecret();
    if (!secret) {
      return false;
    }
    const signatureBytes = base64UrlToBytes(signature);
    if (!signatureBytes) {
      return false;
    }
    return crypto.subtle.verify(
      "HMAC",
      await this.appSessionRouteKey(secret),
      signatureBytes,
      TEXT_ENCODER.encode(signingInput),
    );
  }

  private async cancelPendingScheduleWakes(): Promise<void> {
    const wakeIds: string[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const record of this.schedules.listWakeable()) {
        if (!record.wakeScheduleId) continue;
        wakeIds.push(record.wakeScheduleId);
        this.schedules.setWakeScheduleId(record.id, null);
      }
    });
    await Promise.all(wakeIds.map((wakeId) => this.cancelSchedule(wakeId)));
  }
  async provisionUserKernel(
    input: UserKernelProvisioningTargetInput,
  ): Promise<UserKernelInstanceMarker> {
    const instanceUsername = this.instanceUsername;
    if (
      this.instanceKind !== "user"
      || !instanceUsername
      || input?.sourceKernelName !== SHIP_KERNEL_NAME
      || input.username !== instanceUsername
      || canonicalizeLoginUsername(input.username) !== input.username
      || this.name !== userKernelName(input.username)
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || !isProcessIdentity(input.ownerIdentity)
      || input.ownerIdentity.uid !== input.uid
      || input.ownerIdentity.username !== input.username
      || (input.personalAgent !== undefined && !isProcessIdentity(input.personalAgent))
      || !Array.isArray(input.capabilities)
      || input.capabilities.some((capability) => typeof capability !== "string")
    ) {
      throw new Error("User Kernel provisioning denied");
    }

    const existing = parseUserKernelInstanceMarker(
      await this.ctx.storage.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
    );
    if (existing && (
      existing.username !== input.username
      || existing.uid !== input.uid
      || (existing.lifecycle !== "provisioning" && existing.lifecycle !== "active")
    )) {
      throw new Error("User Kernel provisioning identity mismatch");
    }

    const provisioning: UserKernelInstanceMarker = {
      version: 1,
      kind: "user",
      username: input.username,
      uid: input.uid,
      lifecycle: "provisioning",
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, provisioning);
    this.userKernelMarker = provisioning;
    if (existing?.lifecycle === "active") {
      await this.cancelPendingScheduleWakes();
    }

    let executorPid: string | null = null;
    try {
      executorPid = await this.ensureUserKernelProvisioningExecutor(provisioning, input);
      const persistedProvisioning = parseUserKernelInstanceMarker(
        await this.ctx.storage.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
      );
      if (
        this.userKernelMarker !== provisioning
        || !sameUserKernelInstanceMarker(persistedProvisioning, provisioning)
      ) {
        throw new Error("User Kernel lifecycle changed during provisioning");
      }
      // Preparation deliberately remains non-active. The Master must first
      // commit the authoritative placement, then explicitly confirm activation
      // before this target may admit traffic or re-arm local runtime work.
      return provisioning;
    } catch (error) {
      if (executorPid) {
        await this.rollbackProvisionedUserKernelExecutor(executorPid);
      }
      throw error;
    }
  }

  async activateProvisionedUserKernel(
    input: UserKernelActivationTargetInput,
  ): Promise<UserKernelInstanceMarker> {
    const instanceUsername = this.instanceUsername;
    if (
      this.instanceKind !== "user"
      || !instanceUsername
      || input?.sourceKernelName !== SHIP_KERNEL_NAME
      || input.username !== instanceUsername
      || canonicalizeLoginUsername(input.username) !== input.username
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
    ) {
      throw new Error("User Kernel activation denied");
    }
    const existing = parseUserKernelInstanceMarker(
      await this.ctx.storage.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
    );
    if (
      !existing
      || existing.username !== input.username
      || existing.uid !== input.uid
      || (existing.lifecycle !== "provisioning" && existing.lifecycle !== "active")
    ) {
      throw new Error("User Kernel activation identity mismatch");
    }
    const active: UserKernelInstanceMarker = {
      ...existing,
      lifecycle: "active",
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, active);
    this.userKernelMarker = active;
    await this.rearmPendingSchedules(active);
    return active;
  }

  private async ensureUserKernelProvisioningExecutor(
    marker: UserKernelInstanceMarker,
    input: UserKernelProvisioningTargetInput,
  ): Promise<string> {
    const ownerIdentity = input.ownerIdentity;
    const connectionIdentity: ConnectionIdentity = {
      role: "user",
      process: ownerIdentity,
      capabilities: input.capabilities,
    };
    // During provisioning the Master is mid-transition for this owner, so
    // Master syscalls are unavailable; the input payload stands in. After
    // activation the owner record is re-resolved against the Master.
    if (marker.lifecycle === "active") {
      const account = await this.resolveUserKernelAccountIdentity(ownerIdentity.uid);
      if (!account.ok || !processIdentityEquals(account.identity, ownerIdentity)) {
        throw new Error("User Kernel owner identity is no longer authorized");
      }
      connectionIdentity.capabilities = account.capabilities;
    }
    const context = this.buildKernelContext({
      identity: connectionIdentity,
      ...(marker.lifecycle === "provisioning"
        ? { provisioningMarker: marker }
        : {}),
    });
    const pid = await ensureDefaultConversationExecutor(
      context,
      ownerIdentity,
      input.personalAgent,
    );
    try {
      context.assertCurrentKernel();
      return pid;
    } catch (error) {
      try {
        await this.rollbackProvisionedUserKernelExecutor(pid);
      } catch (rollbackError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; executor rollback failed: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async rollbackProvisionedUserKernelExecutor(pid: string): Promise<void> {
    let rollbackError: unknown;
    const rollbackAuthorization = this.issueProcessRollbackAuthorization(
      pid,
    );
    try {
      const requestId = crypto.randomUUID();
      const response = await sendFrameToProcess(pid, {
        type: "req",
        id: requestId,
        call: "proc.kill",
        args: {
          pid,
          archive: false,
          rollbackAuthorization,
          rollbackKernelName: this.name,
        },
      } as RequestFrame);
      if (!response || response.type !== "res" || response.id !== requestId) {
        throw new Error("proc.kill returned no valid response");
      }
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      if ((response.data as { ok?: unknown } | undefined)?.ok !== true) {
        throw new Error("proc.kill rejected executor rollback");
      }
    } catch (error) {
      rollbackError = error;
    } finally {
      this.revokeProcessRollbackAuthorization(rollbackAuthorization);
    }

    try {
      this.ctx.storage.transactionSync(() => {
        this.conversations.clearActivePid(pid);
        this.procs.kill(pid);
      });
    } catch (error) {
      rollbackError ??= error;
    }

    if (rollbackError) throw rollbackError;
  }

  async resolveUserKernelRoute(
    usernameInput: string,
    trustedLoginSourceAddress?: string,
  ): Promise<UserKernelRouteResult> {
    this.assertMasterKernel();
    const username = canonicalizeLoginUsername(usernameInput);
    if (!username) {
      return { ok: false };
    }
    if (isSetupCommissioningPending(this.config)) {
      return { ok: false };
    }

    let placement = this.userKernels.get(username);
    if (!placement) {
      return { ok: false };
    }
    if (
      placement.lifecycle === "provisioning"
      || !this.isUserKernelActivationConfirmed(placement)
    ) {
      try {
        placement = await this.ensureUserKernelProvisioned(username);
      } catch {
        return { ok: false };
      }
    }
    if (!this.isActiveUserKernelPlacement(placement)) {
      return { ok: false };
    }
    const loginSourceScope = await deriveLoginSourceScope(
      this.config,
      trustedLoginSourceAddress,
    );
    const currentPlacement = this.userKernels.get(username);
    if (
      !this.isActiveUserKernelPlacement(currentPlacement)
      || currentPlacement.uid !== placement.uid
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      kernelName: userKernelName(username),
      loginSourceScope,
    };
  }
  async resolveUserKernelCallbackRoute(
    usernameInput: string,
  ): Promise<{ ok: true; kernelName: string } | { ok: false }> {
    this.assertMasterKernel();
    const username = canonicalizeLoginUsername(usernameInput);
    if (!username || username !== usernameInput) {
      return { ok: false };
    }
    let placement = this.userKernels.get(username);
    if (!placement) return { ok: false };
    if (
      placement.lifecycle === "provisioning"
      || !this.isUserKernelActivationConfirmed(placement)
    ) {
      try {
        placement = await this.ensureUserKernelProvisioned(username);
      } catch {
        return { ok: false };
      }
    }
    const currentPlacement = this.userKernels.get(username);
    if (
      !this.isActiveUserKernelPlacement(placement)
      || !this.isActiveUserKernelPlacement(currentPlacement)
      || currentPlacement.uid !== placement.uid
    ) {
      return { ok: false };
    }
    return { ok: true, kernelName: userKernelName(username) };
  }

  async resolvePreservedAppRuntimeRoute(
    input: Pick<PreservedAppRuntimeDescriptor, "uid" | "username">,
  ): Promise<{ ok: true; kernelName: string } | { ok: false }> {
    this.assertMasterKernel();
    if (
      !input
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || typeof input.username !== "string"
      || !input.username
    ) {
      return { ok: false };
    }
    const actor = this.auth.getPasswdByUid(input.uid);
    const actorAccount = actor ? this.auth.getAccountIdentity(actor.username) : null;
    if (
      !actor
      || actor.username !== input.username
      || !actorAccount
      || actorAccount.uid !== actor.uid
      || actorAccount.state !== "active"
    ) {
      return { ok: false };
    }

    const personalAgentOwners = this.auth.getPasswdEntries().filter(
      (entry) => this.auth.getPersonalAgentUid(entry.uid) === actor.uid,
    );
    if (personalAgentOwners.length > 1) {
      return { ok: false };
    }
    if (this.auth.isPersonalAgentUid(actor.uid) && personalAgentOwners.length !== 1) {
      return { ok: false };
    }
    const owner = personalAgentOwners[0] ?? actor;
    const ownerAccount = this.auth.getAccountIdentity(owner.username);
    const placement = this.userKernels.getByUid(owner.uid);
    if (
      !ownerAccount
      || ownerAccount.uid !== owner.uid
      || ownerAccount.state !== "active"
      || !placement
      || placement.username !== owner.username
    ) {
      return { ok: false };
    }
    return this.resolveUserKernelCallbackRoute(owner.username);
  }

  async authorizeAdapterRunRoute(
    input: AdapterRunRouteAuthorizationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    const username = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelSource({
      sourceKernelName: input.sourceKernelName,
      uid: input.ownerUid,
    });
    const adapter = typeof input.adapter === "string"
      ? input.adapter.trim().toLowerCase()
      : "";
    const accountId = typeof input.accountId === "string"
      ? input.accountId.trim()
      : "";
    const actorId = typeof input.actorId === "string"
      ? input.actorId.trim()
      : "";
    if (
      !username
      || !placement
      || placement.uid !== input.ownerUid
      || input.adapter !== adapter
      || input.accountId !== accountId
      || input.actorId !== actorId
      || !adapter
      || !accountId
      || !actorId
      || adapter.length > 64
      || accountId.length > 512
      || actorId.length > 512
      || !Number.isSafeInteger(input.linkGeneration)
      || input.linkGeneration <= 0
    ) {
      return false;
    }
    const link = this.adapters.identityLinks.get(adapter, accountId, actorId);
    return Boolean(
      link
      && link.uid === placement.uid
      && link.generation === input.linkGeneration
      && this.adapters.identityLinks.isCurrentGeneration(
        adapter,
        accountId,
        actorId,
        input.linkGeneration,
      )
    );
  }

  /** Consume the exact, one-shot Master-to-user signal delivery. */
  async consumeMasterUserSignalAuthorization(
    input: MasterUserSignalAuthorizationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    const authorization = typeof input?.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.masterUserSignalAuthorizations.get(authorization);
    this.masterUserSignalAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || !sameMasterUserSignalAuthorization(pending.signal, input)
    ) {
      return false;
    }

    const username = canonicalizeLoginUsername(input.username);
    const placement = username ? this.userKernels.get(username) : null;
    return Boolean(
      username
      && username === input.username
      && input.targetKernelName === userKernelName(username)
      && placement
      && this.isActiveUserKernelPlacement(placement)
      && placement.uid === input.uid,
    );
  }

  async authenticateUserKernelConnection(
    input: UserKernelAuthenticationInput,
  ): Promise<import("./context").KernelAuthenticationResult> {
    this.assertMasterKernel();
    const username = canonicalizeLoginUsername(input.username);
    if (
      !username
      || input.sourceKernelName !== userKernelName(username)
      || canonicalizeLoginUsername(input.args.auth?.username) !== username
    ) {
      return { ok: false, error: "Authentication failed" };
    }
    const placement = await this.authorizeUserKernelSource({
      sourceKernelName: input.sourceKernelName,
      uid: this.userKernels.get(username)?.uid ?? -1,
    });
    if (!placement) {
      return { ok: false, error: "Authentication failed" };
    }

    const authenticated = await authenticateConnectionIdentity(
      input.args,
      this.auth,
      normalizeLoginSourceScope(input.loginSourceScope),
    );
    const currentPlacement = this.userKernels.get(username);
    if (
      !authenticated.ok
      || !this.isActiveUserKernelPlacement(currentPlacement)
      || currentPlacement.uid !== placement.uid
      || authenticated.identity.username !== username
      || authenticated.identity.uid !== placement.uid
    ) {
      return { ok: false, error: "Authentication failed" };
    }

    const capabilities = input.args.client.role === "user"
      ? this.caps.resolve(authenticated.identity.gids)
      : input.args.client.role === "service"
        ? this.caps.resolve([102])
        : [];
    return {
      ok: true,
      identity: authenticated.identity,
      capabilities,
      credential: authenticated.credential,
    };
  }

  /**
   * The claimed user-Kernel RPC source must parse as `user:<canonical>` and
   * hold an active placement. Placement is never authority by itself — it
   * only proves the named Kernel is the current home of that username.
   */
  private assertActiveUserKernelSourcePlacement(sourceKernelName: string) {
    this.assertMasterKernel();
    const username = userKernelUsername(sourceKernelName);
    const placement = username ? this.userKernels.get(username) : undefined;
    if (!placement || placement.lifecycle !== "active") {
      throw new Error("User Kernel is not active");
    }
    return placement;
  }

  /**
   * Bind a requester uid to its source Kernel: the requester is the Kernel
   * owner or an account the owner may run as. uid 0 is only ever accepted
   * from the root user's own Kernel.
   */
  private assertUserKernelRequester(
    placement: { uid: number; username: string },
    requesterUid: number,
  ): void {
    if (!Number.isSafeInteger(requesterUid) || requesterUid < 0) {
      throw new Error("Invalid requester");
    }
    if (requesterUid === 0) {
      if (placement.uid === 0 && placement.username === "root") return;
      throw new Error("Permission denied");
    }
    if (requesterUid === placement.uid) return;
    const entry = this.auth.getPasswdByUid(requesterUid);
    if (
      !entry
      || !canOwnerRunAsAccount(this.auth, placement.uid, entry, placement.uid === 0)
    ) {
      throw new Error("Permission denied");
    }
  }

  /**
   * Serialized /etc auth files for user Kernels, which hold no auth state.
   * passwd is the public account directory; group membership is filtered to
   * the requester's runnable accounts (root's group emptied for non-root);
   * shadow never leaves the Master except to the root user's own Kernel.
   */
  async masterReadAuthFile(input: {
    sourceKernelName: string;
    requesterUid: number;
    kind: "passwd" | "group" | "shadow";
  }): Promise<{ content: string }> {
    const placement = this.assertActiveUserKernelSourcePlacement(input.sourceKernelName);
    this.assertUserKernelRequester(placement, input.requesterUid);

    if (input.kind === "shadow") {
      if (input.requesterUid !== 0) {
        throw new Error("EACCES: permission denied, open '/etc/shadow'");
      }
      return { content: this.auth.serializeShadow() };
    }
    if (input.kind === "passwd") {
      return { content: this.auth.serializePasswd() };
    }
    if (input.kind === "group") {
      if (input.requesterUid === 0) {
        return { content: this.auth.serializeGroup() };
      }
      const runnable = new Set(
        this.auth.getPasswdEntries()
          .filter((entry) => canOwnerRunAsAccount(this.auth, placement.uid, entry, false))
          .map((entry) => entry.username),
      );
      const groups = this.auth.getGroupEntries().map((group) => ({
        ...group,
        members: group.gid === 0
          ? []
          : group.members.filter((member) => runnable.has(member)),
      }));
      return { content: serializeGroup(groups) };
    }
    throw new Error("Invalid auth file kind");
  }

  /**
   * Full installed-package records visible to the requester, for user Kernels
   * rendering package-backed filesystem views. Same visibility rule as
   * pkg.list, but with the complete records the filesystem needs.
   */
  async masterPackagesList(input: {
    sourceKernelName: string;
    requesterUid: number;
    enabled?: boolean;
  }): Promise<{ packages: InstalledPackageRecord[] }> {
    const placement = this.assertActiveUserKernelSourcePlacement(input.sourceKernelName);
    this.assertUserKernelRequester(placement, input.requesterUid);
    return {
      packages: this.packages.list({
        enabled: input.enabled,
        scopes: visiblePackageScopesForActor({ uid: input.requesterUid }),
      }),
    };
  }

  /** Authoritative package-agent check for a provisioned user Kernel. */
  async validatePackageRuntime(
    input: PackageRuntimeAuthorizationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    if (
      !isProcessIdentity(input.runAs)
      || input.ownerUid !== input.uid
      || !this.authorizeUserKernelSource(input)
    ) {
      return false;
    }
    return this.authorizeCurrentPackageAgentRuntime(
      input.ownerUid,
      input.runAs,
      input.packageSecurityRevision,
      input.requiredCall,
    );
  }

  /** Resolve Process DO authority from the Master-owned account directory. */
  async resolveProcessIdentity(
    input: ProcessIdentityResolutionInput,
  ): Promise<ProcessIdentityResolutionResult> {
    this.assertMasterKernel();
    const placement = this.authorizeUserKernelSource(input);
    if (
      !placement
      || input.ownerUid !== placement.uid
      || !isProcessIdentity(input.runAs)
    ) {
      return { ok: false, error: "process identity authentication failed" };
    }
    const owner = this.auth.getPasswdByUid(input.ownerUid);
    const runAs = this.auth.getPasswdByUid(input.runAs.uid);
    if (
      !owner
      || owner.username !== placement.username
      || !runAs
      || runAs.username !== input.runAs.username
      || !canOwnerRunAsAccount(this.auth, owner.uid, runAs, owner.uid === 0)
    ) {
      return { ok: false, error: "process identity is no longer authorized" };
    }
    const authoritativeRunAs: ProcessIdentity = {
      uid: runAs.uid,
      gid: runAs.gid,
      gids: this.auth.resolveGids(runAs.username, runAs.gid),
      username: runAs.username,
      home: runAs.home,
      cwd: input.runAs.cwd,
    };
    if (!processIdentityEquals(authoritativeRunAs, input.runAs, { includeCwd: true })) {
      return { ok: false, error: "process identity does not match the account directory" };
    }
    return {
      ok: true,
      runAs: authoritativeRunAs,
      owner: {
        uid: owner.uid,
        gid: owner.gid,
        gids: this.auth.resolveGids(owner.username, owner.gid),
        username: owner.username,
        home: owner.home,
        cwd: owner.home,
      },
    };
  }

  /** Resolve a runnable account and capabilities without copying the directory. */
  async resolveAccountIdentity(
    input: AccountIdentityResolutionInput,
  ): Promise<AccountIdentityResolutionResult> {
    this.assertMasterKernel();
    const placement = this.authorizeUserKernelSource(input);
    const owner = placement ? this.auth.getPasswdByUid(placement.uid) : null;
    const actor = Number.isSafeInteger(input.actorUid)
      ? this.auth.getPasswdByUid(input.actorUid)
      : null;
    if (
      !placement
      || input.ownerUid !== placement.uid
      || !owner
      || owner.username !== placement.username
      || !actor
      || !canOwnerRunAsAccount(this.auth, owner.uid, actor, owner.uid === 0)
    ) {
      return { ok: false, error: "account identity is no longer authorized" };
    }
    const identity = accountIdentity(this.auth, actor);
    return {
      ok: true,
      identity,
      capabilities: this.caps.resolve(identity.gids),
    };
  }

  private resolveAuthoritativeRunAsAccount(
    ownerUid: number,
    callerUid: number,
    selector?: string,
  ): RunAsAccountResult {
    const owner = this.auth.getPasswdByUid(ownerUid);
    const caller = this.auth.getPasswdByUid(callerUid);
    if (
      !owner
      || !caller
      || !canOwnerRunAsAccount(this.auth, owner.uid, caller, owner.uid === 0)
    ) {
      return { ok: false, error: "Process owner or caller is no longer authorized" };
    }

    const normalizedSelector = selector?.trim() ?? "";
    let identity: ProcessIdentity;
    if (!normalizedSelector) {
      if (owner.uid < 1000 || this.auth.isPersonalAgentUid(owner.uid)) {
        identity = accountIdentity(this.auth, owner);
      } else {
        const personalAgentUid = this.auth.getPersonalAgentUid(owner.uid);
        const personalAgent = personalAgentUid === null
          ? null
          : this.auth.getPasswdByUid(personalAgentUid);
        if (!personalAgent) {
          return { ok: false, error: `Personal agent is not provisioned for ${owner.username}` };
        }
        identity = accountIdentity(this.auth, personalAgent);
      }
    } else if (normalizedSelector.includes("#")) {
      const callerIdentity = accountIdentity(this.auth, caller);
      const resolved = resolvePackageAgentRunAs(
        this.buildKernelContext({
          identity: {
            role: "user",
            process: callerIdentity,
            capabilities: this.caps.resolve(callerIdentity.gids),
          },
          callerOwnerUid: owner.uid,
        }),
        normalizedSelector,
        owner.uid,
        caller.uid === 0,
      );
      if (!resolved.ok) return resolved;
      identity = resolved.identity;
    } else {
      const entry = /^\d+$/.test(normalizedSelector)
        ? this.auth.getPasswdByUid(Number(normalizedSelector))
        : this.auth.getPasswdByUsername(normalizedSelector);
      if (!entry) {
        return { ok: false, error: `Unknown account: ${selector}` };
      }
      const isSelf = entry.uid === caller.uid;
      if (
        caller.uid !== 0
        && !isSelf
        && !canOwnerDelegateRunAs(this.auth, owner.uid, entry)
      ) {
        return { ok: false, error: `Permission denied: cannot run as ${entry.username}` };
      }
      identity = accountIdentity(this.auth, entry);
    }

    const entry = this.auth.getPasswdByUid(identity.uid);
    const account = entry ? this.auth.getAccountIdentity(entry.username) : null;
    if (!entry || !account || account.uid !== entry.uid || account.state !== "active") {
      return { ok: false, error: "Run-as account is no longer active" };
    }
    let packageSecurityRevision: string | null;
    try {
      packageSecurityRevision = packageAgentRuntimeSecurityRevision(
        { config: this.config },
        entry.uid,
      );
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    const personalAgentUid = this.auth.getPersonalAgentUid(owner.uid);
    return {
      ok: true,
      ownerIdentity: accountIdentity(this.auth, owner),
      account: {
        identity,
        capabilities: this.caps.resolve(identity.gids),
        displayName: entry.gecos?.trim() || entry.username,
        relation: entry.uid === owner.uid
          ? "self"
          : entry.uid === personalAgentUid
            ? "personal-agent"
            : account.kind === "agent"
              ? "agent"
              : "human",
        packageSecurityRevision,
      },
    };
  }

  private listAuthoritativeRunnableAccounts(
    ownerUid: number,
    callerUid: number,
  ): RunnableAccount[] {
    const owner = this.auth.getPasswdByUid(ownerUid);
    const caller = this.auth.getPasswdByUid(callerUid);
    if (
      !owner
      || !caller
      || !canOwnerRunAsAccount(this.auth, owner.uid, caller, owner.uid === 0)
    ) {
      throw new Error("Process owner or caller is no longer authorized");
    }
    const personalAgentUid = this.auth.getPersonalAgentUid(owner.uid);
    const accounts = this.auth.getPasswdEntries().flatMap((entry): RunnableAccount[] => {
      if (entry.uid !== 0 && entry.uid < 1000) return [];
      if (!canOwnerRunAsAccount(this.auth, owner.uid, entry, owner.uid === 0)) return [];
      const account = this.auth.getAccountIdentity(entry.username);
      if (!account || account.uid !== entry.uid || account.state !== "active") return [];
      const packageSecurityRevision = packageAgentRuntimeSecurityRevision(
        { config: this.config },
        entry.uid,
      );
      return [{
        identity: accountIdentity(this.auth, entry),
        capabilities: this.caps.resolve(
          this.auth.resolveGids(entry.username, entry.gid),
        ),
        displayName: entry.gecos?.trim() || entry.username,
        relation: entry.uid === owner.uid
          ? "self"
          : entry.uid === personalAgentUid
            ? "personal-agent"
            : account.kind === "agent"
              ? "agent"
              : "human",
        packageSecurityRevision,
      }];
    });
    const relationRank: Record<RunnableAccount["relation"], number> = {
      "self": 0,
      "personal-agent": 1,
      "agent": 2,
      "human": 3,
    };
    return accounts.sort((left, right) => (
      relationRank[left.relation] - relationRank[right.relation]
      || left.identity.username.localeCompare(right.identity.username)
    ));
  }

  async resolveRunAsAccount(
    input: RunAsAccountResolutionInput,
  ): Promise<RunAsAccountResult> {
    this.assertMasterKernel();
    const placement = this.authorizeUserKernelSource(input);
    if (!placement || input.ownerUid !== placement.uid) {
      return { ok: false, error: "Run-as resolution authentication failed" };
    }
    return this.resolveAuthoritativeRunAsAccount(
      input.ownerUid,
      input.callerUid,
      input.selector,
    );
  }

  async listRunnableAccounts(
    input: RunnableAccountListInput,
  ): Promise<RunnableAccount[]> {
    this.assertMasterKernel();
    const placement = this.authorizeUserKernelSource(input);
    if (!placement || input.ownerUid !== placement.uid) {
      throw new Error("Runnable-account listing authentication failed");
    }
    return this.listAuthoritativeRunnableAccounts(input.ownerUid, input.callerUid);
  }

  async resolveAdapterServiceIdentity(
    input: AdapterServiceIdentityInput,
  ): Promise<ConnectionIdentity | null> {
    this.assertMasterKernel();
    const placement = this.authorizeUserKernelSource(input);
    const owner = placement ? this.auth.getPasswdByUid(placement.uid) : null;
    const channel = input.channel.trim().toLowerCase();
    if (
      !placement
      || input.ownerUid !== placement.uid
      || !owner
      || owner.username !== placement.username
      || !channel
    ) {
      return null;
    }
    return {
      role: "service",
      process: accountIdentity(this.auth, owner),
      capabilities: this.caps.resolve([102]),
      channel,
    };
  }

  /** Validate package and actor authority from the Master-owned stores. */
  async validateAppFrame(
    input: AppFrameAuthorizationInput,
  ): Promise<AppFrameAuthorizationResult> {
    return this.validateAppFrameAuthority(input, false);
  }

  async validateAppDaemonFrame(
    input: AppFrameAuthorizationInput,
  ): Promise<AppFrameAuthorizationResult> {
    return this.validateAppFrameAuthority(input, true);
  }

  private validateAppFrameAuthority(
    input: AppFrameAuthorizationInput,
    requireDaemonAccess: boolean,
  ): AppFrameAuthorizationResult {
    this.assertMasterKernel();
    const placement = this.authorizeUserKernelSource(input);
    const appFrame = input.appFrame;
    if (
      !placement
      || !appFrame
      || typeof appFrame !== "object"
      || isAppFrameContextExpired(appFrame)
      || (input.requiredCall !== undefined
        && (typeof input.requiredCall !== "string" || !input.requiredCall))
    ) {
      return { ok: false };
    }
    const actor = this.auth.getPasswdByUid(appFrame.uid);
    const actorAccount = actor ? this.auth.getAccountIdentity(actor.username) : null;
    if (
      !actor
      || actor.username !== appFrame.username
      || !actorAccount
      || actorAccount.uid !== actor.uid
      || actorAccount.state !== "active"
      || !canOwnerRunAsAccount(this.auth, placement.uid, actor, placement.uid === 0)
    ) {
      return { ok: false };
    }
    const record = this.packages.resolve(
      appFrame.packageId,
      visiblePackageScopesForActor({ uid: actor.uid }),
    );
    if (
      !record
      || !record.enabled
      || (record.reviewRequired && !record.reviewedAt)
      || record.manifest.name !== appFrame.packageName
      || record.updatedAt !== appFrame.packageUpdatedAt
      || record.artifact.hash !== appFrame.packageArtifactHash
      || (requireDaemonAccess
        && record.artifact.runtimeAccess?.daemon?.rpcSchedules !== true)
    ) {
      return { ok: false };
    }
    const entrypoint = findAppFrameEntrypoint(
      record.manifest.entrypoints,
      appFrame.entrypointName,
      appFrame.routeBase,
    );
    if (
      !entrypoint
      || (input.requiredCall !== undefined
        && !entrypoint.syscalls?.includes(input.requiredCall))
    ) {
      return { ok: false };
    }
    const gids = this.auth.resolveGids(actor.username, actor.gid);
    const capabilities = this.caps.resolve(gids);
    if (
      input.requiredCall !== undefined
      && !hasCapability(capabilities, input.requiredCall)
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      entrypointKind: entrypoint.kind,
      identity: {
        role: "user",
        process: {
          uid: actor.uid,
          gid: actor.gid,
          gids,
          username: actor.username,
          home: actor.home,
          cwd: actor.home,
        },
        capabilities,
      },
    };
  }

  async authorizePreservedAppRuntime(
    input: PreservedAppRuntimeAuthorityInput,
  ): Promise<PreservedAppRuntimeAuthorityResult> {
    this.assertMasterKernel();
    const placement = this.authorizeUserKernelSource(input);
    const runtime = input.runtime;
    const owner = placement ? this.auth.getPasswdByUid(placement.uid) : null;
    const actor = isPreservedAppRuntimeDescriptor(runtime)
      ? this.auth.getPasswdByUid(runtime.uid)
      : null;
    const actorAccount = actor ? this.auth.getAccountIdentity(actor.username) : null;
    if (
      !placement
      || input.ownerUid !== placement.uid
      || !owner
      || owner.username !== placement.username
      || !actor
      || actor.username !== runtime.username
      || !actorAccount
      || actorAccount.uid !== actor.uid
      || actorAccount.state !== "active"
      || !canOwnerRunAsAccount(this.auth, owner.uid, actor, owner.uid === 0)
    ) {
      return { ok: false };
    }

    const record = this.packages.resolve(
      runtime.packageId,
      visiblePackageScopesForActor({ uid: actor.uid }),
    );
    if (
      !record
      || !record.enabled
      || (record.reviewRequired && !record.reviewedAt)
      || record.manifest.name !== runtime.packageName
      || record.artifact.runtimeAccess?.daemon?.rpcSchedules !== true
      || !findAppFrameEntrypoint(
        record.manifest.entrypoints,
        runtime.entrypointName,
        runtime.routeBase,
      )
    ) {
      return { ok: false };
    }

    return {
      ok: true,
      identity: accountIdentity(this.auth, actor),
      packageId: record.packageId,
      packageName: record.manifest.name,
      packageUpdatedAt: record.updatedAt,
      artifact: record.artifact,
      entrypointName: runtime.entrypointName,
      routeBase: runtime.routeBase,
    };
  }

  /** Authoritative half of user-Kernel device forgetting. */
  async revokeUserKernelDeviceCredentials(
    input: UserKernelDeviceRevocationInput,
  ): Promise<TokenRevocationNotice[]> {
    this.assertMasterKernel();
    const username = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelSource({
      sourceKernelName: input.sourceKernelName,
      uid: input.ownerUid,
    });
    if (
      !username
      || !placement
      || placement.uid !== input.ownerUid
      || typeof input.deviceId !== "string"
      || input.deviceId.trim().length === 0
    ) {
      throw new Error("Device credential revocation authentication failed");
    }
    const notices = this.revokeDeviceCredentialsLocally(
      placement.uid,
      input.deviceId.trim(),
    );
    this.ctx.waitUntil(this.schedule(
      1,
      "onTokenRevocationOutboxDue",
    ).then(() => undefined));
    return notices;
  }

  /** Reauthorize a target delivery against current Master state. */
  async confirmTokenRevocationDelivery(
    input: TokenRevocationConfirmationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    const username = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelSource({
      sourceKernelName: input.sourceKernelName,
      uid: input.uid,
    });
    if (
      !username
      || username !== input.username
      || !placement
      || placement.uid !== input.uid
      || input.notice.uid !== input.uid
      || typeof input.notice.tokenId !== "string"
      || input.notice.tokenId.length === 0
      || !Number.isSafeInteger(input.notice.revokedAt)
      || input.notice.revokedAt <= 0
    ) {
      return false;
    }
    const token = this.auth.getToken(input.notice.tokenId, input.uid);
    return token?.revokedAt === input.notice.revokedAt;
  }

  /** Target half of durable Master revocation delivery. */
  async receiveMasterTokenRevocation(
    input: MasterTokenRevocationDeliveryInput,
  ): Promise<boolean> {
    if (
      this.instanceKind !== "user"
      || input.sourceKernelName !== SHIP_KERNEL_NAME
      || this.name !== userKernelName(input.username)
      || input.notice.uid !== input.uid
      || typeof input.notice.tokenId !== "string"
      || input.notice.tokenId.length === 0
      || !Number.isSafeInteger(input.notice.revokedAt)
      || input.notice.revokedAt <= 0
    ) {
      return false;
    }
    const marker = await this.loadUserKernelMarker();
    if (
      !marker
      || marker.lifecycle !== "active"
      || marker.username !== input.username
      || marker.uid !== input.uid
    ) {
      return false;
    }

    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const confirmed = await master.confirmTokenRevocationDelivery({
      sourceKernelName: this.name,
      username: marker.username,
      uid: marker.uid,
      notice: input.notice,
    });
    if (!confirmed) {
      return false;
    }

    this.ctx.storage.transactionSync(() => {
      this.tokenRevocations.remember(input.notice);
    });
    this.closeConnectionsForTokenIds(new Set([input.notice.tokenId]));
    return true;
  }

  async dispatchMasterSyscall(input: MasterSyscallInput): Promise<MasterSyscallResult> {
    this.assertMasterKernel();
    if (!isMasterOwnedSyscall(input.frame.call)) {
      return {
        response: masterErrorFrame(input.frame.id, 403, "Operation is not master-routable"),
      };
    }

    const sourceUsername = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelSource({
      sourceKernelName: input.sourceKernelName,
      uid: input.callerOwnerUid,
    });
    if (
      !sourceUsername
      || !placement
      || placement.username !== sourceUsername
      || placement.uid !== input.callerOwnerUid
    ) {
      return {
        response: masterErrorFrame(input.frame.id, 401, "Authentication failed"),
      };
    }

    const identity = this.resolveMasterSyscallIdentity(input, placement.uid);
    if (!identity || !hasCapability(identity.capabilities, input.frame.call)) {
      return {
        response: masterErrorFrame(input.frame.id, 403, `Permission denied: ${input.frame.call}`),
      };
    }

    const releaseOperation = this.beginMasterUserOperation(sourceUsername);
    if (!releaseOperation) {
      return {
        response: masterErrorFrame(input.frame.id, 401, "Authentication failed"),
      };
    }
    try {
      return await this.dispatchAuthorizedMasterSyscall(
        input,
        sourceUsername,
        placement,
        identity,
      );
    } finally {
      releaseOperation();
    }
  }

  private async provisionCreatedHuman(
    response: ResponseFrame,
  ): Promise<void> {
    if (!response.ok) return;
    const data = response.data as {
      kind?: unknown;
      account?: { username?: unknown };
    } | undefined;
    if (data?.kind !== "human" || typeof data.account?.username !== "string") return;
    await this.ensureUserKernelProvisioned(data.account.username);
  }

  private async dispatchAuthorizedMasterSyscall(
    input: MasterSyscallInput,
    sourceUsername: string,
    placement: UserKernelRecord,
    identity: ConnectionIdentity,
  ): Promise<MasterSyscallResult> {
    const ctx = this.buildKernelContext({
      identity,
      callerOwnerUid: input.callerOwnerUid,
    });
    const frame = input.frame as RequestFrame;
    const result = await this.dispatchKernelFrame(
      frame,
      { type: "process", id: `user-kernel:${sourceUsername}` },
      ctx,
    );
    if (!result.handled) {
      return {
        response: masterErrorFrame(input.frame.id, 500, "Master operation cannot be deferred"),
      };
    }

    if (result.response.ok && result.response.body) {
      await cancelUnlockedBody(result.response.body, "Master RPC cannot return a body");
      const response = masterErrorFrame(
        input.frame.id,
        500,
        "Master operation returned an unsupported body",
      );
      return {
        response,
      };
    }
    const tokenRevocations = this.tokenRevocationsFromResponse(frame, result.response);
    if (tokenRevocations.length > 0) {
      this.ctx.waitUntil(this.schedule(
        1,
        "onTokenRevocationOutboxDue",
      ).then(() => undefined));
    }
    return {
      response: result.response as MasterSyscallResult["response"],
      ...(tokenRevocations.some((notice) => notice.uid === placement.uid)
        ? {
            tokenRevocations: tokenRevocations.filter(
              (notice) => notice.uid === placement.uid,
            ),
          }
        : {}),
    };
  }

  /**
   * Return only a Master-authoritative repository access decision. Repository
   * payloads stay on the user Kernel data plane. Read callers invoke this once
   * before RIPGIT and again after fetch resolves but before consuming its body;
   * the second decision is the read's linearization point. Write callers invoke
   * it immediately before mutation, which is the write's linearization point.
   */
  async authorizeUserRepoOperation(
    input: UserRepoOperationAuthorizationInput,
  ): Promise<UserRepoOperationAuthorizationResult> {
    this.assertMasterKernel();
    if (
      !isAuthoritativeRepoOperationCall(input?.call)
      || (input.call === "repo.list"
        ? input.repo !== undefined
          || (input.requestedOwner !== undefined
            && typeof input.requestedOwner !== "string")
        : typeof input.repo !== "string" || input.requestedOwner !== undefined)
    ) {
      return {
        ok: false,
        error: { code: 403, message: "Repository operation is not authorized" },
      };
    }

    const sourceUsername = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelSource({
      sourceKernelName: input.sourceKernelName,
      uid: input.callerOwnerUid,
    });
    if (
      !sourceUsername
      || !placement
      || placement.username !== sourceUsername
      || placement.uid !== input.callerOwnerUid
    ) {
      return { ok: false, error: { code: 401, message: "Authentication failed" } };
    }

    const identity = this.resolveMasterSyscallIdentity(input, placement.uid);
    if (!identity || !hasCapability(identity.capabilities, input.call)) {
      return {
        ok: false,
        error: { code: 403, message: `Permission denied: ${input.call}` },
      };
    }
    const context = this.buildKernelContext({
      identity,
      callerOwnerUid: input.callerOwnerUid,
    });
    try {
      const repoList = authorizeAuthoritativeRepoOperation(
        input.call,
        input.repo,
        input.requestedOwner,
        context,
      );
      return {
        ok: true,
        ...(repoList ? { repoList } : {}),
      };
    } catch {
      return {
        ok: false,
        error: { code: 403, message: "Repository operation is not authorized" },
      };
    }
  }

  async mutateUserRepoMetadata(
    input: MasterRepoMetadataMutationInput,
  ): Promise<RepoMetadataMutationResult> {
    this.assertMasterKernel();
    const sourceUsername = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelSource({
      sourceKernelName: input.sourceKernelName,
      uid: input.callerOwnerUid,
    });
    if (
      !sourceUsername
      || !placement
      || placement.username !== sourceUsername
      || placement.uid !== input.callerOwnerUid
    ) {
      throw new Error("Repository metadata authentication failed");
    }

    const releaseOperation = this.beginMasterUserOperation(sourceUsername);
    if (!releaseOperation) {
      throw new Error("Repository metadata authentication failed");
    }
    try {
      const mutation = normalizeRepoMetadataMutation(input.mutation);
      const identity = this.resolveMasterSyscallIdentity({
        sourceKernelName: input.sourceKernelName,
        callerOwnerUid: input.callerOwnerUid,
        identity: input.identity,
        frame: {
          type: "req",
          id: "repo-metadata",
          call: mutation.call,
          args: {},
        },
      }, placement.uid);
      if (!identity) {
        throw new Error("Repository metadata authentication failed");
      }
      return await this.applyAuthorizedRepoMetadataMutation(
        mutation,
        identity,
        input.callerOwnerUid,
        () => {
          const current = this.userKernels.get(sourceUsername);
          if (
            !current
            || !sameUserKernelPlacement(current, placement)
            || !this.isActiveUserKernelPlacement(current)
          ) {
            throw new Error("Repository metadata authentication failed");
          }
        },
      );
    } finally {
      releaseOperation();
    }
  }

  private async applyAuthorizedRepoMetadataMutation(
    input: RepoMetadataMutation,
    identity: ConnectionIdentity,
    callerOwnerUid: number,
    assertAuthority?: () => void,
  ): Promise<RepoMetadataMutationResult> {
    this.assertMasterKernel();
    const mutation = normalizeRepoMetadataMutation(input);
    if (!hasCapability(identity.capabilities, mutation.call)) {
      throw new Error(`Permission denied: ${mutation.call}`);
    }
    const context = this.buildKernelContext({ identity, callerOwnerUid });
    const repo = `${mutation.repo.owner}/${mutation.repo.repo}`;
    if (!canWriteRepo(repo, context)) {
      throw new Error(`Forbidden: cannot write repo ${repo}`);
    }
    assertAuthority?.();
    return this.ctx.storage.transactionSync(() => (
      applyRepoMetadataMutation(this.config, mutation)
    ));
  }

  private async ensureUserKernelProvisioned(
    usernameInput: string,
  ): Promise<UserKernelRecord> {
    this.assertMasterKernel();
    const username = canonicalizeLoginUsername(usernameInput);
    if (!username) {
      throw new Error("Invalid canonical username");
    }
    const existingFlight = this.userKernelProvisioningFlights.get(username);
    if (existingFlight) {
      return existingFlight;
    }
    const transitions = this.transitioningUserKernels ??= new Set<string>();
    if (transitions.has(username)) {
      throw new Error(`User Kernel transition is already in progress for ${username}`);
    }
    transitions.add(username);
    const flight = (async () => {
      try {
        await this.waitForMasterUserOperations(username);
        return await this.ensureUserKernelProvisionedSingleFlight(username);
      } finally {
        transitions.delete(username);
      }
    })();
    this.userKernelProvisioningFlights.set(username, flight);
    try {
      return await flight;
    } finally {
      if (this.userKernelProvisioningFlights.get(username) === flight) {
        this.userKernelProvisioningFlights.delete(username);
      }
    }
  }

  private async ensureUserKernelProvisionedSingleFlight(
    username: string,
  ): Promise<UserKernelRecord> {
    const placement = this.userKernels.get(username);
    if (!placement) {
      throw new Error(`User Kernel is not reserved: ${username}`);
    }
    if (placement.lifecycle === "active") {
      return this.completeUserKernelActivation(placement);
    }
    if (placement.lifecycle !== "provisioning") {
      throw new Error(`User Kernel cannot provision from ${placement.lifecycle}`);
    }

    // The target holds no Master state; everything its runtime needs is
    // resolved here and carried by the provisioning RPC.
    const owner = this.auth.getPasswdByUsername(username);
    if (!owner || owner.uid !== placement.uid) {
      throw new Error(`User Kernel owner is unavailable: ${username}`);
    }
    const ownerIdentity = accountIdentity(this.auth, owner);
    const personalAgentUid = this.auth.getPersonalAgentUid(owner.uid);
    const agentEntry = personalAgentUid != null
      ? this.auth.getPasswdByUid(personalAgentUid)
      : null;
    const target = await getAgentByName(
      this.env.KERNEL,
      userKernelName(username),
    ) as unknown as {
      provisionUserKernel: (
        input: UserKernelProvisioningTargetInput,
      ) => Promise<UserKernelInstanceMarker>;
    };
    const marker = await target.provisionUserKernel({
      sourceKernelName: this.name,
      username,
      uid: placement.uid,
      ownerIdentity,
      ...(agentEntry ? { personalAgent: accountIdentity(this.auth, agentEntry) } : {}),
      capabilities: this.caps.resolve(ownerIdentity.gids),
    });
    if (
      marker.lifecycle !== "provisioning"
      || marker.username !== placement.username
      || marker.uid !== placement.uid
    ) {
      throw new Error(`User Kernel failed to prepare: ${username}`);
    }
    const active = this.userKernels.markActive(username);
    return this.completeUserKernelActivation(active);
  }

  private async completeUserKernelActivation(
    placement: UserKernelRecord,
  ): Promise<UserKernelRecord> {
    if (placement.lifecycle !== "active") {
      throw new Error(`User Kernel is not committed active: ${placement.username}`);
    }
    const target = await getAgentByName(
      this.env.KERNEL,
      userKernelName(placement.username),
    ) as unknown as {
      activateProvisionedUserKernel: (
        input: UserKernelActivationTargetInput,
      ) => Promise<UserKernelInstanceMarker>;
    };
    const marker = await target.activateProvisionedUserKernel({
      sourceKernelName: this.name,
      username: placement.username,
      uid: placement.uid,
    });
    if (
      marker.lifecycle !== "active"
      || marker.username !== placement.username
      || marker.uid !== placement.uid
    ) {
      throw new Error(`User Kernel failed to confirm activation: ${placement.username}`);
    }
    const current = this.userKernels.get(placement.username);
    if (!current || !sameUserKernelPlacement(current, placement)) {
      throw new Error(`User Kernel placement changed for ${placement.username}`);
    }
    this.confirmedUserKernelActivations.set(current.username, current.uid);
    return current;
  }

  private isUserKernelActivationConfirmed(placement: UserKernelRecord): boolean {
    return placement.lifecycle === "active"
      && this.confirmedUserKernelActivations.get(placement.username) === placement.uid;
  }

  private async provisionSetupUserKernels(username: string): Promise<void> {
    this.assertMasterKernel();
    const root = this.auth.getPasswdByUsername("root");
    const user = this.auth.getPasswdByUsername(username);
    if (!root || !user) {
      throw new Error("Setup identities are incomplete");
    }
    this.ctx.storage.transactionSync(() => {
      this.userKernels.reserve(root.username, root.uid);
      this.userKernels.reserve(user.username, user.uid);
    });
    await this.ensureUserKernelProvisioned(root.username);
    await this.ensureUserKernelProvisioned(user.username);
  }

  private async authenticateConnectionViaMaster(
    args: ConnectArgs,
    loginSourceScope: LoginSourceScope,
  ): Promise<import("./context").KernelAuthenticationResult> {
    const marker = await this.loadUserKernelMarker();
    const username = canonicalizeLoginUsername(args.auth?.username);
    if (
      !marker
      || marker.lifecycle !== "active"
      || !username
      || username !== marker.username
      || this.name !== userKernelName(username)
    ) {
      return { ok: false, error: "Authentication failed" };
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const authenticated = await master.authenticateUserKernelConnection({
      sourceKernelName: this.name,
      username,
      args,
      loginSourceScope,
    });
    return authenticated;
  }

  private async forwardMasterSyscall(
    frame: RequestFrame,
    ctx: KernelContext,
  ): Promise<ResponseFrame> {
    if (!ctx.identity || this.instanceKind !== "user" || !this.instanceUsername) {
      return errFrame(frame.id, 403, "Master operation requires a user Kernel identity");
    }
    let marker: UserKernelInstanceMarker | null;
    try {
      marker = await this.requireActiveUserKernel();
    } catch {
      return errFrame(frame.id, 401, "Authentication failed");
    }
    if (!marker || marker.username !== this.instanceUsername) {
      return errFrame(frame.id, 401, "Authentication failed");
    }
    ctx.assertCurrentKernel();
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const result = await master.dispatchMasterSyscall({
      sourceKernelName: this.name,
      callerOwnerUid: resolveCallerOwnerUid(ctx),
      identity: ctx.identity,
      frame: {
        type: "req",
        id: frame.id,
        call: frame.call,
        args: frame.args as MasterRpcValue,
        ...(frame.runId ? { runId: frame.runId } : {}),
      },
    });
    ctx.assertCurrentKernel();
    if (result.tokenRevocations?.length) {
      this.persistAndFenceTokenRevocations(
        result.tokenRevocations,
        ctx.connection?.id,
      );
    }
    return result.response as ResponseFrame;
  }

  private revokeDeviceCredentialsLocally(
    ownerUid: number,
    deviceId: string,
  ): TokenRevocationNotice[] {
    return this.ctx.storage.transactionSync(() => {
      const notices: TokenRevocationNotice[] = [];
      const tokens = this.auth.listTokens(ownerUid).filter((token) => (
        token.kind === "node" && token.allowedDeviceId === deviceId
      ));
      for (const token of tokens) {
        if (!this.auth.revokeToken(token.tokenId, "machine forgotten", ownerUid)) {
          continue;
        }
        const revoked = this.auth.getToken(token.tokenId, ownerUid);
        if (revoked?.revokedAt !== null && revoked?.revokedAt !== undefined) {
          notices.push({
            tokenId: revoked.tokenId,
            uid: revoked.uid,
            revokedAt: revoked.revokedAt,
          });
        }
      }
      return notices;
    });
  }

  private async revokeDeviceCredentialsFromContext(
    ownerUid: number,
    deviceId: string,
    context: KernelContext,
  ): Promise<TokenRevocationNotice[]> {
    const callerUid = context.identity?.process.uid;
    if (
      !Number.isSafeInteger(ownerUid)
      || ownerUid < 0
      || typeof deviceId !== "string"
      || deviceId.length === 0
      || (callerUid !== 0 && callerUid !== ownerUid)
    ) {
      throw new Error("Device credential revocation authentication failed");
    }

    if (this.instanceKind === "master") {
      const notices = this.revokeDeviceCredentialsLocally(ownerUid, deviceId);
      this.persistAndFenceTokenRevocations(notices, context.connection?.id);
      for (const notice of notices) {
        this.tokenRevocations.acknowledge(notice.tokenId, notice.uid);
      }
      return notices;
    }

    const marker = await this.requireActiveUserKernel();
    if (!marker || marker.uid !== ownerUid) {
      throw new Error("Device credential revocation authentication failed");
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const notices = await master.revokeUserKernelDeviceCredentials({
      sourceKernelName: this.name,
      ownerUid,
      deviceId,
    });
    this.persistAndFenceTokenRevocations(notices, context.connection?.id);
    return notices;
  }

  private persistAndFenceTokenRevocations(
    notices: readonly TokenRevocationNotice[],
    deferConnectionId?: string,
  ): void {
    if (notices.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      this.tokenRevocations.rememberAll(notices);
    });
    this.closeConnectionsForTokenIds(
      new Set(notices.map((notice) => notice.tokenId)),
      deferConnectionId,
    );
  }

  private isConnectionCredentialActive(state: Readonly<Pick<
    ConnectionState,
    "step" | "credential"
  >>): boolean {
    if (state.step !== "connected") return true;
    const credential = state.credential;
    if (!credential) return false;
    if (credential.kind === "password") return true;
    return (credential.expiresAt === null || credential.expiresAt > Date.now())
      && !this.tokenRevocations.isRevoked(credential.tokenId);
  }

  private closeConnectionsForTokenIds(
    tokenIds: ReadonlySet<string>,
    deferConnectionId?: string,
  ): void {
    for (const [connectionId, connection] of this.connections) {
      const credential = connection.state?.credential;
      if (credential?.kind !== "token" || !tokenIds.has(credential.tokenId)) {
        continue;
      }
      if (
        connectionId === deferConnectionId
        || this.deferredCredentialClosures.has(connectionId)
      ) {
        this.deferredCredentialClosures.add(connectionId);
        continue;
      }
      connection.close(1008, "Authentication expired");
    }
  }

  private flushDeferredCredentialClosures(): void {
    for (const connectionId of this.deferredCredentialClosures) {
      this.deferredCredentialClosures.delete(connectionId);
      this.connections.get(connectionId)?.close(1008, "Authentication expired");
    }
  }

  private flushTokenRevocationOutbox(): Promise<void> {
    if (this.instanceKind !== "master") {
      return Promise.resolve();
    }
    if (this.tokenRevocationFlush) {
      return this.tokenRevocationFlush;
    }
    const operation = this.deliverTokenRevocationOutbox().finally(() => {
      if (this.tokenRevocationFlush === operation) {
        this.tokenRevocationFlush = null;
      }
    });
    this.tokenRevocationFlush = operation;
    return operation;
  }

  private async deliverTokenRevocationOutbox(): Promise<void> {
    for (const record of this.tokenRevocations.listDue()) {
      try {
        await this.deliverTokenRevocation(record);
        this.tokenRevocations.acknowledge(record.tokenId, record.uid);
      } catch (error) {
        this.tokenRevocations.recordFailure(record.tokenId, error);
      }
    }

    const nextAttemptAt = this.tokenRevocations.nextAttemptAt();
    if (nextAttemptAt !== null) {
      await this.schedule(
        new Date(Math.max(Date.now() + 1_000, nextAttemptAt)),
        "onTokenRevocationOutboxDue",
      );
    }
  }

  private async deliverTokenRevocation(record: TokenRevocationOutboxRecord): Promise<void> {
    const placement = this.userKernels.getByUid(record.uid);
    if (!placement) {
      this.persistAndFenceTokenRevocations([record]);
      return;
    }
    if (!this.isActiveUserKernelPlacement(placement)) {
      // A non-active target cannot accept credentials or runtime notices.
      return;
    }

    const target = await getAgentByName(
      this.env.KERNEL,
      userKernelName(placement.username),
    ) as unknown as {
      receiveMasterTokenRevocation: (
        input: MasterTokenRevocationDeliveryInput,
      ) => Promise<boolean>;
    };
    const accepted = await target.receiveMasterTokenRevocation({
      sourceKernelName: this.name,
      username: placement.username,
      uid: placement.uid,
      notice: {
        tokenId: record.tokenId,
        uid: record.uid,
        revokedAt: record.revokedAt,
      },
    });
    if (!accepted) {
      throw new Error("User Kernel rejected token revocation delivery");
    }
  }

  private tokenRevocationsFromResponse(
    frame: RequestFrame,
    response: ResponseFrame,
  ): TokenRevocationNotice[] {
    if (!response.ok || frame.call !== "sys.token.revoke") {
      return [];
    }
    const result = response.data as { revoked?: unknown } | undefined;
    const args = frame.args as { tokenId?: unknown };
    if (result?.revoked !== true || typeof args.tokenId !== "string") {
      return [];
    }
    const token = this.auth.getToken(args.tokenId.trim());
    if (!token || token.revokedAt === null) {
      return [];
    }
    return [{
      tokenId: token.tokenId,
      uid: token.uid,
      revokedAt: token.revokedAt,
    }];
  }

  private applyDirectTokenRevocationEffects(
    frame: RequestFrame,
    response: ResponseFrame,
    deferConnectionId?: string,
  ): void {
    if (this.instanceKind !== "master") return;
    const notices = this.tokenRevocationsFromResponse(frame, response);
    if (notices.length === 0) return;

    const locallyOwned = notices.filter((notice) => !this.userKernels.getByUid(notice.uid));
    this.persistAndFenceTokenRevocations(locallyOwned, deferConnectionId);
    for (const notice of locallyOwned) {
      this.tokenRevocations.acknowledge(notice.tokenId, notice.uid);
    }
    if (locallyOwned.length !== notices.length) {
      this.ctx.waitUntil(this.schedule(
        1,
        "onTokenRevocationOutboxDue",
      ).then(() => undefined));
    }
  }

  private async mutateRepoMetadataFromContext(
    mutation: RepoMetadataMutation,
    context: KernelContext,
  ): Promise<RepoMetadataMutationResult> {
    if (!context.identity) {
      throw new Error("Authenticated identity required");
    }
    const callerOwnerUid = resolveCallerOwnerUid(context);
    if (this.instanceKind === "master") {
      return await this.applyAuthorizedRepoMetadataMutation(
        mutation,
        context.identity,
        callerOwnerUid,
      );
    }

    const marker = await this.requireActiveUserKernel();
    if (!marker || !this.instanceUsername || marker.username !== this.instanceUsername) {
      throw new Error("Repository metadata authentication failed");
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const result = await master.mutateUserRepoMetadata({
      sourceKernelName: this.name,
      callerOwnerUid,
      identity: context.identity,
      mutation,
    });
    context.assertCurrentKernel();
    return result;
  }

  private async authorizeRepoOperationFromContext(
    call: AuthoritativeRepoOperationCall,
    normalizedRepo: string | undefined,
    requestedOwner: string | undefined,
    context: KernelContext,
  ): Promise<RepoListResult | undefined> {
    if (
      this.instanceKind !== "user"
      || !this.instanceUsername
      || !context.identity
      || !isAuthoritativeRepoOperationCall(call)
      || (call === "repo.list"
        ? normalizedRepo !== undefined
        : typeof normalizedRepo !== "string" || requestedOwner !== undefined)
    ) {
      throw new Error("Authoritative repository operation requires a user Kernel identity");
    }
    const marker = await this.requireActiveUserKernel();
    if (!marker || marker.username !== this.instanceUsername) {
      throw new Error("Repository operation authentication failed");
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const authorization = await master.authorizeUserRepoOperation({
      sourceKernelName: this.name,
      callerOwnerUid: resolveCallerOwnerUid(context),
      identity: context.identity,
      call,
      ...(normalizedRepo !== undefined ? { repo: normalizedRepo } : {}),
      ...(requestedOwner !== undefined ? { requestedOwner } : {}),
    });
    context.assertCurrentKernel();
    if (!this.isCurrentUserKernelMarker(marker)) {
      throw new Error("Repository operation authentication failed");
    }
    if (!authorization.ok) {
      throw new Error(authorization.error.message);
    }
    if (call === "repo.list" && !authorization.repoList) {
      throw new Error("Authoritative repository list is unavailable");
    }
    return authorization.repoList;
  }

  private resolveMasterSyscallIdentity(
    input: MasterSyscallInput | UserRepoOperationAuthorizationInput,
    ownerUid: number,
  ): ConnectionIdentity | null {
    const claimed = input.identity.process;
    const account = this.auth.getPasswdByUid(claimed.uid);
    if (!account || account.username !== claimed.username) {
      return null;
    }
    const gids = this.auth.resolveGids(account.username, account.gid);
    const authoritative: ProcessIdentity = {
      uid: account.uid,
      gid: account.gid,
      gids,
      username: account.username,
      home: account.home,
      cwd: claimed.cwd,
    };
    if (!processIdentityEquals(authoritative, claimed, { includeCwd: true })) {
      return null;
    }
    if (
      account.uid !== ownerUid
      && !canOwnerRunAsAccount(this.auth, ownerUid, account, ownerUid === 0)
    ) {
      return null;
    }

    if (input.identity.role === "driver") {
      return { ...input.identity, process: authoritative, capabilities: [] };
    }
    if (input.identity.role === "service") {
      return {
        ...input.identity,
        process: authoritative,
        capabilities: this.caps.resolve([102]),
      };
    }
    return {
      role: "user",
      process: authoritative,
      capabilities: this.caps.resolve(gids),
    };
  }

  createMcpOAuthProvider(
    callbackUrl: string,
    clientMetadataUrl?: string,
  ): AgentMcpOAuthProvider {
    const callbackRoute = matchUserMcpOAuthCallbackPath(new URL(callbackUrl).pathname);
    if (
      this.instanceKind === "user"
      && (
        !callbackRoute
        || callbackRoute.username !== this.instanceUsername
      )
    ) {
      throw new Error("User Kernel MCP callback route is invalid");
    }
    const provider = (
      callbackRoute
        ? new UserKernelMcpOAuthProvider(
            this.ctx.storage,
            this.name,
            callbackUrl,
            callbackRoute.username,
            () => {
              const marker = this.userKernelMarker;
              return Boolean(
                marker
                && marker.lifecycle === "active"
                && marker.username === callbackRoute.username
              );
            },
          )
        : new BoundedMcpOAuthProvider(this.ctx.storage, this.name, callbackUrl)
    ) as AgentMcpOAuthProvider & { clientMetadataUrl?: string };
    const metadataUrl = clientMetadataUrl
      ?? `${new URL(callbackUrl).origin}/.well-known/oauth-client/gsv.json`;
    if (metadataUrl.startsWith("https://")) {
      provider.clientMetadataUrl = metadataUrl;
    }
    return provider;
  }

  private async handleAuthorizedMcpOAuthCallback(
    request: Request,
  ): Promise<Response | null> {
    if (!this.mcp.isCallbackRequest(request)) return null;

    const state = new URL(request.url).searchParams.get("state");
    const stateParts = state && state.length <= 1024 ? state.split(".") : [];
    const serverId = stateParts.length === 2 ? stateParts[1] : "";
    const server = serverId ? this.mcpServers.get(serverId) : null;
    if (!server) {
      return oauthCallbackHtmlResponse({
        ok: false,
        message: "MCP OAuth session is no longer active",
      }, 409);
    }

    const marker = await this.loadUserKernelMarker();
    if (
      this.instanceKind !== "user"
      || !marker
      || marker.lifecycle !== "active"
      || marker.uid !== server.uid
    ) {
      return oauthCallbackHtmlResponse({
        ok: false,
        message: "MCP OAuth session is no longer active",
      }, 409);
    }

    const authProvider = this.mcp.mcpConnections[serverId]
      ?.options.transport.authProvider;
    try {
      const result = await this.mcp.handleCallbackRequest(request);
      if (result.authSuccess) {
        try {
          await this.mcp.establishConnection(result.serverId);
        } catch (error) {
          console.warn("[Kernel] MCP connection establishment failed after OAuth:", error);
        }
      }
      this.broadcastMcpChanged();
      return oauthCallbackHtmlResponse(
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
        result.authSuccess ? 200 : 400,
      );
    } catch {
      return oauthCallbackHtmlResponse({
        ok: false,
        message: "MCP OAuth session is no longer active",
      }, 409);
    } finally {
      if (authProvider instanceof BoundedMcpOAuthProvider) {
        authProvider.setCallbackOperationSignal(undefined);
      }
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/oauth/callback" || request.method !== "GET") {
      return new Response("Not Found", { status: 404 });
    }

    const callbackMarker = await this.loadUserKernelMarker();
    const routedState = parseRoutedOAuthState(url.searchParams.get("state"));
    if (
      this.instanceKind !== "user"
      || !callbackMarker
      || callbackMarker.lifecycle !== "active"
      || !routedState
      || routedState.username !== callbackMarker.username
    ) {
      return new Response("Not Found", { status: 404 });
    }

    const acquireOAuthOperation = (flow: import("./oauth-store").OAuthFlowRecord) => (
      flow.kernelOwnerUid === callbackMarker.uid
        ? { release: () => {} }
        : null
    );
    const result = await completeOAuthCallbackFlow({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
    }, this.oauth, fetch, () => this.isCurrentUserKernelMarker(callbackMarker), acquireOAuthOperation);
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
    const marker = this.instanceKind === "user" ? await this.loadUserKernelMarker() : null;
    const callbackPath = marker?.lifecycle === "active"
      ? buildUserMcpOAuthCallbackPath(marker.username)
      : "/oauth/callback";
    const callbackUrl = callbackHost
      ? `${callbackHost.replace(/\/$/, "")}${callbackPath}`
      : undefined;
    let clientMetadataUrl: string | undefined;
    if (callbackHost && marker?.lifecycle === "active") {
      const metadataUrl = new URL("/.well-known/oauth-client/gsv.json", callbackHost);
      metadataUrl.searchParams.set("username", marker.username);
      clientMetadataUrl = metadataUrl.toString();
    }
    const authProvider = callbackUrl
      ? this.createMcpOAuthProvider(callbackUrl, clientMetadataUrl)
      : undefined;
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

  async onConnect(
    connection: Connection<ConnectionState>,
    ctx: ConnectionContext,
  ): Promise<void> {
    const loginSourceScope = this.instanceKind === "master"
      ? await deriveLoginSourceScope(
          this.config,
          ctx.request.headers.get("CF-Connecting-IP"),
        )
      : normalizeLoginSourceScope(
          ctx.request.headers.get(USER_KERNEL_LOGIN_SOURCE_HEADER),
        );
    const state: ConnectionState = {
      step: "pending",
      loginSourceScope,
    };
    connection.setState(state);
  }

  onClose(connection: Connection): void {
    this.closeFrameBodyChannel(connection.id);
    const state = connection.state as ConnectionState | undefined;
    if (!state) return;
    if (state.credentialExpiryScheduleId) {
      this.cancelSchedule(state.credentialExpiryScheduleId).catch(() => {});
    }

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
    if (
      connection.state?.step === "connected"
      && !this.isConnectionCredentialActive(connection.state)
    ) {
      connection.close(1008, "Authentication expired");
      return;
    }
    if (
      this.instanceKind === "master"
      && connection.state?.step === "connected"
    ) {
      connection.close(1008, "Username-scoped connection required");
      return;
    }
    if (this.instanceKind === "user") {
      try {
        await this.requireActiveUserKernel();
      } catch {
        connection.close(1008, "Authentication failed");
        return;
      }
    }
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
    const registered = this.procs.get(processId);
    if (this.instanceKind !== "user") {
      if (frame.type === "req") {
        await cancelUnlockedBody(frame.body, "Process request rejected");
        return errFrame(frame.id, 404, "Unknown process");
      }
      return null;
    }
    if (!registered) {
      if (frame.type === "req") {
        await cancelUnlockedBody(frame.body, "Process request rejected");
        return errFrame(frame.id, 404, "Unknown process");
      }
      return null;
    }
    try {
      await this.requireActiveUserKernel();
    } catch (error) {
      if (frame.type === "req") {
        await cancelUnlockedBody(frame.body, "Process request rejected");
        return errFrame(frame.id, 503, errorMessage(error));
      }
      return null;
    }

    const requiredCall = frame.type === "req" && !isInternalOnlySyscall(frame.call)
      ? frame.call
      : undefined;
    if (!await this.authorizeRegisteredProcessRuntime(processId, requiredCall)) {
      if (frame.type === "req") {
        await cancelUnlockedBody(frame.body, "Process package authority revoked");
        return errFrame(frame.id, 403, "Process package-agent authority was revoked");
      }
      return null;
    }
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
      if (frame.signal === "proc.run.finished") {
        await delivered;
      }
    }
    return null;
  }

  /**
   * Internal Process-DO handshake for upgrading executors that predate the
   * persisted human owner identity. The registry binds the pid to its run-as
   * identity and owner uid; AuthStore is authoritative for both accounts.
   */
  async consumeProcessRollbackAuthorization(
    input: ProcessRollbackAuthorizationInput,
  ): Promise<boolean> {
    const authorization = typeof input?.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.processRollbackAuthorizations.get(authorization);
    this.processRollbackAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || typeof input.processId !== "string"
      || input.processId !== pending.processId
    ) {
      return false;
    }
    const marker = await this.loadUserKernelMarker();
    return Boolean(
      this.instanceKind === "user"
      && marker
      && (marker.lifecycle === "provisioning" || marker.lifecycle === "active")
    );
  }

  async resolveProcessAuthority(
    processId: string,
    claimedIdentity: unknown,
  ): Promise<ProcessAuthorityResult> {
    try {
      await this.requireActiveUserKernel();
    } catch {
      return { ok: false, error: "user Kernel is not active" };
    }
    const authority = await this.resolveProcessRegistryAuthority(processId, claimedIdentity);
    if (!authority.ok) return authority;
    const current = this.procs.get(processId)!;
    if (!await this.authorizeCurrentPackageAgentRuntime(
      current.ownerUid,
      authority.authority.identity,
      current.packageSecurityRevision,
      undefined,
      processId,
    )) {
      return { ok: false, error: "process package-agent authority was revoked" };
    }
    return authority;
  }

  /** Registry authority used exclusively to exact-ack proc.kill. */
  async resolveProcessTeardownAuthority(
    processId: string,
    claimedIdentity: unknown,
  ): Promise<ProcessAuthorityResult> {
    const marker = await this.loadUserKernelMarker();
    if (
      this.instanceKind !== "user"
      || !marker
      || (marker.lifecycle !== "active" && marker.lifecycle !== "provisioning")
    ) {
      return { ok: false, error: "user Kernel teardown authority is unavailable" };
    }
    return this.resolveProcessRegistryAuthority(processId, claimedIdentity);
  }

  private async resolveProcessRegistryAuthority(
    processId: string,
    claimedIdentity: unknown,
  ): Promise<ProcessAuthorityResult> {
    if (typeof processId !== "string" || processId.length === 0) {
      return { ok: false, error: "invalid process id" };
    }
    if (!isProcessIdentity(claimedIdentity)) {
      return { ok: false, error: "invalid process identity claim" };
    }
    const record = this.procs.get(processId);
    if (!record) {
      return { ok: false, error: "process registry record not found" };
    }
    const registryIdentity: ProcessIdentity = {
      uid: record.uid,
      gid: record.gid,
      gids: record.gids,
      username: record.username,
      home: record.home,
      cwd: record.cwd,
    };
    if (!processIdentityEquals(registryIdentity, claimedIdentity, { includeCwd: true })) {
      return { ok: false, error: "process identity does not match registry" };
    }
    const marker = await this.loadUserKernelMarker();
    if (
      this.instanceKind !== "user"
      || !marker
      || (marker.lifecycle !== "active" && marker.lifecycle !== "provisioning")
      || marker.uid !== record.ownerUid
    ) {
      return { ok: false, error: "user Kernel process authority is unavailable" };
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const resolved = await master.resolveProcessIdentity({
      sourceKernelName: this.name,
      uid: marker.uid,
      ownerUid: record.ownerUid,
      runAs: registryIdentity,
    });
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      authority: {
        processId,
        identity: resolved.runAs,
        ownerIdentity: resolved.owner,
      },
    };
  }

  async requestProcessNetFetch(
    processId: string,
    target: string,
    args: NetFetchArgs,
    options: ProcessNetFetchOptions = {},
  ): Promise<ResponseOkFrame<"net.fetch">> {
    const registered = this.procs.get(processId);
    if (this.instanceKind !== "user" || !registered) {
      throw new Error("Unknown process");
    }
    let controller: AbortController | null = null;
    const origin: RouteOrigin = { type: "process", id: processId };
    try {
      await this.requireActiveUserKernel();
      const requiredCall = options.internalPurpose === "model-transport"
        ? undefined
        : "net.fetch";
      if (!await this.authorizeRegisteredProcessRuntime(processId, requiredCall)) {
        throw new Error("Process package-agent authority was revoked");
      }
      const ctx = await this.buildProcessContext(processId);
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
      try {
        await this.requireActiveUserKernel();
        if (!await this.authorizeRegisteredProcessRuntime(processId, requiredCall)) {
          throw new Error("Process package-agent authority was revoked");
        }
      } catch (error) {
        await cancelUnlockedBody(response.body, "Process net.fetch result rejected");
        throw error;
      }
      return response as ResponseOkFrame<"net.fetch">;
    } finally {
      if (options.requestId && controller) {
        this.finishActiveRequest(options.requestId, controller);
      }
      await cancelUnlockedBody(options.body, "Process net.fetch completed");
    }
  }

  async cancelProcessRequests(
    processId: string,
    requestIds: string[],
    reason?: string,
  ): Promise<number> {
    if (!processId || !Array.isArray(requestIds)) {
      return 0;
    }
    try {
      await this.requireActiveUserKernel();
    } catch {
      return 0;
    }
    if (!this.procs.get(processId)) {
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
    if (this.instanceKind === "user") {
      if (frame.type === "req") {
        await cancelUnlockedBody(frame.body, "User Kernel service request rejected");
        return errFrame(frame.id, 401, "Authentication failed");
      }
      return null;
    }
    if (frame.type !== "req") {
      return null;
    }

    try {
      if (frame.call !== "adapter.state.update") {
        return errFrame(frame.id, 400, `${frame.call} requires a scoped ingress RPC`);
      }
      return await this.handleServiceReq(frame);
    } finally {
      await cancelUnlockedBody(frame.body, "Service request completed");
    }
  }

  /** Resolve live adapter ownership once, then forward the original payload. */
  async receiveAdapterInbound(
    frame: RequestFrame<"adapter.inbound">,
  ): Promise<ResponseFrame> {
    this.assertMasterKernel();
    const routed = adapterInboundRouteMetadata(frame);
    try {
      if (!routed || frame.body) {
        return errFrame(typeof frame?.id === "string" ? frame.id : "", 400, "Invalid adapter request");
      }

      const link = this.adapters.identityLinks.get(
        routed.adapter,
        routed.accountId,
        routed.actorId,
      );
      if (!link) {
        if (routed.surfaceKind !== "dm") {
          return {
            type: "res",
            id: frame.id,
            ok: true,
            data: { ok: true, droppedReason: "unlinked_actor" },
          };
        }
        const challenge = this.adapters.linkChallenges.issue({
          adapter: routed.adapter,
          accountId: routed.accountId,
          actorId: routed.actorId,
          surfaceKind: routed.surfaceKind,
          surfaceId: routed.surfaceId,
        });
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            challenge: {
              code: challenge.code,
              prompt: `UNKNOWN USER. Who are you? 🧐.\n\nIdentify yourself in your GSV by using this access code: ${challenge.code}`,
              expiresAt: challenge.expiresAt,
            },
          },
        };
      }
      if (!this.adapters.identityLinks.isCurrentGeneration(
        routed.adapter,
        routed.accountId,
        routed.actorId,
        link.generation,
      )) {
        return errFrame(frame.id, 401, "Authentication failed");
      }

      let placement = this.userKernels.getByUid(link.uid);
      if (
        placement
        && (
          placement.lifecycle === "provisioning"
          || !this.isUserKernelActivationConfirmed(placement)
        )
      ) {
        try {
          placement = await this.ensureUserKernelProvisioned(placement.username);
        } catch {
          return errFrame(frame.id, 503, "Adapter owner is unavailable");
        }
      }
      if (!this.isActiveUserKernelPlacement(placement)) {
        return errFrame(frame.id, 503, "Adapter owner is unavailable");
      }
      const currentLink = this.adapters.identityLinks.get(
        routed.adapter,
        routed.accountId,
        routed.actorId,
      );
      const currentPlacement = this.userKernels.get(placement.username);
      if (
        !currentLink
        || currentLink.uid !== link.uid
        || currentLink.generation !== link.generation
        || !this.isActiveUserKernelPlacement(currentPlacement)
        || currentPlacement.uid !== placement.uid
      ) {
        return errFrame(frame.id, 401, "Authentication failed");
      }
      const target = await getAgentByName(
        this.env.KERNEL,
        userKernelName(placement.username),
      ) as unknown as {
        serviceAdapterFrame(input: AdapterInboundDeliveryInput): Promise<ResponseFrame>;
      };
      return await target.serviceAdapterFrame({
        sourceKernelName: SHIP_KERNEL_NAME,
        ownerUid: placement.uid,
        linkGeneration: link.generation,
        frame,
      });
    } finally {
      await cancelUnlockedBody(frame?.body, "Adapter ingress completed");
    }
  }

  async serviceAdapterFrame(input: AdapterInboundDeliveryInput): Promise<ResponseFrame> {
    const frame = input?.frame;
    try {
      const marker = await this.requireActiveUserKernel();
      const routed = adapterInboundRouteMetadata(frame);
      if (
        this.instanceKind !== "user"
        || input.sourceKernelName !== SHIP_KERNEL_NAME
        || !marker
        || marker.uid !== input.ownerUid
        || !Number.isSafeInteger(input.linkGeneration)
        || input.linkGeneration <= 0
        || !routed
        || frame.body
      ) {
        return errFrame(typeof frame?.id === "string" ? frame.id : "", 401, "Authentication failed");
      }
      return await this.handleServiceReq(frame, {
        routedAdapterOwnerUid: marker.uid,
        routedAdapterLinkGeneration: input.linkGeneration,
      });
    } catch {
      return errFrame(typeof frame?.id === "string" ? frame.id : "", 401, "Authentication failed");
    } finally {
      await cancelUnlockedBody(frame?.body, "Adapter request completed");
    }
  }

  async appRequest(
    appFrame: AppFrameContext,
    frame: RequestFrame,
    _runnerName?: string,
  ): Promise<ResponseFrame> {
    try {
      await this.requireActiveUserKernel();
    } catch (error) {
      await cancelUnlockedBody(frame.body, "Package app request rejected");
      return errFrame(frame.id, 503, errorMessage(error));
    }
    try {
      return await this.handleAppRequest(appFrame, frame);
    } finally {
      await cancelUnlockedBody(frame.body, "App request completed");
    }
  }

  async appDaemonRequest(
    appFrame: AppFrameContext,
    frame: RequestFrame,
    _runnerName?: string,
  ): Promise<ResponseFrame> {
    try {
      await this.requireActiveUserKernel();
    } catch (error) {
      await cancelUnlockedBody(frame.body, "Package daemon request rejected");
      return errFrame(frame.id, 503, errorMessage(error));
    }
    try {
      return await this.handleAppRequest(appFrame, frame, true);
    } finally {
      await cancelUnlockedBody(frame.body, "App daemon request completed");
    }
  }

  async authorizeAppFrame(
    appFrame: AppFrameContext,
    _runnerName?: string,
  ): Promise<boolean> {
    try {
      return (await this.authorizeLocalAppFrame(appFrame)) !== null;
    } catch {
      return false;
    }
  }

  async authorizeAppDaemonFrame(
    appFrame: AppFrameContext,
    _runnerName?: string,
  ): Promise<boolean> {
    try {
      return (await this.authorizeLocalAppDaemonFrame(appFrame)) !== null;
    } catch {
      return false;
    }
  }

  async refreshPreservedAppRuntime(
    runtime: PreservedAppRuntimeDescriptor,
  ): Promise<PreservedAppRuntimeRefreshResult> {
    if (!isPreservedAppRuntimeDescriptor(runtime)) {
      return { ok: false };
    }
    const marker = await this.requireActiveUserKernel();
    if (
      this.instanceKind !== "user"
      || userKernelUsername(this.name) !== marker.username
    ) {
      return { ok: false };
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const authority = await master.authorizePreservedAppRuntime({
      sourceKernelName: this.name,
      uid: marker.uid,
      ownerUid: marker.uid,
      runtime,
    });
    if (
      !authority.ok
      || authority.identity.uid !== runtime.uid
      || authority.identity.username !== runtime.username
      || authority.packageId !== runtime.packageId
      || authority.packageName !== runtime.packageName
      || authority.entrypointName !== runtime.entrypointName
      || authority.routeBase !== runtime.routeBase
      || authority.artifact.hash.length === 0
    ) {
      return { ok: false };
    }

    const currentMarker = await this.requireActiveUserKernel();
    if (
      currentMarker.uid !== marker.uid
      || currentMarker.username !== marker.username
    ) {
      throw new Error("User Kernel placement changed during runtime refresh");
    }
    const now = Date.now();
    const appFrame: AppFrameContext = {
      uid: authority.identity.uid,
      username: authority.identity.username,
      packageId: authority.packageId,
      packageName: authority.packageName,
      packageUpdatedAt: authority.packageUpdatedAt,
      packageArtifactHash: authority.artifact.hash,
      entrypointName: authority.entrypointName,
      routeBase: authority.routeBase,
      issuedAt: now,
      expiresAt: now + DEFAULT_APP_FRAME_TTL_MS,
    };
    const props: AppRunnerProps = {
      kernelName: this.name,
      packageId: authority.packageId,
      packageName: authority.packageName,
      routeBase: authority.routeBase,
      entrypointName: authority.entrypointName,
      artifact: authority.artifact,
      appFrame,
    };
    return { ok: true, props };
  }

  private async authorizeLocalAppFrame(
    appFrame: AppFrameContext,
    requiredCall?: string,
  ): Promise<ConnectionIdentity | null> {
    if (this.instanceKind !== "user" || isAppFrameContextExpired(appFrame)) {
      return null;
    }
    const marker = await this.requireActiveUserKernel();
    if (!marker) return null;
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const authorization = await master.validateAppFrame({
      sourceKernelName: this.name,
      uid: marker.uid,
      appFrame,
      ...(requiredCall === undefined ? {} : { requiredCall }),
    });
    if (
      !authorization.ok
      || (authorization.entrypointKind === "ui" && !this.isActiveLocalAppClient(appFrame))
    ) {
      return null;
    }
    await this.requireActiveUserKernel();
    return authorization.identity;
  }

  private async authorizeLocalAppDaemonFrame(
    appFrame: AppFrameContext,
    requiredCall?: string,
  ): Promise<ConnectionIdentity | null> {
    if (this.instanceKind !== "user" || isAppFrameContextExpired(appFrame)) {
      return null;
    }
    const marker = await this.requireActiveUserKernel();
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const authorization = await master.validateAppDaemonFrame({
      sourceKernelName: this.name,
      uid: marker.uid,
      appFrame,
      ...(requiredCall === undefined ? {} : { requiredCall }),
    });
    if (!authorization.ok) {
      return null;
    }
    await this.requireActiveUserKernel();
    return authorization.identity;
  }

  /**
   * Preflight the routed locator's HMAC and this object's active marker. This
   * selects where a bounded launch body may be read; the full, exact local
   * session id and secret are still authorized by
   * resolvePackageAppRpcSession or refreshPackageAppRpcSession.
   */
  async authorizeAppSessionRoute(sessionId: unknown): Promise<boolean> {
    if (this.instanceKind !== "user" || typeof sessionId !== "string") {
      return false;
    }
    const routed = parseRoutedAppSessionId(sessionId);
    if (!routed) {
      return false;
    }

    try {
      return await this.acceptsLocalAppSessionRoute(sessionId);
    } catch {
      return false;
    }
  }

  private async handleAppRequest(
    appFrame: AppFrameContext,
    frame: RequestFrame,
    daemon = false,
  ): Promise<ResponseFrame> {
    if (isAppFrameContextExpired(appFrame)) {
      return errFrame(frame.id, 401, "App frame expired");
    }

    if (isInternalOnlySyscall(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }
    const authorize = daemon
      ? this.authorizeLocalAppDaemonFrame.bind(this)
      : this.authorizeLocalAppFrame.bind(this);
    const identity = await authorize(appFrame, frame.call);
    if (!identity) {
      return errFrame(frame.id, 401, "Authentication failed");
    }

    const origin: RouteOrigin = { type: "app", id: frame.id };
    let controller: AbortController;
    try {
      controller = this.registerActiveRequest(origin, frame.id);
    } catch (error) {
      return errFrame(frame.id, 409, error instanceof Error ? error.message : String(error));
    }
    const requestSignal = controller.signal;
    frame = this.bindRequestBodyCancellation(frame, requestSignal);
    const ctx = this.buildKernelContext({
      identity,
      appFrame,
      requestSignal,
    });
    const pending = this.createPendingAppResponse(frame.id);
    try {
      const result = await this.dispatchKernelFrame(frame, origin, ctx);
      if (requestSignal.aborted) {
        return errFrame(frame.id, 503, "User Kernel is not active");
      }
      await this.requireActiveUserKernel();
      if (!(await authorize(appFrame, frame.call))) {
        await cancelUnlockedBody(
          result.handled && result.response.ok ? result.response.body : undefined,
          "Package app authority revoked",
        );
        return errFrame(frame.id, 401, "Authentication failed");
      }
      if (!result.handled) {
        return await raceWithAbort(pending.promise, requestSignal, {
          abortReason: () => requestAbortError(requestSignal.reason),
          onAbort: () => {
            this.cancelRequest(
              origin,
              frame.id,
              requestAbortError(requestSignal.reason).message,
              false,
            );
          },
        });
      }

      this.applyDirectTokenRevocationEffects(frame, result.response);
      return result.response;
    } finally {
      pending.cleanup();
      this.finishActiveRequest(frame.id, controller);
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

    if (this.instanceKind !== "user" || !parseRoutedAppSessionId(sessionId)) {
      return { ok: false, status: 401, message: "Authentication failed" };
    }

    try {
      await this.requireActiveUserKernel();
      if (!(await this.acceptsLocalAppSessionRoute(sessionId))) {
        return { ok: false, status: 401, message: "Authentication failed" };
      }

      const clientSession = mode === "refresh"
        ? await this.appSessions.refresh(
            sessionId,
            secret,
            APP_CLIENT_SESSION_TTL_MS,
          )
        : await this.appSessions.resolve(
            sessionId,
            secret,
          );
      if (!clientSession) {
        return { ok: false, status: 401, message: "Authentication failed" };
      }
      if (packageName && clientSession.packageName !== packageName) {
        return { ok: false, status: 404, message: "Package app session not found" };
      }

      const resolved = await this.resolvePackageAppSessionContext(clientSession);
      return resolved;
    } catch {
      return { ok: false, status: 401, message: "Authentication failed" };
    }
  }

  private async resolvePackageAppSessionContext(
    clientSession: AppClientSessionContext,
  ): Promise<ResolvePackageAppRpcResult> {
    const marker = await this.requireActiveUserKernel();
    if (!marker || !(await this.acceptsLocalAppSessionRoute(clientSession.sessionId))) {
      return { ok: false, status: 401, message: "Authentication failed" };
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const { packages } = await master.masterPackagesList({
      sourceKernelName: this.name,
      requesterUid: clientSession.uid,
      enabled: true,
    });
    const record = visiblePackageScopesForActor({ uid: clientSession.uid })
      .map((scope) => packages.find((candidate) => (
        candidate.packageId === clientSession.packageId
        && packageScopeKey(candidate.scope) === packageScopeKey(scope)
      )))
      .find((candidate): candidate is InstalledPackageRecord => candidate !== undefined)
      ?? null;
    if (
      !record
      || !record.enabled
      || (record.reviewRequired && !record.reviewedAt)
      || record.manifest.name !== clientSession.packageName
    ) {
      return { ok: false, status: 404, message: "Package app not found" };
    }
    const entrypoint = findAppFrameEntrypoint(
      record.manifest.entrypoints,
      clientSession.entrypointName,
      clientSession.routeBase,
    );
    if (!entrypoint || entrypoint.kind !== "ui") {
      return { ok: false, status: 404, message: "Package app entrypoint not found" };
    }

    const appFrame: AppFrameContext = {
      uid: clientSession.uid,
      username: clientSession.username,
      sessionId: clientSession.sessionId,
      clientId: clientSession.clientId,
      packageId: record.packageId,
      packageName: record.manifest.name,
      packageUpdatedAt: record.updatedAt,
      packageArtifactHash: record.artifact.hash,
      entrypointName: clientSession.entrypointName,
      routeBase: clientSession.routeBase,
      issuedAt: clientSession.createdAt,
      expiresAt: clientSession.expiresAt,
    };
    const identity = await this.authorizeLocalAppFrame(appFrame);
    if (!identity) {
      return { ok: false, status: 404, message: "Package app not found" };
    }

    return {
      ok: true,
      packageId: record.packageId,
      packageName: record.manifest.name,
      routeBase: clientSession.routeBase,
      artifact: record.artifact,
      appFrame,
      clientSession,
      auth: {
        uid: clientSession.uid,
        username: clientSession.username,
        capabilities: identity.capabilities,
      },
      hasRpc: record.manifest.entrypoints.some((candidateEntrypoint) => candidateEntrypoint.kind === "rpc"),
    };
  }

  private async acceptsLocalAppSessionRoute(sessionId: string): Promise<boolean> {
    if (this.instanceKind !== "user") return false;
    const marker = await this.loadUserKernelMarker();
    const routed = parseRoutedAppSessionId(sessionId);
    if (
      !marker
      || marker.lifecycle !== "active"
      || !routed
      || routed.expiresAt <= Date.now()
      || routed.username !== marker.username
      || routed.uid !== marker.uid
      || !this.appSessions.getActiveRoute(sessionId)
    ) {
      return false;
    }
    return this.verifyAppSessionRoute(routed.signingInput, routed.signature);
  }

  private isActiveLocalAppClient(appFrame: AppFrameContext): boolean {
    if (!appFrame.sessionId || !appFrame.clientId) {
      return false;
    }
    const session = this.appSessions.getActiveForUid(appFrame.uid, appFrame.sessionId);
    if (
      !session
      || session.username !== appFrame.username
      || session.packageId !== appFrame.packageId
      || session.packageName !== appFrame.packageName
      || session.entrypointName !== appFrame.entrypointName
      || session.routeBase !== appFrame.routeBase
    ) {
      return false;
    }
    return session.clients.some((client) => client.clientId === appFrame.clientId);
  }

  async authorizeGitHttp(input: AuthorizeGitHttpInput): Promise<AuthorizeGitHttpResult> {
    this.assertMasterKernel();
    const owner = normalizeGitRepoSegment(input.owner);
    const repo = normalizeGitRepoSegment(input.repo);
    const username = typeof input.username === "string" ? input.username : "";
    const credential = typeof input.credential === "string" ? input.credential : "";

    if (!owner || !repo) {
      return { ok: false, status: 401, message: "Authentication required" };
    }

    const isPublicRead = !input.write && isRepoPublic({ owner, repo }, this.config);
    const loginSourceScope = await deriveLoginSourceScope(
      this.config,
      input.trustedSourceAddress,
    );

    if (!username || !credential) {
      if (!isPublicRead) {
        return { ok: false, status: 401, message: "Authentication required" };
      }
    } else {
      const canonicalUsername = canonicalizeLoginUsername(username);
      const placement = canonicalUsername
        ? this.userKernels.get(canonicalUsername)
        : null;
      const placementAdmitsGit = Boolean(
        placement
        && placement.lifecycle === "active",
      );
      const release = canonicalUsername && placementAdmitsGit
        ? this.beginMasterUserOperation(canonicalUsername)
        : null;
      try {
        // Always execute the bounded credential verifier when credentials were
        // supplied. Suspended, retired, unknown, and transitioning identities
        // therefore retain the same generic authentication surface.
        const auth = await this.auth.authenticatePasswordOrToken(
          username,
          credential,
          loginSourceScope,
          { role: "user" },
        );

        const currentPlacement = canonicalUsername
          ? this.userKernels.get(canonicalUsername)
          : null;
        if (
          auth.ok
          && release
          && placement
          && canonicalUsername === auth.identity.username
          && placement.uid === auth.identity.uid
          && sameUserKernelPlacement(currentPlacement, placement)
          && placement.lifecycle === "active"
        ) {
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

          // This authorization result is the Git request's admission point.
          // A lifecycle transition closes new admission and drains verifiers;
          // a request admitted before that linearization may finish in ripgit.
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
      } finally {
        release?.();
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
    await this.requireActiveUserKernel();
    if (!await this.authorizeRegisteredProcessRuntime(processId)) {
      return;
    }
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

    if (route.uid !== ownerUid) {
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

    await this.deliverSignalToAdapter(route, frame);
    if (frame.signal === "proc.run.finished") {
      this.runRoutes.delete(runId);
    }
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

  private enqueueProcessSignal(
    processId: string,
    frame: SignalFrame,
  ): Promise<void> {
    const previous = this.pendingProcessSignals.get(processId) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      await this.requireActiveUserKernel();
      if (!this.procs.get(processId)) {
        throw new Error("Unknown process");
      }
      await this.handleProcessSignal(processId, frame);
      await this.requireActiveUserKernel();
    });
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
    await this.requireActiveUserKernel();
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

  private async deliverSignalToAdapter(route: AdapterRunRoute, frame: SignalFrame): Promise<void> {
    if (!(await this.isAdapterRunRouteCurrent(route))) {
      this.runRoutes.delete(route.runId);
      return;
    }
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

  private async isAdapterRunRouteCurrent(route: AdapterRunRoute): Promise<boolean> {
    if (
      !route.actorId
      || !Number.isSafeInteger(route.linkGeneration)
      || route.linkGeneration <= 0
    ) {
      return false;
    }
    if (this.instanceKind === "master") {
      return false;
    }

    const marker = await this.requireActiveUserKernel();
    if (!marker || marker.uid !== route.uid) {
      return false;
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    return master.authorizeAdapterRunRoute({
      sourceKernelName: this.name,
      ownerUid: marker.uid,
      adapter: route.adapter,
      accountId: route.accountId,
      actorId: route.actorId,
      linkGeneration: route.linkGeneration,
    });
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

  private async handleProcessReq(
    processId: string,
    frame: RequestFrame,
  ): Promise<ResponseFrame | null> {
    const ctx = await this.buildProcessContext(processId, frame.runId);
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
      const requestSignal = controller.signal;
      frame = this.bindRequestBodyCancellation(frame, requestSignal);
      result = await this.dispatchKernelFrame(
        frame,
        origin,
        { ...ctx, requestSignal },
      );
    } finally {
      this.finishActiveRequest(frame.id, controller);
    }

    try {
      await this.requireActiveUserKernel();
      if (!this.procs.get(processId)) return errFrame(frame.id, 404, "Unknown process");
      if (!await this.authorizeRegisteredProcessRuntime(
        processId,
        isInternalOnlySyscall(frame.call) ? undefined : frame.call,
      )) {
        await cancelUnlockedBody(
          result.handled && result.response.ok ? result.response.body : undefined,
          "Process package authority revoked",
        );
        return errFrame(frame.id, 403, "Process package-agent authority was revoked");
      }
    } catch {
      return errFrame(frame.id, 503, "User Kernel is not active");
    }

    if (result.handled) {
      this.applyDirectTokenRevocationEffects(frame, result.response);
      return result.response;
    }

    return null;
  }

  /** Resolve internal user-Kernel identity without capability-gating it as a syscall. */
  private async resolveUserKernelAccountIdentity(
    actorUid: number,
  ): Promise<AccountIdentityResolutionResult> {
    const marker = await this.loadUserKernelMarker();
    if (
      this.instanceKind !== "user"
      || !marker
      || (marker.lifecycle !== "active" && marker.lifecycle !== "provisioning")
    ) {
      return { ok: false, error: "user Kernel is not active" };
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    return master.resolveAccountIdentity({
      sourceKernelName: this.name,
      uid: marker.uid,
      ownerUid: marker.uid,
      actorUid,
    });
  }

  private async buildProcessContext(
    processId: string,
    processRunId?: string,
  ): Promise<KernelContext | null> {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      return null;
    }

    const connIdentity: ConnectionIdentity = {
      role: "user",
      process: identity,
      capabilities: this.instanceKind === "master"
        ? this.caps.resolve(identity.gids)
        : [],
    };
    if (this.instanceKind === "user") {
      const account = await this.resolveUserKernelAccountIdentity(identity.uid);
      if (!account.ok || !processIdentityEquals(account.identity, identity)) {
        throw new Error("Process identity is no longer authorized");
      }
      connIdentity.capabilities = account.capabilities;
    }

    return this.buildKernelContext({
      identity: connIdentity,
      processId,
      processRunId,
    });
  }

  private async handleServiceReq(
    frame: RequestFrame,
    options: {
      routedAdapterOwnerUid?: number;
      routedAdapterLinkGeneration?: number;
    } = {},
  ): Promise<ResponseFrame> {
    if (frame.call === "sys.connect" || frame.call === "sys.setup" || frame.call === "sys.setup.assist") {
      return errFrame(frame.id, 400, `${frame.call} is not supported via serviceFrame`);
    }

    if (isInternalOnlySyscall(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const identity = await this.buildServiceBindingIdentity(
      frame,
      options.routedAdapterOwnerUid,
    );
    if (!identity) {
      return errFrame(frame.id, 503, "Service identity is not configured");
    }
    if (!hasCapability(identity.capabilities, frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const origin: RouteOrigin = { type: "process", id: "__service_binding__" };
    let controller: AbortController;
    try {
      controller = this.registerActiveRequest(origin, frame.id);
    } catch (error) {
      return errFrame(frame.id, 409, error instanceof Error ? error.message : String(error));
    }
    const requestSignal = controller.signal;
    frame = this.bindRequestBodyCancellation(frame, requestSignal);
    const ctx = this.buildKernelContext({
      identity,
      routedAdapterOwnerUid: options.routedAdapterOwnerUid,
      routedAdapterLinkGeneration: options.routedAdapterLinkGeneration,
      serviceBinding: true,
      requestSignal,
    });
    let result;
    try {
      result = await this.dispatchKernelFrame(frame, origin, ctx);
    } finally {
      this.finishActiveRequest(frame.id, controller);
    }

    if (!result.handled) {
      return errFrame(frame.id, 501, `${frame.call} requires unsupported async routing`);
    }

    if (requestSignal.aborted) {
      return errFrame(frame.id, 503, "Kernel operation is no longer active");
    }
    if (this.instanceKind === "user") {
      await this.requireActiveUserKernel();
    } else if (frame.call !== "adapter.state.update") {
      return errFrame(frame.id, 403, "Master service operation is not allowed");
    }

    this.applyDirectTokenRevocationEffects(frame, result.response);
    return result.response;
  }

  private buildContext(
    connection: Connection<ConnectionState>,
  ): KernelContext {
    const state = connection.state;
    if (!state) throw new Error("Connection state is missing");
    return this.buildKernelContext({
      connection,
      loginSourceScope: state.loginSourceScope ?? UNAVAILABLE_LOGIN_SOURCE_SCOPE,
      identity: state.identity as ConnectionIdentity | undefined,
    });
  }

  private issueProcessRollbackAuthorization(
    processId: string,
  ): string {
    if (typeof processId !== "string" || processId.length === 0) {
      throw new Error("Invalid process rollback target");
    }
    pruneExpiredAuthorizations(this.processRollbackAuthorizations);
    const authorization = crypto.randomUUID();
    this.processRollbackAuthorizations.set(authorization, {
      expiresAt: Date.now() + PROCESS_ROLLBACK_AUTHORIZATION_TTL_MS,
      processId,
    });
    return authorization;
  }

  private revokeProcessRollbackAuthorization(authorization: string): void {
    this.processRollbackAuthorizations.delete(authorization);
  }

  private buildKernelContext(options: {
    connection?: Connection | null;
    loginSourceScope?: LoginSourceScope;
    identity?: ConnectionIdentity;
    processId?: string;
    processRunId?: string;
    requestSignal?: AbortSignal;
    callerOwnerUid?: number;
    appFrame?: AppFrameContext;
    routedAdapterOwnerUid?: number;
    routedAdapterLinkGeneration?: number;
    serviceBinding?: boolean;
    provisioningMarker?: UserKernelInstanceMarker;
  }): KernelContext {
    const boundKernelMarker = options.provisioningMarker
      ?? (this.userKernelMarker?.lifecycle === "active" ? this.userKernelMarker : null);
    const expectedKernelMarker = this.instanceKind === "master"
      ? null
      : boundKernelMarker;
    let kernelContext: KernelContext;
    const dispatchMasterRead = async <T>(call: SyscallName, args: unknown): Promise<T> => {
      const response = await this.requestDispatchedFrame({
        type: "req",
        id: crypto.randomUUID(),
        call,
        args,
      } as RequestFrame, kernelContext, options.requestSignal);
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      await cancelUnlockedBody(response.body, "Master read completed");
      return response.data as T;
    };
    kernelContext = {
      env: this.env,
      kernelName: this.name,
      kernelKind: this.instanceKind,
      ...(this.instanceUsername ? { kernelUsername: this.instanceUsername } : {}),
      ...(boundKernelMarker
        ? {
            kernelOwnerUid: boundKernelMarker.uid,
            ...(options.provisioningMarker ? { kernelProvisioning: true } : {}),
          }
        : {}),
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
      userKernels: this.userKernels,
      connection: options.connection ?? null,
      loginSourceScope: options.loginSourceScope ?? UNAVAILABLE_LOGIN_SOURCE_SCOPE,
      identity: options.identity,
      processId: options.processId,
      processRunId: options.processRunId,
      requestSignal: options.requestSignal,
      assertCurrentKernel: () => {
        if (options.provisioningMarker) {
          if (
            this.userKernelMarker !== options.provisioningMarker
            || !sameUserKernelInstanceMarker(
              this.userKernelMarker ?? null,
              options.provisioningMarker,
            )
          ) {
            throw new Error("User Kernel lifecycle changed during provisioning");
          }
          return;
        }
        if (!this.isCurrentUserKernelMarker(expectedKernelMarker)) {
          throw new Error("User Kernel is not active");
        }
      },
      callerOwnerUid: options.callerOwnerUid,
      routedAdapterOwnerUid: options.routedAdapterOwnerUid,
      routedAdapterLinkGeneration: options.routedAdapterLinkGeneration,
      serviceBinding: options.serviceBinding,
      appFrame: options.appFrame,
      serverVersion: SERVER_VERSION,
      transactionSync: this.ctx.storage.transactionSync.bind(this.ctx.storage),
      issueProcessRollbackAuthorization: (processId) => (
        this.issueProcessRollbackAuthorization(processId)
      ),
      revokeProcessRollbackAuthorization: (authorization) => {
        this.revokeProcessRollbackAuthorization(authorization);
      },
      ...(this.instanceKind === "user"
        ? {
            authenticateConnection: (args: ConnectArgs) => this.authenticateConnectionViaMaster(
              args,
              options.loginSourceScope ?? UNAVAILABLE_LOGIN_SOURCE_SCOPE,
            ),
          }
        : {}),
      accountGet: async (query) => {
        if (this.instanceKind === "master") {
          return handleAccountGet(query, kernelContext).account;
        }
        const result = await dispatchMasterRead<AccountGetResult>("account.get", query);
        return result.account;
      },
      resolveRunAsAccount: async (input) => {
        if (this.instanceKind === "master") {
          return this.resolveAuthoritativeRunAsAccount(
            input.ownerUid,
            input.callerUid,
            input.selector,
          );
        }
        const marker = await this.loadUserKernelMarker();
        if (
          !marker
          || (marker.lifecycle !== "active" && marker.lifecycle !== "provisioning")
          || marker.uid !== input.ownerUid
        ) {
          return { ok: false, error: "User Kernel run-as authority is unavailable" };
        }
        const master = await getAgentByName(
          this.env.KERNEL,
          SHIP_KERNEL_NAME,
        ) as unknown as MasterKernelControlStub;
        return master.resolveRunAsAccount({
          sourceKernelName: this.name,
          uid: marker.uid,
          ...input,
        });
      },
      listRunnableAccounts: async (input) => {
        if (this.instanceKind === "master") {
          return this.listAuthoritativeRunnableAccounts(input.ownerUid, input.callerUid);
        }
        const marker = await this.loadUserKernelMarker();
        if (
          !marker
          || marker.lifecycle !== "active"
          || marker.uid !== input.ownerUid
        ) {
          throw new Error("User Kernel runnable-account authority is unavailable");
        }
        const master = await getAgentByName(
          this.env.KERNEL,
          SHIP_KERNEL_NAME,
        ) as unknown as MasterKernelControlStub;
        return master.listRunnableAccounts({
          sourceKernelName: this.name,
          uid: marker.uid,
          ...input,
        });
      },
      readAuthFile: async (kind) => {
        const requesterUid = kernelContext.identity?.process.uid;
        if (typeof requesterUid !== "number") {
          throw new Error("Authentication required");
        }
        if (this.instanceKind === "master") {
          if (kind === "shadow") {
            if (requesterUid !== 0) {
              throw new Error("EACCES: permission denied, open '/etc/shadow'");
            }
            return this.auth.serializeShadow();
          }
          return kind === "passwd" ? this.auth.serializePasswd() : this.auth.serializeGroup();
        }
        const master = await getAgentByName(
          this.env.KERNEL,
          SHIP_KERNEL_NAME,
        ) as unknown as MasterKernelControlStub;
        const result = await master.masterReadAuthFile({
          sourceKernelName: this.name,
          requesterUid,
          kind,
        });
        return result.content;
      },
      configGet: async (key) => {
        // Seeded defaults are public semantics: an unreadable explicit value
        // behaves as unset and falls back to the shipped default.
        if (this.instanceKind === "master") {
          if (!canReadSysConfig(kernelContext, key)) {
            return SYSTEM_CONFIG_DEFAULTS[key] ?? null;
          }
          return this.config.get(key);
        }
        try {
          const result = await dispatchMasterRead<SysConfigGetResult>(
            "sys.config.get",
            { key, explicit: true },
          );
          return result.entries.find((entry) => entry.key === key)?.value
            ?? SYSTEM_CONFIG_DEFAULTS[key]
            ?? null;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Permission denied")) {
            return SYSTEM_CONFIG_DEFAULTS[key] ?? null;
          }
          throw error;
        }
      },
      configList: async (prefix) => {
        if (this.instanceKind === "master") {
          return this.config.list(prefix).filter((entry) => canReadSysConfig(kernelContext, entry.key));
        }
        const result = await dispatchMasterRead<SysConfigGetResult>(
          "sys.config.get",
          prefix.length > 0 ? { key: prefix } : {},
        );
        return result.entries;
      },
      configListExplicit: async (prefix) => {
        if (this.instanceKind === "master") {
          return this.config.listExplicit(prefix).filter((entry) => canReadSysConfig(kernelContext, entry.key));
        }
        const result = await dispatchMasterRead<SysConfigGetResult>("sys.config.get", {
          key: prefix,
          explicit: true,
        });
        return result.entries;
      },
      capsList: async (gid) => {
        if (this.instanceKind === "master") {
          return handleSysCapList({ gid }, kernelContext).records;
        }
        const result = await dispatchMasterRead<SysCapListResult>("sys.cap.list", { gid });
        return result.records;
      },
      packagesList: async (listOptions) => {
        if (!kernelContext.identity) throw new Error("Authentication required");
        // Package visibility follows the owning human's scopes, even for
        // agent-backed filesystems.
        const ownerUid = resolveCallerOwnerUid(kernelContext);
        if (this.instanceKind === "master") {
          return this.packages.list({
            enabled: listOptions?.enabled,
            scopes: visiblePackageScopesForActor({ uid: ownerUid }),
          });
        }
        const master = await getAgentByName(
          this.env.KERNEL,
          SHIP_KERNEL_NAME,
        ) as unknown as MasterKernelControlStub;
        const result = await master.masterPackagesList({
          sourceKernelName: this.name,
          requesterUid: ownerUid,
          enabled: listOptions?.enabled,
        });
        return result.packages;
      },
      listRepos: async (listArgs) => {
        if (this.instanceKind === "master") {
          return handleRepoList(listArgs, kernelContext);
        }
        return dispatchMasterRead<RepoListResult>("repo.list", listArgs ?? {});
      },
      writeConfig: async (key, value) => {
        const response = await this.requestDispatchedFrame({
          type: "req",
          id: crypto.randomUUID(),
          call: "sys.config.set",
          args: { key, value },
        }, kernelContext, options.requestSignal);
        if (!response.ok) {
          throw new Error(response.error.message);
        }
        await cancelUnlockedBody(response.body, "Config write completed");
      },
      mutateRepoMetadata: (mutation) => this.mutateRepoMetadataFromContext(
        mutation,
        kernelContext,
      ),
      authorizeRepoOperation: (call, normalizedRepo, requestedOwner) => (
        this.authorizeRepoOperationFromContext(
          call,
          normalizedRepo,
          requestedOwner,
          kernelContext,
        )
      ),
      revokeDeviceCredentials: (ownerUid, deviceId) => (
        this.revokeDeviceCredentialsFromContext(ownerUid, deviceId, kernelContext)
      ),
      authorizePackageAgentRuntime: (
        ownerUid,
        runAs,
        packageSecurityRevision,
        requiredCall,
        processId,
      ) => this.authorizeCurrentPackageAgentRuntime(
          ownerUid,
          runAs,
          packageSecurityRevision,
          requiredCall,
          processId,
        ),
      authorizePackageRuntime: async (appFrame, call) => (
        (await this.authorizeLocalAppFrame(appFrame, call)) !== null
      ),
      broadcastToUserUid: this.broadcastToUserUid.bind(this),
      getAppRunner: (actorUid, packageId) => this.getAppRunner(actorUid, packageId),
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
    return kernelContext;
  }

  private getAppRunner(
    actorUid: number,
    packageId: string,
  ): unknown {
    return this.ctx.exports.AppRunner.getByName(
      buildAppRunnerName(actorUid, packageId),
    );
  }

  private buildDispatchDeps(): DispatchDeps {
    return {
      shellSessions: this.shellSessions,
      connections: this.connections,
      sendFrame: this.sendWebSocketFrame.bind(this),
      registerRoute: this.registerRouteWithExpiry.bind(this),
      requestDevice: this.requestDevice.bind(this),
      request: this.requestDispatchedFrame.bind(this),
      ...(this.instanceKind === "user"
        ? { requestMaster: this.forwardMasterSyscall.bind(this) }
        : {}),
    };
  }

  private async dispatchKernelFrame(
    frame: RequestFrame,
    origin: RouteOrigin,
    context: KernelContext,
  ): Promise<Awaited<ReturnType<typeof dispatch>>> {
    const process = context.processId ? this.procs.get(context.processId) : null;
    const packageDerived = Boolean(
      context.appFrame
      || typeof process?.packageSecurityRevision === "string",
    );
    if (PACKAGE_AUTHORITY_MUTATIONS.has(frame.call) && packageDerived) {
      await cancelUnlockedBody(frame.body, "Package authority mutation denied");
      return {
        handled: true,
        response: errFrame(
          frame.id,
          403,
          "Package-derived runtimes cannot mutate package authority",
        ),
      };
    }
    const result = await dispatch(
      frame,
      origin,
      context,
      this.buildDispatchDeps(),
    );

    if (frame.call === "account.create" && result.handled) {
      try {
        await this.provisionCreatedHuman(result.response);
      } catch (error) {
        return {
          handled: true,
          response: errFrame(
            frame.id,
            503,
            `Account was created but its user Kernel remains closed: ${errorMessage(error)}`,
          ),
        };
      }
    }
    return result;
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
        this.dispatchKernelFrame(
          frame,
          origin,
          { ...ctx, requestSignal },
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
      this.applyDirectTokenRevocationEffects(frame, response);
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

  private queueRevokedProcessTeardown(processId: string, reason: string): Promise<void> {
    const origin: RouteOrigin = { type: "process", id: processId };
    for (const [requestId, request] of this.activeRequests) {
      if (sameRouteOrigin(request.origin, origin)) {
        this.cancelRequest(origin, requestId, reason, false);
      }
    }
    const current = this.revokedProcessTeardowns.get(processId);
    if (current) return current;

    const pending = this.teardownRevokedProcess(processId, reason).finally(() => {
      if (this.revokedProcessTeardowns.get(processId) === pending) {
        this.revokedProcessTeardowns.delete(processId);
      }
    });
    this.revokedProcessTeardowns.set(processId, pending);
    this.ctx.waitUntil(pending.catch((error) => {
      console.warn(`[Kernel] Failed to tear down revoked process ${processId}:`, error);
    }));
    return pending;
  }

  private async teardownRevokedProcess(processId: string, reason: string): Promise<void> {
    const record = this.procs.get(processId);
    if (!record) return;
    const requestId = crypto.randomUUID();
    const response = await sendFrameToProcess(processId, {
      type: "req",
      id: requestId,
      call: "proc.kill",
      args: { pid: processId, archive: false },
    });
    const data = response?.type === "res" && response.ok
      ? response.data as { ok?: unknown; pid?: unknown } | undefined
      : undefined;
    if (
      !response
      || response.type !== "res"
      || response.id !== requestId
      || !response.ok
      || data?.ok !== true
      || data.pid !== processId
    ) {
      throw new Error(`Revoked process did not exact-ack teardown: ${reason}`);
    }

    const current = this.procs.get(processId);
    if (!current) return;
    if (
      current.uid !== record.uid
      || current.ownerUid !== record.ownerUid
      || current.packageSecurityRevision !== record.packageSecurityRevision
    ) {
      throw new Error("Revoked process registry identity changed during teardown");
    }
    if (record.activeRunId) this.runRoutes.delete(record.activeRunId);
    this.ipcCalls.cancelBySourcePid({ uid: record.ownerUid, sourcePid: processId });
    this.failIpcCallsByTarget(record.ownerUid, processId, reason);
    this.ctx.storage.transactionSync(() => {
      this.conversations.clearActivePid(processId);
      this.procs.kill(processId);
    });
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

  private async rearmInterruptedScheduleRuns(): Promise<void> {
    const marker = await this.loadUserKernelMarker();
    if (
      !marker
      || marker.lifecycle !== "active"
    ) {
      return;
    }
    await this.rearmPendingSchedules(marker);
  }

  private queueUserKernelScheduleRearmRecovery(delaySeconds = 1): void {
    if (
      this.instanceKind !== "user"
      || this.userKernelScheduleRearmRecoveryQueued
    ) {
      return;
    }
    this.userKernelScheduleRearmRecoveryQueued = true;
    this.ctx.waitUntil(this.schedule(
      Math.max(1, delaySeconds),
      "onUserKernelScheduleRearmRecoveryDue",
    ).then(() => undefined).catch(() => {
      this.userKernelScheduleRearmRecoveryQueued = false;
    }));
  }

  async onUserKernelScheduleRearmRecoveryDue(): Promise<void> {
    this.userKernelScheduleRearmRecoveryQueued = false;
    if (this.instanceKind !== "user") {
      return;
    }
    try {
      await this.rearmInterruptedScheduleRuns();
      this.userKernelScheduleRearmRecoveryAttempt = 0;
    } catch {
      this.userKernelScheduleRearmRecoveryAttempt += 1;
      this.queueUserKernelScheduleRearmRecovery(Math.min(
        2 ** Math.min(this.userKernelScheduleRearmRecoveryAttempt - 1, 6),
        60,
      ));
    }
  }

  private async rearmPendingSchedules(
    expectedMarker: UserKernelInstanceMarker,
  ): Promise<void> {
    for (const record of this.schedules.listWakeable()) {
      if (!this.isCurrentUserKernelMarker(expectedMarker)) {
        return;
      }
      await this.replaceScheduleWake(record, expectedMarker);
    }
  }

  private async replaceScheduleWake(
    record: NonNullable<ReturnType<ScheduleStore["getStored"]>>,
    expectedMarker: UserKernelInstanceMarker | null,
    options: { allowRunning?: boolean } = {},
  ): Promise<boolean> {
    const dueAtMs = record.state.nextRunAtMs;
    if (
      !record.enabled
      || (!options.allowRunning && record.state.runningAtMs !== null)
      || dueAtMs === null
      || !this.isCurrentUserKernelMarker(expectedMarker)
    ) {
      return false;
    }

    const previousWakeId = record.wakeScheduleId;
    const wakeId = await this.scheduleScheduleWake(record.id, dueAtMs);
    const current = this.schedules.getStored(record.id);
    if (
      this.isCurrentUserKernelMarker(expectedMarker)
      && current?.enabled
      && (options.allowRunning || current.state.runningAtMs === null)
      && current.state.nextRunAtMs === dueAtMs
      && current.wakeScheduleId === previousWakeId
    ) {
      this.schedules.setWakeScheduleId(record.id, wakeId);
      if (previousWakeId && previousWakeId !== wakeId) {
        await this.cancelSchedule(previousWakeId).catch(() => {});
      }
      return true;
    }

    await this.cancelSchedule(wakeId).catch(() => {});
    return false;
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
        if (this.auth.isSetupMode() || isSetupCommissioningPending(this.config)) {
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

      if (this.instanceKind !== "user") {
        this.sendError(connection, frame.id, 409, "Username-scoped connection required");
        return;
      }
      try {
        await this.requireActiveUserKernel();
      } catch {
        this.sendError(connection, frame.id, 401, "Authentication failed");
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
        const requestSignal = controller.signal;
        frame = this.bindRequestBodyCancellation(frame, requestSignal);
        result = await this.dispatchKernelFrame(
          frame,
          origin,
          { ...this.buildContext(connection), requestSignal },
        );
      } finally {
        this.finishActiveRequest(frame.id, controller);
      }
      try {
        await this.requireActiveUserKernel();
      } catch {
        this.sendError(connection, frame.id, 401, "Authentication failed");
        return;
      }
      if (result.handled) {
        this.applyDirectTokenRevocationEffects(frame, result.response, connection.id);
        try {
          this.sendWebSocketFrame(connection, result.response);
        } finally {
          // A token may revoke the very socket carrying this request. Persist
          // the fence before sending, then close only after the response frame.
          this.flushDeferredCredentialClosures();
        }
      }
      // Routed responses arrive asynchronously through handleRes.
    } finally {
      await cancelUnlockedBody(frame.body, "WebSocket request completed");
    }
  }

  private async buildServiceBindingIdentity(
    frame: RequestFrame,
    routedOwnerUid?: number,
  ): Promise<ConnectionIdentity | null> {
    const args = frame.args as Record<string, unknown>;
    const adapterHint =
      typeof args.adapter === "string" && args.adapter.trim().length > 0
        ? args.adapter.trim().toLowerCase()
        : "service-binding";

    if (this.instanceKind === "user") {
      const marker = await this.loadUserKernelMarker();
      if (
        !marker
        || marker.lifecycle !== "active"
        || marker.uid !== routedOwnerUid
      ) {
        return null;
      }
      const master = await getAgentByName(
        this.env.KERNEL,
        SHIP_KERNEL_NAME,
      ) as unknown as MasterKernelControlStub;
      return master.resolveAdapterServiceIdentity({
        sourceKernelName: this.name,
        uid: marker.uid,
        ownerUid: marker.uid,
        channel: adapterHint,
      });
    }

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
    const marker = await this.requireActiveUserKernel();
    if (this.instanceKind !== "user" || !marker) {
      throw new Error(`App route owner unavailable for watch ${watch.watchId}`);
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const [account, packageList] = await Promise.all([
      master.resolveAccountIdentity({
        sourceKernelName: this.name,
        uid: marker.uid,
        ownerUid: marker.uid,
        actorUid: watch.uid,
      }),
      master.masterPackagesList({
        sourceKernelName: this.name,
        requesterUid: watch.uid,
        enabled: true,
      }),
    ]);
    const record = packageList.packages.find((candidate) => candidate.packageId === watch.packageId);
    if (
      !account.ok
      || !record
      || !record.enabled
      || (record.reviewRequired && !record.reviewedAt)
      || record.manifest.name !== watch.packageName
    ) {
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

    const now = Date.now();
    const appFrame: AppFrameContext = {
      uid: account.identity.uid,
      username: account.identity.username,
      ...(appClientSession
        ? {
            sessionId: appClientSession.sessionId,
            clientId: appClientSession.clientId,
          }
        : {}),
      packageId: record.packageId,
      packageName: record.manifest.name,
      packageUpdatedAt: record.updatedAt,
      packageArtifactHash: record.artifact.hash,
      entrypointName: entrypoint.name,
      routeBase: watch.routeBase,
      issuedAt: now,
      expiresAt: now + DEFAULT_APP_FRAME_TTL_MS,
    };
    if (!(await this.authorizeLocalAppFrame(appFrame))) {
      throw new Error(`Package runtime authorization expired for watch ${watch.watchId}`);
    }
    const runner = this.ctx.exports.AppRunner.getByName(
      buildAppRunnerName(account.identity.uid, record.packageId),
    );
    await runner.ensureRuntime({
      kernelName: this.name,
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
    if (this.instanceKind === "master") {
      const username = canonicalizeLoginUsername(frame.args.auth?.username);
      const placement = username ? this.userKernels.get(username) : null;
      if (
        !this.auth.isSetupMode()
        && !isSetupCommissioningPending(this.config)
      ) {
        this.sendError(
          connection,
          frame.id,
          placement?.lifecycle === "active" ? 409 : 401,
          placement?.lifecycle === "active"
            ? "Username-scoped connection required"
            : "Authentication failed",
          placement?.lifecycle === "active" && username
            ? { path: `/ws/${encodeURIComponent(username)}` }
            : undefined,
        );
        return;
      }
    }
    const ctx = this.buildContext(connection);

    const outcome = await handleConnect(frame.args, ctx);

    if (!outcome.ok) {
      this.sendError(connection, frame.id, outcome.code, outcome.message, outcome.details);
      return;
    }

    const clientId = frame.args?.client?.id?.trim();
    const clientPlatform = frame.args?.client?.platform?.trim();
    const transportState = connection.state;
    const credentialExpiryScheduleId = outcome.credential.kind === "token"
      && outcome.credential.expiresAt !== null
      ? (await this.schedule(
          new Date(outcome.credential.expiresAt),
          "onConnectionCredentialExpired",
          { connectionId: connection.id, tokenId: outcome.credential.tokenId },
          { idempotent: true },
        )).id
      : undefined;
    if (this.instanceKind === "user") {
      try {
        await this.requireActiveUserKernel();
      } catch {
        if (credentialExpiryScheduleId) {
          await this.cancelSchedule(credentialExpiryScheduleId).catch(() => {});
        }
        this.sendError(connection, frame.id, 401, "Authentication failed");
        return;
      }
    }
    const newState = {
      step: "connected",
      identity: outcome.identity,
      credential: outcome.credential,
      ...(transportState?.loginSourceScope
        ? { loginSourceScope: transportState.loginSourceScope }
        : {}),
      ...(credentialExpiryScheduleId ? { credentialExpiryScheduleId } : {}),
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
      if (this.instanceKind === "user") {
        try {
          await this.requireActiveUserKernel();
        } catch {
          return;
        }
      }
      await this.reconcileOwnedIdentities(freshIdentity.uid);
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
    if (this.instanceKind !== "master") {
      this.sendError(connection, frame.id, 403, "Setup is master-only");
      return;
    }
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

    if (!this.auth.isSetupMode() && !isSetupCommissioningPending(this.config)) {
      this.sendError(connection, frame.id, 409, "System already initialized");
      return;
    }

    try {
      const data = await handleKernelSetup(frame.args, ctx, {
        provisionUserKernels: async (result) => {
          await this.provisionSetupUserKernels(result.user.username);
        },
      });
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
    if (this.instanceKind !== "master") {
      this.sendError(connection, frame.id, 403, "Setup assistant is master-only");
      return;
    }
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

    if (!this.auth.isSetupMode() && !isSetupCommissioningPending(this.config)) {
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
    try {
      await this.requireActiveUserKernel();
    } catch {
      return;
    }
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
    try {
      await this.requireActiveUserKernel();
    } catch {
      return;
    }
    const timedOut = this.ipcCalls.timeout(callId);
    if (!timedOut) return;
    this.queueIpcCallDelivery(callId);
  }

  async onTokenRevocationOutboxDue(): Promise<void> {
    if (this.instanceKind !== "master") return;
    await this.flushTokenRevocationOutbox();
  }

  async onConnectionCredentialExpired(input: {
    connectionId: string;
    tokenId: string;
  }): Promise<void> {
    const connection = this.connections.get(input.connectionId);
    const state = connection?.state;
    if (
      !connection
      || state?.step !== "connected"
      || state.credential?.kind !== "token"
      || state.credential.tokenId !== input.tokenId
      || state.credential.expiresAt === null
      || state.credential.expiresAt > Date.now()
    ) {
      return;
    }
    connection.close(1008, "Authentication expired");
  }

  async onIpcCallDelivery(callId: string): Promise<void> {
    try {
      await this.requireActiveUserKernel();
    } catch {
      return;
    }
    await this.deliverIpcCall(callId);
  }

  async onScheduleDue(scheduleId: string, wake?: { id?: unknown }): Promise<void> {
    let kernelMarker: UserKernelInstanceMarker | null;
    try {
      kernelMarker = await this.requireActiveUserKernel();
    } catch {
      return;
    }
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
    if (current?.enabled && current.state.nextRunAtMs !== null) {
      await this.replaceScheduleWake(current, kernelMarker, { allowRunning: true });
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
      ? [this.schedules.getStored(args.id)].filter((record): record is StoredScheduleRecord => (
          record !== null
        ))
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
    record: StoredScheduleRecord,
    mode: "due" | "force",
  ): Promise<ScheduleRunResult> {
    if (this.instanceKind === "master") {
      return skippedScheduleResult(record.id, "schedule owner runtime is not active");
    }
    return this.runAdmittedScheduleRecord(record, mode);
  }

  private async runAdmittedScheduleRecord(
    record: StoredScheduleRecord,
    mode: "due" | "force",
  ): Promise<ScheduleRunResult> {
    const kernelMarker = await this.requireActiveUserKernel();
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

    const scheduleIdentity = await this.resolveScheduleIdentity(record);
    const requiredCall = scheduleRequiredCall(record);
    if (!await this.authorizeCurrentPackageAgentRuntime(
      record.ownerUid,
      scheduleIdentity.process,
      record.packageSecurityRevision,
      requiredCall,
    )) {
      await this.disableRevokedSchedule(record, "Schedule package-agent authority was revoked");
      return skippedScheduleResult(record.id, "schedule package-agent authority was revoked");
    }

    const startedAtMs = Date.now();
    const running = this.schedules.markRunning(record.id, startedAtMs);
    if (!running) {
      return skippedScheduleResult(record.id, "schedule is already running");
    }

    const controller = new AbortController();
    const runSignal = controller.signal;
    this.activeScheduleRuns.set(record.id, controller);
    try {
      let status: "ok" | "error" = "ok";
      let error: string | undefined;
      let result: unknown;

      try {
        result = await this.dispatchScheduleTarget(
          record,
          scheduledAtMs,
          startedAtMs,
          runSignal,
          scheduleIdentity,
        );
      } catch (err) {
        status = "error";
        error = err instanceof Error ? err.message : String(err);
        result = { error };
      }

      const stillAuthorized = await this.authorizeCurrentPackageAgentRuntime(
        record.ownerUid,
        scheduleIdentity.process,
        record.packageSecurityRevision,
        requiredCall,
      );
      if (!stillAuthorized) {
        status = "error";
        error = "Schedule package-agent authority was revoked during execution";
        result = { error };
      }

      const finishedAtMs = Date.now();
      if (
        runSignal.aborted
        || !this.isCurrentUserKernelMarker(kernelMarker)
      ) {
        const staleError = runSignal.reason instanceof Error
          ? runSignal.reason.message
          : "User Kernel lifecycle changed during schedule run";
        return {
          scheduleId: record.id,
          status: "error",
          error: staleError,
          summary: scheduleResultSummary(record, { error: staleError }),
          durationMs: Math.max(0, finishedAtMs - startedAtMs),
          nextRunAtMs: null,
        };
      }

      const next = !stillAuthorized
        ? { enabled: false, nextRunAtMs: null }
        : mode === "force"
        ? { enabled: record.enabled, nextRunAtMs: record.state.nextRunAtMs }
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
      });

      if (updated?.enabled && updated.state.nextRunAtMs !== null && mode !== "force") {
        const current = this.schedules.getStored(updated.id);
        if (current) {
          await this.replaceScheduleWake(current, kernelMarker);
        }
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
    } finally {
      if (this.activeScheduleRuns.get(record.id) === controller) {
        this.activeScheduleRuns.delete(record.id);
      }
    }
  }

  private async dispatchScheduleTarget(
    record: ScheduleRecord,
    scheduledAtMs: number | null,
    firedAtMs: number,
    signal?: AbortSignal,
    identity?: ConnectionIdentity,
  ): Promise<unknown> {
    const target = record.target;
    const ctx = this.buildScheduleContext(record, identity, signal);
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

    if (target.kind === "process.event") {
      if (!hasCapability(ctx.identity?.capabilities ?? [], "proc.send")) {
        throw new Error("Permission denied: proc.send");
      }
      const proc = this.procs.get(target.pid);
      if (!proc) {
        throw new Error(`Process not found: ${target.pid}`);
      }
      if (proc.ownerUid !== record.ownerUid && record.ownerUid !== 0) {
        throw new Error(`Permission denied: schedule ${record.id} cannot access process ${target.pid}`);
      }

      const request: ProcessScheduleDeliverRequestFrame = {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.schedule.deliver",
        args: {
          scheduleId: record.id,
          scheduleName: record.name,
          conversationId: target.conversationId,
          message: target.message,
          data: target.data,
          scheduledAtMs,
          firedAtMs,
        },
      };
      const response = await raceWithAbort(
        sendFrameToProcess(target.pid, request),
        signal,
        {
          abortReason: () => signal?.reason ?? new Error("Schedule cancelled"),
          onAbort: () => {
            void sendFrameToProcess(target.pid, {
              type: "sig",
              signal: REQUEST_CANCEL_SIGNAL,
              payload: {
                id: request.id,
                reason: signal?.reason instanceof Error
                  ? signal.reason.message
                  : "Schedule cancelled",
              },
            }).catch(() => {});
          },
        },
      );
      if (!response || response.type !== "res" || response.id !== request.id) {
        throw new Error("proc.schedule.deliver did not return a response");
      }
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return {
        kind: "process.event",
        pid: target.pid,
        conversationId: target.conversationId ?? "default",
      };
    }

    return { kind: "unknown" };
  }

  private buildScheduleContext(
    record: ScheduleRecord,
    identity?: ConnectionIdentity,
    requestSignal?: AbortSignal,
  ): KernelContext {
    if (!identity) throw new Error("Schedule identity is unavailable");

    return this.buildKernelContext({
      identity,
      callerOwnerUid: record.ownerUid,
      requestSignal,
    });
  }

  private isCurrentUserKernelMarker(
    expected: UserKernelInstanceMarker | null,
  ): boolean {
    if (expected === null) {
      return this.instanceKind === "master";
    }
    const current = this.userKernelMarker;
    return Boolean(
      current
      && current.lifecycle === "active"
      && current.username === expected.username
      && current.uid === expected.uid
    );
  }

  private async resolveScheduleIdentity(record: ScheduleRecord): Promise<ConnectionIdentity> {
    const marker = await this.requireActiveUserKernel();
    if (this.instanceKind !== "user" || !marker || marker.uid !== record.ownerUid) {
      throw new Error("Schedule owner runtime is not active");
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const resolved = await master.resolveAccountIdentity({
      sourceKernelName: this.name,
      uid: marker.uid,
      ownerUid: record.ownerUid,
      actorUid: record.runAs.uid,
    });
    if (!resolved.ok || resolved.identity.username !== record.runAs.username) {
      throw new Error(`Schedule run-as authority was revoked for uid ${record.runAs.uid}`);
    }
    return {
      role: "user",
      process: resolved.identity,
      capabilities: resolved.capabilities,
    };
  }

  private async disableRevokedSchedule(
    record: StoredScheduleRecord,
    reason: string,
  ): Promise<void> {
    this.activeScheduleRuns.get(record.id)?.abort(new Error(reason));
    const current = this.schedules.getStored(record.id);
    if (!current) return;
    this.schedules.update(record.id, { enabled: false, now: Date.now() });
    this.schedules.setWakeScheduleId(record.id, null);
    if (current.wakeScheduleId) {
      await this.cancelSchedule(current.wakeScheduleId).catch(() => {});
    }
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
   * the Master account directory. Each process keeps its run-as account
   * (preserving the personal-agent split); only group/home/gid drift for that
   * account is refreshed, and identity.changed is emitted when it changes.
   */
  private async reconcileOwnedIdentities(ownerUid: number): Promise<void> {
    for (const proc of this.procs.list(ownerUid)) {
      let fresh: ProcessIdentity | null = null;
      if (this.instanceKind === "user") {
        const resolved = await this.resolveUserKernelAccountIdentity(proc.uid);
        if (resolved.ok && resolved.identity.username === proc.username) {
          fresh = { ...resolved.identity, cwd: proc.cwd };
        }
      } else {
        const entry = this.auth.getPasswdByUsername(proc.username);
        if (entry) {
          fresh = {
            uid: entry.uid,
            gid: entry.gid,
            gids: this.auth.resolveGids(entry.username, entry.gid),
            username: entry.username,
            home: entry.home,
            cwd: proc.cwd,
          };
        }
      }
      if (!fresh) continue;

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
    if (this.instanceKind === "master") {
      const placement = this.userKernels.getByUid(uid);
      if (placement?.lifecycle === "active") {
        this.ctx.waitUntil((async () => {
          pruneExpiredAuthorizations(this.masterUserSignalAuthorizations);
          const authorization = crypto.randomUUID();
          const payloadJson = payload === undefined
            ? undefined
            : JSON.stringify(payload);
          const authorizedSignal: Omit<
            MasterUserSignalAuthorizationInput,
            "authorization"
          > = {
            targetKernelName: userKernelName(placement.username),
            username: placement.username,
            uid,
            signal,
            ...(payloadJson === undefined ? {} : { payloadJson }),
          };
          this.masterUserSignalAuthorizations.set(authorization, {
            expiresAt: Date.now() + MASTER_USER_SIGNAL_AUTHORIZATION_TTL_MS,
            signal: authorizedSignal,
          });
          const userKernel = await getAgentByName(
            this.env.KERNEL,
            userKernelName(placement.username),
          ) as unknown as {
            receiveMasterUserSignal: (
              input: MasterUserSignalTargetInput,
            ) => Promise<boolean>;
          };
          try {
            await userKernel.receiveMasterUserSignal({
              sourceKernelName: this.name,
              authorization,
              username: placement.username,
              uid,
              signal,
              ...(payloadJson === undefined ? {} : { payloadJson }),
            });
          } finally {
            this.masterUserSignalAuthorizations.delete(authorization);
          }
        })().catch((error) => {
          console.warn(
            `[Kernel] Failed to deliver Master signal ${signal} to ${placement.username}:`,
            error,
          );
        }));
        return;
      }
      if (placement) {
        return;
      }
    }

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

  async receiveMasterUserSignal(input: MasterUserSignalTargetInput): Promise<boolean> {
    try {
      const marker = await this.requireActiveUserKernel();
      if (
        !marker
        || input.sourceKernelName !== SHIP_KERNEL_NAME
        || typeof input.authorization !== "string"
        || input.authorization.length === 0
        || input.username !== marker.username
        || marker.uid !== input.uid
        || typeof input.signal !== "string"
        || input.signal.length === 0
        || input.signal.length > 128
        || (input.payloadJson !== undefined && typeof input.payloadJson !== "string")
      ) {
        return false;
      }

      let payload: unknown;
      if (input.payloadJson !== undefined) {
        try {
          payload = JSON.parse(input.payloadJson);
        } catch {
          return false;
        }
      }
      const master = await getAgentByName(
        this.env.KERNEL,
        SHIP_KERNEL_NAME,
      ) as unknown as MasterKernelControlStub;
      const authorized = await master.consumeMasterUserSignalAuthorization({
        authorization: input.authorization,
        targetKernelName: this.name,
        username: marker.username,
        uid: marker.uid,
        signal: input.signal,
        ...(input.payloadJson === undefined ? {} : { payloadJson: input.payloadJson }),
      });
      if (!authorized || !this.isCurrentUserKernelMarker(marker)) {
        return false;
      }
      this.broadcastToUserUid(marker.uid, input.signal, payload);
      return true;
    } catch {
      return false;
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
    const masterRuntimeClosed = this.instanceKind === "master"
      && !this.auth.isSetupMode()
      && !isSetupCommissioningPending(this.config);

    const onlineTargets = new Set<string>();

    for (const connection of live) {
      const state = connection.state;
      if (!state || state.step !== "connected" || !state.identity) continue;
      if (masterRuntimeClosed) {
        connection.close(1008, "Username-scoped connection required");
        continue;
      }
      if (!this.isConnectionCredentialActive(state)) {
        connection.close(1008, "Authentication expired");
        continue;
      }

      this.connections.set(connection.id, connection);
      if (
        state.credential?.kind === "token"
        && state.credential.expiresAt !== null
        && !state.credentialExpiryScheduleId
      ) {
        const credential = {
          tokenId: state.credential.tokenId,
          expiresAt: state.credential.expiresAt as number,
        };
        this.ctx.waitUntil(this.schedule(
          new Date(credential.expiresAt),
          "onConnectionCredentialExpired",
          { connectionId: connection.id, tokenId: credential.tokenId },
          { idempotent: true },
        ).then(() => undefined));
      }
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

function sameMasterUserSignalAuthorization(
  expected: Omit<MasterUserSignalAuthorizationInput, "authorization">,
  actual: MasterUserSignalAuthorizationInput,
): boolean {
    return expected.targetKernelName === actual.targetKernelName
    && expected.username === actual.username
    && expected.uid === actual.uid
    && expected.signal === actual.signal
    && expected.payloadJson === actual.payloadJson;
}

function sameUserKernelInstanceMarker(
  left: UserKernelInstanceMarker | null,
  right: UserKernelInstanceMarker,
): boolean {
  return Boolean(
    left
    && left.version === right.version
    && left.kind === right.kind
    && left.username === right.username
    && left.uid === right.uid
    && left.lifecycle === right.lifecycle
    && left.updatedAt === right.updatedAt,
  );
}

function sameUserKernelPlacement(
  left: UserKernelRecord | null,
  right: UserKernelRecord,
): boolean {
  return Boolean(
    left
    && left.username === right.username
    && left.uid === right.uid
    && left.lifecycle === right.lifecycle,
  );
}

function pruneExpiredAuthorizations<T extends { expiresAt: number }>(
  authorizations: Map<string, T>,
  now = Date.now(),
): void {
  for (const [authorization, pending] of authorizations) {
    if (pending.expiresAt <= now) {
      authorizations.delete(authorization);
    }
  }
}

function parseUserKernelInstanceMarker(value: unknown): UserKernelInstanceMarker | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const marker = value as Partial<UserKernelInstanceMarker>;
  if (
    marker.version !== 1
    || marker.kind !== "user"
    || typeof marker.username !== "string"
    || canonicalizeLoginUsername(marker.username) !== marker.username
    || !Number.isSafeInteger(marker.uid)
    || (marker.uid ?? -1) < 0
    || !["provisioning", "active"].includes(marker.lifecycle ?? "")
    || typeof marker.updatedAt !== "number"
    || !Number.isFinite(marker.updatedAt)
  ) {
    throw new Error("User Kernel lifecycle marker is invalid");
  }
  return marker as UserKernelInstanceMarker;
}

function scheduleRequiredCall(record: ScheduleRecord): string | undefined {
  switch (record.target.kind) {
    case "command.exec":
      return "shell.exec";
    case "process.spawn":
      return "proc.spawn";
    case "process.event":
      return "proc.send";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isPreservedAppRuntimeDescriptor(
  value: unknown,
): value is PreservedAppRuntimeDescriptor {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Record<string, unknown>;
  return Number.isSafeInteger(runtime.uid)
    && (runtime.uid as number) >= 0
    && typeof runtime.username === "string"
    && runtime.username.length > 0
    && typeof runtime.packageId === "string"
    && runtime.packageId.length > 0
    && typeof runtime.packageName === "string"
    && runtime.packageName.length > 0
    && typeof runtime.entrypointName === "string"
    && runtime.entrypointName.length > 0
    && typeof runtime.routeBase === "string"
    && runtime.routeBase.length > 0;
}

async function cancelUnlockedBody(body: FrameBody | undefined, reason: string): Promise<void> {
  if (body && !body.stream.locked) {
    await body.stream.cancel(reason).catch(() => {});
  }
}

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function masterErrorFrame(
  id: string,
  code: number,
  message: string,
): MasterSyscallResult["response"] {
  return { type: "res", id, ok: false, error: { code, message } };
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return null;
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const binary = atob(normalized);
    if (binary.length !== 32) {
      return null;
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
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

function normalizeGitRepoSegment(value: unknown): string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= GIT_REPO_SEGMENT_MAX_CHARACTERS
    && value !== "."
    && value !== ".."
    && /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : "";
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
