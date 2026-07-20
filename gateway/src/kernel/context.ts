/**
 * KernelContext — the single shape passed to all syscall handlers.
 *
 * `identity` is undefined for the pre-auth sys.connect, sys.setup, and
 * sys.setup.assist handlers. Authenticated dispatch guarantees it is present.
 */

import type { Connection } from "agents";
import type { MCPClientManager } from "agents/mcp/client";
import type {
  ConnectArgs,
  ConnectionIdentity,
  ProcessIdentity,
  RepoListResult,
  SchedulerRunArgs,
  SchedulerRunResult,
} from "@humansandmachines/gsv/protocol";
import type { AuthenticatedCredential, AuthStore } from "./auth-store";
import type { CapabilityStore } from "./capabilities";
import type { ConfigStore } from "./config";
import type { DeviceRegistry } from "./devices";
import type { ProcessRegistry } from "./processes";
import type { ConversationRegistry } from "./conversations";
import type { AdapterStore } from "./adapter-store";
import type { RunRouteStore } from "./run-routes";
import type { ShellSessionStore } from "./shell-sessions";
import type { PackageStore } from "./packages";
import type { OAuthStore } from "./oauth-store";
import type { McpServerStore } from "./mcp-store";
import type { SignalWatchStore } from "./signal-watches";
import type { NotificationStore } from "./notifications";
import type { IpcCallStore } from "./ipc-calls";
import type { ScheduleStore } from "./scheduler";
import type { AppSessionStore } from "./app-sessions";
import type { AppFrameContext } from "../protocol/app-frame";
import type { McpAddConnectionInput, McpAddConnectionResult } from "./sys/mcp";
import type { LoginSourceScope } from "./login-source";
import type { UserKernelRegistry } from "./user-kernels";
import type {
  RepoMetadataMutation,
  RepoMetadataMutationResult,
} from "./repo-metadata";
import type { TokenRevocationNotice } from "./token-revocations";
import type {
  AuthoritativeRepoOperationCall,
} from "./repo";

export type KernelInstanceKind = "master" | "user";

export type KernelAuthenticationResult =
  | {
      ok: true;
      identity: ProcessIdentity;
      capabilities: string[];
      credential: AuthenticatedCredential;
    }
  | { ok: false; error: string };

