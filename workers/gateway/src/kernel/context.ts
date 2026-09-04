/**
 * KernelContext — the single shape passed to all syscall handlers.
 *
 * `identity` is undefined for the pre-auth sys.connect, sys.setup, and
 * sys.setup.assist handlers. Authenticated dispatch guarantees it is present.
 */

import type { MCPClientManager } from "agents/mcp/client";
import type {
  FederationDeliveryReceipt,
  JsonObject,
  JsonValue,
  PeerPrincipalKind,
  ProcessIdentity,
  SchedulerRunArgs,
  SchedulerRunResult,
} from "@humansandmachines/gsv/protocol";
import type { AuthStore } from "./auth-store";
import type { CapabilityStore } from "./capabilities";
import type { ConfigStore } from "./config";
import type { TargetRegistry } from "./target-registry";
import type { ProcessRegistry } from "./processes";
import type { ConversationRegistry } from "./conversations";
import type { AdapterStore } from "./adapter-store";
import type { RunRouteStore } from "./run-routes";
import type { ShellSessionStore } from "./shell-sessions";
import type { OAuthStore } from "./oauth-store";
import type { McpServerStore } from "./mcp-store";
import type { SignalWatchStore } from "./signal-watches";
import type { IpcCallStore } from "./ipc-calls";
import type { ScheduleStore } from "./scheduler";
import type { MailboxStore } from "./mailbox-store";
import type { ResponsibilityStore } from "./responsibility-store";
import type { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";
import type { FederationStore } from "./federation-store";
import type { FederationIdentity } from "./federation-crypto";
import type { McpAddConnectionInput, McpAddConnectionResult } from "./sys/mcp";
import type { InstallationIdentity } from "../installation/identity";
import type { KernelConnection, KernelConnectionState } from "./connection";
import type { PeerContext } from "./peer";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { GatewayEnv } from "../runtime-env";

export type KernelContext = {
  env: GatewayEnv;
  installationId: string;
  installationIdentity: InstallationIdentity | null;
  auth: AuthStore;
  caps: CapabilityStore;
  config: ConfigStore;
  targets: TargetRegistry;
  procs: ProcessRegistry;
  conversations: ConversationRegistry;
  oauth: OAuthStore;
  mcp: MCPClientManager;
  mcpServers: McpServerStore;
  adapters: AdapterStore;
  runRoutes: RunRouteStore;
  shellSessions: ShellSessionStore;
  signalWatches: SignalWatchStore;
  ipcCalls: IpcCallStore;
  schedules: ScheduleStore;
  mailboxes: MailboxStore;
  responsibilities: ResponsibilityStore;
  responsibilitySources: ResponsibilitySourcePolicyStore;
  federation: FederationStore;
  federationIdentity: FederationIdentity;
  connection: KernelConnection<KernelConnectionState> | null;
  peer?: PeerContext;
  processId?: string;
  processRunId?: string;
  requestId?: string;
  requestSignal?: AbortSignal;
  callerOwnerUid?: number;
  serverVersion: string;
  defer: (promise: Promise<unknown>) => void;
  broadcastToUserUid: (uid: number, signal: string, payload?: JsonValue) => void;
  scheduleIpcCallTimeout: (
    callId: string,
    deadlineAt: number,
    options?: {
      mode: "supervise";
      intervalMs: number;
      checkInCount: number;
    },
  ) => Promise<string>;
  failIpcCallsByTarget: (uid: number, targetPid: string, error: string) => void;
  scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
  cancelScheduleWake: (wakeScheduleId: string) => Promise<void>;
  reconcileResponsibilityWake: (ownerUid: number) => Promise<void>;
  scheduleManagedOutboundEnqueue: (
    outboundId: string,
    dueAtMs: number,
  ) => Promise<void>;
  scheduleFederationDelivery: (
    deliveryId: string,
    dueAtMs: number,
    idempotent?: boolean,
  ) => Promise<void>;
  scheduleFederationInbox: (
    contactId: string,
    contactGeneration: string,
    deliveryId: string,
    dueAtMs: number,
    idempotent?: boolean,
  ) => Promise<void>;
  coordinateFederationInbound: (
    key: string,
    operation: () => Promise<FederationDeliveryReceipt>,
  ) => Promise<FederationDeliveryReceipt>;
  coordinateFederationContact: <Value>(
    contactId: string,
    operation: () => Value | Promise<Value>,
  ) => Promise<Value>;
  runSchedules: (
    args: SchedulerRunArgs,
    principal?: PrincipalView,
    callerOwnerUid?: number,
  ) => Promise<SchedulerRunResult>;
  addMcpServerConnection: (input: McpAddConnectionInput) => Promise<McpAddConnectionResult>;
  removeMcpServerConnection: (serverId: string) => Promise<void>;
  refreshMcpServerConnection: (serverId: string) => Promise<void>;
  callMcpTool: (
    serverId: string,
    toolName: string,
    args: JsonObject,
    signal?: AbortSignal,
  ) => ReturnType<MCPClientManager["callTool"]>;
  request?: (
    frame: RequestFrame,
    ctx: KernelContext,
    signal?: AbortSignal,
  ) => Promise<ResponseFrame>;
};

export type CallerOwnerContext = {
  callerOwnerUid?: number;
  processId?: string;
  procs: Pick<ProcessRegistry, "getOwnerUid">;
  peer?: PeerContext;
};

/**
 * The acting principal as syscall handlers see it: who is acting, as which
 * account, with which calls, and which peer id carries the session.
 */
export type PrincipalView = {
  kind: PeerPrincipalKind;
  account: ProcessIdentity;
  calls: string[];
  peerId: string;
};

export function principalOf(ctx: Pick<KernelContext, "peer">): PrincipalView | undefined {
  const peer = ctx.peer;
  if (!peer) return undefined;
  return {
    kind: peer.peer.principal.kind,
    account: peer.peer.principal.account,
    calls: peer.peer.grant.calls,
    peerId: peer.peer.id,
  };
}

export function requirePrincipal(ctx: Pick<KernelContext, "peer">): PrincipalView {
  const principal = principalOf(ctx);
  if (!principal) throw new Error("Authentication required");
  return principal;
}

/**
 * The human owner uid for the caller: the owning human of the calling process
 * when invoked from a process (so a personal agent acting on its human's behalf
 * resolves to the human, not the agent's run-as uid), otherwise the connecting
 * user. This is the uid that governs process ownership, visibility, and run-as
 * authorization — distinct from `identity.process.uid`, which is the run-as
 * account.
 */
export function resolveCallerOwnerUid(ctx: CallerOwnerContext): number {
  if (ctx.callerOwnerUid !== undefined && Number.isFinite(ctx.callerOwnerUid)) {
    return ctx.callerOwnerUid;
  }
  if (ctx.processId) {
    const ownerUid = ctx.procs.getOwnerUid(ctx.processId);
    if (ownerUid != null) return ownerUid;
  }
  return requirePrincipal(ctx).account.uid;
}
