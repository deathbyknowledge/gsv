/**
 * KernelContext — the single shape passed to all syscall handlers.
 *
 * `identity` is undefined for the pre-auth sys.connect, sys.setup, and
 * sys.setup.assist handlers. Authenticated dispatch guarantees it is present.
 */

import type { MCPClientManager } from "agents/mcp/client";
import type {
  ConnectionIdentity,
  JsonObject,
  JsonValue,
  SchedulerRunArgs,
  SchedulerRunResult,
} from "@humansandmachines/gsv/protocol";
import type { AuthStore } from "./auth-store";
import type { CapabilityStore } from "./capabilities";
import type { ConfigStore } from "./config";
import type { DeviceRegistry } from "./devices";
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
import type { McpAddConnectionInput, McpAddConnectionResult } from "./sys/mcp";
import type { InstallationIdentity } from "../installation/identity";
import type { KernelConnection, KernelConnectionState } from "./connection";

export type KernelContext = {
  env: Env;
  installationId: string;
  installationIdentity: InstallationIdentity | null;
  auth: AuthStore;
  caps: CapabilityStore;
  config: ConfigStore;
  devices: DeviceRegistry;
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
  connection: KernelConnection<KernelConnectionState> | null;
  identity?: ConnectionIdentity;
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
    options?: { terminateTargetOnTimeout?: boolean },
  ) => Promise<string>;
  failIpcCallsByTarget: (uid: number, targetPid: string, error: string) => void;
  scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
  cancelScheduleWake: (wakeScheduleId: string) => Promise<void>;
  scheduleManagedOutboundEnqueue: (
    outboundId: string,
    dueAtMs: number,
  ) => Promise<void>;
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
    args: JsonObject,
    signal?: AbortSignal,
  ) => ReturnType<MCPClientManager["callTool"]>;
};

export type CallerOwnerContext = {
  callerOwnerUid?: number;
  processId?: string;
  procs: Pick<ProcessRegistry, "getOwnerUid">;
  identity?: ConnectionIdentity;
};

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
  return ctx.identity!.process.uid;
}