export type KernelContext = {
  env: Env;
  kernelName: string;
  kernelKind: KernelInstanceKind;
  kernelUsername?: string;
  kernelGeneration?: number;
  /** True only for the target's Master-authorized non-active provisioning pass. */
  kernelProvisioning?: boolean;
  /** Human owner recorded by this active user Kernel's provisioning marker. */
  kernelOwnerUid?: number;
  auth: AuthStore;
  caps: CapabilityStore;
  config: ConfigStore;
  devices: DeviceRegistry;
  procs: ProcessRegistry;
  conversations: ConversationRegistry;
  packages: PackageStore;
  oauth: OAuthStore;
  mcp: MCPClientManager;
  mcpServers: McpServerStore;
  adapters: AdapterStore;
  runRoutes: RunRouteStore;
  shellSessions: ShellSessionStore;
  appSessions: AppSessionStore;
  signalWatches: SignalWatchStore;
  ipcCalls: IpcCallStore;
  notifications: NotificationStore;
  schedules: ScheduleStore;
  userKernels?: UserKernelRegistry;
  connection: Connection | null;
  loginSourceScope: LoginSourceScope;
  identity?: ConnectionIdentity;
  processId?: string;
  processRunId?: string;
  requestSignal?: AbortSignal;
  /** Throws synchronously when this request's Kernel generation is no longer current. */
  assertCurrentKernel: () => void;
  /** True after this admitted operation crosses into package-derived authority. */
  isPackageProjectionOperation?: () => boolean;
  /** Marks the operation package-derived before the first package authority await. */
  markPackageProjectionOperation?: () => void;
  callerOwnerUid?: number;
  /** Owner selected by a trusted, Master-issued adapter route projection. */
  routedAdapterOwnerUid?: number;
  /** Master-authoritative identity-link generation for routed inbound delivery. */
  routedAdapterLinkGeneration?: number;
  /** True only for the Gateway's deploy-time scoped adapter service binding. */
  serviceBinding?: boolean;
  appFrame?: AppFrameContext;
  serverVersion: string;
  transactionSync?: <T>(closure: () => T) => T;
  /** Short-lived, Kernel-local capability used only to erase a failed executor initialization. */
  issueProcessRollbackAuthorization?: (processId: string) => string;
  revokeProcessRollbackAuthorization?: (authorization: string) => void;
  authenticateConnection?: (args: ConnectArgs) => Promise<KernelAuthenticationResult>;
  writeConfig: (key: string, value: string) => Promise<void>;
  mutateRepoMetadata: (
    mutation: RepoMetadataMutation,
  ) => Promise<RepoMetadataMutationResult>;
  authorizeRepoOperation?: (
    call: AuthoritativeRepoOperationCall,
    normalizedRepo?: string,
    requestedOwner?: string,
  ) => Promise<RepoListResult | undefined>;
  revokeDeviceCredentials: (
    ownerUid: number,
    deviceId: string,
  ) => Promise<TokenRevocationNotice[]>;
  authorizePackageAgentRuntime?: (
    ownerUid: number,
    runAs: ProcessIdentity,
    packageSecurityRevision: string | null,
    requiredCall?: string,
    processId?: string,
  ) => Promise<boolean>;
  authorizePackageRuntime: (appFrame: AppFrameContext, call?: string) => Promise<boolean>;
  broadcastToUserUid: (uid: number, signal: string, payload?: unknown) => void;
  getAppRunner: (uid: number, packageId: string) => unknown;
  scheduleIpcCallTimeout: (callId: string, deadlineAt: number) => Promise<string>;
  failIpcCallsByTarget: (uid: number, targetPid: string, error: string) => void;
  scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
  cancelScheduleWake: (wakeScheduleId: string) => Promise<void>;
  runSchedules: (
    args: SchedulerRunArgs,
    identity?: ConnectionIdentity,
    callerOwnerUid?: number,
  ) => Promise<SchedulerRunResult>;
  addMcpServerConnection: (input: McpAddConnectionInput) => Promise<McpAddConnectionResult>;
  removeMcpServerConnection: (serverId: string) => Promise<void>;
  refreshMcpServerConnection: (serverId: string) => Promise<void>;
  callMcpTool: (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

/**
 * The human owner uid for the caller: the owning human of the calling process
 * when invoked from a process (so a personal agent acting on its human's behalf
 * resolves to the human, not the agent's run-as uid), otherwise the connecting
 * user. This is the uid that governs process ownership, visibility, and run-as
 * authorization — distinct from `identity.process.uid`, which is the run-as
 * account.
 */
export function resolveCallerOwnerUid(ctx: KernelContext): number {
  if (typeof ctx.callerOwnerUid === "number" && Number.isFinite(ctx.callerOwnerUid)) {
    return ctx.callerOwnerUid;
  }
  if (ctx.processId) {
    const ownerUid = ctx.procs.getOwnerUid(ctx.processId);
    if (ownerUid != null) return ownerUid;
  }
  return ctx.identity!.process.uid;
}

/**
 * A user Kernel owns exactly one human's runtime state. Until typed Master
 * forwarding exists for an operation, never answer a cross-user or wildcard
 * query from that shard's local stores.
 */
export function assertLocalUserKernelUid(
  ctx: KernelContext,
  uid: number | undefined,
  operation: string,
): void {
  if (ctx.kernelKind !== "user") return;

  const ownerUid = ctx.kernelOwnerUid;
  if (!Number.isSafeInteger(ownerUid) || (ownerUid as number) < 0) {
    throw new Error("Permission denied: active user Kernel owner is unavailable");
  }
  if (uid !== ownerUid) {
    throw new Error(
      `Permission denied: cross-user ${operation} is not available from a user Kernel`,
    );
  }
}
