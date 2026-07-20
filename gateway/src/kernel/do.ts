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
import { ConfigStore } from "./config";
import { DeviceRegistry } from "./devices";
import {
  RoutingTable,
  type FailedDeviceRoute,
  type RouteOrigin,
} from "./routing";
import { ShellSessionStore, type ShellSessionStatus } from "./shell-sessions";
import {
  ProcessRegistry,
  processKernelGenerationMatches,
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
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import { sendFrameToProcess } from "../shared/utils";
import {
  handleSysSetup as handleKernelSetup,
  isSetupCommissioningPending,
} from "./sys/setup";
import {
  buildAppRunnerName,
  buildRoutedAppSessionId,
  buildRoutedAppSessionSigningInput,
  isLegacyAppSessionId,
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
import { ensureDefaultConversationExecutor } from "./agents";
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
import { canOwnerRunAsAccount } from "./account-access";
import {
  findPackageAgentAccount,
  isPackageAgentRuntimeAuthorized,
  packageAgentAccessGroup,
  packageAgentRuntimeIdentity,
  packageAgentSecurityRevision,
  packageAgentSecuritySurface,
  packageAgentSecurityRevisionKey,
  reconcilePackageAgentEntitlements,
  validatePackageAgentProjectionSecurity,
} from "./package-agents";
import { KernelProjectionState } from "./projection-state";
import {
  AppRuntimeRegistry,
  type AppRuntimeLifecycleFence,
  type AppRuntimeRunnerRecord,
} from "./app-runtime-registry";
import type {
  AppRunnerRuntimeFenceAck,
  AppRunnerRuntimeFenceAuthorizationInput,
  AppRunnerPackageRuntimeFenceIdentity as AppRunnerRuntimeFenceIdentity,
  AppRunnerRuntimeFenceKind,
} from "../app-runner/package-runtime-fence";
import { canonicalizeLoginUsername } from "../auth/login";
import { isSharedSystemConfigKey } from "./config-access";
import {
  isMasterKernelName,
  SHIP_KERNEL_NAME,
  USER_KERNEL_GENERATION_HEADER,
  USER_KERNEL_LOGIN_SOURCE_HEADER,
  userKernelName,
  userKernelUsername,
} from "../shared/kernel-names";
import {
  ADAPTER_INBOUND_GATEWAY_SOURCE,
  adapterInboundRouteMetadata,
  normalizeAdapterInboundRouteMetadata,
  sameAdapterInboundRouteMetadata,
  type AdapterInboundRouteMetadata,
  type AdapterInboundRouteResult,
} from "../shared/adapter-inbound-route";
import {
  USER_KERNEL_INSTANCE_STORAGE_KEY,
  UserKernelRegistry,
  type UserKernelInstanceMarker,
  type UserKernelLifecycle,
  type UserKernelProvisioningSnapshot,
  type UserKernelRecord,
} from "./user-kernels";
import {
  failedMasterMutationNeedsGlobalPackageInvalidation,
  failedMasterMutationNeedsGlobalRepoInvalidation,
  isMasterOwnedSyscall,
  masterMutationNeedsPackageProjectionFence,
  masterMutationNeedsProjectionRefresh,
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
import {
  APP_PLACEMENT_VERIFICATION_KEY_OBJECT,
  appPlacementVerificationKeyRecord,
  generateAppPlacementSigningKeyRecord,
  importAppPlacementSigningKey,
  isAppPlacementCertificate,
  parseAppPlacementSigningKeyRecord,
  serializeAppPlacementVerificationKeyRecord,
  signAppPlacementCertificate,
  type AppPlacementSigningKeyRecord,
} from "../shared/app-placement-certificate";

const PROCESS_REQUEST_CANCEL_TTL_MS = 60_000;
const MAX_PROCESS_REQUEST_CANCELLATIONS = 1024;
const MAX_REQUEST_CANCEL_REASON_LENGTH = 512;
const GIT_REPO_SEGMENT_MAX_CHARACTERS = 128;
const APP_SESSION_ROUTE_SECRET_KEY = "gsv/app-session-route-secret/v1";
const APP_PLACEMENT_SIGNING_KEY_STORAGE_KEY = "gsv/app-placement-signing-key/v1";
const APP_PLACEMENT_CERTIFICATE_STORAGE_KEY = "gsv/app-placement-certificate/v1";
const APP_SESSION_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APP_SESSION_ROUTE_SECRET_BYTES = 32;
const USER_KERNEL_LIFECYCLE_AUTHORIZATION_TTL_MS = 30_000;
const USER_KERNEL_PROVISIONING_AUTHORIZATION_TTL_MS = 30_000;
const USER_KERNEL_ACTIVATION_AUTHORIZATION_TTL_MS = 30_000;
const PROCESS_ROLLBACK_AUTHORIZATION_TTL_MS = 30_000;
const ADAPTER_INBOUND_AUTHORIZATION_TTL_MS = 30_000;
const MAX_PENDING_ADAPTER_INBOUND_AUTHORIZATIONS = 4_096;
const MASTER_USER_SIGNAL_AUTHORIZATION_TTL_MS = 30_000;
const PACKAGE_PROJECTION_FENCE_AUTHORIZATION_TTL_MS = 30_000;
const APP_RUNNER_RUNTIME_FENCE_AUTHORIZATION_TTL_MS = 30_000;
const MAX_PENDING_APP_RUNNER_RUNTIME_FENCE_AUTHORIZATIONS = 4_096;
const PACKAGE_PROJECTION_TARGET_CONCURRENCY = 8;
const APP_RUNNER_RUNTIME_FENCE_CONCURRENCY = 8;
const PACKAGE_PROJECTION_RECOVERY_MAX_DELAY_SECONDS = 60;
const USER_KERNEL_CAPABILITY_BYTES = 32;
const USER_KERNEL_CAPABILITY_STORAGE_KEY = "gsv/kernel/capability/v1";
const MASTER_USER_KERNEL_CAPABILITY_STORAGE_PREFIX = "gsv/kernel/user-capability/v1/";
const TEXT_ENCODER = new TextEncoder();

type ConnectionState = {
  step: "pending" | "connected" | "superseded";
  loginSourceScope?: LoginSourceScope;
  kernelGeneration?: number;
  identity?: ConnectionIdentity;
  credential?: AuthenticatedCredential;
  credentialExpiryScheduleId?: string;
  clientId?: string;
  clientPlatform?: string;
};

type UserKernelRouteResult =
  | { ok: true; kernelName: string; lifecycle: "legacy" }
  | {
      ok: true;
      kernelName: string;
      lifecycle: "active";
      generation: number;
      loginSourceScope: LoginSourceScope;
    }
  | { ok: false };

type UserKernelAuthenticationInput = {
  sourceKernelName: string;
  username: string;
  generation: number;
  kernelCapability: string;
  args: ConnectArgs;
  loginSourceScope: LoginSourceScope;
};

type AppKernelRouteResult =
  | {
      ok: true;
      kernelName: string;
      lifecycle: "active" | "legacy";
      username: string;
      uid: number;
      generation: number;
    }
  | { ok: false };

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
  generation: number;
  kernelCapability: string;
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
  generation: number;
  kernelCapability: string;
  identity: ConnectionIdentity;
  mutation: RepoMetadataMutation;
};

type UserRepoOperationAuthorizationInput = {
  sourceKernelName: string;
  callerOwnerUid: number;
  generation: number;
  kernelCapability: string;
  identity: ConnectionIdentity;
  call: AuthoritativeRepoOperationCall;
  repo?: string;
  requestedOwner?: string;
};

type UserRepoOperationAuthorizationResult =
  | { ok: true; repoList?: RepoListResult }
  | { ok: false; error: { code: number; message: string } };

type UserKernelLifecycleTransition = {
  sourceKernelName: string;
  authorization: string;
  username: string;
  uid: number;
  expectedLifecycle: UserKernelLifecycle;
  expectedGeneration: number;
  generation: number;
  lifecycle: Extract<UserKernelLifecycle, "provisioning" | "suspended" | "retired">;
};

type UserKernelLifecycleAuthorizationInput = Omit<
  UserKernelLifecycleTransition,
  "sourceKernelName"
> & {
  targetKernelName: string;
};

type UserKernelLifecycleTargetRecord = Omit<UserKernelRecord, "lifecycle"> & {
  lifecycle: Extract<UserKernelLifecycle, "provisioning" | "suspended" | "retired">;
};

type UserKernelProvisioningTargetInput = {
  sourceKernelName: string;
  authorization: string;
  username: string;
  uid: number;
  generation: number;
};

type UserKernelProvisioningAuthorizationInput = Omit<
  UserKernelProvisioningTargetInput,
  "sourceKernelName"
> & {
  targetKernelName: string;
};

type UserKernelActivationTargetInput = UserKernelProvisioningTargetInput;
type UserKernelActivationAuthorizationInput = UserKernelProvisioningAuthorizationInput & {
  kernelCapability: string;
};

type ProcessRollbackAuthorizationInput = {
  authorization: string;
  processId: string;
};

type MasterSyscallResult = {
  response:
    | { type: "res"; id: string; ok: true; data?: MasterRpcValue }
    | { type: "res"; id: string; ok: false; error: { code: number; message: string; details?: MasterRpcValue } };
  refreshProjection: boolean;
  tokenRevocations?: TokenRevocationNotice[];
};

type UserKernelDeviceRevocationInput = {
  sourceKernelName: string;
  ownerUid: number;
  generation: number;
  kernelCapability: string;
  deviceId: string;
};

type MasterTokenRevocationDeliveryInput = {
  sourceKernelName: string;
  username: string;
  uid: number;
  generation: number;
  notice: TokenRevocationNotice;
};

type TokenRevocationConfirmationInput = {
  sourceKernelName: string;
  username: string;
  uid: number;
  generation: number;
  kernelCapability: string;
  notice: TokenRevocationNotice;
};

type RoutedAdapterInboundInput = AdapterInboundRouteMetadata & {
  source: typeof ADAPTER_INBOUND_GATEWAY_SOURCE;
  authorization: string;
  username: string;
  ownerUid: number;
  generation: number;
  linkGeneration: number;
  frame: RequestFrame<"adapter.inbound">;
};

type AdapterInboundAuthorizationInput = AdapterInboundRouteMetadata & {
  authorization: string;
  targetKernelName: string;
  username: string;
  ownerUid: number;
  generation: number;
  linkGeneration: number;
};

type AdapterRunRouteAuthorizationInput = {
  sourceKernelName: string;
  ownerUid: number;
  kernelGeneration: number;
  kernelCapability: string;
  adapter: string;
  accountId: string;
  actorId: string;
  linkGeneration: number;
};

type UserKernelCapabilityProof = {
  sourceKernelName: string;
  uid: number;
  generation: number;
  kernelCapability: string;
};

type AppPlacementCertificateGrant = {
  version: 1;
  username: string;
  uid: number;
  generation: number;
  certificate: string;
};

type MasterAppPlacementSigningKey = {
  record: AppPlacementSigningKeyRecord;
  key: CryptoKey;
};

type MasterUserKernelCapabilityRecord = {
  version: 1;
  username: string;
  uid: number;
  generation: number;
  digest: string;
};

type LocalUserKernelCapabilityRecord = {
  version: 1;
  username: string;
  uid: number;
  generation: number;
  secret: string;
};

type PackageProjectionFenceAuthorizationInput = {
  authorization: string;
  targetKernelName: string;
  username: string;
  uid: number;
  generation: number;
  fenceId: string;
};

type PackageProjectionFenceTargetInput = Omit<
  PackageProjectionFenceAuthorizationInput,
  "targetKernelName"
> & {
  sourceKernelName: string;
};

type PackageProjectionRefreshTargetInput = {
  sourceKernelName: string;
  username: string;
  uid: number;
  generation: number;
  fenceId: string;
  expectedProjectionRevision: number;
};

type PendingAppRunnerRuntimeFenceAuthorization = {
  expiresAt: number;
  action: AppRunnerRuntimeFenceAuthorizationInput["action"];
  fence: AppRunnerRuntimeFenceIdentity;
};

type AppRunnerRuntimeFenceStub = {
  prepareAppRunnerRuntimeFence: (
    input: AppRunnerRuntimeFenceIdentity & { authorization: string },
  ) => Promise<AppRunnerRuntimeFenceAck>;
  clearAppRunnerRuntimeFence: (
    input: AppRunnerRuntimeFenceIdentity & { authorization: string },
  ) => Promise<AppRunnerRuntimeFenceAck>;
};

type UserKernelTargetOperationLease = {
  generation: number;
  signal: AbortSignal;
  markPackageStamped: () => void;
  isPackageStamped: () => boolean;
  assertCurrent: () => void;
  release: () => void;
};

type AuthorizedUserKernelProvisioningSnapshot = UserKernelProvisioningSnapshot & {
  kernelCapability: string;
};

type MasterUserSignalAuthorizationInput = {
  authorization: string;
  targetKernelName: string;
  username: string;
  uid: number;
  generation: number;
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
  getUserKernelProjection: (
    sourceKernelName: string,
    username: string,
    generation: number,
    kernelCapability: string,
  ) => Promise<UserKernelProvisioningSnapshot>;
  resolveAppFrameKernel: (
    appFrame: AppFrameContext,
    call?: string,
  ) => Promise<AppKernelRouteResult>;
  consumeUserKernelLifecycleAuthorization: (
    input: UserKernelLifecycleAuthorizationInput,
  ) => Promise<boolean>;
  consumeUserKernelProvisioningAuthorization: (
    input: UserKernelProvisioningAuthorizationInput,
  ) => Promise<AuthorizedUserKernelProvisioningSnapshot | null>;
  consumeUserKernelActivationAuthorization: (
    input: UserKernelActivationAuthorizationInput,
  ) => Promise<UserKernelProvisioningSnapshot | null>;
  consumeAdapterInboundAuthorization: (
    input: AdapterInboundAuthorizationInput,
  ) => Promise<boolean>;
  issueAdapterInboundRoute: (
    input: AdapterInboundRouteMetadata,
  ) => Promise<AdapterInboundRouteResult>;
  authorizeAdapterRunRoute: (
    input: AdapterRunRouteAuthorizationInput,
  ) => Promise<boolean>;
  issueAppPlacementCertificate: (
    input: UserKernelCapabilityProof,
  ) => Promise<AppPlacementCertificateGrant | null>;
  consumeMasterUserSignalAuthorization: (
    input: MasterUserSignalAuthorizationInput,
  ) => Promise<boolean>;
  consumePackageProjectionFenceAuthorization: (
    input: PackageProjectionFenceAuthorizationInput,
  ) => Promise<boolean>;
  consumeAppRunnerRuntimeFenceAuthorization: (
    input: AppRunnerRuntimeFenceAuthorizationInput,
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

class GenerationFencedMcpOAuthProvider extends BoundedMcpOAuthProvider {
  constructor(
    storage: DurableObjectStorage,
    clientName: string,
    callbackUrl: string,
    private readonly expectedUsername: string,
    private readonly expectedGeneration: number,
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
        || marker.generation !== this.expectedGeneration
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
  // Exact one-shot Master control handshakes.
  "consumeUserKernelLifecycleAuthorization",
  "applyMasterUserKernelLifecycle",
  "consumeUserKernelProvisioningAuthorization",
  "provisionUserKernel",
  "consumeUserKernelActivationAuthorization",
  "activateProvisionedUserKernel",
  // Scoped Gateway routing plus exact one-shot adapter target admission.
  "issueAdapterInboundRoute",
  "consumeAdapterInboundAuthorization",
  "serviceLinkedAdapterFrame",
  "consumeMasterUserSignalAuthorization",
  "receiveMasterUserSignal",
  // Master-to-user notices that pull or confirm authoritative Master state.
  "receiveMasterProjection",
  "consumePackageProjectionFenceAuthorization",
  "preparePackageProjectionFence",
  "refreshPackageProjectionFence",
  "consumeAppRunnerRuntimeFenceAuthorization",
  "onAppRuntimeLifecycleFenceRecoveryDue",
  "onUserKernelScheduleRearmRecoveryDue",
  "receiveMasterTokenRevocation",
  // Per-generation user-Kernel-capability authenticated Master operations.
  "authorizeAdapterRunRoute",
  "issueAppPlacementCertificate",
  "authenticateUserKernelConnection",
  "revokeUserKernelDeviceCredentials",
  "confirmTokenRevocationDelivery",
  "dispatchMasterSyscall",
  "mutateUserRepoMetadata",
  "authorizeUserRepoOperation",
  "getUserKernelProjection",
  // Gateway HTTP routing and public read seams.
  "resolveUserKernelRoute",
  "resolveUserKernelCallbackRoute",
  "resolveAppSessionKernel",
  "resolveAppFrameKernel",
  "authorizeGitHttp",
  "listPublicPackages",
  // Process-DO RPC, authenticated today by Kernel namespace plus registry pid.
  "recvFrame",
  "resolveProcessAuthority",
  "resolveProcessTeardownAuthority",
  "resolveProcessLifecycleFenceAuthority",
  "resolveProcessPackageProjectionFenceAuthority",
  "consumeProcessRollbackAuthorization",
  "requestProcessNetFetch",
  "cancelProcessRequests",
  // Scoped gateway service-binding RPC; the Kernel namespace is its capability.
  "serviceFrame",
  // AppRunner/package RPC; session-bearing calls also reauthorize local state.
  "appRequest",
  "authorizeAppFrame",
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
  private readonly projectionState: KernelProjectionState;
  private readonly appRuntimes: AppRuntimeRegistry;
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
  private readonly userKernelLifecycleAuthorizations = new Map<
    string,
    { expiresAt: number; transition: Omit<UserKernelLifecycleAuthorizationInput, "authorization"> }
  >();
  private readonly userKernelProvisioningAuthorizations = new Map<
    string,
    {
      expiresAt: number;
      provisioning: Omit<UserKernelProvisioningAuthorizationInput, "authorization">;
      kernelCapability: string;
    }
  >();
  private readonly userKernelActivationAuthorizations = new Map<
    string,
    {
      expiresAt: number;
      activation: Omit<UserKernelProvisioningAuthorizationInput, "authorization">;
    }
  >();
  private readonly processRollbackAuthorizations = new Map<
    string,
    { expiresAt: number; processId: string; generation: number | null }
  >();
  private readonly adapterInboundAuthorizations = new Map<
    string,
    {
      expiresAt: number;
      delivery: Omit<AdapterInboundAuthorizationInput, "authorization">;
    }
  >();
  private readonly masterUserSignalAuthorizations = new Map<
    string,
    {
      expiresAt: number;
      signal: Omit<MasterUserSignalAuthorizationInput, "authorization">;
    }
  >();
  private readonly packageProjectionFenceAuthorizations = new Map<
    string,
    {
      expiresAt: number;
      fence: Omit<PackageProjectionFenceAuthorizationInput, "authorization">;
    }
  >();
  private readonly appRunnerRuntimeFenceAuthorizations = new Map<
    string,
    PendingAppRunnerRuntimeFenceAuthorization
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
  private projectionInstallTail: Promise<void> = Promise.resolve();
  private masterProjectionMutationTail: Promise<void> = Promise.resolve();
  private pendingMasterProjectionCommit: Promise<void> | null = null;
  /** Set before a package transition enters the projection queue. */
  private masterPackageProjectionTransitionPending: string | null = null;
  private appPlacementSigningKeyPromise: Promise<MasterAppPlacementSigningKey> | null = null;
  private masterPackageFenceRecoveryQueued = false;
  private masterPackageFenceRecoveryAttempt = 0;
  private appRuntimeLifecycleFenceRecoveryQueued = false;
  private appRuntimeLifecycleFenceRecoveryAttempt = 0;
  private userKernelScheduleRearmRecoveryQueued = false;
  private userKernelScheduleRearmRecoveryAttempt = 0;
  private closedTargetOperationGeneration: number | null = null;
  private readonly activeTargetOperations = new Map<
    string,
    { generation: number; packageStamped: boolean; controller: AbortController }
  >();
  private readonly targetOperationDrainWaiters = new Map<
    number,
    Set<{ packageOnly: boolean; resolve: () => void }>
  >();

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
    const sql = ctx.storage.sql;
    runKernelSqlMigrations(ctx.storage);

    this.auth = new AuthStore(sql);
    this.tokenRevocations = new TokenRevocationStore(sql);
    this.userKernels = new UserKernelRegistry(sql);
    this.projectionState = new KernelProjectionState(sql);
    this.appRuntimes = new AppRuntimeRegistry(sql);
    if (this.instanceKind === "master") {
      this.ctx.storage.transactionSync(() => {
        this.projectionState.recoverPendingMasterRevision();
      });
    }
    if (this.instanceKind === "user") {
      this.userKernelMarker = parseUserKernelInstanceMarker(
        this.ctx.storage.kv.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
      );
    }

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

    if (this.instanceKind === "user" && this.userKernelMarker) {
      const lifecycleFence = this.appRuntimes.getLifecycleFence(
        this.userKernelMarker.uid,
      );
      if (lifecycleFence) {
        if (
          lifecycleFence.ownerUsername !== this.userKernelMarker.username
          || lifecycleFence.sourceKernelName !== this.name
        ) {
          throw new Error("AppRunner lifecycle fence identity mismatch");
        }
        this.closeUserKernelTargetAdmission(
          this.userKernelMarker.generation,
          "User Kernel lifecycle recovery is fenced",
        );
        this.fenceUserKernelRuntime("User Kernel lifecycle recovery is fenced");
      }
    }

    this.rehydrateConnections();
    if (
      this.instanceKind === "user"
      && this.userKernelMarker?.lifecycle === "active"
      && this.appRuntimes.getLifecycleFence(this.userKernelMarker.uid) === null
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
    for (const callId of this.ipcCalls.recoverDeliveryIds()) {
      this.queueIpcCallDelivery(callId);
    }
    if (this.instanceKind === "user" && this.projectionState.packageFence()) {
      this.ctx.waitUntil(this.recoverPackageProjectionFence().catch((error) => {
        console.warn("[Kernel] Package projection fence recovery remains fail-closed:", error);
      }));
    }
    if (this.instanceKind === "master" && this.projectionState.packageFence()) {
      this.queueMasterPackageFenceRecovery();
    }
    if (this.appRuntimes.listLifecycleFences().length > 0) {
      this.queueAppRuntimeLifecycleFenceRecovery();
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

  private beginMasterLegacyProcessOperation(
    record: ProcessRecord | null,
  ): (() => void) | null {
    if (this.instanceKind !== "master" || !record) return null;
    const placement = this.userKernels.getByUid(record.ownerUid);
    if (
      !placement
      || placement.lifecycle !== "legacy"
      || this.appRuntimes.getLifecycleFence(placement.uid) !== null
    ) {
      return null;
    }
    return this.beginMasterUserOperation(placement.username);
  }

  private beginMasterLegacyOwnerOperation(ownerUid: number): (() => void) | null {
    if (this.instanceKind !== "master") return null;
    const placement = this.userKernels.getByUid(ownerUid);
    if (
      !placement
      || placement.lifecycle !== "legacy"
      || this.appRuntimes.getLifecycleFence(placement.uid) !== null
    ) {
      return null;
    }
    return this.beginMasterUserOperation(placement.username);
  }

  private beginUserKernelTargetOperation(
    expectedGeneration: number,
    options: {
      packageStamped?: boolean;
      allowProvisioning?: boolean;
      allowLifecycleFence?: boolean;
      allowClosedAdmission?: boolean;
    } = {},
  ): UserKernelTargetOperationLease {
    const operationGeneration = this.instanceKind === "master"
      ? this.projectionState.masterRevision()
      : expectedGeneration;
    const initialPackageStamped = options.packageStamped === true;
    if (
      this.instanceKind === "master"
      && initialPackageStamped
      && this.projectionState.packageFence() !== null
    ) {
      throw new Error("Package authority projection is fenced");
    }
    const marker = this.userKernelMarker === undefined
      ? parseUserKernelInstanceMarker(
          this.ctx.storage.kv.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
        )
      : this.userKernelMarker;
    this.userKernelMarker = marker;
    const lifecycleAllowed = marker?.lifecycle === "active"
      || (options.allowProvisioning === true && marker?.lifecycle === "provisioning");
    const lifecycleFence = marker
      ? this.appRuntimes.getLifecycleFence(marker.uid)
      : null;
    const packageFence = initialPackageStamped ? this.projectionState.packageFence() : null;
    if (
      this.instanceKind === "user"
      && (
        !marker
        || !lifecycleAllowed
        || marker.generation !== expectedGeneration
        || (
          this.closedTargetOperationGeneration === expectedGeneration
          && options.allowClosedAdmission !== true
        )
        || (lifecycleFence !== null && options.allowLifecycleFence !== true)
        || (packageFence !== null && packageFence.kernelGeneration === expectedGeneration)
      )
    ) {
      throw new Error("User Kernel target operation admission is closed");
    }

    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    const activeOperation = {
      generation: operationGeneration,
      packageStamped: initialPackageStamped,
      controller,
    };
    this.activeTargetOperations.set(operationId, activeOperation);
    let released = false;
    const assertCurrent = () => {
      if (this.instanceKind === "master") {
        if (
          controller.signal.aborted
          || (
            activeOperation.packageStamped
            && this.projectionState.packageFence() !== null
          )
        ) {
          throw new Error("Master package authority operation was fenced");
        }
        return;
      }
      const current = this.userKernelMarker;
      const currentLifecycleAllowed = current?.lifecycle === "active"
        || (options.allowProvisioning === true && current?.lifecycle === "provisioning");
      const currentLifecycleFence = current
        ? this.appRuntimes.getLifecycleFence(current.uid)
        : null;
      if (
        controller.signal.aborted
        || !current
        || !currentLifecycleAllowed
        || current.generation !== expectedGeneration
        || (
          this.closedTargetOperationGeneration === expectedGeneration
          && options.allowClosedAdmission !== true
        )
        || (
          currentLifecycleFence !== null
          && options.allowLifecycleFence !== true
        )
        || (
          activeOperation.packageStamped
          && this.projectionState.packageFence()?.kernelGeneration === expectedGeneration
        )
      ) {
        throw new Error("User Kernel target operation was fenced");
      }
    };
    return {
      generation: operationGeneration,
      signal: controller.signal,
      markPackageStamped: () => {
        if (activeOperation.packageStamped) {
          assertCurrent();
          return;
        }
        const fence = this.projectionState.packageFence();
        if (
          fence !== null
          && (
            this.instanceKind === "master"
            || fence.kernelGeneration === expectedGeneration
          )
        ) {
          controller.abort(new Error("Package authority projection is fenced"));
          throw new Error("Package authority projection is fenced");
        }
        activeOperation.packageStamped = true;
        assertCurrent();
      },
      isPackageStamped: () => activeOperation.packageStamped,
      assertCurrent,
      release: () => {
        if (released) return;
        released = true;
        this.activeTargetOperations.delete(operationId);
        this.resolveTargetOperationDrainWaiters(operationGeneration);
      },
    };
  }

  private closeUserKernelTargetAdmission(
    generation: number,
    reason: string,
    packageOnly = false,
  ): void {
    if (!packageOnly) this.closedTargetOperationGeneration = generation;
    const error = new Error(reason);
    for (const operation of this.activeTargetOperations.values()) {
      if (
        operation.generation === generation
        && (!packageOnly || operation.packageStamped)
      ) {
        operation.controller.abort(error);
      }
    }
  }

  private waitForUserKernelTargetOperations(
    generation: number,
    packageOnly = false,
  ): Promise<void> {
    if (![...this.activeTargetOperations.values()].some((operation) => (
      operation.generation === generation
      && (!packageOnly || operation.packageStamped)
    ))) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters = this.targetOperationDrainWaiters.get(generation) ?? new Set();
      waiters.add({ packageOnly, resolve });
      this.targetOperationDrainWaiters.set(generation, waiters);
    });
  }

  private resolveTargetOperationDrainWaiters(generation: number): void {
    const waiters = this.targetOperationDrainWaiters.get(generation);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      const stillActive = [...this.activeTargetOperations.values()].some((operation) => (
        operation.generation === generation
        && (!waiter.packageOnly || operation.packageStamped)
      ));
      if (!stillActive) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
    if (waiters.size === 0) this.targetOperationDrainWaiters.delete(generation);
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

  private async requireActiveUserKernel(
    expectedGeneration?: number,
    options: { allowLifecycleFence?: boolean } = {},
  ): Promise<UserKernelInstanceMarker | null> {
    if (this.instanceKind === "master") {
      return null;
    }
    const marker = await this.loadUserKernelMarker();
    if (
      !marker
      || marker.lifecycle !== "active"
      || (expectedGeneration !== undefined && marker.generation !== expectedGeneration)
      || (
        this.appRuntimes.getLifecycleFence(marker.uid) !== null
        && options.allowLifecycleFence !== true
      )
    ) {
      throw new Error("User Kernel is not active");
    }
    return marker;
  }

  private async rotateUserKernelCapability(
    placement: UserKernelRecord,
  ): Promise<string> {
    this.assertMasterKernel();
    const secret = bytesToHex(crypto.getRandomValues(
      new Uint8Array(USER_KERNEL_CAPABILITY_BYTES),
    ));
    const record: MasterUserKernelCapabilityRecord = {
      version: 1,
      username: placement.username,
      uid: placement.uid,
      generation: placement.generation,
      digest: await hashUserKernelCapability(secret),
    };
    const current = this.userKernels.get(placement.username);
    if (!sameUserKernelPlacement(current, placement)) {
      throw new Error(`User Kernel placement changed for ${placement.username}`);
    }
    await this.ctx.storage.put(
      masterUserKernelCapabilityStorageKey(placement.username),
      record,
    );
    const persistedPlacement = this.userKernels.get(placement.username);
    if (!sameUserKernelPlacement(persistedPlacement, placement)) {
      throw new Error(`User Kernel placement changed for ${placement.username}`);
    }
    return secret;
  }

  private async authorizeUserKernelCapability(
    proof: UserKernelCapabilityProof,
  ): Promise<UserKernelRecord | null> {
    this.assertMasterKernel();
    const username = userKernelUsername(proof.sourceKernelName);
    const placement = username ? this.userKernels.get(username) : null;
    if (
      !username
      || !placement
      || !this.isActiveUserKernelPlacement(placement)
      || placement.uid !== proof.uid
      || placement.generation !== proof.generation
      || !isUserKernelCapabilitySecret(proof.kernelCapability)
    ) {
      return null;
    }

    if (!await this.verifyUserKernelCapabilityRecord(
      placement,
      proof.kernelCapability,
    )) {
      return null;
    }

    const current = this.userKernels.get(username);
    return current
      && this.isActiveUserKernelPlacement(current)
      && sameUserKernelPlacement(current, placement)
      ? current
      : null;
  }

  private async verifyUserKernelCapabilityRecord(
    placement: UserKernelRecord,
    secret: string,
  ): Promise<boolean> {
    if (!isUserKernelCapabilitySecret(secret)) return false;
    const record = parseMasterUserKernelCapabilityRecord(
      await this.ctx.storage.get<unknown>(
        masterUserKernelCapabilityStorageKey(placement.username),
      ),
    );
    if (
      !record
      || record.username !== placement.username
      || record.uid !== placement.uid
      || record.generation !== placement.generation
      || !constantTimeEqualHex(
        record.digest,
        await hashUserKernelCapability(secret),
      )
    ) {
      return false;
    }
    return sameUserKernelPlacement(
      this.userKernels.get(placement.username),
      placement,
    );
  }

  private async requireLocalUserKernelCapability(
    marker: UserKernelInstanceMarker,
    options: {
      allowProvisioning?: boolean;
      allowLifecycleFence?: boolean;
    } = {},
  ): Promise<string> {
    const record = parseLocalUserKernelCapabilityRecord(
      await this.ctx.storage.get<unknown>(USER_KERNEL_CAPABILITY_STORAGE_KEY),
    );
    if (
      !record
      || record.username !== marker.username
      || record.uid !== marker.uid
      || record.generation !== marker.generation
      || (
        this.appRuntimes.getLifecycleFence(marker.uid) !== null
        && options.allowLifecycleFence !== true
      )
      || !(options.allowProvisioning && marker.lifecycle === "provisioning"
        ? this.userKernelMarker === marker
        : this.isCurrentUserKernelMarker(marker, {
            allowLifecycleFence: options.allowLifecycleFence,
          }))
    ) {
      throw new Error("User Kernel capability is unavailable");
    }
    return record.secret;
  }

  private async masterAppPlacementSigningKey(): Promise<MasterAppPlacementSigningKey> {
    this.assertMasterKernel();
    const existing = this.appPlacementSigningKeyPromise;
    if (existing) return existing;

    const pending = this.loadOrCreateMasterAppPlacementSigningKey();
    this.appPlacementSigningKeyPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.appPlacementSigningKeyPromise === pending) {
        this.appPlacementSigningKeyPromise = null;
      }
      throw error;
    }
  }

  private async loadOrCreateMasterAppPlacementSigningKey(): Promise<
    MasterAppPlacementSigningKey
  > {
    const stored = await this.ctx.storage.get<unknown>(
      APP_PLACEMENT_SIGNING_KEY_STORAGE_KEY,
    );
    let record: AppPlacementSigningKeyRecord;
    if (stored === undefined) {
      if (await this.env.STORAGE.head(APP_PLACEMENT_VERIFICATION_KEY_OBJECT)) {
        // Never silently replace an edge trust anchor after Master key loss.
        // Recovery must explicitly remove the orphaned public record as part
        // of ship reset/recommissioning.
        throw new Error("Master app placement signing key recovery is required");
      }
      record = await generateAppPlacementSigningKeyRecord();
      await this.ctx.storage.put(APP_PLACEMENT_SIGNING_KEY_STORAGE_KEY, record);
    } else {
      const parsed = parseAppPlacementSigningKeyRecord(stored);
      if (!parsed) {
        throw new Error("Master app placement signing key is invalid");
      }
      record = parsed;
    }
    return {
      record,
      key: await importAppPlacementSigningKey(record),
    };
  }

  private async publishMasterAppPlacementVerificationKey(
    record: AppPlacementSigningKeyRecord,
  ): Promise<void> {
    const verificationRecord = appPlacementVerificationKeyRecord(record);
    await this.env.STORAGE.put(
      APP_PLACEMENT_VERIFICATION_KEY_OBJECT,
      serializeAppPlacementVerificationKeyRecord(verificationRecord),
      {
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
          cacheControl: "private, no-store",
        },
        customMetadata: {
          uid: "0",
          gid: "0",
          mode: "444",
          gsvInternal: "app-placement-verification-key-v1",
        },
      },
    );
  }

  private processKernelGenerationError(
    processId: string,
    marker: UserKernelInstanceMarker | null,
  ): string | null {
    if (!marker) {
      return null;
    }
    const record = this.procs.get(processId);
    if (!record) {
      return "Process registry record not found";
    }
    if (!processKernelGenerationMatches(record, marker.generation)) {
      return "Process belongs to a stale user Kernel generation";
    }
    return null;
  }

  private async authorizeCurrentPackageAgentRuntime(
    ownerUid: number,
    runAs: ProcessIdentity,
    packageSecurityRevision: string | null,
    requiredCall?: string,
    processId?: string,
  ): Promise<boolean> {
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

    const localPackageIdentity = packageAgentRuntimeIdentity(
      { config: this.config },
      runAs.uid,
    );
    if (packageSecurityRevision === null && localPackageIdentity.kind === "ordinary") {
      return true;
    }
    if (
      this.instanceKind === "master"
      && localPackageIdentity.kind !== "ordinary"
      && this.projectionState.packageFence() !== null
    ) {
      return false;
    }
    if (
      !localAccount
      || !canOwnerRunAsAccount(this.auth, ownerUid, localAccount, ownerUid === 0)
    ) {
      if (processId) this.queueRevokedProcessTeardown(processId, "Process delegation was revoked");
      return false;
    }

    let authorized = false;
    let marker: UserKernelInstanceMarker | null = null;
    if (this.instanceKind === "user") {
      try {
        marker = await this.requireActiveUserKernel();
      } catch {
        marker = null;
      }
      const installed = this.projectionState.installed();
      if (
        !marker
        || marker.uid !== ownerUid
        || !installed
        || installed.username !== marker.username
        || installed.uid !== marker.uid
        || installed.kernelGeneration !== marker.generation
      ) {
        if (processId && localPackageIdentity.kind !== "ordinary") {
          this.queueRevokedProcessTeardown(processId, "Package projection is unavailable");
        }
        return false;
      }
      if (
        localPackageIdentity.kind !== "ordinary"
        && this.projectionState.packageFence()?.kernelGeneration === marker.generation
      ) {
        if (processId) {
          this.queueRevokedProcessTeardown(
            processId,
            "Package authority projection is fenced",
          );
        }
        return false;
      }
    }
    authorized = await isPackageAgentRuntimeAuthorized(
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
    if (
      this.instanceKind === "master"
      && localPackageIdentity.kind !== "ordinary"
      && this.projectionState.packageFence() !== null
    ) {
      authorized = false;
    }
    if (
      marker
      && (
        !this.isCurrentUserKernelMarker(marker)
        || (
          localPackageIdentity.kind !== "ordinary"
          && this.projectionState.packageFence()?.kernelGeneration === marker.generation
        )
      )
    ) {
      authorized = false;
    }
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
    const actor = this.auth.getPasswdByUid(input.uid);
    if (!actor || actor.username !== input.username) {
      throw new Error("App session actor is invalid");
    }

    if (this.instanceKind === "master") {
      const placement = this.userKernels.get(input.username);
      if (
        !placement
        || placement.lifecycle !== "legacy"
        || placement.uid !== input.uid
      ) {
        throw new Error("App sessions require an active user Kernel");
      }
      return crypto.randomUUID();
    }

    const marker = await this.requireActiveUserKernel();
    if (!marker || this.name !== userKernelName(marker.username)) {
      throw new Error("App sessions require an active user Kernel");
    }
    const placementCertificate = await this.appPlacementCertificate(marker);
    const route = {
      username: marker.username,
      uid: marker.uid,
      generation: marker.generation,
      expiresAt: Date.now() + APP_SESSION_ROUTE_TTL_MS,
      nonce: crypto.randomUUID(),
      placementCertificate,
    };
    const signature = await this.signAppSessionRoute(
      buildRoutedAppSessionSigningInput(route),
    );
    const current = await this.requireActiveUserKernel(marker.generation);
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

  private async appPlacementCertificate(
    marker: UserKernelInstanceMarker,
  ): Promise<string> {
    const stored = this.ctx.storage.kv.get<unknown>(
      APP_PLACEMENT_CERTIFICATE_STORAGE_KEY,
    );
    if (stored !== undefined) {
      const cached = parseAppPlacementCertificateGrant(stored);
      if (!cached) {
        throw new Error("Cached app placement certificate is invalid");
      }
      if (
        cached.username === marker.username
        && cached.uid === marker.uid
        && cached.generation === marker.generation
      ) {
        return cached.certificate;
      }
    }

    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const issued = parseAppPlacementCertificateGrant(
      await master.issueAppPlacementCertificate({
        sourceKernelName: this.name,
        uid: marker.uid,
        generation: marker.generation,
        kernelCapability,
      }),
    );
    if (
      !issued
      || issued.username !== marker.username
      || issued.uid !== marker.uid
      || issued.generation !== marker.generation
    ) {
      throw new Error("Master denied app placement certificate issuance");
    }
    const current = await this.requireActiveUserKernel(marker.generation);
    if (
      !current
      || current.username !== marker.username
      || current.uid !== marker.uid
      || this.name !== userKernelName(current.username)
    ) {
      throw new Error("App placement certificate issuance denied");
    }
    this.ctx.storage.kv.put(APP_PLACEMENT_CERTIFICATE_STORAGE_KEY, issued);
    return issued.certificate;
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

  /** Consume the one-shot authorization created by the Master transition. */
  async consumeUserKernelLifecycleAuthorization(
    input: UserKernelLifecycleAuthorizationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    const authorization = typeof input.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.userKernelLifecycleAuthorizations.get(authorization);
    this.userKernelLifecycleAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || !sameUserKernelLifecycleAuthorization(
        pending.transition,
        input,
      )
    ) {
      return false;
    }

    const username = canonicalizeLoginUsername(input.username);
    const current = username ? this.userKernels.get(username) : null;
    if (
      !username
      || username !== input.username
      || input.targetKernelName !== userKernelName(username)
      || !current
      || current.uid !== input.uid
      || current.lifecycle !== input.expectedLifecycle
      || current.generation !== input.expectedGeneration
      || !["provisioning", "suspended", "retired"].includes(input.lifecycle)
    ) {
      return false;
    }
    try {
      const desired = describeUserKernelLifecycleTransition(current, input.lifecycle);
      return desired.lifecycle === input.lifecycle
        && desired.generation === input.generation;
    } catch {
      return false;
    }
  }

  /**
   * Internal Master control seam for an eventual authenticated admin syscall.
   * New admissions stop synchronously, existing Master mutations drain, and
   * the target durably fences itself before the Master commits the placement.
   * A failed target call leaves the Master unchanged; a failed Master commit
   * leaves the target closed. Either outcome is fail-closed and retryable.
   */
  async transitionUserKernelLifecycle(input: {
    username: string;
    expectedGeneration: number;
    lifecycle: Extract<UserKernelLifecycle, "provisioning" | "suspended" | "retired">;
  }): Promise<UserKernelRecord> {
    this.assertMasterKernel();
    if (
      this.projectionState.packageFence() !== null
      || this.masterPackageProjectionTransitionPending !== null
    ) {
      throw new Error("User Kernel lifecycle changes are blocked by package projection recovery");
    }
    const username = canonicalizeLoginUsername(input.username);
    const current = username ? this.userKernels.get(username) : null;
    if (
      !username
      || username !== input.username
      || !current
      || !Number.isSafeInteger(input.expectedGeneration)
      || input.expectedGeneration <= 0
      || current.generation !== input.expectedGeneration
      || !["provisioning", "suspended", "retired"].includes(input.lifecycle)
    ) {
      throw new Error(`User Kernel generation mismatch for ${input.username}`);
    }

    const transitions = this.transitioningUserKernels ??= new Set<string>();
    if (transitions.has(username)) {
      throw new Error(`User Kernel transition is already in progress for ${username}`);
    }
    transitions.add(username);
    try {
      await this.waitForMasterUserOperations(username);
      const admitted = this.userKernels.get(username);
      if (
        !admitted
        || admitted.uid !== current.uid
        || admitted.lifecycle !== current.lifecycle
        || admitted.generation !== current.generation
      ) {
        throw new Error(`User Kernel generation mismatch for ${username}`);
      }

      const desired = describeUserKernelLifecycleTransition(admitted, input.lifecycle);
      if (admitted.lifecycle === "legacy") {
        const lifecycleFence = this.ensureMasterLegacyAppRuntimeLifecycleFence(
          admitted,
          desired.lifecycle,
        );
        await this.fenceMasterLegacyUserRuntime(admitted, lifecycleFence);
      }
      const authorization = crypto.randomUUID();
      const authorizedTransition: Omit<
        UserKernelLifecycleAuthorizationInput,
        "authorization"
      > = {
        targetKernelName: userKernelName(username),
        username,
        uid: admitted.uid,
        expectedLifecycle: admitted.lifecycle,
        expectedGeneration: admitted.generation,
        generation: desired.generation,
        lifecycle: desired.lifecycle,
      };
      this.userKernelLifecycleAuthorizations.set(authorization, {
        expiresAt: Date.now() + USER_KERNEL_LIFECYCLE_AUTHORIZATION_TTL_MS,
        transition: authorizedTransition,
      });
      let marker: UserKernelInstanceMarker;
      try {
        marker = await this.applyUserKernelLifecycleTargetFence({
          sourceKernelName: this.name,
          authorization,
          username,
          uid: admitted.uid,
          expectedLifecycle: admitted.lifecycle,
          expectedGeneration: admitted.generation,
          generation: desired.generation,
          lifecycle: desired.lifecycle,
        });
      } finally {
        this.userKernelLifecycleAuthorizations.delete(authorization);
      }
      if (
        marker.username !== desired.username
        || marker.uid !== desired.uid
        || marker.generation !== desired.generation
        || marker.lifecycle !== desired.lifecycle
      ) {
        throw new Error(`User Kernel lifecycle fence failed for ${username}`);
      }

      const beforeCommit = this.userKernels.get(username);
      if (!beforeCommit || !sameUserKernelPlacement(beforeCommit, admitted)) {
        throw new Error(`User Kernel generation mismatch for ${username}`);
      }
      const committed = this.commitUserKernelLifecycleTransition(
        username,
        admitted,
        input.lifecycle,
      );
      if (
        committed.uid !== desired.uid
        || committed.lifecycle !== desired.lifecycle
        || committed.generation !== desired.generation
      ) {
        throw new Error(`User Kernel lifecycle barrier failed for ${username}`);
      }
      return committed;
    } finally {
      transitions.delete(username);
      if (this.appRuntimes.getLifecycleFence(current.uid)) {
        this.queueAppRuntimeLifecycleFenceRecovery(1);
      }
    }
  }

  private ensureMasterLegacyAppRuntimeLifecycleFence(
    placement: UserKernelRecord,
    targetLifecycle: AppRuntimeLifecycleFence["targetLifecycle"],
  ): AppRuntimeLifecycleFence {
    this.assertMasterKernel();
    if (placement.lifecycle !== "legacy") {
      throw new Error("Legacy AppRunner lifecycle fence requires legacy placement");
    }
    const existing = this.appRuntimes.getLifecycleFence(placement.uid);
    if (existing) {
      if (
        existing.ownerUsername !== placement.username
        || existing.sourceKernelName !== SHIP_KERNEL_NAME
        || existing.generation !== placement.generation
        || existing.targetLifecycle !== targetLifecycle
      ) {
        throw new Error("A different legacy AppRunner lifecycle fence is active");
      }
      return existing;
    }
    return this.appRuntimes.beginLifecycleFence({
      ownerUid: placement.uid,
      ownerUsername: placement.username,
      sourceKernelName: SHIP_KERNEL_NAME,
      generation: placement.generation,
      fenceId: crypto.randomUUID(),
      targetLifecycle,
      createdAt: Date.now(),
    });
  }

  private async fenceMasterLegacyUserRuntime(
    placement: UserKernelRecord,
    fence: AppRuntimeLifecycleFence,
  ): Promise<void> {
    this.assertMasterKernel();
    const reason = "User Kernel is migrating from the legacy runtime";
    const connectionIds = new Set<string>();
    for (const [connectionId, connection] of this.connections) {
      if (connection.state?.identity?.process.uid !== placement.uid) continue;
      connectionIds.add(connectionId);
      connection.close(1008, reason);
    }
    for (const [requestId, active] of [...this.activeRequests]) {
      const belongsToOwner = active.origin.type === "connection"
        ? connectionIds.has(active.origin.id)
        : active.origin.type === "process"
          ? this.procs.get(active.origin.id)?.ownerUid === placement.uid
          : false;
      if (belongsToOwner) {
        this.cancelRequest(active.origin, requestId, reason, false);
      }
    }
    for (const [scheduleId, controller] of this.activeScheduleRuns) {
      if (this.schedules.getStored(scheduleId)?.ownerUid === placement.uid) {
        controller.abort(new Error(reason));
      }
    }
    this.schedules.releaseInterruptedRunsForOwner(placement.uid, reason);
    const ownedProcessIds = this.procs.list()
      .filter((process) => process.ownerUid === placement.uid)
      .map((process) => process.processId);
    const origins: RouteOrigin[] = [
      ...[...connectionIds].map((id) => ({ type: "connection" as const, id })),
      ...ownedProcessIds.map((id) => ({ type: "process" as const, id })),
    ];
    const routeWakeCancellations: Promise<unknown>[] = [];
    for (let offset = 0; offset < origins.length; offset += 256) {
      for (const route of this.routes.drainForOrigins(origins.slice(offset, offset + 256))) {
        this.sendDeviceRequestCancel(
          route.deviceId,
          route.driverConnectionId,
          route.id,
          reason,
        );
        this.cancelRoutedBody(route.id, reason);
        if (route.scheduleId) {
          routeWakeCancellations.push(this.cancelSchedule(route.scheduleId));
        }
      }
    }
    await Promise.all(routeWakeCancellations);
    this.runRoutes.clearForUid(placement.uid);
    await this.abortFencedUserKernelProcesses(
      fence.generation,
      reason,
      placement.uid,
    );
    await this.prepareRegisteredAppRunners({
      fenceKind: "user-lifecycle",
      ownerUid: placement.uid,
      ownerUsername: placement.username,
      generation: fence.generation,
      fenceId: fence.fenceId,
    });
  }

  private queueAppRuntimeLifecycleFenceRecovery(delaySeconds = 0): void {
    if (
      this.appRuntimes.listLifecycleFences().length === 0
      || this.appRuntimeLifecycleFenceRecoveryQueued
    ) {
      return;
    }
    this.appRuntimeLifecycleFenceRecoveryQueued = true;
    if (delaySeconds > 0) {
      this.ctx.waitUntil(this.schedule(
        delaySeconds,
        "onAppRuntimeLifecycleFenceRecoveryDue",
      ).then(() => undefined).catch(() => {
        this.appRuntimeLifecycleFenceRecoveryQueued = false;
      }));
      return;
    }
    this.ctx.waitUntil(Promise.resolve().then(
      () => this.onAppRuntimeLifecycleFenceRecoveryDue(),
    ));
  }

  async onAppRuntimeLifecycleFenceRecoveryDue(): Promise<void> {
    this.appRuntimeLifecycleFenceRecoveryQueued = false;
    if (this.appRuntimes.listLifecycleFences().length === 0) {
      this.appRuntimeLifecycleFenceRecoveryAttempt = 0;
      return;
    }
    try {
      await this.recoverAppRuntimeLifecycleFences();
      this.appRuntimeLifecycleFenceRecoveryAttempt = 0;
    } catch {
      this.appRuntimeLifecycleFenceRecoveryAttempt += 1;
      const retrySeconds = Math.min(
        2 ** Math.min(this.appRuntimeLifecycleFenceRecoveryAttempt - 1, 6),
        PACKAGE_PROJECTION_RECOVERY_MAX_DELAY_SECONDS,
      );
      this.queueAppRuntimeLifecycleFenceRecovery(retrySeconds);
    }
  }

  private async recoverAppRuntimeLifecycleFences(): Promise<void> {
    const fences = this.appRuntimes.listLifecycleFences();
    if (this.instanceKind === "master") {
      for (const fence of fences) {
        if (fence.sourceKernelName !== SHIP_KERNEL_NAME) {
          throw new Error("AppRunner lifecycle fence source mismatch");
        }
        const placement = this.userKernels.getByUid(fence.ownerUid);
        if (!placement || placement.username !== fence.ownerUsername) {
          throw new Error("AppRunner lifecycle fence owner mismatch");
        }
        if (placement.lifecycle === "active") {
          await this.completeUserKernelActivation(placement);
          continue;
        }
        if (placement.lifecycle === "legacy") {
          await this.transitionUserKernelLifecycle({
            username: placement.username,
            expectedGeneration: placement.generation,
            lifecycle: fence.targetLifecycle,
          });
          continue;
        }
        await this.fenceMasterLegacyUserRuntime(placement, fence);
      }
      return;
    }

    if (fences.length !== 1) {
      throw new Error("User Kernel AppRunner lifecycle fence cardinality mismatch");
    }
    const fence = fences[0]!;
    const marker = await this.loadUserKernelMarker();
    if (
      !marker
      || marker.uid !== fence.ownerUid
      || marker.username !== fence.ownerUsername
      || fence.sourceKernelName !== this.name
    ) {
      throw new Error("User Kernel AppRunner lifecycle fence identity mismatch");
    }
    this.closeUserKernelTargetAdmission(
      marker.generation,
      "User Kernel lifecycle recovery is fenced",
    );
    this.fenceUserKernelRuntime("User Kernel lifecycle recovery is fenced");
    await this.waitForUserKernelTargetOperations(marker.generation);
    if (marker.lifecycle !== "active") {
      await this.abortFencedUserKernelProcesses(
        fence.generation,
        "User Kernel lifecycle recovery is fenced",
      );
      await this.prepareRegisteredAppRunners({
        fenceKind: "user-lifecycle",
        ownerUid: fence.ownerUid,
        ownerUsername: fence.ownerUsername,
        generation: fence.generation,
        fenceId: fence.fenceId,
      });
    }
    if (marker.lifecycle !== "active" && marker.lifecycle !== "provisioning") {
      return;
    }

    const kernelCapability = await this.requireLocalUserKernelCapability(marker, {
      allowProvisioning: true,
      allowLifecycleFence: true,
    });
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const projection = await master.getUserKernelProjection(
      this.name,
      marker.username,
      marker.generation,
      kernelCapability,
    );
    const current = await this.loadUserKernelMarker();
    if (!sameUserKernelInstanceMarker(current, marker)) {
      throw new Error("User Kernel lifecycle changed during activation recovery");
    }
    await this.activateUserKernelFromProjection(marker, projection, marker.username);
  }

  private commitUserKernelLifecycleTransition(
    username: string,
    current: UserKernelRecord,
    lifecycle: Extract<UserKernelLifecycle, "provisioning" | "suspended" | "retired">,
  ): UserKernelRecord {
    switch (lifecycle) {
      case "provisioning":
        return this.userKernels.beginProvisioning(username, current.generation);
      case "suspended":
        return this.userKernels.suspend(username, current.generation);
      case "retired":
        return this.userKernels.retire(username, current.generation);
    }
  }

  private async applyUserKernelLifecycleTargetFence(
    transition: UserKernelLifecycleTransition,
  ): Promise<UserKernelInstanceMarker> {
    const target = await getAgentByName(
      this.env.KERNEL,
      userKernelName(transition.username),
    ) as unknown as {
      applyMasterUserKernelLifecycle: (
        input: UserKernelLifecycleTransition,
      ) => Promise<UserKernelInstanceMarker>;
    };
    return target.applyMasterUserKernelLifecycle(transition);
  }

  private ensureTargetAppRuntimeLifecycleFence(
    input: UserKernelLifecycleTransition,
  ): AppRuntimeLifecycleFence | null {
    if (input.expectedLifecycle === "legacy") {
      // The singleton owns and fences every legacy AppRunner until the first
      // successful activation has completed.
      return null;
    }
    const existing = this.appRuntimes.getLifecycleFence(input.uid);
    if (existing) {
      const sameOwner = existing.ownerUsername === input.username
        && existing.sourceKernelName === this.name;
      const exactRetry = existing.generation === input.expectedGeneration
        && existing.targetLifecycle === input.lifecycle;
      const reactivation = input.expectedLifecycle === "suspended"
        || input.expectedLifecycle === "provisioning";
      if (!sameOwner || (!exactRetry && !reactivation)) {
        throw new Error("A different AppRunner lifecycle fence is active");
      }
      return existing;
    }
    return this.appRuntimes.beginLifecycleFence({
      ownerUid: input.uid,
      ownerUsername: input.username,
      sourceKernelName: this.name,
      generation: input.expectedGeneration,
      fenceId: crypto.randomUUID(),
      targetLifecycle: input.lifecycle,
      createdAt: Date.now(),
    });
  }

  private ensureProvisioningAppRuntimeLifecycleFence(
    marker: UserKernelInstanceMarker,
  ): AppRuntimeLifecycleFence {
    if (marker.lifecycle !== "provisioning") {
      throw new Error("User Kernel provisioning fence requires provisioning state");
    }
    const existing = this.appRuntimes.getLifecycleFence(marker.uid);
    if (existing) {
      if (
        existing.ownerUsername !== marker.username
        || existing.sourceKernelName !== this.name
        || existing.generation > marker.generation
      ) {
        throw new Error("User Kernel provisioning fence identity mismatch");
      }
      return existing;
    }
    return this.appRuntimes.beginLifecycleFence({
      ownerUid: marker.uid,
      ownerUsername: marker.username,
      sourceKernelName: this.name,
      generation: marker.generation,
      fenceId: crypto.randomUUID(),
      targetLifecycle: "provisioning",
      createdAt: Date.now(),
    });
  }

  /**
   * Target-side lifecycle fence. Only a transition matching the Master's
   * current placement is accepted. The durable AppRunner fence intent and
   * in-memory admission close precede teardown; the non-active marker is
   * committed only after every owned runtime has exact-acknowledged the fence.
   */
  async applyMasterUserKernelLifecycle(
    input: UserKernelLifecycleTransition,
  ): Promise<UserKernelInstanceMarker> {
    const instanceUsername = this.instanceUsername;
    if (
      this.instanceKind !== "user"
      || !instanceUsername
      || input.sourceKernelName !== SHIP_KERNEL_NAME
      || typeof input.authorization !== "string"
      || input.authorization.length === 0
      || input.username !== instanceUsername
      || canonicalizeLoginUsername(input.username) !== input.username
      || this.name !== userKernelName(input.username)
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || !Number.isSafeInteger(input.expectedGeneration)
      || input.expectedGeneration <= 0
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
      || !["legacy", "provisioning", "active", "suspended", "retired"].includes(
        input.expectedLifecycle,
      )
      || !["provisioning", "suspended", "retired"].includes(input.lifecycle)
    ) {
      throw new Error("User Kernel lifecycle transition denied");
    }

    const authorized = await this.isMasterUserKernelLifecycleAuthorized({
      targetKernelName: this.name,
      authorization: input.authorization,
      username: input.username,
      uid: input.uid,
      expectedLifecycle: input.expectedLifecycle,
      expectedGeneration: input.expectedGeneration,
      generation: input.generation,
      lifecycle: input.lifecycle,
    });
    if (!authorized) {
      throw new Error("User Kernel lifecycle transition denied");
    }

    const existing = await this.loadUserKernelMarker();
    const existingIsExpected = Boolean(
      existing
      && existing.username === input.username
      && existing.uid === input.uid
      && existing.generation === input.expectedGeneration
      && existing.lifecycle === input.expectedLifecycle,
    );
    const existingIsDesired = Boolean(
      existing
      && existing.username === input.username
      && existing.uid === input.uid
      && existing.generation === input.generation
      && existing.lifecycle === input.lifecycle,
    );
    const existingIsValidPredecessor = Boolean(
      existing
      && isValidUserKernelLifecyclePredecessor(existing, input),
    );
    if (
      existing
      && !existingIsExpected
      && !existingIsDesired
      && !existingIsValidPredecessor
    ) {
      throw new Error("User Kernel lifecycle identity mismatch");
    }
    if (
      !existing
      && input.expectedLifecycle !== "legacy"
      && input.expectedLifecycle !== "provisioning"
      && input.lifecycle !== "provisioning"
      && input.lifecycle !== "retired"
    ) {
      throw new Error("User Kernel lifecycle marker is missing");
    }

    const marker: UserKernelInstanceMarker = {
      version: 1,
      kind: "user",
      username: input.username,
      uid: input.uid,
      generation: input.generation,
      lifecycle: input.lifecycle,
      updatedAt: Date.now(),
    };
    this.closeUserKernelTargetAdmission(
      input.expectedGeneration,
      "User Kernel is not active",
    );
    const lifecycleFence = this.ensureTargetAppRuntimeLifecycleFence(input);
    try {
      this.fenceUserKernelRuntime("User Kernel is not active");
      await this.waitForUserKernelTargetOperations(input.expectedGeneration);
      await this.abortFencedUserKernelProcesses(
        input.expectedGeneration,
        "User Kernel is not active",
      );
      if (lifecycleFence) {
        await this.prepareRegisteredAppRunners({
          fenceKind: "user-lifecycle",
          ownerUid: lifecycleFence.ownerUid,
          ownerUsername: lifecycleFence.ownerUsername,
          generation: lifecycleFence.generation,
          fenceId: lifecycleFence.fenceId,
        });
      }
      await this.ctx.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, marker);
      this.userKernelMarker = marker;
      if (marker.lifecycle === "provisioning") {
        this.closedTargetOperationGeneration = null;
      }
      return marker;
    } catch (error) {
      if (lifecycleFence) this.queueAppRuntimeLifecycleFenceRecovery(1);
      throw error;
    }
  }

  private async abortFencedUserKernelProcesses(
    fencedGeneration: number,
    reason: string,
    ownerUid?: number,
  ): Promise<void> {
    const processes = this.procs.list().filter((record) => (
      this.instanceKind === "master"
        ? record.kernelGeneration === null && record.ownerUid === ownerUid
        : processKernelGenerationMatches(record, fencedGeneration)
    ));
    await Promise.all(processes.map(async (record) => {
      const requestId = crypto.randomUUID();
      const response = await sendFrameToProcess(record.processId, {
        type: "req",
        id: requestId,
        call: "proc.abort",
        args: {
          pid: record.processId,
          lifecycleFenceGeneration: fencedGeneration,
        } as { pid: string; lifecycleFenceGeneration: number },
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
        || data.pid !== record.processId
      ) {
        throw new Error(`Process did not exact-ack lifecycle fence: ${record.processId}`);
      }

      const current = this.procs.get(record.processId);
      if (
        !current
        || current.uid !== record.uid
        || current.ownerUid !== record.ownerUid
        || current.kernelGeneration !== record.kernelGeneration
      ) {
        throw new Error(`Process identity changed during lifecycle fence: ${record.processId}`);
      }
      if (record.activeRunId) {
        const finished: SignalFrame = {
          type: "sig",
          signal: "proc.run.finished",
          payload: {
            pid: record.processId,
            runId: record.activeRunId,
            conversationId: record.activeConversationId,
            status: "aborted",
            reason: "kernel.lifecycle",
            aborted: true,
            queuedCount: record.queuedCount,
            timestamp: Date.now(),
          },
        };
        this.updateProcessRuntimeFromSignal(record.processId, finished, record.activeRunId);
        this.completeIpcCallsForProcessSignal(record.processId, finished);
        this.runRoutes.delete(record.activeRunId);
      }
    }));
  }

  private async isMasterUserKernelLifecycleAuthorized(
    input: UserKernelLifecycleAuthorizationInput,
  ): Promise<boolean> {
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    return master.consumeUserKernelLifecycleAuthorization(input);
  }

  /** Consume the exact, one-shot provisioning request and return Master-owned state. */
  async consumeUserKernelProvisioningAuthorization(
    input: UserKernelProvisioningAuthorizationInput,
  ): Promise<AuthorizedUserKernelProvisioningSnapshot | null> {
    this.assertMasterKernel();
    if (this.projectionState.packageFence() !== null) return null;
    const authorization = typeof input?.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.userKernelProvisioningAuthorizations.get(authorization);
    this.userKernelProvisioningAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || !sameUserKernelProvisioningAuthorization(
        pending.provisioning,
        input,
      )
    ) {
      return null;
    }

    const username = canonicalizeLoginUsername(input.username);
    const placement = username ? this.userKernels.get(username) : null;
    if (
      !username
      || username !== input.username
      || input.targetKernelName !== userKernelName(username)
      || !placement
      || placement.uid !== input.uid
      || placement.lifecycle !== "provisioning"
      || placement.generation !== input.generation
    ) {
      return null;
    }

    const snapshot = await this.buildCommittedUserKernelProjection(username);
    const current = this.userKernels.get(username);
    if (
      !current
      || current.uid !== input.uid
      || current.lifecycle !== "provisioning"
      || current.generation !== input.generation
      || this.projectionState.packageFence() !== null
    ) {
      return null;
    }
    return { ...snapshot, kernelCapability: pending.kernelCapability };
  }

  /** Consume the exact, one-shot activation confirmation after Master commit. */
  async consumeUserKernelActivationAuthorization(
    input: UserKernelActivationAuthorizationInput,
  ): Promise<UserKernelProvisioningSnapshot | null> {
    this.assertMasterKernel();
    if (this.projectionState.packageFence() !== null) return null;
    const authorization = typeof input?.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.userKernelActivationAuthorizations.get(authorization);
    this.userKernelActivationAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || !sameUserKernelProvisioningAuthorization(
        pending.activation,
        input,
      )
    ) {
      return null;
    }

    const username = canonicalizeLoginUsername(input.username);
    const placement = username ? this.userKernels.get(username) : null;
    if (
      !username
      || username !== input.username
      || input.targetKernelName !== userKernelName(username)
      || !placement
      || placement.uid !== input.uid
      || placement.lifecycle !== "active"
      || placement.generation !== input.generation
      || !await this.verifyUserKernelCapabilityRecord(
        placement,
        input.kernelCapability,
      )
    ) {
      return null;
    }
    const snapshot = await this.buildCommittedUserKernelProjection(username);
    const current = this.userKernels.get(username);
    return current
      && current.uid === input.uid
      && current.lifecycle === "active"
      && current.generation === input.generation
      && this.projectionState.packageFence() === null
      ? snapshot
      : null;
  }

  async provisionUserKernel(
    input: UserKernelProvisioningTargetInput,
  ): Promise<UserKernelInstanceMarker> {
    const instanceUsername = this.instanceUsername;
    if (
      this.instanceKind !== "user"
      || !instanceUsername
      || input?.sourceKernelName !== SHIP_KERNEL_NAME
      || typeof input.authorization !== "string"
      || input.authorization.length === 0
      || input.username !== instanceUsername
      || canonicalizeLoginUsername(input.username) !== input.username
      || this.name !== userKernelName(input.username)
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
    ) {
      throw new Error("User Kernel provisioning denied");
    }

    const authorizedSnapshot = await this.pullAuthorizedUserKernelProvisioningSnapshot({
      targetKernelName: this.name,
      authorization: input.authorization,
      username: input.username,
      uid: input.uid,
      generation: input.generation,
    });
    if (!authorizedSnapshot) {
      throw new Error("User Kernel provisioning denied");
    }
    const { kernelCapability, ...snapshot } = authorizedSnapshot;
    validateUserKernelProvisioningSnapshot(snapshot, instanceUsername);
    if (
      snapshot.username !== input.username
      || snapshot.uid !== input.uid
      || snapshot.generation !== input.generation
      || !isUserKernelCapabilitySecret(kernelCapability)
    ) {
      throw new Error("User Kernel provisioning identity mismatch");
    }

    const existing = parseUserKernelInstanceMarker(
      await this.ctx.storage.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
    );
    if (existing) {
      if (
        existing.username !== snapshot.username
        || existing.uid !== snapshot.uid
        || existing.generation !== snapshot.generation
        || (existing.lifecycle !== "provisioning" && existing.lifecycle !== "active")
      ) {
        throw new Error("User Kernel provisioning identity mismatch");
      }
    }

    const provisioning: UserKernelInstanceMarker = {
      version: 1,
      kind: "user",
      username: snapshot.username,
      uid: snapshot.uid,
      generation: snapshot.generation,
      lifecycle: "provisioning",
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, provisioning);
    this.userKernelMarker = provisioning;
    if (existing?.lifecycle === "active") {
      this.fenceUserKernelRuntime("User Kernel is not active");
      await this.cancelPendingScheduleWakes();
    }
    const capabilityRecord: LocalUserKernelCapabilityRecord = {
      version: 1,
      username: provisioning.username,
      uid: provisioning.uid,
      generation: provisioning.generation,
      secret: kernelCapability,
    };
    await this.ctx.storage.put(USER_KERNEL_CAPABILITY_STORAGE_KEY, capabilityRecord);

    const provisioningFence = this.ensureProvisioningAppRuntimeLifecycleFence(provisioning);
    await this.prepareRegisteredAppRunners({
      fenceKind: "user-lifecycle",
      ownerUid: provisioningFence.ownerUid,
      ownerUsername: provisioningFence.ownerUsername,
      generation: provisioningFence.generation,
      fenceId: provisioningFence.fenceId,
    });

    let executorPid: string | null = null;
    try {
      executorPid = await this.initializeUserKernelProvisioning(snapshot, provisioning);

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
      const executor = executorPid ? this.procs.get(executorPid) : null;
      const isFencedPredecessor = Boolean(
        executor
        && provisioning.generation > 1
        && executor.kernelGeneration === provisioning.generation - 1,
      );
      if (executorPid && !isFencedPredecessor) {
        try {
          await this.rollbackProvisionedUserKernelExecutor(executorPid);
        } catch (rollbackError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; executor rollback failed: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`,
            { cause: error },
          );
        }
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
      || typeof input.authorization !== "string"
      || input.authorization.length === 0
      || input.username !== instanceUsername
      || canonicalizeLoginUsername(input.username) !== input.username
      || this.name !== userKernelName(input.username)
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
    ) {
      throw new Error("User Kernel activation denied");
    }

    const existing = await this.loadUserKernelMarker();
    if (
      !existing
      || existing.username !== input.username
      || existing.uid !== input.uid
      || existing.generation !== input.generation
      || (existing.lifecycle !== "provisioning" && existing.lifecycle !== "active")
    ) {
      throw new Error("User Kernel activation identity mismatch");
    }

    const kernelCapability = await this.requireLocalUserKernelCapability(existing, {
      allowProvisioning: true,
      allowLifecycleFence: true,
    });
    const projection = await this.pullAuthorizedUserKernelActivationProjection({
      targetKernelName: this.name,
      authorization: input.authorization,
      username: input.username,
      uid: input.uid,
      generation: input.generation,
      kernelCapability,
    });
    if (!projection) {
      throw new Error("User Kernel activation denied");
    }
    return await this.activateUserKernelFromProjection(existing, projection, instanceUsername);
  }

  private async activateUserKernelFromProjection(
    existing: UserKernelInstanceMarker,
    projection: UserKernelProvisioningSnapshot,
    instanceUsername: string,
  ): Promise<UserKernelInstanceMarker> {
    const lifecycleFence = existing.lifecycle === "provisioning"
      ? this.ensureProvisioningAppRuntimeLifecycleFence(existing)
      : this.appRuntimes.getLifecycleFence(existing.uid);
    if (lifecycleFence) {
      if (
        lifecycleFence.ownerUsername !== existing.username
        || lifecycleFence.sourceKernelName !== this.name
      ) {
        throw new Error("User Kernel AppRunner lifecycle fence identity mismatch");
      }
      this.closeUserKernelTargetAdmission(
        existing.generation,
        "User Kernel activation is fenced",
      );
    }
    const active: UserKernelInstanceMarker = existing.lifecycle === "active"
      ? existing
      : {
          version: 1,
          kind: "user",
          username: existing.username,
          uid: existing.uid,
          generation: existing.generation,
          lifecycle: "active",
          updatedAt: Date.now(),
        };
    let activationCommitStarted = existing.lifecycle === "active" && lifecycleFence !== null;
    try {
      if (this.userKernelMarker !== existing) {
        throw new Error("User Kernel lifecycle changed during activation");
      }
      validateUserKernelProvisioningSnapshot(projection, instanceUsername);
      if (
        projection.username !== existing.username
        || projection.uid !== existing.uid
        || projection.generation !== existing.generation
      ) {
        throw new Error("User Kernel activation projection mismatch");
      }
      await this.installUserKernelProjection(projection, {
        allowLifecycleFence: lifecycleFence !== null,
        allowClosedAdmission: lifecycleFence !== null,
      });
      if (existing.lifecycle === "provisioning") {
        await this.discardPreparedUserKernelExecutors(existing);
        this.rebindFencedUserKernelProcesses(existing);
        try {
          await this.ensureUserKernelProvisioningExecutor(existing);
        } catch (error) {
          throw new Error(
            `User Kernel executor activation failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      }

      if (existing.lifecycle !== "active") {
        // A failed acknowledgement after this point is an ambiguous active
        // commit and must run the same fail-closed recovery as a rearm error.
        activationCommitStarted = true;
        await this.ctx.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, active);
        this.userKernelMarker = active;
      }

      if (!this.isCurrentUserKernelMarker(active, { allowLifecycleFence: true })) {
        throw new Error("User Kernel lifecycle changed during activation");
      }
      if (lifecycleFence) {
        await this.clearRegisteredAppRunners({
          fenceKind: "user-lifecycle",
          ownerUid: lifecycleFence.ownerUid,
          ownerUsername: lifecycleFence.ownerUsername,
          generation: lifecycleFence.generation,
          fenceId: lifecycleFence.fenceId,
        });
        if (!this.isCurrentUserKernelMarker(active, { allowLifecycleFence: true })) {
          throw new Error("User Kernel lifecycle changed during AppRunner activation");
        }
      }
      // Install wakes while the durable lifecycle row still prevents them
      // from executing. A post-open pass below replaces any wake that raced
      // the fence window and was consumed fail-closed.
      await this.rearmPendingSchedules(active, { allowLifecycleFence: true });
      if (!this.isCurrentUserKernelMarker(active, { allowLifecycleFence: true })) {
        throw new Error("User Kernel lifecycle changed during schedule activation");
      }
      if (lifecycleFence) {
        if (!this.appRuntimes.clearLifecycleFence(lifecycleFence)) {
          throw new Error("User Kernel AppRunner lifecycle fence clear failed");
        }
        this.purgeAppRunnerRuntimeFenceAuthorizations(
          "user-lifecycle",
          lifecycleFence.fenceId,
          lifecycleFence.generation,
        );
      }
      this.closedTargetOperationGeneration = null;
      try {
        await this.rearmPendingSchedules(active);
      } catch (error) {
        console.warn("[Kernel] Active schedule rearm will retry:", error);
        this.queueUserKernelScheduleRearmRecovery();
      }
      return active;
    } catch (error) {
      const recoveryErrors: unknown[] = [];
      if (
        activationCommitStarted
        && this.appRuntimes.getLifecycleFence(active.uid) !== null
      ) {
        try {
          await this.restoreProvisioningAfterActivationFailure(active);
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (recoveryErrors.length > 0) {
        if (this.appRuntimes.getLifecycleFence(active.uid)) {
          this.queueAppRuntimeLifecycleFenceRecovery(1);
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; activation recovery failed: ${
            recoveryErrors.map((failure) => (
              failure instanceof Error ? failure.message : String(failure)
            )).join("; ")
          }`,
          { cause: error },
        );
      }
      if (this.appRuntimes.getLifecycleFence(active.uid)) {
        this.queueAppRuntimeLifecycleFenceRecovery(1);
      }
      throw error;
    }
  }

  private async pullAuthorizedUserKernelActivationProjection(
    input: UserKernelActivationAuthorizationInput,
  ): Promise<UserKernelProvisioningSnapshot | null> {
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    return master.consumeUserKernelActivationAuthorization(input);
  }

  private async restoreProvisioningAfterActivationFailure(
    active: UserKernelInstanceMarker,
  ): Promise<void> {
    const inMemory = this.userKernelMarker;
    if (sameUserKernelInstanceMarker(inMemory ?? null, active)) {
      this.userKernelMarker = {
        ...active,
        lifecycle: "provisioning",
        updatedAt: Date.now(),
      };
    }
    // Fence synchronously before touching storage so no request can enter
    // during recovery from an active or ambiguously-committed marker.
    this.fenceUserKernelRuntime("User Kernel activation failed");

    let persistenceError: unknown;
    try {
      const current = parseUserKernelInstanceMarker(
        await this.ctx.storage.get<unknown>(USER_KERNEL_INSTANCE_STORAGE_KEY),
      );
      const recovery = this.userKernelMarker;
      if (
        recovery
        && recovery.username === active.username
        && recovery.uid === active.uid
        && recovery.generation === active.generation
        && recovery.lifecycle === "provisioning"
        && sameUserKernelInstanceMarker(current, active)
      ) {
        await this.ctx.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, recovery);
      }
    } catch (error) {
      persistenceError = error;
    }
    try {
      await this.cancelPendingScheduleWakes();
    } catch (error) {
      persistenceError ??= error;
    }
    try {
      await this.abortFencedUserKernelProcesses(
        active.generation,
        "User Kernel activation failed",
      );
    } catch (error) {
      persistenceError ??= error;
    }
    const lifecycleFence = this.appRuntimes.getLifecycleFence(active.uid);
    if (lifecycleFence && lifecycleFence.sourceKernelName === this.name) {
      try {
        await this.prepareRegisteredAppRunners({
          fenceKind: "user-lifecycle",
          ownerUid: lifecycleFence.ownerUid,
          ownerUsername: lifecycleFence.ownerUsername,
          generation: lifecycleFence.generation,
          fenceId: lifecycleFence.fenceId,
        });
      } catch (error) {
        persistenceError ??= error;
      }
    }
    if (persistenceError) throw persistenceError;
  }

  private rebindFencedUserKernelProcesses(
    marker: UserKernelInstanceMarker,
  ): void {
    if (marker.lifecycle !== "provisioning" || marker.generation <= 1) {
      return;
    }
    const fencedGeneration = marker.generation - 1;
    this.ctx.storage.transactionSync(() => {
      for (const process of this.procs.list()) {
        if (process.kernelGeneration !== fencedGeneration) continue;
        if (process.ownerUid !== marker.uid) {
          throw new Error("Fenced process owner does not match user Kernel");
        }
        if (!this.procs.rebindKernelGeneration(
          process.processId,
          fencedGeneration,
          marker.generation,
        )) {
          throw new Error(`Failed to rebind fenced process: ${process.processId}`);
        }
      }
    });
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

  private async discardPreparedUserKernelExecutors(
    marker: UserKernelInstanceMarker,
  ): Promise<void> {
    const pids = new Set<string>();
    for (const conversation of this.conversations.listByOwner(marker.uid)) {
      if (!conversation.isDefault || !conversation.activePid) continue;
      const process = this.procs.get(conversation.activePid);
      if (process && processKernelGenerationMatches(process, marker.generation)) {
        pids.add(conversation.activePid);
      }
    }
    for (const pid of pids) {
      await this.rollbackProvisionedUserKernelExecutor(pid);
    }
  }

  private async pullAuthorizedUserKernelProvisioningSnapshot(
    input: UserKernelProvisioningAuthorizationInput,
  ): Promise<AuthorizedUserKernelProvisioningSnapshot | null> {
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    return master.consumeUserKernelProvisioningAuthorization(input);
  }

  private async initializeUserKernelProvisioning(
    snapshot: UserKernelProvisioningSnapshot,
    provisioning: UserKernelInstanceMarker,
  ): Promise<string> {
    await this.installUserKernelProjection(snapshot, {
      allowLifecycleFence: true,
      allowClosedAdmission: true,
    });

    return this.ensureUserKernelProvisioningExecutor(provisioning);
  }

  private async ensureUserKernelProvisioningExecutor(
    marker: UserKernelInstanceMarker,
  ): Promise<string> {

    const owner = this.auth.getPasswdByUid(marker.uid);
    if (!owner || owner.username !== marker.username) {
      throw new Error("User Kernel projection is missing its owner");
    }
    const ownerIdentity: ProcessIdentity = {
      uid: owner.uid,
      gid: owner.gid,
      gids: this.auth.resolveGids(owner.username, owner.gid),
      username: owner.username,
      home: owner.home,
      cwd: owner.home,
    };
    const connectionIdentity: ConnectionIdentity = {
      role: "user",
      process: ownerIdentity,
      capabilities: this.caps.resolve(ownerIdentity.gids),
    };
    const context = this.buildKernelContext({
      identity: connectionIdentity,
      ...(marker.lifecycle === "provisioning"
        ? { provisioningMarker: marker }
        : {}),
    });
    const pid = await ensureDefaultConversationExecutor(
      context,
      ownerIdentity,
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
      this.userKernelMarker?.generation ?? null,
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

  /**
   * AppRunner callbacks are capabilities, not ambient trust. Each token is
   * consumed once and is accepted only while this Kernel still owns the exact
   * durable package/lifecycle fence that issued it.
   */
  async consumeAppRunnerRuntimeFenceAuthorization(
    input: AppRunnerRuntimeFenceAuthorizationInput,
  ): Promise<boolean> {
    const authorization = typeof input?.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.appRunnerRuntimeFenceAuthorizations.get(authorization);
    this.appRunnerRuntimeFenceAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || pending.action !== input.action
      || !sameAppRunnerRuntimeFenceIdentity(pending.fence, input)
      || input.sourceKernelName !== this.name
    ) {
      return false;
    }

    const runner = this.appRuntimes.getRunner(input.runnerName);
    if (
      !runner
      || runner.ownerUid !== input.ownerUid
      || runner.ownerUsername !== input.ownerUsername
      || runner.kernelOwnerUid !== input.kernelOwnerUid
      || runner.kernelOwnerUsername !== input.kernelOwnerUsername
      || runner.packageId !== input.packageId
    ) {
      return false;
    }
    return this.isControllingAppRunnerRuntimeFenceActive(input, runner);
  }

  private async isControllingAppRunnerRuntimeFenceActive(
    input: AppRunnerRuntimeFenceIdentity,
    runner: AppRuntimeRunnerRecord,
  ): Promise<boolean> {
    if (input.fenceKind === "package-projection") {
      const fence = this.projectionState.packageFence();
      if (
        !fence
        || fence.fenceId !== input.fenceId
        || fence.kernelGeneration !== input.generation
      ) {
        return false;
      }
      if (this.instanceKind === "master") {
        const placement = this.userKernels.getByUid(runner.kernelOwnerUid);
        return Boolean(
          input.sourceKernelName === SHIP_KERNEL_NAME
          && placement
          && placement.lifecycle === "legacy"
          && placement.username === runner.kernelOwnerUsername
          && placement.uid === runner.kernelOwnerUid,
        );
      }
      const marker = await this.loadUserKernelMarker();
      return Boolean(
        marker
        && marker.lifecycle === "active"
        && input.sourceKernelName === userKernelName(marker.username)
        && marker.username === runner.kernelOwnerUsername
        && marker.uid === runner.kernelOwnerUid
        && marker.generation === input.generation,
      );
    }

    const fence = this.appRuntimes.getLifecycleFence(runner.kernelOwnerUid);
    return Boolean(
      fence
      && fence.ownerUid === runner.kernelOwnerUid
      && fence.ownerUsername === runner.kernelOwnerUsername
      && fence.sourceKernelName === this.name
      && fence.sourceKernelName === input.sourceKernelName
      && fence.generation === input.generation
      && fence.fenceId === input.fenceId,
    );
  }

  private appRuntimeRunnersForKernelOwner(
    ownerUid: number,
    ownerUsername: string,
  ): AppRuntimeRunnerRecord[] {
    return this.appRuntimes.listRunners({
      kernelOwnerUid: ownerUid,
      kernelOwnerUsername: ownerUsername,
    });
  }

  private async prepareRegisteredAppRunners(input: {
    fenceKind: AppRunnerRuntimeFenceKind;
    ownerUid: number;
    ownerUsername: string;
    generation: number;
    fenceId: string;
  }): Promise<void> {
    await this.transitionRegisteredAppRunners("prepare", input);
  }

  private async clearRegisteredAppRunners(input: {
    fenceKind: AppRunnerRuntimeFenceKind;
    ownerUid: number;
    ownerUsername: string;
    generation: number;
    fenceId: string;
  }): Promise<void> {
    await this.transitionRegisteredAppRunners("clear", input);
  }

  private async transitionRegisteredAppRunners(
    action: AppRunnerRuntimeFenceAuthorizationInput["action"],
    input: {
      fenceKind: AppRunnerRuntimeFenceKind;
      ownerUid: number;
      ownerUsername: string;
      generation: number;
      fenceId: string;
    },
  ): Promise<void> {
    const runners = this.appRuntimeRunnersForKernelOwner(
      input.ownerUid,
      input.ownerUsername,
    );
    const results = await mapWithConcurrency(
      runners,
      APP_RUNNER_RUNTIME_FENCE_CONCURRENCY,
      async (runner) => {
        const fence: AppRunnerRuntimeFenceIdentity = {
          fenceKind: input.fenceKind,
          sourceKernelName: this.name,
          runnerName: runner.runnerName,
          ownerUid: runner.ownerUid,
          ownerUsername: runner.ownerUsername,
          kernelOwnerUid: runner.kernelOwnerUid,
          kernelOwnerUsername: runner.kernelOwnerUsername,
          packageId: runner.packageId,
          generation: input.generation,
          fenceId: input.fenceId,
        };
        try {
          await this.transitionAppRunnerRuntimeFence(action, fence);
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
    );
    const failure = results.find((result) => !result.ok);
    if (failure && !failure.ok) throw failure.error;
  }

  private async transitionAppRunnerRuntimeFence(
    action: AppRunnerRuntimeFenceAuthorizationInput["action"],
    fence: AppRunnerRuntimeFenceIdentity,
  ): Promise<void> {
    pruneExpiredAuthorizations(this.appRunnerRuntimeFenceAuthorizations);
    if (
      this.appRunnerRuntimeFenceAuthorizations.size
      >= MAX_PENDING_APP_RUNNER_RUNTIME_FENCE_AUTHORIZATIONS
    ) {
      throw new Error("AppRunner runtime fence authorization is busy");
    }
    const authorization = crypto.randomUUID();
    this.appRunnerRuntimeFenceAuthorizations.set(authorization, {
      expiresAt: Date.now() + APP_RUNNER_RUNTIME_FENCE_AUTHORIZATION_TTL_MS,
      action,
      fence,
    });
    try {
      const runner = this.ctx.exports.AppRunner.getByName(
        fence.runnerName,
      ) as unknown as AppRunnerRuntimeFenceStub;
      const ack = action === "prepare"
        ? await runner.prepareAppRunnerRuntimeFence({ authorization, ...fence })
        : await runner.clearAppRunnerRuntimeFence({ authorization, ...fence });
      if (
        ack.state !== (action === "prepare" ? "fenced" : "cleared")
        || !sameAppRunnerRuntimeFenceIdentity(fence, ack)
      ) {
        throw new Error("AppRunner runtime fence acknowledgment mismatch");
      }
    } finally {
      this.appRunnerRuntimeFenceAuthorizations.delete(authorization);
    }
  }

  private purgeAppRunnerRuntimeFenceAuthorizations(
    fenceKind: AppRunnerRuntimeFenceKind,
    fenceId: string,
    generation: number,
  ): void {
    for (const [authorization, pending] of this.appRunnerRuntimeFenceAuthorizations) {
      if (
        pending.fence.fenceKind === fenceKind
        && pending.fence.fenceId === fenceId
        && pending.fence.generation === generation
      ) {
        this.appRunnerRuntimeFenceAuthorizations.delete(authorization);
      }
    }
  }

  async consumePackageProjectionFenceAuthorization(
    input: PackageProjectionFenceAuthorizationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    const authorization = typeof input.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.packageProjectionFenceAuthorizations.get(authorization);
    this.packageProjectionFenceAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || !samePackageProjectionFenceAuthorization(pending.fence, input)
    ) {
      return false;
    }
    const placement = this.userKernels.get(input.username);
    return Boolean(
      placement
      && placement.lifecycle === "active"
      && placement.username === input.username
      && placement.uid === input.uid
      && placement.generation === input.generation
      && input.targetKernelName === userKernelName(input.username)
      && !this.transitioningUserKernels.has(input.username)
    );
  }

  async preparePackageProjectionFence(
    input: PackageProjectionFenceTargetInput,
  ): Promise<boolean> {
    const instanceUsername = this.instanceUsername;
    if (
      this.instanceKind !== "user"
      || !instanceUsername
      || input.sourceKernelName !== SHIP_KERNEL_NAME
      || input.username !== instanceUsername
      || canonicalizeLoginUsername(input.username) !== input.username
      || this.name !== userKernelName(input.username)
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
      || typeof input.authorization !== "string"
      || !input.authorization
      || typeof input.fenceId !== "string"
      || !input.fenceId
    ) {
      return false;
    }
    const marker = await this.loadUserKernelMarker();
    if (
      !marker
      || marker.lifecycle !== "active"
      || marker.username !== input.username
      || marker.uid !== input.uid
      || marker.generation !== input.generation
      || this.appRuntimes.getLifecycleFence(input.uid) !== null
    ) {
      return false;
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    if (!await master.consumePackageProjectionFenceAuthorization({
      authorization: input.authorization,
      targetKernelName: this.name,
      username: input.username,
      uid: input.uid,
      generation: input.generation,
      fenceId: input.fenceId,
    })) {
      return false;
    }
    if (!this.isCurrentUserKernelMarker(marker)) return false;

    this.ctx.storage.transactionSync(() => {
      this.projectionState.enterPackageFence({
        fenceId: input.fenceId,
        kernelGeneration: input.generation,
        startedAt: Date.now(),
      });
    });
    this.closeUserKernelTargetAdmission(
      input.generation,
      "Package authority projection is fenced",
      true,
    );
    this.abortPackageProjectionKernelWork(input.generation, input.fenceId);
    await this.abortPackageProjectionProcesses(input.generation, input.fenceId);
    await this.waitForUserKernelTargetOperations(input.generation, true);
    this.schedules.releaseInterruptedRuns(
      "Package authority projection is fenced",
      Date.now(),
      true,
    );
    await this.prepareRegisteredAppRunners({
      fenceKind: "package-projection",
      ownerUid: marker.uid,
      ownerUsername: marker.username,
      generation: marker.generation,
      fenceId: input.fenceId,
    });
    return true;
  }

  async refreshPackageProjectionFence(
    input: PackageProjectionRefreshTargetInput,
  ): Promise<boolean> {
    if (
      this.instanceKind !== "user"
      || input.sourceKernelName !== SHIP_KERNEL_NAME
      || input.username !== this.instanceUsername
      || !Number.isSafeInteger(input.expectedProjectionRevision)
      || input.expectedProjectionRevision <= 0
    ) {
      return false;
    }
    return this.refreshPackageProjectionFenceInternal({
      username: input.username,
      uid: input.uid,
      generation: input.generation,
      fenceId: input.fenceId,
      expectedProjectionRevision: input.expectedProjectionRevision,
    });
  }

  private async recoverPackageProjectionFence(): Promise<void> {
    const marker = await this.loadUserKernelMarker();
    const fence = this.projectionState.packageFence();
    if (
      !marker
      || marker.lifecycle !== "active"
      || !fence
      || fence.kernelGeneration !== marker.generation
    ) {
      return;
    }
    this.closeUserKernelTargetAdmission(
      marker.generation,
      "Package authority projection recovery is fenced",
      true,
    );
    this.abortPackageProjectionKernelWork(marker.generation, fence.fenceId);
    await this.abortPackageProjectionProcesses(marker.generation, fence.fenceId);
    await this.waitForUserKernelTargetOperations(marker.generation, true);
    this.schedules.releaseInterruptedRuns(
      "Package authority projection recovery is fenced",
      Date.now(),
      true,
    );
    await this.prepareRegisteredAppRunners({
      fenceKind: "package-projection",
      ownerUid: marker.uid,
      ownerUsername: marker.username,
      generation: marker.generation,
      fenceId: fence.fenceId,
    });
    // A restarted target must never decide that the Master's mutation is
    // committed merely because it can fetch a snapshot. Wake the Master and
    // leave this local fence intact until its exact refresh RPC supplies the
    // committed revision and fence identity.
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    await master.getUserKernelProjection(
      this.name,
      marker.username,
      marker.generation,
      kernelCapability,
    );
  }

  private async refreshPackageProjectionFenceInternal(input: {
    username: string;
    uid: number;
    generation: number;
    fenceId: string;
    expectedProjectionRevision?: number;
  }): Promise<boolean> {
    const marker = await this.loadUserKernelMarker();
    const fence = this.projectionState.packageFence();
    if (
      !marker
      || marker.lifecycle !== "active"
      || marker.username !== input.username
      || marker.uid !== input.uid
      || marker.generation !== input.generation
      || !fence
      || (
        fence.fenceId !== input.fenceId
        || fence.kernelGeneration !== input.generation
      )
    ) {
      return false;
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    const snapshot = await master.getUserKernelProjection(
      this.name,
      marker.username,
      marker.generation,
      kernelCapability,
    );
    if (
      input.expectedProjectionRevision !== undefined
      && snapshot.projectionRevision !== input.expectedProjectionRevision
    ) {
      throw new Error("Package projection refresh revision mismatch");
    }
    await this.installUserKernelProjection(snapshot);
    const after = await this.loadUserKernelMarker();
    const installed = this.projectionState.installed();
    if (
      !after
      || !this.isCurrentUserKernelMarker(marker)
      || after !== marker
      || !installed
      || installed.username !== marker.username
      || installed.uid !== marker.uid
      || installed.kernelGeneration !== marker.generation
      || installed.revision !== snapshot.projectionRevision
    ) {
      return false;
    }
    await this.clearRegisteredAppRunners({
      fenceKind: "package-projection",
      ownerUid: marker.uid,
      ownerUsername: marker.username,
      generation: marker.generation,
      fenceId: input.fenceId,
    });
    const cleared = this.ctx.storage.transactionSync(() => (
      this.projectionState.clearPackageFence(input.fenceId, input.generation)
    ));
    if (cleared) {
      this.purgeAppRunnerRuntimeFenceAuthorizations(
        "package-projection",
        input.fenceId,
        input.generation,
      );
    }
    return cleared;
  }

  private abortPackageProjectionKernelWork(generation: number, fenceId: string): void {
    const reason = new Error(`Package authority projection fenced: ${fenceId}`);
    for (const [requestId, active] of [...this.activeRequests]) {
      if (active.origin.type === "app") {
        this.cancelRequest(active.origin, requestId, reason.message, false);
        continue;
      }
      if (active.origin.type !== "process") continue;
      const record = this.procs.get(active.origin.id);
      if (
        !record
        || (this.instanceKind === "user" && record.kernelGeneration !== generation)
        || record.packageSecurityRevision === null
      ) {
        continue;
      }
      this.cancelRequest(active.origin, requestId, reason.message, false);
    }
    for (const [scheduleId, controller] of this.activeScheduleRuns) {
      const schedule = this.schedules.getStored(scheduleId);
      if (typeof schedule?.packageSecurityRevision === "string") {
        controller.abort(reason);
        this.activeScheduleRuns.delete(scheduleId);
      }
    }
  }

  private async abortPackageProjectionProcesses(
    generation: number,
    fenceId: string,
  ): Promise<void> {
    const processes = this.procs.list().filter((record) => (
      (this.instanceKind === "master" || record.kernelGeneration === generation)
      && record.packageSecurityRevision !== null
    ));
    await mapWithConcurrency(
      processes,
      PACKAGE_PROJECTION_TARGET_CONCURRENCY,
      async (record) => {
        const requestId = crypto.randomUUID();
        const response = await sendFrameToProcess(record.processId, {
          type: "req",
          id: requestId,
          call: "proc.abort",
          args: {
            pid: record.processId,
            packageProjectionFenceGeneration: generation,
            packageProjectionFenceId: fenceId,
          } as {
            pid: string;
            packageProjectionFenceGeneration: number;
            packageProjectionFenceId: string;
          },
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
          || data.pid !== record.processId
        ) {
          throw new Error(`Process did not exact-ack package projection fence: ${record.processId}`);
        }
        const current = this.procs.get(record.processId);
        if (
          !current
          || current.uid !== record.uid
          || current.ownerUid !== record.ownerUid
          || current.kernelGeneration !== record.kernelGeneration
          || current.packageSecurityRevision !== record.packageSecurityRevision
        ) {
          throw new Error(`Process identity changed during package fence: ${record.processId}`);
        }
        if (record.activeRunId) {
          this.procs.updateRuntimeState(record.processId, {
            state: record.queuedCount > 0 ? "queued" : "idle",
            activeRunId: null,
            activeConversationId: null,
            queuedCount: record.queuedCount,
            lastActiveAt: Date.now(),
          });
          this.runRoutes.delete(record.activeRunId);
        }
      },
    );
  }

  async receiveMasterProjection(input: {
    sourceKernelName: string;
    generation: number;
    signal?: "pkg.changed" | "config.changed";
  }): Promise<boolean> {
    if (
      this.instanceKind !== "user"
      || input.sourceKernelName !== SHIP_KERNEL_NAME
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
      || (input.signal !== undefined
        && input.signal !== "pkg.changed"
        && input.signal !== "config.changed")
    ) {
      return false;
    }
    const before = await this.loadUserKernelMarker();
    if (!before || before.lifecycle !== "active" || before.generation !== input.generation) {
      return false;
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const kernelCapability = await this.requireLocalUserKernelCapability(before);
    const snapshot = await master.getUserKernelProjection(
      this.name,
      before.username,
      before.generation,
      kernelCapability,
    );
    const current = await this.loadUserKernelMarker();
    if (
      !current
      || current.lifecycle !== "active"
      || current.username !== snapshot.username
      || current.uid !== snapshot.uid
      || current.generation !== snapshot.generation
      || current.generation !== input.generation
    ) {
      return false;
    }
    validateUserKernelProvisioningSnapshot(snapshot, current.username);
    await this.installUserKernelProjection(snapshot);
    if (input.signal) {
      this.broadcastToRole("user", input.signal);
    }
    return true;
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

    const placement = this.userKernels.get(username);
    if (!placement) {
      return { ok: false };
    }
    if (this.transitioningUserKernels?.has(username)) {
      return { ok: false };
    }
    if (placement.lifecycle === "legacy") {
      return { ok: true, kernelName: SHIP_KERNEL_NAME, lifecycle: "legacy" };
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
      || currentPlacement.generation !== placement.generation
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      kernelName: userKernelName(username),
      lifecycle: "active",
      generation: placement.generation,
      loginSourceScope,
    };
  }

  /**
   * Certify one exact active placement for edge routing. The per-generation
   * user-Kernel capability authenticates the requester, and the transition
   * barrier prevents a certificate from escaping after that placement closes.
   */
  async issueAppPlacementCertificate(
    input: UserKernelCapabilityProof,
  ): Promise<AppPlacementCertificateGrant | null> {
    this.assertMasterKernel();
    if (
      !input
      || typeof input.sourceKernelName !== "string"
      || !Number.isSafeInteger(input.uid)
      || input.uid < 0
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
      || typeof input.kernelCapability !== "string"
    ) {
      return null;
    }

    const username = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelCapability(input);
    if (!username || !placement || placement.username !== username) {
      return null;
    }
    const releaseOperation = this.beginMasterUserOperation(username);
    if (!releaseOperation) return null;
    try {
      const before = this.userKernels.get(username);
      if (
        !before
        || !this.isActiveUserKernelPlacement(before)
        || !sameUserKernelPlacement(before, placement)
      ) {
        return null;
      }
      const signingKey = await this.masterAppPlacementSigningKey();
      await this.publishMasterAppPlacementVerificationKey(signingKey.record);
      const certificate = await signAppPlacementCertificate(signingKey.key, {
        username,
        uid: placement.uid,
        generation: placement.generation,
      });
      const current = this.userKernels.get(username);
      if (
        !current
        || !this.isActiveUserKernelPlacement(current)
        || !sameUserKernelPlacement(current, placement)
      ) {
        return null;
      }
      return {
        version: 1,
        username,
        uid: placement.uid,
        generation: placement.generation,
        certificate,
      };
    } finally {
      releaseOperation();
    }
  }

  async resolveUserKernelCallbackRoute(
    usernameInput: string,
    generation: number,
  ): Promise<{ ok: true; kernelName: string } | { ok: false }> {
    this.assertMasterKernel();
    const username = canonicalizeLoginUsername(usernameInput);
    const placement = username ? this.userKernels.get(username) : null;
    if (
      !username
      || username !== usernameInput
      || !Number.isSafeInteger(generation)
      || generation <= 0
      || !placement
      || !this.isActiveUserKernelPlacement(placement)
      || placement.generation !== generation
    ) {
      return { ok: false };
    }
    return { ok: true, kernelName: userKernelName(username) };
  }

  async authorizeAdapterRunRoute(
    input: AdapterRunRouteAuthorizationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    const username = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelCapability({
      sourceKernelName: input.sourceKernelName,
      uid: input.ownerUid,
      generation: input.kernelGeneration,
      kernelCapability: input.kernelCapability,
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
      || placement.generation !== input.kernelGeneration
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

  /** Consume a one-shot adapter delivery authorization at the target admission point. */
  async consumeAdapterInboundAuthorization(
    input: AdapterInboundAuthorizationInput,
  ): Promise<boolean> {
    this.assertMasterKernel();
    const authorization = typeof input?.authorization === "string"
      ? input.authorization
      : "";
    const pending = this.adapterInboundAuthorizations.get(authorization);
    this.adapterInboundAuthorizations.delete(authorization);
    if (
      !pending
      || pending.expiresAt <= Date.now()
      || !sameAdapterInboundAuthorization(pending.delivery, input)
    ) {
      return false;
    }

    const username = canonicalizeLoginUsername(input.username);
    const route = normalizeAdapterInboundRouteMetadata({
      adapter: input.adapter,
      accountId: input.accountId,
      actorId: input.actorId,
      frameId: input.frameId,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
    });
    const placement = username ? this.userKernels.get(username) : null;
    if (
      !username
      || username !== input.username
      || input.targetKernelName !== userKernelName(username)
      || !placement
      || !this.isActiveUserKernelPlacement(placement)
      || placement.uid !== input.ownerUid
      || placement.generation !== input.generation
      || !route
      || !Number.isSafeInteger(input.linkGeneration)
      || input.linkGeneration <= 0
    ) {
      return false;
    }

    const link = this.adapters.identityLinks.get(
      route.adapter,
      route.accountId,
      route.actorId,
    );
    return Boolean(
      link
      && link.uid === placement.uid
      && link.generation === input.linkGeneration
      && this.adapters.identityLinks.isCurrentGeneration(
        route.adapter,
        route.accountId,
        route.actorId,
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
      && placement.uid === input.uid
      && placement.generation === input.generation,
    );
  }

  async resolveAppSessionKernel(sessionIdInput: string): Promise<AppKernelRouteResult> {
    this.assertMasterKernel();
    const sessionId = typeof sessionIdInput === "string" ? sessionIdInput : "";
    if (parseRoutedAppSessionId(sessionId)) {
      // Active route signatures belong exclusively to their user Kernel.
      // Gateway active routing is deterministic and target-verified, so the
      // Master compatibility resolver must never accept these locators.
      return { ok: false };
    }

    if (!isLegacyAppSessionId(sessionId)) {
      return { ok: false };
    }
    const legacy = this.appSessions.getActiveRoute(sessionId);
    const placement = legacy ? this.userKernels.get(legacy.username) : null;
    if (
      !legacy
      || !placement
      || placement.lifecycle !== "legacy"
      || placement.uid !== legacy.uid
      || this.transitioningUserKernels.has(placement.username)
      || this.appRuntimes.getLifecycleFence(placement.uid) !== null
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      kernelName: SHIP_KERNEL_NAME,
      lifecycle: "legacy",
      username: placement.username,
      uid: placement.uid,
      generation: placement.generation,
    };
  }

  async resolveAppFrameKernel(
    appFrame: AppFrameContext,
    call?: string,
    runnerName?: string,
  ): Promise<AppKernelRouteResult> {
    this.assertMasterKernel();
    const ownerUsername = canonicalizeLoginUsername(
      appFrame?.kernelUsername ?? appFrame?.username,
    );
    const placement = ownerUsername ? this.userKernels.get(ownerUsername) : null;
    const releaseMasterOperation = placement?.lifecycle === "legacy"
      && this.appRuntimes.getLifecycleFence(placement.uid) === null
      ? this.beginMasterUserOperation(placement.username)
      : null;
    if (!releaseMasterOperation) return { ok: false };
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(
        this.projectionState.masterRevision(),
        { packageStamped: true },
      );
    } catch {
      releaseMasterOperation();
      return { ok: false };
    }
    try {
      const route = await this.resolveAppFrameKernelAdmitted(
        appFrame,
        call,
        runnerName,
      );
      operation.assertCurrent();
      return route;
    } catch {
      return { ok: false };
    } finally {
      operation.release();
      releaseMasterOperation();
    }
  }

  private async resolveAppFrameKernelAdmitted(
    appFrame: AppFrameContext,
    call?: string,
    runnerName?: string,
  ): Promise<AppKernelRouteResult> {
    if (
      !appFrame
      || typeof appFrame !== "object"
      || isAppFrameContextExpired(appFrame)
      || (call !== undefined && (typeof call !== "string" || call.trim().length === 0))
      || appFrame.kernelGeneration !== undefined
    ) {
      return { ok: false };
    }

    if (appFrame.sessionId !== undefined) {
      if (!isLegacyAppSessionId(appFrame.sessionId)) {
        return { ok: false };
      }
      const route = await this.resolveAppSessionKernel(appFrame.sessionId);
      if (!route.ok || route.lifecycle !== "legacy") {
        return { ok: false };
      }
      if (!this.isMasterAppFrameActorAuthorized(appFrame, route.uid)) {
        return { ok: false };
      }
      if (!this.isMasterPackageRuntimeAuthorized(appFrame, call)) {
        return { ok: false };
      }
      if (
        appFrame.kernelOwnerUid !== route.uid
        || (appFrame.kernelUsername !== undefined
          && appFrame.kernelUsername !== route.username)
      ) {
        return { ok: false };
      }
      return this.rememberAuthorizedAppRuntime(appFrame, runnerName)
        ? route
        : { ok: false };
    }

    const username = canonicalizeLoginUsername(
      appFrame.kernelUsername ?? appFrame.username,
    );
    const placement = username ? this.userKernels.get(username) : null;
    if (
      !username
      || !placement
      || placement.lifecycle !== "legacy"
      || appFrame.kernelOwnerUid !== placement.uid
    ) {
      return { ok: false };
    }
    if (!this.isMasterAppFrameActorAuthorized(appFrame, placement.uid)) {
      return { ok: false };
    }
    if (!this.isMasterPackageRuntimeAuthorized(appFrame, call)) {
      return { ok: false };
    }
    if (!this.rememberAuthorizedAppRuntime(appFrame, runnerName)) {
      return { ok: false };
    }
    return {
      ok: true,
      kernelName: SHIP_KERNEL_NAME,
      lifecycle: "legacy",
      username,
      uid: placement.uid,
      generation: placement.generation,
    };
  }

  private isMasterAppFrameActorAuthorized(
    appFrame: AppFrameContext,
    ownerUid: number,
  ): boolean {
    const actor = this.auth.getPasswdByUid(appFrame.uid);
    return Boolean(
      actor
      && actor.username === appFrame.username
      && canOwnerRunAsAccount(this.auth, ownerUid, actor, ownerUid === 0)
    );
  }

  private isMasterPackageRuntimeAuthorized(
    appFrame: AppFrameContext,
    call?: string,
  ): boolean {
    if (this.projectionState.packageFence() !== null) {
      return false;
    }
    const actor = this.auth.getPasswdByUid(appFrame.uid);
    if (!actor || actor.username !== appFrame.username) {
      return false;
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
    ) {
      return false;
    }
    const entrypoint = findAppFrameEntrypoint(
      record.manifest.entrypoints,
      appFrame.entrypointName,
      appFrame.routeBase,
    );
    if (!entrypoint) {
      return false;
    }
    if (call === undefined) {
      return true;
    }
    const capabilities = this.caps.resolve(
      this.auth.resolveGids(actor.username, actor.gid),
    );
    return Boolean(
      entrypoint.syscalls?.includes(call)
      && hasCapability(capabilities, call),
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
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
    ) {
      return { ok: false, error: "Authentication failed" };
    }
    const placement = await this.authorizeUserKernelCapability({
      sourceKernelName: input.sourceKernelName,
      uid: this.userKernels.get(username)?.uid ?? -1,
      generation: input.generation,
      kernelCapability: input.kernelCapability,
    });
    if (
      !placement
      || placement.generation !== input.generation
    ) {
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
      || currentPlacement.generation !== input.generation
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

  /** Authoritative half of user-Kernel device forgetting. */
  async revokeUserKernelDeviceCredentials(
    input: UserKernelDeviceRevocationInput,
  ): Promise<TokenRevocationNotice[]> {
    this.assertMasterKernel();
    const username = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelCapability({
      sourceKernelName: input.sourceKernelName,
      uid: input.ownerUid,
      generation: input.generation,
      kernelCapability: input.kernelCapability,
    });
    if (
      !username
      || !placement
      || placement.uid !== input.ownerUid
      || placement.generation !== input.generation
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
    const placement = await this.authorizeUserKernelCapability({
      sourceKernelName: input.sourceKernelName,
      uid: input.uid,
      generation: input.generation,
      kernelCapability: input.kernelCapability,
    });
    if (
      !username
      || username !== input.username
      || !placement
      || placement.uid !== input.uid
      || placement.generation !== input.generation
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
      || marker.generation !== input.generation
    ) {
      return false;
    }

    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    let kernelCapability: string;
    try {
      kernelCapability = await this.requireLocalUserKernelCapability(marker);
    } catch {
      return false;
    }
    const confirmed = await master.confirmTokenRevocationDelivery({
      sourceKernelName: this.name,
      username: marker.username,
      uid: marker.uid,
      generation: marker.generation,
      kernelCapability,
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
        refreshProjection: false,
      };
    }

    const sourceUsername = userKernelUsername(input.sourceKernelName);
    const placement = await this.authorizeUserKernelCapability({
      sourceKernelName: input.sourceKernelName,
      uid: input.callerOwnerUid,
      generation: input.generation,
      kernelCapability: input.kernelCapability,
    });
    if (
      !sourceUsername
      || !placement
      || placement.username !== sourceUsername
      || placement.uid !== input.callerOwnerUid
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
      || placement.generation !== input.generation
    ) {
      return {
        response: masterErrorFrame(input.frame.id, 401, "Authentication failed"),
        refreshProjection: false,
      };
    }

    const identity = this.resolveMasterSyscallIdentity(input, placement.uid);
    if (!identity || !hasCapability(identity.capabilities, input.frame.call)) {
      return {
        response: masterErrorFrame(input.frame.id, 403, `Permission denied: ${input.frame.call}`),
        refreshProjection: false,
      };
    }

    const releaseOperation = this.beginMasterUserOperation(sourceUsername);
    if (!releaseOperation) {
      return {
        response: masterErrorFrame(input.frame.id, 401, "Authentication failed"),
        refreshProjection: false,
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

  private async runPackageProjectionMutation<T>(
    frameId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      this.masterPackageProjectionTransitionPending !== null
      || this.projectionState.packageFence() !== null
    ) {
      this.queueMasterPackageFenceRecovery();
      throw new Error("Package authority projection transition is already in progress");
    }
    const fenceId = crypto.randomUUID();
    this.masterPackageProjectionTransitionPending = fenceId;
    try {
      return await this.runSerializedMasterProjectionOperation(
        () => this.runPackageProjectionMutationExclusive(frameId, fenceId, operation),
        fenceId,
      );
    } finally {
      if (this.masterPackageProjectionTransitionPending === fenceId) {
        this.masterPackageProjectionTransitionPending = null;
      }
    }
  }

  private masterLegacyAppRuntimeOwners(): Array<{
    ownerUid: number;
    ownerUsername: string;
  }> {
    this.assertMasterKernel();
    const owners = new Map<number, { ownerUid: number; ownerUsername: string }>();
    for (const runner of this.appRuntimes.listRunners()) {
      const placement = this.userKernels.getByUid(runner.kernelOwnerUid);
      if (
        !placement
        || placement.lifecycle !== "legacy"
        || placement.username !== runner.kernelOwnerUsername
      ) {
        continue;
      }
      const existing = owners.get(placement.uid);
      if (existing && existing.ownerUsername !== placement.username) {
        throw new Error("AppRunner registry owner identity conflicts");
      }
      owners.set(placement.uid, {
        ownerUid: placement.uid,
        ownerUsername: placement.username,
      });
    }
    return [...owners.values()].sort((left, right) => (
      left.ownerUsername.localeCompare(right.ownerUsername)
    ));
  }

  private async transitionMasterLegacyAppRunners(
    action: AppRunnerRuntimeFenceAuthorizationInput["action"],
    generation: number,
    fenceId: string,
  ): Promise<void> {
    const owners = this.masterLegacyAppRuntimeOwners();
    const results = await mapWithConcurrency(
      owners,
      APP_RUNNER_RUNTIME_FENCE_CONCURRENCY,
      async (owner) => {
        try {
          await this.transitionRegisteredAppRunners(action, {
            fenceKind: "package-projection",
            ...owner,
            generation,
            fenceId,
          });
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
    );
    const failure = results.find((result) => !result.ok);
    if (failure && !failure.ok) throw failure.error;
  }

  private async runPackageProjectionMutationExclusive<T>(
    frameId: string,
    fenceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.projectionState.packageFence() !== null) {
      this.queueMasterPackageFenceRecovery();
      throw new Error("Package authority projection recovery is in progress");
    }
    if (this.transitioningUserKernels.size > 0) {
      throw new Error("A user Kernel lifecycle transition is in progress");
    }
    if (this.appRuntimes.listLifecycleFences().length > 0) {
      throw new Error("An AppRunner lifecycle transition is in progress");
    }
    const targets = this.userKernels.list("active");
    const releases: Array<() => void> = [];
    for (const target of targets) {
      const release = this.beginMasterUserOperation(target.username);
      if (!release) {
        for (const acquired of releases) acquired();
        throw new Error(`Package authority transition is in progress for ${target.username}`);
      }
      releases.push(release);
    }

    const masterFenceGeneration = this.projectionState.masterRevision();
    let prepared = false;
    try {
      this.ctx.storage.transactionSync(() => {
        this.projectionState.enterPackageFence({
          fenceId,
          kernelGeneration: masterFenceGeneration,
          startedAt: Date.now(),
        });
      });
      this.closeUserKernelTargetAdmission(
        masterFenceGeneration,
        "Package authority projection is fenced",
        true,
      );
      this.abortPackageProjectionKernelWork(masterFenceGeneration, fenceId);
      await this.abortPackageProjectionProcesses(masterFenceGeneration, fenceId);
      await this.waitForUserKernelTargetOperations(masterFenceGeneration, true);
      this.schedules.releaseInterruptedRuns(
        "Package authority projection is fenced",
        Date.now(),
        true,
      );
      try {
        await this.transitionMasterLegacyAppRunners(
          "prepare",
          masterFenceGeneration,
          fenceId,
        );
        await this.preparePackageProjectionTargets(targets, fenceId);
        prepared = true;
      } catch (error) {
        const revision = this.projectionState.masterRevision();
        const targetsRecovered = await this.refreshPackageProjectionTargets(
          targets,
          fenceId,
          revision,
        );
        let runnersRecovered = false;
        if (targetsRecovered) {
          try {
            await this.transitionMasterLegacyAppRunners(
              "clear",
              masterFenceGeneration,
              fenceId,
            );
            runnersRecovered = true;
          } catch {
          }
        }
        const recovered = targetsRecovered && runnersRecovered;
        if (recovered) {
          this.ctx.storage.transactionSync(() => {
            this.projectionState.clearPackageFence(fenceId, masterFenceGeneration);
          });
          this.purgeAppRunnerRuntimeFenceAuthorizations(
            "package-projection",
            fenceId,
            masterFenceGeneration,
          );
        }
        throw new Error(recovered
          ? `Package authority fence preparation failed: ${errorMessage(error)}`
          : "Package authority fence preparation failed and a target remains fenced");
      }

      let mutation: { value: T; revision: number } | null = null;
      let mutationError: unknown;
      try {
        mutation = await this.runMasterProjectionMutation(operation, {
          gateHeld: true,
          packageFenceId: fenceId,
        });
      } catch (error) {
        mutationError = error;
      }
      const revision = mutation?.revision ?? this.projectionState.masterRevision();

      if (!await this.refreshPackageProjectionTargets(
        targets,
        fenceId,
        revision,
      )) {
        throw new Error(
          `Authoritative package state changed for ${frameId}, but a user Kernel remains fenced`,
        );
      }
      await this.transitionMasterLegacyAppRunners(
        "clear",
        masterFenceGeneration,
        fenceId,
      );
      this.ctx.storage.transactionSync(() => {
        if (!this.projectionState.clearPackageFence(fenceId, masterFenceGeneration)) {
          throw new Error("Master package projection fence clear failed");
        }
      });
      this.purgeAppRunnerRuntimeFenceAuthorizations(
        "package-projection",
        fenceId,
        masterFenceGeneration,
      );
      if (mutationError) throw mutationError;
      if (!mutation) throw new Error("Master package mutation did not produce a result");
      return mutation.value;
    } finally {
      for (const release of releases) release();
      if (!prepared) {
        for (const [authorization, pending] of this.packageProjectionFenceAuthorizations) {
          if (pending.fence.fenceId === fenceId) {
            this.packageProjectionFenceAuthorizations.delete(authorization);
          }
        }
      }
      if (this.projectionState.packageFence()?.fenceId === fenceId) {
        this.queueMasterPackageFenceRecovery();
      }
    }
  }

  private async preparePackageProjectionTarget(
    placement: UserKernelRecord,
    fenceId: string,
  ): Promise<void> {
    pruneExpiredAuthorizations(this.packageProjectionFenceAuthorizations);
    const authorization = crypto.randomUUID();
    const fence: Omit<PackageProjectionFenceAuthorizationInput, "authorization"> = {
      targetKernelName: userKernelName(placement.username),
      username: placement.username,
      uid: placement.uid,
      generation: placement.generation,
      fenceId,
    };
    this.packageProjectionFenceAuthorizations.set(authorization, {
      expiresAt: Date.now() + PACKAGE_PROJECTION_FENCE_AUTHORIZATION_TTL_MS,
      fence,
    });
    try {
      const target = await getAgentByName(
        this.env.KERNEL,
        fence.targetKernelName,
      ) as unknown as {
        preparePackageProjectionFence: (
          input: PackageProjectionFenceTargetInput,
        ) => Promise<boolean>;
      };
      const accepted = await target.preparePackageProjectionFence({
        sourceKernelName: this.name,
        authorization,
        username: placement.username,
        uid: placement.uid,
        generation: placement.generation,
        fenceId,
      });
      if (!accepted) {
        throw new Error(`User Kernel rejected package fence: ${placement.username}`);
      }
    } finally {
      this.packageProjectionFenceAuthorizations.delete(authorization);
    }
  }

  private async preparePackageProjectionTargets(
    placements: readonly UserKernelRecord[],
    fenceId: string,
  ): Promise<void> {
    const results = await mapWithConcurrency(
      placements,
      PACKAGE_PROJECTION_TARGET_CONCURRENCY,
      async (placement) => {
        try {
          await this.preparePackageProjectionTarget(placement, fenceId);
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
    );
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) throw failed.error;
  }

  private async refreshPackageProjectionTargets(
    placements: readonly UserKernelRecord[],
    fenceId: string,
    expectedProjectionRevision: number,
  ): Promise<boolean> {
    const results = await mapWithConcurrency(
      placements,
      PACKAGE_PROJECTION_TARGET_CONCURRENCY,
      async (placement) => {
        try {
          const target = await getAgentByName(
            this.env.KERNEL,
            userKernelName(placement.username),
          ) as unknown as {
            refreshPackageProjectionFence: (
              input: PackageProjectionRefreshTargetInput,
            ) => Promise<boolean>;
          };
          return await target.refreshPackageProjectionFence({
            sourceKernelName: this.name,
            username: placement.username,
            uid: placement.uid,
            generation: placement.generation,
            fenceId,
            expectedProjectionRevision,
          });
        } catch {
          return false;
        }
      },
    );
    return results.every(Boolean);
  }

  private queueMasterPackageFenceRecovery(delaySeconds = 0): void {
    if (
      this.instanceKind !== "master"
      || this.projectionState.packageFence() === null
      || this.masterPackageFenceRecoveryQueued
    ) {
      return;
    }
    this.masterPackageFenceRecoveryQueued = true;
    if (delaySeconds > 0) {
      this.ctx.waitUntil(this.schedule(
        delaySeconds,
        "onMasterPackageProjectionFenceRecoveryDue",
      ).then(() => undefined).catch((error) => {
        this.masterPackageFenceRecoveryQueued = false;
        console.warn("[Kernel] Failed to schedule package projection recovery:", error);
        this.queueMasterPackageFenceRecovery();
      }));
      return;
    }
    this.ctx.waitUntil(Promise.resolve().then(
      () => this.onMasterPackageProjectionFenceRecoveryDue(),
    ));
  }

  async onMasterPackageProjectionFenceRecoveryDue(): Promise<void> {
    this.masterPackageFenceRecoveryQueued = false;
    if (this.instanceKind !== "master" || this.projectionState.packageFence() === null) {
      this.masterPackageFenceRecoveryAttempt = 0;
      return;
    }
    try {
      await this.recoverMasterPackageProjectionFence();
      this.masterPackageFenceRecoveryAttempt = 0;
    } catch (error) {
      this.masterPackageFenceRecoveryAttempt += 1;
      const retrySeconds = Math.min(
        2 ** Math.min(this.masterPackageFenceRecoveryAttempt - 1, 6),
        PACKAGE_PROJECTION_RECOVERY_MAX_DELAY_SECONDS,
      );
      console.warn(
        `[Kernel] Master package projection recovery remains fail-closed; retrying in ${retrySeconds}s:`,
        error,
      );
      this.queueMasterPackageFenceRecovery(retrySeconds);
    }
  }

  private async recoverMasterPackageProjectionFence(): Promise<void> {
    this.assertMasterKernel();
    const fence = this.projectionState.packageFence();
    if (!fence) return;
    await this.runSerializedMasterProjectionOperation(
      () => this.recoverMasterPackageProjectionFenceExclusive(fence),
      fence.fenceId,
    );
  }

  private async recoverMasterPackageProjectionFenceExclusive(
    fence: NonNullable<ReturnType<KernelProjectionState["packageFence"]>>,
  ): Promise<void> {
    const currentFence = this.projectionState.packageFence();
    if (
      !currentFence
      || currentFence.fenceId !== fence.fenceId
      || currentFence.kernelGeneration !== fence.kernelGeneration
    ) {
      return;
    }
    const placements = this.userKernels.list("active");
    const releases: Array<() => void> = [];
    try {
      for (const placement of placements) {
        const release = this.beginMasterUserOperation(placement.username);
        if (!release) {
          throw new Error(`User Kernel transition is active for ${placement.username}`);
        }
        releases.push(release);
      }
      this.closeUserKernelTargetAdmission(
        fence.kernelGeneration,
        "Package authority projection recovery is fenced",
        true,
      );
      this.abortPackageProjectionKernelWork(fence.kernelGeneration, fence.fenceId);
      await this.abortPackageProjectionProcesses(
        fence.kernelGeneration,
        fence.fenceId,
      );
      await this.waitForUserKernelTargetOperations(fence.kernelGeneration, true);
      this.schedules.releaseInterruptedRuns(
        "Package authority projection recovery is fenced",
        Date.now(),
        true,
      );
      if (this.projectionState.pendingMasterRevision() !== null) {
        this.ctx.storage.transactionSync(() => {
          this.projectionState.recoverPendingMasterRevision();
        });
      }
      await this.transitionMasterLegacyAppRunners(
        "prepare",
        fence.kernelGeneration,
        fence.fenceId,
      );
      await this.preparePackageProjectionTargets(placements, fence.fenceId);
      const revision = this.projectionState.masterRevision();
      if (!await this.refreshPackageProjectionTargets(
        placements,
        fence.fenceId,
        revision,
      )) {
        throw new Error("A user Kernel rejected Master package fence recovery");
      }
      await this.transitionMasterLegacyAppRunners(
        "clear",
        fence.kernelGeneration,
        fence.fenceId,
      );
      this.ctx.storage.transactionSync(() => {
        if (!this.projectionState.clearPackageFence(
          fence.fenceId,
          fence.kernelGeneration,
        )) {
          throw new Error("Master package projection fence recovery changed concurrently");
        }
      });
      this.purgeAppRunnerRuntimeFenceAuthorizations(
        "package-projection",
        fence.fenceId,
        fence.kernelGeneration,
      );
    } finally {
      for (const release of releases) release();
    }
  }

  private async runMasterProjectionMutation<T>(
    operation: () => Promise<T>,
    options: { gateHeld?: boolean; packageFenceId?: string } = {},
  ): Promise<{ value: T; revision: number }> {
    this.assertMasterKernel();
    const execute = () => this.runMasterProjectionMutationExclusive(operation, options);
    if (options.gateHeld) {
      return await execute();
    }
    return await this.runSerializedMasterProjectionOperation(
      execute,
      options.packageFenceId,
    );
  }

  private async runSerializedMasterProjectionOperation<T>(
    operation: () => Promise<T>,
    packageFenceId?: string,
  ): Promise<T> {
    const pendingFenceId = this.masterPackageProjectionTransitionPending;
    if (pendingFenceId !== null && pendingFenceId !== packageFenceId) {
      throw new Error("Master projection is blocked by a pending package transition");
    }
    const admittedFence = this.projectionState.packageFence();
    if (admittedFence && admittedFence.fenceId !== packageFenceId) {
      this.queueMasterPackageFenceRecovery();
      throw new Error("Master projection is fenced pending package recovery");
    }
    const previous = this.masterProjectionMutationTail;
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    this.masterProjectionMutationTail = previous.then(() => queued);
    await previous;

    try {
      const pending = this.masterPackageProjectionTransitionPending;
      if (pending !== null && pending !== packageFenceId) {
        throw new Error("Master projection is blocked by a pending package transition");
      }
      const fence = this.projectionState.packageFence();
      if (fence && fence.fenceId !== packageFenceId) {
        this.queueMasterPackageFenceRecovery();
        throw new Error("Master projection is fenced pending package recovery");
      }
      return await operation();
    } finally {
      releaseQueue();
    }
  }

  private async runMasterProjectionMutationExclusive<T>(
    operation: () => Promise<T>,
    options: { packageFenceId?: string } = {},
  ): Promise<{ value: T; revision: number }> {
    const fence = this.projectionState.packageFence();
    if (fence && fence.fenceId !== options.packageFenceId) {
      throw new Error("Master projection is fenced pending package recovery");
    }
    let releaseCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    this.pendingMasterProjectionCommit = committed;
    let revision: number;
    try {
      revision = this.ctx.storage.transactionSync(() => (
        this.projectionState.beginMasterMutation()
      ));
    } catch (error) {
      if (this.pendingMasterProjectionCommit === committed) {
        this.pendingMasterProjectionCommit = null;
      }
      releaseCommit();
      throw error;
    }
    let value!: T;
    let operationError: unknown;
    try {
      value = await operation();
    } catch (error) {
      operationError = error;
    }
    try {
      this.ctx.storage.transactionSync(() => {
        this.projectionState.commitMasterMutation(revision);
      });
    } finally {
      if (this.pendingMasterProjectionCommit === committed) {
        this.pendingMasterProjectionCommit = null;
      }
      releaseCommit();
    }
    if (operationError) throw operationError;
    return { value, revision };
  }

  private async provisionCreatedHumanAfterProjectionCommit(
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
    const packageRuntime = packageAgentRuntimeIdentity(
      { config: this.config },
      identity.process.uid,
    );
    const ctx = this.buildKernelContext({
      identity,
      callerOwnerUid: input.callerOwnerUid,
      packageProjectionOperation: packageRuntime.kind !== "ordinary",
    });
    const frame = input.frame as RequestFrame;
    const result = await this.dispatchWithMasterProjectionGate(
      frame,
      { type: "process", id: `user-kernel:${sourceUsername}` },
      ctx,
    );
    if (!result.handled) {
      return {
        response: masterErrorFrame(input.frame.id, 500, "Master operation cannot be deferred"),
        refreshProjection: false,
      };
    }

    if (result.response.ok && result.response.body) {
      await cancelUnlockedBody(result.response.body, "Master RPC cannot return a body");
      const response = masterErrorFrame(
        input.frame.id,
        500,
        "Master operation returned an unsupported body",
      );
      this.applyFailedMasterMutationProjectionEffects(frame, response);
      return {
        response,
        refreshProjection: masterMutationNeedsProjectionRefresh(frame.call),
      };
    }
    this.applyPostDispatchEffects(frame, result.response);
    this.applyFailedMasterMutationProjectionEffects(frame, result.response);
    const tokenRevocations = this.tokenRevocationsFromResponse(frame, result.response);
    if (tokenRevocations.length > 0) {
      this.ctx.waitUntil(this.schedule(
        1,
        "onTokenRevocationOutboxDue",
      ).then(() => undefined));
    }
    return {
      response: result.response as MasterSyscallResult["response"],
      // A mutating handler may persist authoritative state before a later
      // reconciliation step fails. Refresh even on errors so the originating
      // shard converges to what the Master actually committed.
      refreshProjection: masterMutationNeedsProjectionRefresh(frame.call),
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
    const placement = await this.authorizeUserKernelCapability({
      sourceKernelName: input.sourceKernelName,
      uid: input.callerOwnerUid,
      generation: input.generation,
      kernelCapability: input.kernelCapability,
    });
    if (
      !sourceUsername
      || !placement
      || placement.username !== sourceUsername
      || placement.uid !== input.callerOwnerUid
      || placement.generation !== input.generation
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
    const placement = await this.authorizeUserKernelCapability({
      sourceKernelName: input.sourceKernelName,
      uid: input.callerOwnerUid,
      generation: input.generation,
      kernelCapability: input.kernelCapability,
    });
    if (
      !sourceUsername
      || !placement
      || placement.username !== sourceUsername
      || placement.uid !== input.callerOwnerUid
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0
      || placement.generation !== input.generation
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
        generation: input.generation,
        kernelCapability: input.kernelCapability,
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
    const { value: result } = await this.runMasterProjectionMutation(async () => {
      assertAuthority?.();
      return this.ctx.storage.transactionSync(() => (
        applyRepoMetadataMutation(this.config, mutation)
      ));
    });
    this.broadcastRepoProjection();
    return result;
  }

  async getUserKernelProjection(
    sourceKernelName: string,
    usernameInput: string,
    generation: number,
    kernelCapability: string,
  ): Promise<UserKernelProvisioningSnapshot> {
    this.assertMasterKernel();
    const username = canonicalizeLoginUsername(usernameInput);
    const placement = username
      ? await this.authorizeUserKernelCapability({
          sourceKernelName,
          uid: this.userKernels.get(username)?.uid ?? -1,
          generation,
          kernelCapability,
        })
      : null;
    if (
      !username
      || sourceKernelName !== userKernelName(username)
      || !placement
      || placement.generation !== generation
    ) {
      throw new Error("User Kernel projection request denied");
    }
    if (this.projectionState.packageFence() !== null) {
      this.queueMasterPackageFenceRecovery();
    }
    const snapshot = await this.buildCommittedUserKernelProjection(placement.username);
    const current = this.userKernels.get(placement.username);
    if (
      !current
      || !sameUserKernelPlacement(current, placement)
      || !this.isActiveUserKernelPlacement(current)
    ) {
      throw new Error("User Kernel projection request denied");
    }
    return snapshot;
  }

  private async buildCommittedUserKernelProjection(
    username: string,
  ): Promise<UserKernelProvisioningSnapshot> {
    const pendingCommit = this.pendingMasterProjectionCommit;
    if (pendingCommit) await pendingCommit;
    if (this.projectionState.pendingMasterRevision() !== null) {
      throw new Error("User Kernel projection is temporarily unavailable");
    }
    return this.buildUserKernelProjection(username);
  }

  private async ensureUserKernelProvisioned(
    usernameInput: string,
  ): Promise<UserKernelRecord> {
    this.assertMasterKernel();
    if (this.projectionState.packageFence() !== null) {
      throw new Error("User Kernel provisioning is blocked by package projection recovery");
    }
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
    if (
      placement.lifecycle === "legacy"
    ) {
      return placement;
    }
    if (placement.lifecycle === "active") {
      return this.completeUserKernelActivation(placement);
    }
    if (placement.lifecycle !== "provisioning") {
      throw new Error(`User Kernel cannot provision from ${placement.lifecycle}`);
    }

    pruneExpiredAuthorizations(this.userKernelProvisioningAuthorizations);
    const authorization = crypto.randomUUID();
    const kernelCapability = await this.rotateUserKernelCapability(placement);
    const authorizedProvisioning: Omit<
      UserKernelProvisioningAuthorizationInput,
      "authorization"
    > = {
      targetKernelName: userKernelName(username),
      username,
      uid: placement.uid,
      generation: placement.generation,
    };
    this.userKernelProvisioningAuthorizations.set(authorization, {
      expiresAt: Date.now() + USER_KERNEL_PROVISIONING_AUTHORIZATION_TTL_MS,
      provisioning: authorizedProvisioning,
      kernelCapability,
    });
    let marker: UserKernelInstanceMarker;
    try {
      const target = await getAgentByName(
        this.env.KERNEL,
        authorizedProvisioning.targetKernelName,
      ) as unknown as {
        provisionUserKernel: (
          input: UserKernelProvisioningTargetInput,
        ) => Promise<UserKernelInstanceMarker>;
      };
      marker = await target.provisionUserKernel({
        sourceKernelName: this.name,
        authorization,
        username,
        uid: placement.uid,
        generation: placement.generation,
      });
    } finally {
      this.userKernelProvisioningAuthorizations.delete(authorization);
    }
    if (
      marker.lifecycle !== "provisioning"
      || marker.username !== placement.username
      || marker.uid !== placement.uid
      || marker.generation !== placement.generation
    ) {
      throw new Error(`User Kernel failed to prepare: ${username}`);
    }
    if (!await this.verifyUserKernelCapabilityRecord(placement, kernelCapability)) {
      throw new Error(`User Kernel capability activation failed for ${username}`);
    }
    const active = this.userKernels.markActive(username, placement.generation);
    return this.completeUserKernelActivation(active);
  }

  private async completeUserKernelActivation(
    placement: UserKernelRecord,
  ): Promise<UserKernelRecord> {
    if (placement.lifecycle !== "active") {
      throw new Error(`User Kernel is not committed active: ${placement.username}`);
    }
    pruneExpiredAuthorizations(this.userKernelActivationAuthorizations);
    const authorization = crypto.randomUUID();
    const activation: Omit<UserKernelProvisioningAuthorizationInput, "authorization"> = {
      targetKernelName: userKernelName(placement.username),
      username: placement.username,
      uid: placement.uid,
      generation: placement.generation,
    };
    this.userKernelActivationAuthorizations.set(authorization, {
      expiresAt: Date.now() + USER_KERNEL_ACTIVATION_AUTHORIZATION_TTL_MS,
      activation,
    });
    let marker: UserKernelInstanceMarker;
    try {
      const target = await getAgentByName(
        this.env.KERNEL,
        activation.targetKernelName,
      ) as unknown as {
        activateProvisionedUserKernel: (
          input: UserKernelActivationTargetInput,
        ) => Promise<UserKernelInstanceMarker>;
      };
      marker = await target.activateProvisionedUserKernel({
        sourceKernelName: this.name,
        authorization,
        username: placement.username,
        uid: placement.uid,
        generation: placement.generation,
      });
    } finally {
      this.userKernelActivationAuthorizations.delete(authorization);
    }
    if (
      marker.lifecycle !== "active"
      || marker.username !== placement.username
      || marker.uid !== placement.uid
      || marker.generation !== placement.generation
    ) {
      throw new Error(`User Kernel failed to confirm activation: ${placement.username}`);
    }
    const current = this.userKernels.get(placement.username);
    if (!current || !sameUserKernelPlacement(current, placement)) {
      throw new Error(`User Kernel placement changed for ${placement.username}`);
    }
    const legacyFence = this.appRuntimes.getLifecycleFence(placement.uid);
    if (legacyFence) {
      if (
        legacyFence.ownerUsername !== placement.username
        || legacyFence.sourceKernelName !== SHIP_KERNEL_NAME
      ) {
        throw new Error(`Legacy AppRunner lifecycle fence mismatch for ${placement.username}`);
      }
      await this.clearRegisteredAppRunners({
        fenceKind: "user-lifecycle",
        ownerUid: legacyFence.ownerUid,
        ownerUsername: legacyFence.ownerUsername,
        generation: legacyFence.generation,
        fenceId: legacyFence.fenceId,
      });
      const afterClear = this.userKernels.get(placement.username);
      if (!afterClear || !sameUserKernelPlacement(afterClear, placement)) {
        throw new Error(`User Kernel placement changed for ${placement.username}`);
      }
      if (!this.appRuntimes.clearLifecycleFence(legacyFence)) {
        throw new Error(`Legacy AppRunner lifecycle fence clear failed for ${placement.username}`);
      }
      this.purgeAppRunnerRuntimeFenceAuthorizations(
        "user-lifecycle",
        legacyFence.fenceId,
        legacyFence.generation,
      );
    }
    return current;
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

  private buildUserKernelProjection(username: string): UserKernelProvisioningSnapshot {
    this.assertMasterKernel();
    const placement = this.userKernels.get(username);
    const owner = this.auth.getPasswdByUsername(username);
    if (!placement || !owner || placement.uid !== owner.uid) {
      throw new Error(`Cannot project unknown user Kernel: ${username}`);
    }
    const ownerAccount = this.auth.getAccountIdentity(username);
    const isRootAccount = owner.username === "root"
      && owner.uid === 0
      && ownerAccount?.kind === "system";
    if (
      !ownerAccount
      || ownerAccount.uid !== owner.uid
      || ownerAccount.state !== "active"
      || (ownerAccount.kind !== "human" && !isRootAccount)
    ) {
      throw new Error(`Cannot project non-human user Kernel: ${username}`);
    }

    const isRoot = owner.uid === 0;
    const accounts = this.auth.getPasswdEntries();
    const runnableAccounts = accounts.filter((entry) => (
      canOwnerRunAsAccount(this.auth, owner.uid, entry, isRoot)
    ));
    const runnableAccountNames = new Set(runnableAccounts.map((entry) => entry.username));
    const runnableAccountUids = new Set(runnableAccounts.map((entry) => entry.uid));
    const capabilityAccounts = accounts.filter((entry) => (
      entry.uid < 1000
      || runnableAccountNames.has(entry.username)
    ));
    const primaryGids = new Set(capabilityAccounts.map((entry) => entry.gid));
    const authoritativeGroups = this.auth.getGroupEntries();
    const groups = authoritativeGroups.map((group) => ({
      ...group,
      members: isRoot
        ? group.members
        : group.gid === 0
          ? []
          : group.members.filter((member) => runnableAccountNames.has(member)),
    }));
    const relevantGids = new Set([
      ...primaryGids,
      ...authoritativeGroups
        .filter((group) => (
          group.gid < 1000
          || primaryGids.has(group.gid)
          || group.members.some((member) => runnableAccountNames.has(member))
        ))
        .map((group) => group.gid),
    ]);
    if (!isRoot) relevantGids.delete(0);

    const config = this.config.listExplicit("").filter((entry) => {
      if (entry.key.startsWith("config/")) {
        return isRoot || isSharedSystemConfigKey(entry.key);
      }
      const match = /^users\/(\d+)\//.exec(entry.key);
      return match ? runnableAccountUids.has(Number(match[1])) : false;
    });
    config.push(...selectRepoMetadataProjection(
      this.config.listExplicit("repos"),
      runnableAccountNames,
      isRoot,
    ));
    const packages = isRoot
      ? this.packages.list({})
      : this.packages.list({
          scopes: visiblePackageScopesForActor({ uid: owner.uid }),
        });

    return {
      version: 1,
      username: owner.username,
      uid: owner.uid,
      generation: placement.generation,
      projectionRevision: this.projectionState.masterRevision(),
      accounts: accounts.map((entry) => {
        const account = this.auth.getAccountIdentity(entry.username);
        if (!account || account.uid !== entry.uid || account.state !== "active") {
          throw new Error(`Account identity projection is incomplete: ${entry.username}`);
        }
        const kind = account.kind;
        return {
          entry,
          kind,
          locked: !runnableAccountNames.has(entry.username)
            || kind === "agent"
            || isLocked(this.auth.getShadowByUsername(entry.username) ?? {
              username: entry.username,
              hash: "!",
              lastchanged: "",
              min: "",
              max: "",
              warn: "",
              inactive: "",
              expire: "",
              reserved: "",
            }),
        };
      }),
      groups,
      personalAgentUid: this.auth.getPersonalAgentUid(owner.uid),
      capabilities: this.caps.list().filter((record) => relevantGids.has(record.gid)),
      config,
      packages,
    };
  }

  private async installUserKernelProjection(
    snapshot: UserKernelProvisioningSnapshot,
    options: {
      allowLifecycleFence?: boolean;
      allowClosedAdmission?: boolean;
    } = {},
  ): Promise<void> {
    const operation = this.beginUserKernelTargetOperation(snapshot.generation, {
      allowProvisioning: true,
      allowLifecycleFence: options.allowLifecycleFence,
      allowClosedAdmission: options.allowClosedAdmission,
    });
    const previous = this.projectionInstallTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.projectionInstallTail = previous.then(() => current);
    await previous;
    try {
      operation.assertCurrent();
      await this.installUserKernelProjectionSerialized(snapshot, operation);
    } finally {
      release();
      operation.release();
    }
  }

  private async installUserKernelProjectionSerialized(
    snapshot: UserKernelProvisioningSnapshot,
    operation: UserKernelTargetOperationLease,
  ): Promise<void> {
    validateUserKernelProvisioningSnapshot(snapshot, snapshot.username);
    await validatePackageAgentProjectionSecurity(snapshot);
    const before = await this.loadUserKernelMarker();
    if (
      !before
      || (before.lifecycle !== "active" && before.lifecycle !== "provisioning")
      || before.username !== snapshot.username
      || before.uid !== snapshot.uid
      || before.generation !== snapshot.generation
    ) {
      throw new Error("User Kernel projection generation is stale");
    }
    const digest = await userKernelProjectionDigest(snapshot);
    const installed = this.projectionState.installed();
    if (
      installed
      && installed.username === snapshot.username
      && installed.uid === snapshot.uid
      && installed.kernelGeneration === snapshot.generation
    ) {
      if (snapshot.projectionRevision < installed.revision) {
        throw new Error("User Kernel projection revision is stale");
      }
      if (snapshot.projectionRevision === installed.revision) {
        if (installed.digest !== digest) {
          throw new Error("User Kernel projection changed without a new revision");
        }
        return;
      }
    }
    await this.reconcilePackageProjectionRuntime(snapshot.config);
    operation.assertCurrent();
    const after = await this.loadUserKernelMarker();
    const latestInstalled = this.projectionState.installed();
    if (
      !after
      || after !== this.userKernelMarker
      || after.username !== before.username
      || after.uid !== before.uid
      || after.generation !== before.generation
      || (after.lifecycle !== "active" && after.lifecycle !== "provisioning")
      || (
        latestInstalled
        && latestInstalled.username === snapshot.username
        && latestInstalled.uid === snapshot.uid
        && latestInstalled.kernelGeneration === snapshot.generation
        && latestInstalled.revision >= snapshot.projectionRevision
      )
    ) {
      throw new Error("User Kernel projection changed during reconciliation");
    }
    this.applyUserKernelProjection(snapshot, digest);
  }

  private async reconcilePackageProjectionRuntime(
    config: readonly { key: string; value: string }[],
  ): Promise<void> {
    const revisions = new Map<number, string>();
    for (const entry of config) {
      const match = /^users\/(\d+)\/pkg\/security_revision$/.exec(entry.key);
      if (!match) continue;
      const uid = Number(match[1]);
      if (
        !Number.isSafeInteger(uid)
        || uid < 0
        || !/^sha256:[0-9a-f]{64}$/.test(entry.value)
        || revisions.has(uid)
      ) {
        throw new Error("User Kernel package security revision projection is invalid");
      }
      revisions.set(uid, entry.value);
    }

    const processTeardowns: Promise<void>[] = [];
    for (const process of this.procs.list()) {
      const projectedRevision = revisions.get(process.uid) ?? null;
      const localPackageIdentity = packageAgentRuntimeIdentity(
        { config: this.config },
        process.uid,
      );
      const isOrWasPackage = localPackageIdentity.kind !== "ordinary"
        || projectedRevision !== null
        || process.packageSecurityRevision !== null;
      if (
        isOrWasPackage
        && (
          process.packageSecurityRevision === null
          || projectedRevision === null
          || process.packageSecurityRevision !== projectedRevision
        )
      ) {
        processTeardowns.push(this.queueRevokedProcessTeardown(
          process.processId,
          "Package security revision changed",
        ));
      }
    }

    const scheduleTeardowns: Promise<void>[] = [];
    for (const schedule of this.schedules.listStored()) {
      const projectedRevision = revisions.get(schedule.runAs.uid) ?? null;
      const localPackageIdentity = packageAgentRuntimeIdentity(
        { config: this.config },
        schedule.runAs.uid,
      );
      const isOrWasPackage = localPackageIdentity.kind !== "ordinary"
        || projectedRevision !== null
        || schedule.packageSecurityRevision !== null;
      if (
        isOrWasPackage
        && (
          schedule.packageSecurityRevision === null
          || projectedRevision === null
          || schedule.packageSecurityRevision !== projectedRevision
        )
      ) {
        scheduleTeardowns.push(this.disableRevokedSchedule(
          schedule,
          "Package security revision changed",
        ));
      }
    }
    await Promise.all([...processTeardowns, ...scheduleTeardowns]);
  }

  private applyUserKernelProjection(
    snapshot: UserKernelProvisioningSnapshot,
    digest: string,
  ): void {
    this.ctx.storage.transactionSync(() => {
      this.auth.replaceRuntimeDirectory({
        accounts: snapshot.accounts,
        groups: snapshot.groups,
        ownerUid: snapshot.uid,
        personalAgentUid: snapshot.personalAgentUid,
      });
      this.caps.replaceRuntimeProjection(snapshot.capabilities);
      this.config.replaceRuntimeProjection(snapshot.config);
      this.packages.replaceRuntimeProjection(snapshot.packages);
      this.projectionState.recordInstalled({
        username: snapshot.username,
        uid: snapshot.uid,
        kernelGeneration: snapshot.generation,
        revision: snapshot.projectionRevision,
        digest,
      });
    });
  }

  private async authenticateConnectionViaMaster(
    args: ConnectArgs,
    loginSourceScope: LoginSourceScope,
    expectedGeneration?: number,
  ): Promise<import("./context").KernelAuthenticationResult> {
    const marker = await this.loadUserKernelMarker();
    const username = canonicalizeLoginUsername(args.auth?.username);
    if (
      !marker
      || marker.lifecycle !== "active"
      || !username
      || username !== marker.username
      || this.name !== userKernelName(username)
      || expectedGeneration !== marker.generation
    ) {
      return { ok: false, error: "Authentication failed" };
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    let kernelCapability: string;
    try {
      kernelCapability = await this.requireLocalUserKernelCapability(marker);
    } catch {
      return { ok: false, error: "Authentication failed" };
    }
    const authenticated = await master.authenticateUserKernelConnection({
      sourceKernelName: this.name,
      username,
      generation: marker.generation,
      kernelCapability,
      args,
      loginSourceScope,
    });
    if (authenticated.ok) {
      let projection: UserKernelProvisioningSnapshot;
      try {
        projection = await master.getUserKernelProjection(
          this.name,
          username,
          marker.generation,
          kernelCapability,
        );
      } catch {
        return { ok: false, error: "Authentication failed" };
      }
      if (!this.isCurrentUserKernelMarker(marker)) {
        return { ok: false, error: "Authentication failed" };
      }
      validateUserKernelProvisioningSnapshot(projection, marker.username);
      await this.installUserKernelProjection(projection);
    }
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
      marker = await this.requireActiveUserKernel(ctx.kernelGeneration);
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
    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    const result = await master.dispatchMasterSyscall({
      sourceKernelName: this.name,
      callerOwnerUid: resolveCallerOwnerUid(ctx),
      generation: marker.generation,
      kernelCapability,
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
    if (result.refreshProjection) {
      const projection = await master.getUserKernelProjection(
        this.name,
        this.instanceUsername,
        marker.generation,
        kernelCapability,
      );
      await this.installUserKernelProjection(projection);
      ctx.assertCurrentKernel();
    }
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

    const marker = await this.requireActiveUserKernel(context.kernelGeneration);
    if (!marker || marker.uid !== ownerUid) {
      throw new Error("Device credential revocation authentication failed");
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    const notices = await master.revokeUserKernelDeviceCredentials({
      sourceKernelName: this.name,
      ownerUid,
      generation: marker.generation,
      kernelCapability,
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
    if (!placement || placement.lifecycle === "legacy") {
      this.persistAndFenceTokenRevocations([record]);
      return;
    }
    if (!this.isActiveUserKernelPlacement(placement)) {
      // Non-active generations are already fenced, and revoked credentials
      // cannot authenticate when a later generation becomes active.
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
      generation: placement.generation,
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

    const locallyOwned = notices.filter((notice) => {
      const placement = this.userKernels.getByUid(notice.uid);
      return !placement || placement.lifecycle === "legacy";
    });
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

    const marker = await this.requireActiveUserKernel(context.kernelGeneration);
    if (!marker || !this.instanceUsername || marker.username !== this.instanceUsername) {
      throw new Error("Repository metadata authentication failed");
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    const result = await master.mutateUserRepoMetadata({
      sourceKernelName: this.name,
      callerOwnerUid,
      generation: marker.generation,
      kernelCapability,
      identity: context.identity,
      mutation,
    });
    context.assertCurrentKernel();
    const refreshed = await this.receiveMasterProjection({
      sourceKernelName: SHIP_KERNEL_NAME,
      generation: marker.generation,
    });
    if (!refreshed) {
      throw new Error("Repository metadata projection refresh failed");
    }
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
    const marker = await this.requireActiveUserKernel(context.kernelGeneration);
    if (!marker || marker.username !== this.instanceUsername) {
      throw new Error("Repository operation authentication failed");
    }
    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const authorization = await master.authorizeUserRepoOperation({
      sourceKernelName: this.name,
      callerOwnerUid: resolveCallerOwnerUid(context),
      generation: marker.generation,
      kernelCapability,
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
        ? new GenerationFencedMcpOAuthProvider(
            this.ctx.storage,
            this.name,
            callbackUrl,
            callbackRoute.username,
            callbackRoute.generation,
            () => {
              const marker = this.userKernelMarker;
              return Boolean(
                marker
                && marker.lifecycle === "active"
                && marker.username === callbackRoute.username
                && marker.generation === callbackRoute.generation
                && this.appRuntimes.getLifecycleFence(marker.uid) === null
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

    let operation: UserKernelTargetOperationLease | null = null;
    let releaseMasterOperation: (() => void) | null = null;
    if (this.instanceKind === "user") {
      const marker = await this.loadUserKernelMarker();
      if (
        !marker
        || marker.lifecycle !== "active"
        || marker.uid !== server.uid
      ) {
        return oauthCallbackHtmlResponse({
          ok: false,
          message: "MCP OAuth session is no longer active",
        }, 409);
      }
      try {
        operation = this.beginUserKernelTargetOperation(marker.generation);
      } catch {
        return oauthCallbackHtmlResponse({
          ok: false,
          message: "MCP OAuth session is no longer active",
        }, 409);
      }
    } else {
      releaseMasterOperation = this.beginMasterLegacyOwnerOperation(server.uid);
      if (!releaseMasterOperation) {
        return oauthCallbackHtmlResponse({
          ok: false,
          message: "MCP OAuth session is no longer active",
        }, 409);
      }
    }

    const authProvider = this.mcp.mcpConnections[serverId]
      ?.options.transport.authProvider;
    if (authProvider instanceof BoundedMcpOAuthProvider) {
      authProvider.setCallbackOperationSignal(operation?.signal);
    }
    try {
      const result = await this.mcp.handleCallbackRequest(request);
      operation?.assertCurrent();
      if (result.authSuccess) {
        try {
          await this.mcp.establishConnection(result.serverId);
        } catch (error) {
          console.warn("[Kernel] MCP connection establishment failed after OAuth:", error);
        }
        operation?.assertCurrent();
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
      if (operation?.signal.aborted) {
        await this.mcp.closeConnection(serverId).catch(() => {});
      }
      return oauthCallbackHtmlResponse({
        ok: false,
        message: "MCP OAuth session is no longer active",
      }, 409);
    } finally {
      if (authProvider instanceof BoundedMcpOAuthProvider) {
        authProvider.setCallbackOperationSignal(undefined);
      }
      operation?.release();
      releaseMasterOperation?.();
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/oauth/callback" || request.method !== "GET") {
      return new Response("Not Found", { status: 404 });
    }

    let callbackMarker: UserKernelInstanceMarker | null = null;
    if (this.instanceKind === "user") {
      callbackMarker = await this.loadUserKernelMarker();
      const routedState = parseRoutedOAuthState(url.searchParams.get("state"));
      if (
        !callbackMarker
        || callbackMarker.lifecycle !== "active"
        || !routedState
        || routedState.username !== callbackMarker.username
        || routedState.generation !== callbackMarker.generation
      ) {
        return new Response("Not Found", { status: 404 });
      }
    }

    const acquireOAuthOperation = callbackMarker
      ? (flow: import("./oauth-store").OAuthFlowRecord) => {
          if (flow.kernelOwnerUid !== callbackMarker.uid) return null;
          try {
            const operation = this.beginUserKernelTargetOperation(callbackMarker.generation);
            return { release: operation.release, signal: operation.signal };
          } catch {
            return null;
          }
        }
      : (flow: import("./oauth-store").OAuthFlowRecord) => {
          if (!Number.isSafeInteger(flow.kernelOwnerUid) || flow.kernelOwnerUid! < 0) {
            return null;
          }
          const release = this.beginMasterLegacyOwnerOperation(flow.kernelOwnerUid!);
          return release ? { release } : null;
        };
    const result = await completeOAuthCallbackFlow({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
    }, this.oauth, fetch, callbackMarker
      ? () => this.isCurrentUserKernelMarker(callbackMarker)
      : undefined, acquireOAuthOperation);
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
      ? buildUserMcpOAuthCallbackPath(marker.username, marker.generation)
      : "/oauth/callback";
    const callbackUrl = callbackHost
      ? `${callbackHost.replace(/\/$/, "")}${callbackPath}`
      : undefined;
    let clientMetadataUrl: string | undefined;
    if (callbackHost && marker?.lifecycle === "active") {
      const metadataUrl = new URL("/.well-known/oauth-client/gsv.json", callbackHost);
      metadataUrl.searchParams.set("username", marker.username);
      metadataUrl.searchParams.set("generation", String(marker.generation));
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
    const kernelGeneration = this.instanceKind === "user"
      ? parseUserKernelGenerationHeader(
          ctx.request.headers.get(USER_KERNEL_GENERATION_HEADER),
        )
      : undefined;
    const state: ConnectionState = {
      step: "pending",
      loginSourceScope,
      ...(kernelGeneration !== undefined ? { kernelGeneration } : {}),
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
    let operation: UserKernelTargetOperationLease | null = null;
    if (this.instanceKind === "user") {
      try {
        if (connection.state?.kernelGeneration === undefined) {
          throw new Error("Missing user Kernel generation");
        }
        operation = this.beginUserKernelTargetOperation(connection.state.kernelGeneration);
        await this.requireActiveUserKernel(connection.state?.kernelGeneration);
        operation.assertCurrent();
      } catch {
        operation?.release();
        connection.close(1008, "Authentication failed");
        return;
      }
    } else {
      operation = this.beginUserKernelTargetOperation(
        this.projectionState.masterRevision(),
      );
    }
    try {
      if (typeof message !== "string") {
        operation?.assertCurrent();
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
      if (parsed.type === "res" && operation) {
        const route = this.routes.get(parsed.id);
        const packageBound = route?.origin.type === "app"
          || (route?.origin.type === "process"
            && this.procs.get(route.origin.id)?.packageSecurityRevision !== null);
        if (packageBound) operation.markPackageStamped();
      }
      operation?.assertCurrent();

      switch (parsed.type) {
        case "req":
          await this.handleReq(connection, parsed, operation ?? undefined);
          break;
        case "res":
          operation?.assertCurrent();
          this.handleRes(connection, parsed);
          break;
        case "sig":
          if ((parsed as unknown as { body?: unknown }).body !== undefined) {
            this.sendError(connection, "?", 400, "Signals cannot carry bodies");
            return;
          }
          operation?.assertCurrent();
          if (parsed.signal === REQUEST_CANCEL_SIGNAL) {
            this.handleRequestCancel(connection, parsed);
          } else {
            this.handleSig(connection, parsed);
          }
          break;
      }
    } finally {
      operation?.release();
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
    const releaseMasterOperation = this.instanceKind === "master"
      ? this.beginMasterLegacyProcessOperation(registered)
      : null;
    if (this.instanceKind === "master" && !releaseMasterOperation) {
      if (frame.type === "req") {
        await cancelUnlockedBody(frame.body, "Process request rejected");
        return errFrame(frame.id, 503, "User Kernel is not active");
      }
      return null;
    }
    const expectedGeneration = this.instanceKind === "user"
      ? this.userKernelMarker?.generation ?? registered?.kernelGeneration ?? 0
      : 0;
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(expectedGeneration, {
        packageStamped: typeof registered?.packageSecurityRevision === "string",
      });
    } catch (error) {
      releaseMasterOperation?.();
      if (frame.type === "req") {
        await cancelUnlockedBody(frame.body, "Process request rejected");
        return errFrame(frame.id, 503, errorMessage(error));
      }
      return null;
    }

    try {
      const marker = await this.requireActiveUserKernel();
      operation.assertCurrent();
      const generationError = this.processKernelGenerationError(processId, marker);
      if (generationError) {
        if (frame.type === "req") {
          await cancelUnlockedBody(frame.body, "Process request rejected");
          return errFrame(
            frame.id,
            generationError === "Process registry record not found" ? 404 : 410,
            generationError,
          );
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
      operation.assertCurrent();
      if (frame.type === "req") {
        try {
          return await this.handleProcessReq(
            processId,
            frame,
            marker?.generation,
            operation,
          );
        } finally {
          await cancelUnlockedBody(frame.body, "Process request completed");
        }
      }

      if (frame.type === "sig") {
        const runId = this.extractRunId(frame.payload);
        operation.assertCurrent();
        if (!this.updateProcessRuntimeFromSignal(processId, frame, runId)) {
          if (frame.signal === "proc.run.finished" && runId) {
            this.runRoutes.delete(runId);
          }
          return null;
        }
        const delivered = this.enqueueProcessSignal(
          processId,
          frame,
          marker?.generation,
        );
        this.completeIpcCallsForProcessSignal(processId, frame);
        if (frame.signal === "proc.run.finished") {
          await delivered;
        }
        return null;
      }

      return null;
    } finally {
      operation.release();
      releaseMasterOperation?.();
    }
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
    if (this.instanceKind === "master") {
      return pending.generation === null;
    }
    const marker = await this.loadUserKernelMarker();
    return Boolean(
      marker
      && (marker.lifecycle === "provisioning" || marker.lifecycle === "active")
      && pending.generation === marker.generation,
    );
  }

  async resolveProcessAuthority(
    processId: string,
    claimedIdentity: unknown,
  ): Promise<ProcessAuthorityResult> {
    const record = this.procs.get(processId);
    const releaseMasterOperation = this.instanceKind === "master"
      ? this.beginMasterLegacyProcessOperation(record)
      : null;
    if (this.instanceKind === "master" && !releaseMasterOperation) {
      return { ok: false, error: "user Kernel is not active" };
    }
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(
        this.instanceKind === "user"
          ? this.userKernelMarker?.generation ?? record?.kernelGeneration ?? 0
          : this.projectionState.masterRevision(),
        { packageStamped: typeof record?.packageSecurityRevision === "string" },
      );
    } catch {
      releaseMasterOperation?.();
      return { ok: false, error: "user Kernel is not active" };
    }
    try {
      let marker: UserKernelInstanceMarker | null;
      try {
        marker = await this.requireActiveUserKernel();
        operation.assertCurrent();
      } catch {
        return { ok: false, error: "user Kernel is not active" };
      }
      const authority = this.resolveProcessRegistryAuthority(
        processId,
        claimedIdentity,
        marker?.generation,
      );
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
      operation.assertCurrent();
      return authority;
    } finally {
      operation.release();
      releaseMasterOperation?.();
    }
  }

  /** Registry/generation-only authority used exclusively to exact-ack proc.kill. */
  async resolveProcessTeardownAuthority(
    processId: string,
    claimedIdentity: unknown,
  ): Promise<ProcessAuthorityResult> {
    const marker = this.instanceKind === "master"
      ? null
      : await this.loadUserKernelMarker();
    if (
      this.instanceKind === "user"
      && (!marker || (marker.lifecycle !== "active" && marker.lifecycle !== "provisioning"))
    ) {
      return { ok: false, error: "user Kernel teardown authority is unavailable" };
    }
    let registryGeneration = marker?.generation;
    if (marker?.lifecycle === "provisioning") {
      const record = this.procs.get(processId);
      const registered = record?.kernelGeneration;
      if (
        registered === marker.generation
        || (
          typeof registered === "number"
          && marker.generation > 1
          && registered === marker.generation - 1
        )
      ) {
        registryGeneration = registered;
      }
    }
    return this.resolveProcessRegistryAuthority(
      processId,
      claimedIdentity,
      registryGeneration,
    );
  }

  /**
   * Exact authority for a Process DO to acknowledge a target-side lifecycle
   * abort after the user Kernel has already persisted its non-active marker.
   * The process must still be registered to the generation being fenced.
   */
  async resolveProcessLifecycleFenceAuthority(
    processId: string,
    claimedIdentity: unknown,
    fencedGeneration: number,
  ): Promise<ProcessAuthorityResult> {
    if (
      !Number.isSafeInteger(fencedGeneration)
      || fencedGeneration <= 0
    ) {
      return { ok: false, error: "user Kernel lifecycle fence authority is unavailable" };
    }
    if (this.instanceKind === "master") {
      const record = this.procs.get(processId);
      const fence = record
        ? this.appRuntimes.getLifecycleFence(record.ownerUid)
        : null;
      const placement = fence ? this.userKernels.getByUid(fence.ownerUid) : null;
      if (
        !record
        || record.kernelGeneration !== null
        || !fence
        || fence.sourceKernelName !== SHIP_KERNEL_NAME
        || fence.generation !== fencedGeneration
        || !placement
        || placement.username !== fence.ownerUsername
        || placement.uid !== record.ownerUid
      ) {
        return { ok: false, error: "user Kernel lifecycle fence authority is unavailable" };
      }
      return this.resolveProcessRegistryAuthority(processId, claimedIdentity, undefined);
    }
    const marker = await this.loadUserKernelMarker();
    const lifecycleFence = marker
      ? this.appRuntimes.getLifecycleFence(marker.uid)
      : null;
    const activeRecoveryFence = Boolean(
      marker?.lifecycle === "active"
      && lifecycleFence
      && lifecycleFence.sourceKernelName === this.name
      && lifecycleFence.generation === fencedGeneration,
    );
    if (
      !marker
      || (marker.lifecycle === "active" && !activeRecoveryFence)
      || (
        marker.generation !== fencedGeneration
        && marker.generation !== fencedGeneration + 1
      )
    ) {
      return { ok: false, error: "user Kernel lifecycle fence authority is unavailable" };
    }
    return this.resolveProcessRegistryAuthority(
      processId,
      claimedIdentity,
      fencedGeneration,
    );
  }

  /** Exact authority for aborting only package-stamped processes while fenced. */
  async resolveProcessPackageProjectionFenceAuthority(
    processId: string,
    claimedIdentity: unknown,
    fencedGeneration: number,
    fenceId: string,
  ): Promise<ProcessAuthorityResult> {
    if (
      !Number.isSafeInteger(fencedGeneration)
      || fencedGeneration <= 0
      || typeof fenceId !== "string"
      || !fenceId
    ) {
      return { ok: false, error: "package projection fence authority is unavailable" };
    }
    const fence = this.projectionState.packageFence();
    const record = this.procs.get(processId);
    if (
      fence?.fenceId !== fenceId
      || fence.kernelGeneration !== fencedGeneration
      || !record
      || record.packageSecurityRevision === null
    ) {
      return { ok: false, error: "package projection fence authority is unavailable" };
    }
    if (this.instanceKind === "user") {
      const marker = await this.loadUserKernelMarker();
      if (
        !marker
        || marker.lifecycle !== "active"
        || marker.generation !== fencedGeneration
      ) {
        return { ok: false, error: "package projection fence authority is unavailable" };
      }
    }
    return this.resolveProcessRegistryAuthority(
      processId,
      claimedIdentity,
      this.instanceKind === "user" ? fencedGeneration : undefined,
    );
  }

  private resolveProcessRegistryAuthority(
    processId: string,
    claimedIdentity: unknown,
    kernelGeneration?: number,
  ): ProcessAuthorityResult {
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
    if (!processKernelGenerationMatches(record, kernelGeneration)) {
      return { ok: false, error: "process belongs to a stale user Kernel generation" };
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
    const runAsEntry = this.auth.getPasswdByUid(record.uid);
    if (!runAsEntry) {
      return { ok: false, error: "process run-as account not found" };
    }
    const runAsIdentity: ProcessIdentity = {
      uid: runAsEntry.uid,
      gid: runAsEntry.gid,
      gids: this.auth.resolveGids(runAsEntry.username, runAsEntry.gid),
      username: runAsEntry.username,
      home: runAsEntry.home,
      cwd: record.cwd,
    };
    if (!processIdentityEquals(registryIdentity, runAsIdentity, { includeCwd: true })) {
      return { ok: false, error: "process registry identity does not match auth store" };
    }
    const ownerEntry = this.auth.getPasswdByUid(record.ownerUid);
    if (!ownerEntry) {
      return { ok: false, error: "process owner account not found" };
    }
    return {
      ok: true,
      authority: {
        processId,
        identity: registryIdentity,
        ownerIdentity: {
          uid: ownerEntry.uid,
          gid: ownerEntry.gid,
          gids: this.auth.resolveGids(ownerEntry.username, ownerEntry.gid),
          username: ownerEntry.username,
          home: ownerEntry.home,
          cwd: ownerEntry.home,
        },
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
    const releaseMasterOperation = this.instanceKind === "master"
      ? this.beginMasterLegacyProcessOperation(registered)
      : null;
    if (this.instanceKind === "master" && !releaseMasterOperation) {
      throw new Error("User Kernel is not active");
    }
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(
        this.instanceKind === "user"
          ? this.userKernelMarker?.generation ?? registered?.kernelGeneration ?? 0
          : 0,
        { packageStamped: typeof registered?.packageSecurityRevision === "string" },
      );
    } catch (error) {
      releaseMasterOperation?.();
      throw error;
    }
    let controller: AbortController | null = null;
    const origin: RouteOrigin = { type: "process", id: processId };
    try {
      const marker = await this.requireActiveUserKernel();
      operation.assertCurrent();
      const generationError = this.processKernelGenerationError(processId, marker);
      if (generationError) {
        throw new Error(generationError);
      }
      const requiredCall = options.internalPurpose === "model-transport"
        ? undefined
        : "net.fetch";
      if (!await this.authorizeRegisteredProcessRuntime(processId, requiredCall)) {
        throw new Error("Process package-agent authority was revoked");
      }
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
      const requestSignal = controller
        ? AbortSignal.any([controller.signal, operation.signal])
        : operation.signal;
      const response = await this.requestDevice(
        device.targetId,
        "net.fetch",
        args,
        {
          ttlMs: options.ttlMs,
          ...(options.body ? { body: options.body } : {}),
          ...(options.requestId ? { id: options.requestId } : {}),
          signal: requestSignal,
        },
      );
      try {
        const currentMarker = await this.requireActiveUserKernel(marker?.generation);
        const currentGenerationError = this.processKernelGenerationError(
          processId,
          currentMarker,
        );
        if (currentGenerationError) {
          throw new Error(currentGenerationError);
        }
        if (!await this.authorizeRegisteredProcessRuntime(processId, requiredCall)) {
          throw new Error("Process package-agent authority was revoked");
        }
        operation.assertCurrent();
      } catch (error) {
        await cancelUnlockedBody(response.body, "Process net.fetch result rejected");
        throw error;
      }
      return response as ResponseOkFrame<"net.fetch">;
    } finally {
      operation.release();
      releaseMasterOperation?.();
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
    let marker: UserKernelInstanceMarker | null;
    try {
      marker = await this.requireActiveUserKernel();
    } catch {
      return 0;
    }
    if (this.processKernelGenerationError(processId, marker)) {
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
    await this.requireActiveUserKernel();
    if (frame.type !== "req") {
      return null;
    }

    let releaseMasterOperation: (() => void) | null = null;
    try {
      if (this.instanceKind === "master" && frame.call === "adapter.inbound") {
        const routed = adapterInboundRouteMetadata(
          frame as RequestFrame<"adapter.inbound">,
        );
        const link = routed
          ? this.adapters.identityLinks.get(
              routed.adapter,
              routed.accountId,
              routed.actorId,
            )
          : null;
        const placement = link ? this.userKernels.getByUid(link.uid) : null;
        if (
          !routed
          || !link
          || !this.adapters.identityLinks.isCurrentGeneration(
            routed.adapter,
            routed.accountId,
            routed.actorId,
            link.generation,
          )
          || placement?.lifecycle !== "legacy"
          || this.transitioningUserKernels.has(placement.username)
          || this.appRuntimes.getLifecycleFence(placement.uid) !== null
        ) {
          return errFrame(frame.id, 401, "Authentication failed");
        }
        releaseMasterOperation = this.beginMasterUserOperation(placement.username);
        if (!releaseMasterOperation) {
          return errFrame(frame.id, 401, "Authentication failed");
        }
      }
      return await this.handleServiceReq(frame);
    } finally {
      releaseMasterOperation?.();
      await cancelUnlockedBody(frame.body, "Service request completed");
    }
  }

  async serviceLinkedAdapterFrame(
    input: RoutedAdapterInboundInput,
  ): Promise<ResponseFrame> {
    const frame = input?.frame;
    let operation: UserKernelTargetOperationLease | null = null;
    try {
      operation = this.beginUserKernelTargetOperation(input.generation);
      const marker = await this.requireActiveUserKernel(input.generation);
      operation.assertCurrent();
      const routed = adapterInboundRouteMetadata(frame);
      if (
        !marker
        || input.source !== ADAPTER_INBOUND_GATEWAY_SOURCE
        || typeof input.authorization !== "string"
        || input.authorization.length === 0
        || input.username !== marker.username
        || input.ownerUid !== marker.uid
        || !Number.isSafeInteger(input.generation)
        || input.generation <= 0
        || !Number.isSafeInteger(input.linkGeneration)
        || input.linkGeneration <= 0
        || !routed
        || !sameAdapterInboundRouteMetadata(input, routed)
        || frame.body
      ) {
        return errFrame(typeof frame?.id === "string" ? frame.id : "", 401, "Authentication failed");
      }

      const authorized = await this.isMasterAdapterInboundAuthorized({
        authorization: input.authorization,
        targetKernelName: this.name,
        username: marker.username,
        ownerUid: marker.uid,
        generation: marker.generation,
        adapter: routed.adapter,
        accountId: routed.accountId,
        actorId: routed.actorId,
        linkGeneration: input.linkGeneration,
        frameId: routed.frameId,
        surfaceKind: routed.surfaceKind,
        surfaceId: routed.surfaceId,
      });
      if (!authorized) {
        return errFrame(frame.id, 401, "Authentication failed");
      }
      operation.assertCurrent();

      let currentMarker: UserKernelInstanceMarker | null;
      try {
        currentMarker = await this.requireActiveUserKernel(marker.generation);
      } catch {
        return errFrame(frame.id, 401, "Authentication failed");
      }
      if (
        !currentMarker
        || currentMarker.username !== marker.username
        || currentMarker.uid !== marker.uid
      ) {
        return errFrame(frame.id, 401, "Authentication failed");
      }

      return await this.handleServiceReq(frame, {
        routedAdapterOwnerUid: currentMarker.uid,
        routedAdapterLinkGeneration: input.linkGeneration,
        targetOperation: operation,
      });
    } catch {
      return errFrame(typeof frame?.id === "string" ? frame.id : "", 401, "Authentication failed");
    } finally {
      operation?.release();
      await cancelUnlockedBody(frame?.body, "Adapter request completed");
    }
  }

  private async isMasterAdapterInboundAuthorized(
    input: AdapterInboundAuthorizationInput,
  ): Promise<boolean> {
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    return master.consumeAdapterInboundAuthorization(input);
  }

  async issueAdapterInboundRoute(
    input: AdapterInboundRouteMetadata,
  ): Promise<AdapterInboundRouteResult> {
    this.assertMasterKernel();
    const routed = normalizeAdapterInboundRouteMetadata(input);
    if (!routed) {
      return { kind: "error", code: 400, message: "Invalid adapter request" };
    }
    const link = this.adapters.identityLinks.get(
      routed.adapter,
      routed.accountId,
      routed.actorId,
    );
    if (!link) {
      if (routed.surfaceKind !== "dm") {
        return {
          kind: "response",
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
        kind: "response",
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
      return { kind: "error", code: 401, message: "Authentication failed" };
    }
    const ownerUid = link.uid;

    const placement = this.userKernels.getByUid(ownerUid);
    if (!placement) {
      return { kind: "error", code: 503, message: "Adapter owner is unavailable" };
    }
    if (placement.lifecycle === "legacy") {
      if (
        this.transitioningUserKernels.has(placement.username)
        || this.appRuntimes.getLifecycleFence(placement.uid) !== null
      ) {
        return { kind: "error", code: 503, message: "Adapter owner is unavailable" };
      }
      return { kind: "legacy" };
    }
    if (!this.isActiveUserKernelPlacement(placement)) {
      return { kind: "error", code: 503, message: "Adapter owner is unavailable" };
    }

    pruneExpiredAuthorizations(this.adapterInboundAuthorizations);
    if (
      this.adapterInboundAuthorizations.size
      >= MAX_PENDING_ADAPTER_INBOUND_AUTHORIZATIONS
    ) {
      return { kind: "error", code: 503, message: "Adapter route is busy" };
    }
    const authorization = crypto.randomUUID();
    const delivery: Omit<AdapterInboundAuthorizationInput, "authorization"> = {
      targetKernelName: userKernelName(placement.username),
      username: placement.username,
      ownerUid,
      generation: placement.generation,
      adapter: routed.adapter,
      accountId: routed.accountId,
      actorId: routed.actorId,
      linkGeneration: link.generation,
      frameId: routed.frameId,
      surfaceKind: routed.surfaceKind,
      surfaceId: routed.surfaceId,
    };
    this.adapterInboundAuthorizations.set(authorization, {
      expiresAt: Date.now() + ADAPTER_INBOUND_AUTHORIZATION_TTL_MS,
      delivery,
    });
    return {
      kind: "active",
      authorization,
      targetKernelName: delivery.targetKernelName,
      username: placement.username,
      ownerUid,
      generation: placement.generation,
      linkGeneration: link.generation,
    };
  }

  async appRequest(
    appFrame: AppFrameContext,
    frame: RequestFrame,
    runnerName?: string,
  ): Promise<ResponseFrame> {
    let releaseMasterOperation: (() => void) | null = null;
    if (this.instanceKind === "master") {
      const ownerUsername = canonicalizeLoginUsername(
        appFrame.kernelUsername ?? appFrame.username,
      );
      const placement = ownerUsername ? this.userKernels.get(ownerUsername) : null;
      releaseMasterOperation = placement?.lifecycle === "legacy"
        ? this.beginMasterUserOperation(placement.username)
        : null;
      if (!releaseMasterOperation) {
        await cancelUnlockedBody(frame.body, "Package app request rejected");
        return errFrame(frame.id, 503, "User Kernel is not active");
      }
    }
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(appFrame.kernelGeneration ?? 0, {
        packageStamped: true,
      });
    } catch (error) {
      releaseMasterOperation?.();
      await cancelUnlockedBody(frame.body, "Package app request rejected");
      return errFrame(frame.id, 503, errorMessage(error));
    }
    try {
      return await this.handleAppRequest(appFrame, frame, operation, runnerName);
    } finally {
      operation.release();
      releaseMasterOperation?.();
      await cancelUnlockedBody(frame.body, "App request completed");
    }
  }

  async authorizeAppFrame(
    appFrame: AppFrameContext,
    runnerName?: string,
  ): Promise<boolean> {
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(appFrame.kernelGeneration ?? 0, {
        packageStamped: true,
      });
    } catch {
      return false;
    }
    try {
      if (isAppFrameContextExpired(appFrame) || !(await this.isLocalAppFrameOwnerActive(appFrame))) {
        return false;
      }
      operation.assertCurrent();
      const record = this.packages.resolve(
        appFrame.packageId,
        visiblePackageScopesForActor({ uid: appFrame.uid }),
      );
      if (
        !record
        || !record.enabled
        || (record.reviewRequired && !record.reviewedAt)
        || record.manifest.name !== appFrame.packageName
        || record.updatedAt !== appFrame.packageUpdatedAt
        || record.artifact.hash !== appFrame.packageArtifactHash
      ) {
        return false;
      }
      const entrypoint = findAppFrameEntrypoint(
        record.manifest.entrypoints,
        appFrame.entrypointName,
        appFrame.routeBase,
      );
      if (
        !entrypoint
        || (entrypoint.kind === "ui" && !this.isActiveLocalAppClient(appFrame))
      ) {
        return false;
      }
      operation.assertCurrent();
      return this.rememberAuthorizedAppRuntime(appFrame, runnerName);
    } finally {
      operation.release();
    }
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

    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(routed.generation, {
        packageStamped: true,
      });
    } catch {
      return false;
    }
    try {
      if (!(await this.acceptsLocalAppSessionRoute(sessionId))) {
        return false;
      }
      operation.assertCurrent();
      return true;
    } catch {
      return false;
    } finally {
      operation.release();
    }
  }

  private async handleAppRequest(
    appFrame: AppFrameContext,
    frame: RequestFrame,
    operation: UserKernelTargetOperationLease,
    runnerName?: string,
  ): Promise<ResponseFrame> {
    if (isAppFrameContextExpired(appFrame)) {
      return errFrame(frame.id, 401, "App frame expired");
    }

    if (!(await this.isLocalAppFrameOwnerActive(appFrame))) {
      return errFrame(frame.id, 401, "Authentication failed");
    }
    operation.assertCurrent();

    if (isInternalOnlySyscall(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const record = this.packages.resolve(
      appFrame.packageId,
      visiblePackageScopesForActor({ uid: appFrame.uid }),
    );
    if (
      !record
      || !record.enabled
      || (record.reviewRequired && !record.reviewedAt)
      || record.manifest.name !== appFrame.packageName
      || record.updatedAt !== appFrame.packageUpdatedAt
      || record.artifact.hash !== appFrame.packageArtifactHash
    ) {
      return errFrame(frame.id, 404, "Package app not found");
    }

    const entrypoint = findAppFrameEntrypoint(record.manifest.entrypoints, appFrame.entrypointName, appFrame.routeBase);
    if (!entrypoint) {
      return errFrame(frame.id, 404, "Package app entrypoint not found");
    }

    if (entrypoint.kind === "ui" && !this.isActiveLocalAppClient(appFrame)) {
      return errFrame(frame.id, 401, "Authentication failed");
    }
    operation.assertCurrent();
    if (!this.rememberAuthorizedAppRuntime(appFrame, runnerName)) {
      return errFrame(frame.id, 401, "Authentication failed");
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

    const origin: RouteOrigin = { type: "app", id: frame.id };
    let controller: AbortController;
    try {
      controller = this.registerActiveRequest(origin, frame.id);
    } catch (error) {
      return errFrame(frame.id, 409, error instanceof Error ? error.message : String(error));
    }
    const requestSignal = AbortSignal.any([controller.signal, operation.signal]);
    frame = this.bindRequestBodyCancellation(frame, requestSignal);
    const ctx = this.buildKernelContext({
      identity,
      appFrame,
      requestSignal,
      targetOperation: operation,
    });
    const pending = this.createPendingAppResponse(frame.id);
    try {
      const result = await this.dispatchWithMasterProjectionGate(frame, origin, ctx);
      if (requestSignal.aborted) {
        return errFrame(frame.id, 503, "User Kernel is not active");
      }
      await this.requireActiveUserKernel(appFrame.kernelGeneration);
      operation.assertCurrent();
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
      this.applyPostDispatchEffects(frame, result.response);
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

    let operation: UserKernelTargetOperationLease | null = null;
    if (this.instanceKind === "user") {
      const routed = parseRoutedAppSessionId(sessionId);
      if (!routed) {
        return { ok: false, status: 401, message: "Authentication failed" };
      }
      try {
        operation = this.beginUserKernelTargetOperation(routed.generation, {
          packageStamped: true,
        });
      } catch {
        return { ok: false, status: 401, message: "Authentication failed" };
      }
    } else {
      try {
        operation = this.beginUserKernelTargetOperation(
          this.projectionState.masterRevision(),
          { packageStamped: true },
        );
      } catch {
        return { ok: false, status: 503, message: "Package authority projection is fenced" };
      }
    }

    try {
      if (!(await this.acceptsLocalAppSessionRoute(sessionId))) {
        return { ok: false, status: 401, message: "Authentication failed" };
      }
      operation?.assertCurrent();

      const clientSession = mode === "refresh"
        ? await this.appSessions.refresh(
            sessionId,
            secret,
            APP_CLIENT_SESSION_TTL_MS,
            operation?.assertCurrent,
          )
        : await this.appSessions.resolve(
            sessionId,
            secret,
            operation?.assertCurrent,
          );
      operation?.assertCurrent();
      if (!clientSession) {
        return { ok: false, status: 401, message: "Authentication failed" };
      }
      if (packageName && clientSession.packageName !== packageName) {
        return { ok: false, status: 404, message: "Package app session not found" };
      }

      const resolved = await this.resolvePackageAppSessionContext(clientSession);
      operation?.assertCurrent();
      return resolved;
    } finally {
      operation?.release();
    }
  }

  private async resolvePackageAppSessionContext(
    clientSession: AppClientSessionContext,
  ): Promise<ResolvePackageAppRpcResult> {
    const routeOwner = await this.resolveLocalAppSessionOwner(clientSession);
    if (!routeOwner) {
      return { ok: false, status: 401, message: "Authentication failed" };
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
      kernelOwnerUid: routeOwner.uid,
      kernelUsername: routeOwner.username,
      ...(routeOwner.lifecycle === "active"
        ? { kernelGeneration: routeOwner.generation }
        : {}),
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
    if (!(await this.isAuthoritativeLocalAppFrame(appFrame))) {
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
        capabilities,
      },
      hasRpc: record.manifest.entrypoints.some((candidateEntrypoint) => candidateEntrypoint.kind === "rpc"),
    };
  }

  private async acceptsLocalAppSessionRoute(sessionId: string): Promise<boolean> {
    if (this.instanceKind === "master") {
      return isLegacyAppSessionId(sessionId);
    }
    const marker = await this.loadUserKernelMarker();
    const routed = parseRoutedAppSessionId(sessionId);
    if (
      !marker
      || marker.lifecycle !== "active"
      || !routed
      || routed.expiresAt <= Date.now()
      || routed.username !== marker.username
      || routed.uid !== marker.uid
      || routed.generation !== marker.generation
    ) {
      return false;
    }
    return this.verifyAppSessionRoute(routed.signingInput, routed.signature);
  }

  private async resolveLocalAppSessionOwner(
    session: AppClientSessionContext,
  ): Promise<{
    lifecycle: "active" | "legacy";
    username: string;
    uid: number;
    generation: number;
  } | null> {
    if (this.instanceKind === "user") {
      const marker = await this.loadUserKernelMarker();
      const routed = parseRoutedAppSessionId(session.sessionId);
      if (
        !marker
        || marker.lifecycle !== "active"
        || this.appRuntimes.getLifecycleFence(marker.uid) !== null
        || !routed
        || routed.expiresAt <= Date.now()
        || routed.username !== marker.username
        || routed.uid !== marker.uid
        || routed.generation !== marker.generation
      ) {
        return null;
      }
      return {
        lifecycle: "active",
        username: marker.username,
        uid: marker.uid,
        generation: marker.generation,
      };
    }

    if (!isLegacyAppSessionId(session.sessionId)) {
      return null;
    }
    const placement = this.userKernels.get(session.username);
    if (
      !placement
      || placement.lifecycle !== "legacy"
      || placement.uid !== session.uid
      || this.transitioningUserKernels.has(placement.username)
      || this.appRuntimes.getLifecycleFence(placement.uid) !== null
    ) {
      return null;
    }
    return {
      lifecycle: "legacy",
      username: placement.username,
      uid: placement.uid,
      generation: placement.generation,
    };
  }

  private async isLocalAppFrameOwnerActive(appFrame: AppFrameContext): Promise<boolean> {
    if (this.instanceKind === "user") {
      const marker = await this.loadUserKernelMarker();
      const installed = this.projectionState.installed();
      const actor = this.auth.getPasswdByUid(appFrame.uid);
      if (
        !marker
        || marker.lifecycle !== "active"
        || this.appRuntimes.getLifecycleFence(marker.uid) !== null
        || !installed
        || installed.username !== marker.username
        || installed.uid !== marker.uid
        || installed.kernelGeneration !== marker.generation
        || this.projectionState.packageFence()?.kernelGeneration === marker.generation
        || appFrame.kernelOwnerUid !== marker.uid
        || appFrame.kernelUsername !== marker.username
        || appFrame.kernelGeneration !== marker.generation
        || !actor
        || actor.username !== appFrame.username
        || !canOwnerRunAsAccount(this.auth, marker.uid, actor, marker.uid === 0)
      ) {
        return false;
      }
      if (!appFrame.sessionId) {
        return true;
      }
      const routed = parseRoutedAppSessionId(appFrame.sessionId);
      return Boolean(
        routed
        && routed.expiresAt > Date.now()
        && routed.username === marker.username
        && routed.uid === marker.uid
        && routed.generation === marker.generation,
      );
    }

    const ownerUsername = canonicalizeLoginUsername(
      appFrame.kernelUsername ?? appFrame.username,
    );
    if (this.projectionState.packageFence() !== null) {
      return false;
    }
    const placement = ownerUsername ? this.userKernels.get(ownerUsername) : null;
    const actor = this.auth.getPasswdByUid(appFrame.uid);
    return Boolean(
      placement
      && placement.lifecycle === "legacy"
      && !this.transitioningUserKernels.has(placement.username)
      && this.appRuntimes.getLifecycleFence(placement.uid) === null
      && appFrame.kernelOwnerUid === placement.uid
      && actor
      && actor.username === appFrame.username
      && canOwnerRunAsAccount(this.auth, placement.uid, actor, placement.uid === 0)
      && (!appFrame.sessionId || isLegacyAppSessionId(appFrame.sessionId)),
    );
  }

  private rememberAuthorizedAppRuntime(
    appFrame: AppFrameContext,
    runnerName?: string,
  ): boolean {
    const actor = this.auth.getPasswdByUid(appFrame.uid);
    if (!actor || actor.username !== appFrame.username) return false;

    let kernelOwner: { uid: number; username: string } | null = null;
    if (this.instanceKind === "user") {
      const marker = this.userKernelMarker;
      if (
        marker?.lifecycle === "active"
        && marker.username === appFrame.kernelUsername
        && marker.generation === appFrame.kernelGeneration
      ) {
        kernelOwner = { uid: marker.uid, username: marker.username };
      }
    } else {
      const ownerUsername = canonicalizeLoginUsername(
        appFrame.kernelUsername ?? appFrame.username,
      );
      const placement = ownerUsername ? this.userKernels.get(ownerUsername) : null;
      if (placement?.lifecycle === "legacy") {
        kernelOwner = { uid: placement.uid, username: placement.username };
      }
    }
    if (
      !kernelOwner
      || appFrame.kernelOwnerUid !== kernelOwner.uid
      || this.appRuntimes.getLifecycleFence(kernelOwner.uid) !== null
    ) {
      return false;
    }
    if (runnerName === undefined) {
      // Compatibility-only direct Kernel bindings have no Durable Object to
      // register. Every AppRunner-owned path supplies its exact object name.
      return true;
    }
    try {
      this.appRuntimes.rememberRunner({
        runnerName,
        ownerUid: actor.uid,
        ownerUsername: actor.username,
        kernelOwnerUid: kernelOwner.uid,
        kernelOwnerUsername: kernelOwner.username,
        packageId: appFrame.packageId,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async isAuthoritativeLocalAppFrame(
    appFrame: AppFrameContext,
    call?: string,
  ): Promise<boolean> {
    if (this.instanceKind === "user") {
      return this.authorizeAppFrame(appFrame);
    }
    const route = await this.resolveAppFrameKernel(appFrame, call);
    return route.ok && route.kernelName === this.name;
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
        && (placement.lifecycle === "active" || placement.lifecycle === "legacy"),
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
          && (placement.lifecycle === "active" || placement.lifecycle === "legacy")
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
    expectedGeneration?: number,
  ): Promise<void> {
    const previous = this.pendingProcessSignals.get(processId) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      const record = this.procs.get(processId);
      const operation = this.beginUserKernelTargetOperation(expectedGeneration ?? 0, {
        packageStamped: typeof record?.packageSecurityRevision === "string",
      });
      try {
        const marker = await this.requireActiveUserKernel(expectedGeneration);
        operation.assertCurrent();
        const generationError = this.processKernelGenerationError(processId, marker);
        if (generationError) {
          throw new Error(generationError);
        }
        await this.handleProcessSignal(processId, frame);
        operation.assertCurrent();
      } finally {
        operation.release();
      }
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
      const link = this.adapters.identityLinks.get(
        route.adapter,
        route.accountId,
        route.actorId,
      );
      const placement = this.userKernels.getByUid(route.uid);
      return Boolean(
        placement?.lifecycle === "legacy"
        && link
        && link.uid === route.uid
        && link.generation === route.linkGeneration
        && this.adapters.identityLinks.isCurrentGeneration(
          route.adapter,
          route.accountId,
          route.actorId,
          route.linkGeneration,
        )
      );
    }

    const marker = await this.requireActiveUserKernel();
    if (!marker || marker.uid !== route.uid) {
      return false;
    }
    const master = await getAgentByName(
      this.env.KERNEL,
      SHIP_KERNEL_NAME,
    ) as unknown as MasterKernelControlStub;
    const kernelCapability = await this.requireLocalUserKernelCapability(marker);
    return master.authorizeAdapterRunRoute({
      sourceKernelName: this.name,
      ownerUid: marker.uid,
      kernelGeneration: marker.generation,
      kernelCapability,
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
    expectedGeneration?: number,
    operation?: UserKernelTargetOperationLease,
  ): Promise<ResponseFrame | null> {
    const ctx = this.buildProcessContext(processId, frame.runId, operation);
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
      const requestSignal = operation
        ? AbortSignal.any([controller.signal, operation.signal])
        : controller.signal;
      frame = this.bindRequestBodyCancellation(frame, requestSignal);
      result = await this.dispatchWithMasterProjectionGate(
        frame,
        origin,
        { ...ctx, requestSignal },
      );
    } finally {
      this.finishActiveRequest(frame.id, controller);
    }

    try {
      const marker = await this.requireActiveUserKernel(expectedGeneration);
      const generationError = this.processKernelGenerationError(processId, marker);
      if (generationError) {
        return errFrame(frame.id, 410, generationError);
      }
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
      this.applyPostDispatchEffects(frame, result.response);
      return result.response;
    }

    return null;
  }

  private buildProcessContext(
    processId: string,
    processRunId?: string,
    targetOperation?: UserKernelTargetOperationLease,
  ): KernelContext | null {
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
      targetOperation,
    });
  }

  private async handleServiceReq(
    frame: RequestFrame,
    options: {
      routedAdapterOwnerUid?: number;
      routedAdapterLinkGeneration?: number;
      targetOperation?: UserKernelTargetOperationLease;
    } = {},
  ): Promise<ResponseFrame> {
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

    const origin: RouteOrigin = { type: "process", id: "__service_binding__" };
    let controller: AbortController;
    try {
      controller = this.registerActiveRequest(origin, frame.id);
    } catch (error) {
      return errFrame(frame.id, 409, error instanceof Error ? error.message : String(error));
    }
    const requestSignal = options.targetOperation
      ? AbortSignal.any([controller.signal, options.targetOperation.signal])
      : controller.signal;
    frame = this.bindRequestBodyCancellation(frame, requestSignal);
    const ctx = this.buildKernelContext({
      identity,
      routedAdapterOwnerUid: options.routedAdapterOwnerUid,
      routedAdapterLinkGeneration: options.routedAdapterLinkGeneration,
      serviceBinding: true,
      requestSignal,
      targetOperation: options.targetOperation,
    });
    let result;
    try {
      result = await this.dispatchWithMasterProjectionGate(frame, origin, ctx);
    } finally {
      this.finishActiveRequest(frame.id, controller);
    }

    if (!result.handled) {
      return errFrame(frame.id, 501, `${frame.call} requires unsupported async routing`);
    }

    if (requestSignal.aborted) {
      return errFrame(frame.id, 503, "User Kernel is not active");
    }
    await this.requireActiveUserKernel();
    options.targetOperation?.assertCurrent();

    this.applyDirectTokenRevocationEffects(frame, result.response);
    this.applyPostDispatchEffects(frame, result.response);
    return result.response;
  }

  private buildContext(
    connection: Connection<ConnectionState>,
    targetOperation?: UserKernelTargetOperationLease,
  ): KernelContext {
    const state = connection.state;
    if (!state) throw new Error("Connection state is missing");
    return this.buildKernelContext({
      connection,
      loginSourceScope: state.loginSourceScope ?? UNAVAILABLE_LOGIN_SOURCE_SCOPE,
      expectedKernelGeneration: state.kernelGeneration,
      identity: state.identity as ConnectionIdentity | undefined,
      targetOperation,
    });
  }

  private issueProcessRollbackAuthorization(
    processId: string,
    generation: number | null,
  ): string {
    if (typeof processId !== "string" || processId.length === 0) {
      throw new Error("Invalid process rollback target");
    }
    pruneExpiredAuthorizations(this.processRollbackAuthorizations);
    const authorization = crypto.randomUUID();
    this.processRollbackAuthorizations.set(authorization, {
      expiresAt: Date.now() + PROCESS_ROLLBACK_AUTHORIZATION_TTL_MS,
      processId,
      generation,
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
    expectedKernelGeneration?: number;
    routedAdapterOwnerUid?: number;
    routedAdapterLinkGeneration?: number;
    serviceBinding?: boolean;
    provisioningMarker?: UserKernelInstanceMarker;
    targetOperation?: UserKernelTargetOperationLease;
    packageProjectionOperation?: boolean;
  }): KernelContext {
    const boundKernelMarker = options.provisioningMarker
      ?? (this.userKernelMarker?.lifecycle === "active" ? this.userKernelMarker : null);
    const expectedKernelMarker = this.instanceKind === "master"
      ? null
      : boundKernelMarker;
    let packageProjectionOperation = options.packageProjectionOperation === true;
    let kernelContext: KernelContext;
    kernelContext = {
      env: this.env,
      kernelName: this.name,
      kernelKind: this.instanceKind,
      ...(this.instanceUsername ? { kernelUsername: this.instanceUsername } : {}),
      ...(boundKernelMarker
        ? {
            kernelGeneration: boundKernelMarker.generation,
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
        options.targetOperation?.assertCurrent();
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
      isPackageProjectionOperation: () => (
        packageProjectionOperation
        || options.targetOperation?.isPackageStamped() === true
      ),
      markPackageProjectionOperation: () => {
        packageProjectionOperation = true;
        options.targetOperation?.markPackageStamped();
      },
      callerOwnerUid: options.callerOwnerUid,
      routedAdapterOwnerUid: options.routedAdapterOwnerUid,
      routedAdapterLinkGeneration: options.routedAdapterLinkGeneration,
      serviceBinding: options.serviceBinding,
      appFrame: options.appFrame,
      serverVersion: SERVER_VERSION,
      transactionSync: this.ctx.storage.transactionSync.bind(this.ctx.storage),
      issueProcessRollbackAuthorization: (processId) => (
        this.issueProcessRollbackAuthorization(
          processId,
          boundKernelMarker?.generation ?? null,
        )
      ),
      revokeProcessRollbackAuthorization: (authorization) => {
        this.revokeProcessRollbackAuthorization(authorization);
      },
      ...(this.instanceKind === "user"
        ? {
            authenticateConnection: (args: ConnectArgs) => this.authenticateConnectionViaMaster(
              args,
              options.loginSourceScope ?? UNAVAILABLE_LOGIN_SOURCE_SCOPE,
              options.expectedKernelGeneration,
            ),
          }
        : {}),
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
      ) => {
        const runtime = packageAgentRuntimeIdentity({ config: this.config }, runAs.uid);
        if (packageSecurityRevision !== null || runtime.kind !== "ordinary") {
          options.targetOperation?.markPackageStamped();
        }
        return this.authorizeCurrentPackageAgentRuntime(
          ownerUid,
          runAs,
          packageSecurityRevision,
          requiredCall,
          processId,
        );
      },
      authorizePackageRuntime: (appFrame, call) => {
        options.targetOperation?.markPackageStamped();
        return this.isAuthoritativeLocalAppFrame(appFrame, call);
      },
      broadcastToUserUid: this.broadcastToUserUid.bind(this),
      getAppRunner: (actorUid, packageId) => this.getAppRunner(
        boundKernelMarker?.uid ?? resolveCallerOwnerUid(kernelContext),
        actorUid,
        packageId,
      ),
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
    kernelOwnerUid: number,
    actorUid: number,
    packageId: string,
  ): unknown {
    return this.ctx.exports.AppRunner.getByName(
      buildAppRunnerName(kernelOwnerUid, actorUid, packageId),
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

  private async dispatchWithMasterProjectionGate(
    frame: RequestFrame,
    origin: RouteOrigin,
    context: KernelContext,
  ): Promise<Awaited<ReturnType<typeof dispatch>>> {
    if (frame.call.startsWith("app.")) {
      context.markPackageProjectionOperation?.();
    }
    if (
      masterMutationNeedsPackageProjectionFence(frame.call)
      && context.isPackageProjectionOperation?.() === true
    ) {
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
    const execute = () => dispatch(
      frame,
      origin,
      context,
      this.buildDispatchDeps(),
    );
    let result: Awaited<ReturnType<typeof dispatch>>;
    if (this.instanceKind !== "master" || !masterMutationNeedsProjectionRefresh(frame.call)) {
      result = await execute();
    } else if (masterMutationNeedsPackageProjectionFence(frame.call)) {
      try {
        result = await this.runPackageProjectionMutation(frame.id, execute);
      } catch (error) {
        result = {
          handled: true,
          response: errFrame(frame.id, 503, errorMessage(error)),
        };
      }
    } else {
      try {
        result = (await this.runMasterProjectionMutation(execute)).value;
      } catch (error) {
        result = {
          handled: true,
          response: errFrame(frame.id, 500, errorMessage(error)),
        };
      }
    }

    if (frame.call === "account.create" && result.handled) {
      try {
        await this.provisionCreatedHumanAfterProjectionCommit(result.response);
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
        this.dispatchWithMasterProjectionGate(
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
      || current.kernelGeneration !== record.kernelGeneration
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

  private fenceUserKernelRuntime(reason: string): void {
    const error = new Error(reason);

    for (const [, active] of this.activeRequests) {
      active.controller.abort(error);
    }
    this.activeRequests.clear();
    for (const controller of this.activeScheduleRuns.values()) {
      controller.abort(error);
    }
    this.activeScheduleRuns.clear();
    this.schedules.releaseInterruptedRuns(reason);
    if (this.mcp) {
      this.ctx.waitUntil(this.mcp.closeAllConnections().catch(() => {}));
    }
    this.cancelledProcessRequests.clear();

    for (const route of this.routes.drain()) {
      this.sendDeviceRequestCancel(
        route.deviceId,
        route.driverConnectionId,
        route.id,
        reason,
      );
      this.cancelRoutedBody(route.id, reason);
      if (route.scheduleId) {
        this.cancelSchedule(route.scheduleId).catch(() => {});
      }
      try {
        this.deliverToOrigin(route.origin, errFrame(route.id, 503, reason));
      } catch {
        // Lifecycle fencing must continue even if a stale origin is malformed.
      }
    }

    for (const [routeId, body] of this.routedBodies) {
      this.routedBodies.delete(routeId);
      void body.cancel(reason);
    }
    for (const [requestId, resolve] of this.pendingAppResponses) {
      this.pendingAppResponses.delete(requestId);
      resolve(errFrame(requestId, 503, reason));
    }

    for (const [connectionId, connection] of this.connections) {
      const state = connection.state;
      if (
        state?.step === "connected"
        && state.identity?.role === "driver"
      ) {
        this.devices.setOnline(state.identity.device, false);
      }
      this.closeFrameBodyChannel(connectionId);
      this.runRoutes.clearForConnection(connectionId);
      try {
        connection.close(1008, "Authentication failed");
      } catch {
        // Continue fencing every connection even if one close implementation fails.
      }
    }
    this.connections.clear();
    this.runRoutes.clearAll();
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
      || this.appRuntimes.getLifecycleFence(marker.uid) !== null
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
    try {
      await this.rearmInterruptedScheduleRuns();
      this.userKernelScheduleRearmRecoveryAttempt = 0;
    } catch {
      this.userKernelScheduleRearmRecoveryAttempt += 1;
      this.queueUserKernelScheduleRearmRecovery(Math.min(
        2 ** Math.min(this.userKernelScheduleRearmRecoveryAttempt - 1, 6),
        PACKAGE_PROJECTION_RECOVERY_MAX_DELAY_SECONDS,
      ));
    }
  }

  private async rearmPendingSchedules(
    expectedMarker: UserKernelInstanceMarker,
    options: { allowLifecycleFence?: boolean } = {},
  ): Promise<void> {
    for (const record of this.schedules.listWakeable()) {
      if (!this.isCurrentUserKernelMarker(expectedMarker, options)) {
        return;
      }
      await this.replaceScheduleWake(record, expectedMarker, {}, options);
    }
  }

  private async replaceScheduleWake(
    record: NonNullable<ReturnType<ScheduleStore["getStored"]>>,
    expectedMarker: UserKernelInstanceMarker | null,
    options: { allowRunning?: boolean } = {},
    markerOptions: { allowLifecycleFence?: boolean } = {},
  ): Promise<boolean> {
    const dueAtMs = record.state.nextRunAtMs;
    if (
      !record.enabled
      || (!options.allowRunning && record.state.runningAtMs !== null)
      || dueAtMs === null
      || !this.isCurrentUserKernelMarker(expectedMarker, markerOptions)
    ) {
      return false;
    }

    const previousWakeId = record.wakeScheduleId;
    const wakeId = await this.scheduleScheduleWake(record.id, dueAtMs);
    const current = this.schedules.getStored(record.id);
    if (
      this.isCurrentUserKernelMarker(expectedMarker, markerOptions)
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
    targetOperation?: UserKernelTargetOperationLease,
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
        const requestSignal = targetOperation
          ? AbortSignal.any([controller.signal, targetOperation.signal])
          : controller.signal;
        frame = this.bindRequestBodyCancellation(frame, requestSignal);
        result = await this.dispatchWithMasterProjectionGate(
          frame,
          origin,
          { ...this.buildContext(connection, targetOperation), requestSignal },
        );
      } finally {
        this.finishActiveRequest(frame.id, controller);
      }
      try {
        await this.requireActiveUserKernel(state.kernelGeneration);
        targetOperation?.assertCurrent();
      } catch {
        this.sendError(connection, frame.id, 401, "Authentication failed");
        return;
      }
      if (result.handled) {
        this.applyDirectTokenRevocationEffects(frame, result.response, connection.id);
        this.applyPostDispatchEffects(frame, result.response);
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

  private applyFailedMasterMutationProjectionEffects(
    frame: RequestFrame,
    response: { readonly ok: boolean },
  ): void {
    if (response.ok || this.instanceKind !== "master") return;
    if (failedMasterMutationNeedsGlobalPackageInvalidation(frame.call)) {
      this.broadcastPackageProjection();
    }
    if (failedMasterMutationNeedsGlobalRepoInvalidation(frame.call)) {
      this.broadcastRepoProjection();
    }
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
      frame.call === "pkg.review.approve" ||
      frame.call === "pkg.remove" ||
      frame.call === "pkg.checkout" ||
      frame.call === "pkg.public.set" ||
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
      if (
        frame.call === "sys.bootstrap"
        || frame.call === "pkg.public.set"
        || scope?.kind === "global"
      ) {
        this.broadcastPackageProjection();
      } else if (scope?.kind === "user" && typeof scope.uid === "number") {
        this.broadcastPackageProjection(scope.uid);
      }
    }

    if (
      this.instanceKind === "master"
      && (frame.call === "pkg.create" || frame.call === "pkg.public.set")
    ) {
      this.broadcastRepoProjection();
    }

    if (this.instanceKind === "master" && frame.call === "sys.config.set") {
      const key = (frame.args as { key?: unknown }).key;
      if (typeof key === "string") {
        this.broadcastConfigProjection(key);
      }
    }
  }

  private broadcastPackageProjection(uid?: number): void {
    if (this.instanceKind !== "master") {
      if (uid === undefined) {
        this.broadcastToRole("user", "pkg.changed");
      } else {
        this.broadcastToUserUid(uid, "pkg.changed");
      }
      return;
    }
    this.broadcastMasterProjection({ uid, signal: "pkg.changed", label: "package" });
  }

  private broadcastRepoProjection(): void {
    this.assertMasterKernel();
    this.broadcastMasterProjection({ label: "repository" });
  }

  private broadcastConfigProjection(key: string): void {
    this.assertMasterKernel();
    if (key.startsWith("config/")) {
      this.broadcastMasterProjection({ signal: "config.changed", label: "configuration" });
      return;
    }
    const match = /^users\/(\d+)\//.exec(key);
    const uid = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(uid) || uid < 0) {
      return;
    }
    // A user-scoped account may be a delegated/package run-as account whose
    // config is projected into its human owner and root rather than into a
    // Kernel named by this uid. Refresh every active projection so all views
    // advance to the same committed revision.
    this.broadcastMasterProjection({ signal: "config.changed", label: "configuration" });
  }

  private broadcastMasterProjection(options: {
    uid?: number;
    signal?: "pkg.changed" | "config.changed";
    label: string;
  }): void {
    this.assertMasterKernel();
    const activePlacements = options.uid === undefined
      ? this.userKernels.list("active")
      : [this.userKernels.getByUid(options.uid)].filter(
          (placement): placement is UserKernelRecord => placement?.lifecycle === "active",
        );
    for (const placement of activePlacements) {
      this.ctx.waitUntil((async () => {
        const userKernel = await getAgentByName(
          this.env.KERNEL,
          userKernelName(placement.username),
        ) as unknown as {
          receiveMasterProjection: (input: {
            sourceKernelName: string;
            generation: number;
            signal?: "pkg.changed" | "config.changed";
          }) => Promise<boolean>;
        };
        await userKernel.receiveMasterProjection({
          sourceKernelName: this.name,
          generation: placement.generation,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      })().catch((error) => {
        console.warn(`[Kernel] Failed to refresh a user ${options.label} projection:`, error);
      }));
    }

    if (!options.signal) {
      return;
    }
    if (options.uid === undefined) {
      this.broadcastToRole("user", options.signal);
      return;
    }
    const placement = this.userKernels.getByUid(options.uid);
    if (placement?.lifecycle === "legacy") {
      this.broadcastToUserUid(options.uid, options.signal);
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
    if (
      !record
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

    const user = this.auth.getPasswdByUid(watch.uid);
    if (!user) {
      throw new Error(`User not found for watch ${watch.watchId}`);
    }

    const sessionOwner = appClientSession
      ? await this.resolveLocalAppSessionOwner(appClientSession)
      : null;
    const marker = this.instanceKind === "user"
      ? await this.loadUserKernelMarker()
      : null;
    const kernelUsername = sessionOwner?.username ?? marker?.username;
    const kernelOwnerUid = sessionOwner?.uid ?? marker?.uid;
    const kernelGeneration = sessionOwner?.generation ?? marker?.generation;
    if (kernelOwnerUid === undefined || !kernelUsername || !kernelGeneration) {
      throw new Error(`App route owner unavailable for watch ${watch.watchId}`);
    }

    const now = Date.now();
    const appFrame: AppFrameContext = {
      uid: user.uid,
      username: user.username,
      kernelOwnerUid,
      kernelUsername,
      ...(this.instanceKind === "user" ? { kernelGeneration } : {}),
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
    if (!(await this.isAuthoritativeLocalAppFrame(appFrame))) {
      throw new Error(`Package runtime authorization expired for watch ${watch.watchId}`);
    }
    const runner = this.ctx.exports.AppRunner.getByName(
      buildAppRunnerName(kernelOwnerUid, user.uid, record.packageId),
    );
    const runtime = {
      artifact: {
        hash: record.artifact.hash,
        ...(record.artifact.runtimeAccess
          ? { runtimeAccess: structuredClone(record.artifact.runtimeAccess) }
          : {}),
      },
      appFrame,
    };

    await runner.deliverSignal({
      runtime,
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
        && placement?.lifecycle !== "legacy"
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
    if (
      this.instanceKind === "user"
      && !this.hasActiveUserKernelGeneration(transportState?.kernelGeneration)
    ) {
      if (credentialExpiryScheduleId) {
        await this.cancelSchedule(credentialExpiryScheduleId).catch(() => {});
      }
      this.sendError(connection, frame.id, 401, "Authentication failed");
      return;
    }
    const newState = {
      step: "connected",
      identity: outcome.identity,
      credential: outcome.credential,
      ...(transportState?.loginSourceScope
        ? { loginSourceScope: transportState.loginSourceScope }
        : {}),
      ...(transportState?.kernelGeneration !== undefined
        ? { kernelGeneration: transportState.kernelGeneration }
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
      if (
        this.instanceKind === "user"
        && !this.hasActiveUserKernelGeneration(transportState?.kernelGeneration)
      ) {
        return;
      }
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

  private hasActiveUserKernelGeneration(expectedGeneration: number | undefined): boolean {
    const marker = this.userKernelMarker;
    return Boolean(
      marker
      && marker.lifecycle === "active"
      && expectedGeneration === marker.generation
      && this.name === userKernelName(marker.username)
      && this.appRuntimes.getLifecycleFence(marker.uid) === null,
    );
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
    let releaseMasterOperation: (() => void) | null = null;
    if (this.instanceKind === "master") {
      const placement = this.userKernels.getByUid(record.ownerUid);
      releaseMasterOperation = placement?.lifecycle === "legacy"
        && this.appRuntimes.getLifecycleFence(placement.uid) === null
        ? this.beginMasterUserOperation(placement.username)
        : null;
      if (!releaseMasterOperation) {
        return skippedScheduleResult(record.id, "schedule owner runtime is not active");
      }
    }
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(
        this.instanceKind === "user"
          ? this.userKernelMarker?.generation ?? 0
          : 0,
        { packageStamped: typeof record.packageSecurityRevision === "string" },
      );
    } catch (error) {
      releaseMasterOperation?.();
      throw error;
    }
    try {
      return await this.runAdmittedScheduleRecord(record, mode, operation);
    } finally {
      operation.release();
      releaseMasterOperation?.();
    }
  }

  private async runAdmittedScheduleRecord(
    record: StoredScheduleRecord,
    mode: "due" | "force",
    operation: UserKernelTargetOperationLease,
  ): Promise<ScheduleRunResult> {
    const kernelMarker = await this.requireActiveUserKernel();
    operation.assertCurrent();
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

    const scheduleIdentity = this.resolveScheduleIdentity(record);
    const requiredCall = scheduleRequiredCall(record);
    if (!await this.authorizeCurrentPackageAgentRuntime(
      record.ownerUid,
      scheduleIdentity,
      record.packageSecurityRevision,
      requiredCall,
    )) {
      await this.disableRevokedSchedule(record, "Schedule package-agent authority was revoked");
      return skippedScheduleResult(record.id, "schedule package-agent authority was revoked");
    }
    operation.assertCurrent();

    const startedAtMs = Date.now();
    const running = this.schedules.markRunning(record.id, startedAtMs);
    if (!running) {
      return skippedScheduleResult(record.id, "schedule is already running");
    }

    const controller = new AbortController();
    const runSignal = AbortSignal.any([controller.signal, operation.signal]);
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
          operation,
        );
      } catch (err) {
        status = "error";
        error = err instanceof Error ? err.message : String(err);
        result = { error };
      }

      const stillAuthorized = await this.authorizeCurrentPackageAgentRuntime(
        record.ownerUid,
        scheduleIdentity,
        record.packageSecurityRevision,
        requiredCall,
      );
      try {
        operation.assertCurrent();
      } catch {
        const finishedAtMs = Date.now();
        const staleError = !this.isCurrentUserKernelMarker(kernelMarker)
          ? "User Kernel lifecycle changed during schedule run"
          : operation.signal.reason instanceof Error
            ? operation.signal.reason.message
            : "Schedule authority changed during execution";
        return {
          scheduleId: record.id,
          status: "error",
          error: staleError,
          summary: scheduleResultSummary(record, { error: staleError }),
          durationMs: Math.max(0, finishedAtMs - startedAtMs),
          nextRunAtMs: null,
        };
      }
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
    operation?: UserKernelTargetOperationLease,
  ): Promise<unknown> {
    const target = record.target;
    const ctx = this.buildScheduleContext(record, signal, operation);
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
    requestSignal?: AbortSignal,
    targetOperation?: UserKernelTargetOperationLease,
  ): KernelContext {
    const process = this.resolveScheduleIdentity(record);
    const identity: ConnectionIdentity = {
      role: "user",
      process,
      capabilities: this.caps.resolve(process.gids),
    };

    return this.buildKernelContext({
      identity,
      callerOwnerUid: record.ownerUid,
      requestSignal,
      targetOperation,
    });
  }

  private isCurrentUserKernelMarker(
    expected: UserKernelInstanceMarker | null,
    options: { allowLifecycleFence?: boolean } = {},
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
      && current.generation === expected.generation
      && (
        options.allowLifecycleFence === true
        || this.appRuntimes.getLifecycleFence(current.uid) === null
      )
    );
  }

  private resolveScheduleIdentity(record: ScheduleRecord): ProcessIdentity {
    const uid = record.runAs.uid;
    const account = this.auth.getPasswdByUid(uid);
    if (!account) {
      throw new Error(`Cannot resolve schedule run-as uid ${uid}`);
    }
    if (account.username !== record.runAs.username) {
      throw new Error(`Schedule run-as authority was revoked for uid ${uid}`);
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
            generation: placement.generation,
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
              generation: placement.generation,
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
      if (placement && placement.lifecycle !== "legacy") {
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
    let operation: UserKernelTargetOperationLease;
    try {
      operation = this.beginUserKernelTargetOperation(input.generation);
    } catch {
      return false;
    }
    try {
      const marker = await this.requireActiveUserKernel(input.generation);
      operation.assertCurrent();
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
      generation: marker.generation,
      signal: input.signal,
      ...(input.payloadJson === undefined ? {} : { payloadJson: input.payloadJson }),
    });
    if (!authorized || !this.isCurrentUserKernelMarker(marker)) {
      return false;
    }
    operation.assertCurrent();
    this.broadcastToUserUid(marker.uid, input.signal, payload);
    return true;
    } finally {
      operation.release();
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

function sameUserKernelLifecycleAuthorization(
  expected: Omit<UserKernelLifecycleAuthorizationInput, "authorization">,
  actual: UserKernelLifecycleAuthorizationInput,
): boolean {
  return expected.targetKernelName === actual.targetKernelName
    && expected.username === actual.username
    && expected.uid === actual.uid
    && expected.expectedLifecycle === actual.expectedLifecycle
    && expected.expectedGeneration === actual.expectedGeneration
    && expected.lifecycle === actual.lifecycle
    && expected.generation === actual.generation;
}

function sameUserKernelProvisioningAuthorization(
  expected: Omit<UserKernelProvisioningAuthorizationInput, "authorization">,
  actual: UserKernelProvisioningAuthorizationInput,
): boolean {
  return expected.targetKernelName === actual.targetKernelName
    && expected.username === actual.username
    && expected.uid === actual.uid
    && expected.generation === actual.generation;
}

function sameAdapterInboundAuthorization(
  expected: Omit<AdapterInboundAuthorizationInput, "authorization">,
  actual: AdapterInboundAuthorizationInput,
): boolean {
  return expected.targetKernelName === actual.targetKernelName
    && expected.username === actual.username
    && expected.ownerUid === actual.ownerUid
    && expected.generation === actual.generation
    && expected.linkGeneration === actual.linkGeneration
    && sameAdapterInboundRouteMetadata(expected, actual);
}

function sameMasterUserSignalAuthorization(
  expected: Omit<MasterUserSignalAuthorizationInput, "authorization">,
  actual: MasterUserSignalAuthorizationInput,
): boolean {
  return expected.targetKernelName === actual.targetKernelName
    && expected.username === actual.username
    && expected.uid === actual.uid
    && expected.generation === actual.generation
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
    && left.generation === right.generation
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
    && left.lifecycle === right.lifecycle
    && left.generation === right.generation,
  );
}

function masterUserKernelCapabilityStorageKey(username: string): string {
  return `${MASTER_USER_KERNEL_CAPABILITY_STORAGE_PREFIX}${username}`;
}

function isUserKernelCapabilitySecret(value: unknown): value is string {
  return typeof value === "string"
    && value.length === USER_KERNEL_CAPABILITY_BYTES * 2
    && /^[a-f0-9]+$/.test(value);
}

function parseMasterUserKernelCapabilityRecord(
  value: unknown,
): MasterUserKernelCapabilityRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<MasterUserKernelCapabilityRecord>;
  if (
    record.version !== 1
    || typeof record.username !== "string"
    || canonicalizeLoginUsername(record.username) !== record.username
    || !Number.isSafeInteger(record.uid)
    || (record.uid ?? -1) < 0
    || !Number.isSafeInteger(record.generation)
    || (record.generation ?? 0) <= 0
    || typeof record.digest !== "string"
    || record.digest.length !== 64
    || !/^[a-f0-9]+$/.test(record.digest)
  ) {
    return null;
  }
  return record as MasterUserKernelCapabilityRecord;
}

function parseLocalUserKernelCapabilityRecord(
  value: unknown,
): LocalUserKernelCapabilityRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<LocalUserKernelCapabilityRecord>;
  if (
    record.version !== 1
    || typeof record.username !== "string"
    || canonicalizeLoginUsername(record.username) !== record.username
    || !Number.isSafeInteger(record.uid)
    || (record.uid ?? -1) < 0
    || !Number.isSafeInteger(record.generation)
    || (record.generation ?? 0) <= 0
    || !isUserKernelCapabilitySecret(record.secret)
  ) {
    return null;
  }
  return record as LocalUserKernelCapabilityRecord;
}

async function hashUserKernelCapability(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(secret),
  );
  return bytesToHex(new Uint8Array(digest));
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
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

function describeUserKernelLifecycleTransition(
  current: UserKernelRecord,
  lifecycle: Extract<UserKernelLifecycle, "provisioning" | "suspended" | "retired">,
): UserKernelLifecycleTargetRecord {
  if (current.lifecycle === lifecycle) {
    return { ...current, lifecycle };
  }

  if (lifecycle === "provisioning") {
    if (current.lifecycle !== "legacy" && current.lifecycle !== "suspended") {
      throw new Error(`User Kernel cannot provision from ${current.lifecycle}`);
    }
    return {
      ...current,
      lifecycle,
      retiredAt: null,
    };
  }

  if (lifecycle === "suspended") {
    if (current.lifecycle !== "active") {
      throw new Error(`User Kernel cannot suspend from ${current.lifecycle}`);
    }
    return {
      ...current,
      lifecycle,
      generation: incrementUserKernelGeneration(current),
      retiredAt: null,
    };
  }

  if (current.lifecycle === "retired") {
    return { ...current, lifecycle: "retired" };
  }
  return {
    ...current,
    lifecycle,
    generation: incrementUserKernelGeneration(current),
    retiredAt: Date.now(),
  };
}

function isValidUserKernelLifecyclePredecessor(
  existing: UserKernelInstanceMarker,
  desired: UserKernelLifecycleTransition,
): boolean {
  if (
    existing.username !== desired.username
    || existing.uid !== desired.uid
  ) {
    return false;
  }
  if (desired.lifecycle === "provisioning") {
    return existing.generation === desired.generation
      && (existing.lifecycle === "active" || existing.lifecycle === "suspended");
  }
  if (desired.lifecycle === "suspended") {
    return existing.lifecycle === "active"
      && existing.generation + 1 === desired.generation;
  }
  return existing.lifecycle !== "retired"
    && existing.generation + 1 === desired.generation;
}

function incrementUserKernelGeneration(current: UserKernelRecord): number {
  if (
    !Number.isSafeInteger(current.generation)
    || current.generation <= 0
    || current.generation >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`User Kernel generation mismatch for ${current.username}`);
  }
  return current.generation + 1;
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
    || !Number.isSafeInteger(marker.generation)
    || (marker.generation ?? 0) <= 0
    || !["provisioning", "active", "suspended", "retired"].includes(marker.lifecycle ?? "")
    || typeof marker.updatedAt !== "number"
    || !Number.isFinite(marker.updatedAt)
  ) {
    throw new Error("User Kernel lifecycle marker is invalid");
  }
  return marker as UserKernelInstanceMarker;
}

function parseAppPlacementCertificateGrant(
  value: unknown,
): AppPlacementCertificateGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "certificate",
    "generation",
    "uid",
    "username",
    "version",
  ];
  if (
    keys.length !== expectedKeys.length
    || !expectedKeys.every((key, index) => keys[index] === key)
  ) {
    return null;
  }
  const grant = value as Partial<AppPlacementCertificateGrant>;
  if (
    grant.version !== 1
    || typeof grant.username !== "string"
    || canonicalizeLoginUsername(grant.username) !== grant.username
    || !Number.isSafeInteger(grant.uid)
    || (grant.uid ?? -1) < 0
    || !Number.isSafeInteger(grant.generation)
    || (grant.generation ?? 0) <= 0
    || !isAppPlacementCertificate(grant.certificate)
  ) {
    return null;
  }
  return grant as AppPlacementCertificateGrant;
}

function parseUserKernelGenerationHeader(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d{0,9}$/.test(value)) {
    return undefined;
  }
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

function validateUserKernelProvisioningSnapshot(
  snapshot: UserKernelProvisioningSnapshot,
  expectedUsername: string,
): void {
  if (
    snapshot.version !== 1
    || snapshot.username !== expectedUsername
    || canonicalizeLoginUsername(snapshot.username) !== snapshot.username
    || !Number.isSafeInteger(snapshot.uid)
    || snapshot.uid < 0
    || !Number.isSafeInteger(snapshot.generation)
    || snapshot.generation <= 0
    || !Number.isSafeInteger(snapshot.projectionRevision)
    || snapshot.projectionRevision <= 0
    || !Array.isArray(snapshot.accounts)
    || !Array.isArray(snapshot.groups)
    || !Array.isArray(snapshot.capabilities)
    || !Array.isArray(snapshot.config)
    || !Array.isArray(snapshot.packages)
  ) {
    throw new Error("User Kernel provisioning snapshot is invalid");
  }

  const usernames = new Set<string>();
  const uids = new Set<number>();
  for (const account of snapshot.accounts) {
    const entry = account?.entry;
    if (
      !entry
      || canonicalizeLoginUsername(entry.username) !== entry.username
      || !Number.isSafeInteger(entry.uid)
      || entry.uid < 0
      || !Number.isSafeInteger(entry.gid)
      || entry.gid < 0
      || typeof entry.gecos !== "string"
      || typeof entry.home !== "string"
      || typeof entry.shell !== "string"
      || !["human", "agent", "system"].includes(account.kind)
      || typeof account.locked !== "boolean"
      || usernames.has(entry.username)
      || uids.has(entry.uid)
    ) {
      throw new Error("User Kernel account projection is invalid");
    }
    usernames.add(entry.username);
    uids.add(entry.uid);
  }
  const owner = snapshot.accounts.find((account) => account.entry.uid === snapshot.uid);
  const isRootOwner = snapshot.uid === 0
    && snapshot.username === "root"
    && owner?.kind === "system";
  if (
    !owner
    || owner.entry.username !== snapshot.username
    || owner.locked
    || (owner.kind !== "human" && !isRootOwner)
    || snapshot.accounts.some((account) => account.kind === "agent" && !account.locked)
  ) {
    throw new Error("User Kernel owner projection is invalid");
  }
}

async function userKernelProjectionDigest(
  snapshot: UserKernelProvisioningSnapshot,
): Promise<string> {
  const canonical = JSON.stringify(canonicalizeProjectionDigestValue(snapshot));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, "0")
  )).join("")}`;
}

function canonicalizeProjectionDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeProjectionDigestValue);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeProjectionDigestValue(entry)]),
  );
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

function sameAppRunnerRuntimeFenceIdentity(
  left: AppRunnerRuntimeFenceIdentity,
  right: AppRunnerRuntimeFenceIdentity,
): boolean {
  return left.fenceKind === right.fenceKind
    && left.sourceKernelName === right.sourceKernelName
    && left.runnerName === right.runnerName
    && left.ownerUid === right.ownerUid
    && left.ownerUsername === right.ownerUsername
    && left.kernelOwnerUid === right.kernelOwnerUid
    && left.kernelOwnerUsername === right.kernelOwnerUsername
    && left.packageId === right.packageId
    && left.generation === right.generation
    && left.fenceId === right.fenceId;
}

function samePackageProjectionFenceAuthorization(
  left: Omit<PackageProjectionFenceAuthorizationInput, "authorization">,
  right: PackageProjectionFenceAuthorizationInput,
): boolean {
  return left.targetKernelName === right.targetKernelName
    && left.username === right.username
    && left.uid === right.uid
    && left.generation === right.generation
    && left.fenceId === right.fenceId;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(values.length, Math.max(1, Math.floor(concurrency))) },
    () => worker(),
  ));
  return results;
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
