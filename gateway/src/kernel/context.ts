/**
 * KernelContext — the single shape passed to all syscall handlers.
 *
 * `identity` is undefined during sys.connect (pre-auth).
 * For all other handlers, the kernel guarantees it is present.
 */

import type { Connection } from "agents";
import type { MCPClientManager } from "agents/mcp/client";
import type { ConnectionIdentity } from "@humansandmachines/gsv/protocol";
import type { AuthStore } from "./auth-store";
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
import type { SchedulerRunArgs, SchedulerRunResult } from "../syscalls/scheduler";
import type { McpAddConnectionInput, McpAddConnectionResult } from "./sys/mcp";

export type KernelContext = {
  env: Env;
  auth: AuthStore;
  caps: CapabilityStore;
  config: ConfigStore;
  devices: DeviceRegistry;
  procs: ProcessRegistry;
  conversations?: ConversationRegistry;
  packages: PackageStore;
  oauth: OAuthStore;
  mcp: MCPClientManager;
  mcpServers: McpServerStore;
  adapters: AdapterStore;
  runRoutes: RunRouteStore;
  shellSessions: ShellSessionStore;
  appSessions: AppSessionStore;
  signalWatches: SignalWatchStore;
  ipcCalls?: IpcCallStore;
  notifications?: NotificationStore;
  schedules?: ScheduleStore;
  connection: Connection | null;
  identity?: ConnectionIdentity;
  processId?: string;
  callerOwnerUid?: number;
  appFrame?: AppFrameContext;
  serverVersion: string;
  broadcastToUid?: (uid: number, signal: string, payload?: unknown) => void;
  getAppRunner?: (uid: number, packageId: string) => unknown;
  scheduleIpcCallTimeout?: (callId: string, delayMs: number) => Promise<string>;
  scheduleScheduleWake?: (scheduleId: string, dueAtMs: number) => Promise<string>;
  cancelScheduleWake?: (wakeScheduleId: string) => Promise<void>;
  runSchedules?: (
    args: SchedulerRunArgs,
    identity?: ConnectionIdentity,
    callerOwnerUid?: number,
  ) => Promise<SchedulerRunResult>;
  addMcpServerConnection?: (input: McpAddConnectionInput) => Promise<McpAddConnectionResult>;
  removeMcpServerConnection?: (serverId: string) => Promise<void>;
  refreshMcpServerConnection?: (serverId: string) => Promise<void>;
  callMcpTool?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
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
