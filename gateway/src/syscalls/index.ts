import type { FsReadArgs, FsReadResult } from "./read";
import type { FsWriteArgs, FsWriteResult } from "./write";
import type { FsEditArgs, FsEditResult } from "./edit";
import type { FsDeleteArgs, FsDeleteResult } from "./delete";
import type { FsSearchArgs, FsSearchResult } from "./search";
import type {
  ShellExecArgs,
  ShellExecResult,
} from "./shell";
import type {
  CodeModeExecArgs,
  CodeModeExecResult,
  CodeModeRunArgs,
  CodeModeRunResult,
} from "./codemode";
import type {
  ProcSpawnArgs,
  ProcSpawnResult,
  ProcKillArgs,
  ProcKillResult,
  ProcSendArgs,
  ProcAbortArgs,
  ProcAbortResult,
  ProcHilArgs,
  ProcHilResult,
  ProcSendResult,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcResetArgs,
  ProcResetResult,
  ProcListArgs,
  ProcListResult,
  ProcProfileListArgs,
  ProcProfileListResult,
  ProcSetIdentityArgs,
  ProcSetIdentityResult,
} from "./proc";
import type {
  PkgAddArgs,
  PkgAddResult,
  PkgCheckoutArgs,
  PkgCheckoutResult,
  PkgInstallArgs,
  PkgInstallResult,
  PkgReviewApproveArgs,
  PkgReviewApproveResult,
  PkgListArgs,
  PkgListResult,
  PkgSyncArgs,
  PkgSyncResult,
  PkgRepoLogArgs,
  PkgRepoLogResult,
  PkgRepoReadArgs,
  PkgRepoReadResult,
  PkgRepoRefsArgs,
  PkgRepoRefsResult,
  PkgRepoSearchArgs,
  PkgRepoSearchResult,
  PkgRepoDiffArgs,
  PkgRepoDiffResult,
  PkgRemoteAddArgs,
  PkgRemoteAddResult,
  PkgRemoteListArgs,
  PkgRemoteListResult,
  PkgRemoteRemoveArgs,
  PkgRemoteRemoveResult,
  PkgRemoveArgs,
  PkgRemoveResult,
  PkgPublicListArgs,
  PkgPublicListResult,
  PkgPublicSetArgs,
  PkgPublicSetResult,
} from "@gsv/protocol/syscalls/packages";
import type {
  ConnectArgs,
  ConnectResult,
  SysSetupAssistArgs,
  SysSetupAssistResult,
  SysSetupArgs,
  SysSetupResult,
  SysBootstrapArgs,
  SysBootstrapResult,
  SysConfigGetArgs,
  SysConfigGetResult,
  SysConfigSetArgs,
  SysConfigSetResult,
  SysDeviceListArgs,
  SysDeviceListResult,
  SysDeviceGetArgs,
  SysDeviceGetResult,
  SysWorkspaceListArgs,
  SysWorkspaceListResult,
  SysTokenCreateArgs,
  SysTokenCreateResult,
  SysTokenListArgs,
  SysTokenListResult,
  SysTokenRevokeArgs,
  SysTokenRevokeResult,
  SysLinkArgs,
  SysLinkResult,
  SysUnlinkArgs,
  SysUnlinkResult,
  SysLinkListArgs,
  SysLinkListResult,
  SysLinkConsumeArgs,
  SysLinkConsumeResult,
} from "@gsv/protocol/syscalls/system";
import type {
  SchedulerListArgs,
  SchedulerListResult,
  SchedulerAddArgs,
  SchedulerRunResult,
  CronJob,
  CronJobPatch,
} from "./scheduler";
import type {
  AiToolsArgs,
  AiToolsResult,
  AiConfigArgs,
  AiConfigResult,
} from "./ai";
import type {
  AdapterConnectArgs,
  AdapterConnectResult,
  AdapterDisconnectArgs,
  AdapterDisconnectResult,
  AdapterInboundArgs,
  AdapterInboundSyscallResult,
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
  AdapterSendArgs,
  AdapterSendResult,
  AdapterStatusArgs,
  AdapterStatusResult,
} from "./adapter";
import type {
  KnowledgeDbInitArgs,
  KnowledgeDbInitResult,
  KnowledgeDbDeleteArgs,
  KnowledgeDbDeleteResult,
  KnowledgeDbListArgs,
  KnowledgeDbListResult,
  KnowledgeCompileArgs,
  KnowledgeCompileResult,
  KnowledgeIngestArgs,
  KnowledgeIngestResult,
  KnowledgeListArgs,
  KnowledgeListResult,
  KnowledgeReadArgs,
  KnowledgeReadResult,
  KnowledgeWriteArgs,
  KnowledgeWriteResult,
  KnowledgeSearchArgs,
  KnowledgeSearchResult,
  KnowledgeMergeArgs,
  KnowledgeMergeResult,
  KnowledgePromoteArgs,
  KnowledgePromoteResult,
  KnowledgeQueryArgs,
  KnowledgeQueryResult,
} from "./knowledge";
import type {
  SignalWatchArgs,
  SignalWatchResult,
  SignalUnwatchArgs,
  SignalUnwatchResult,
} from "./signal";
import type {
  NotificationCreateArgs,
  NotificationCreateResult,
  NotificationDismissArgs,
  NotificationDismissResult,
  NotificationListArgs,
  NotificationListResult,
  NotificationMarkReadArgs,
  NotificationMarkReadResult,
} from "@gsv/protocol/syscalls/notification";
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type SyscallDomains = {
  // Filesystem
  "fs.read": { args: FsReadArgs; result: FsReadResult };
  "fs.write": { args: FsWriteArgs; result: FsWriteResult };
  "fs.edit": { args: FsEditArgs; result: FsEditResult };
  "fs.delete": { args: FsDeleteArgs; result: FsDeleteResult };
  "fs.search": { args: FsSearchArgs; result: FsSearchResult };

  // Shell (device commands)
  "shell.exec": { args: ShellExecArgs; result: ShellExecResult };

  // CodeMode (process-local programmable tool use)
  "codemode.exec": { args: CodeModeExecArgs; result: CodeModeExecResult };
  "codemode.run": { args: CodeModeRunArgs; result: CodeModeRunResult };

  // Process management (OS-level agent processes)
  "proc.spawn": { args: ProcSpawnArgs; result: ProcSpawnResult };
  "proc.kill": { args: ProcKillArgs; result: ProcKillResult };
  "proc.list": { args: ProcListArgs; result: ProcListResult };
  "proc.profile.list": { args: ProcProfileListArgs; result: ProcProfileListResult };
  "proc.send": { args: ProcSendArgs; result: ProcSendResult };
  "proc.abort": { args: ProcAbortArgs; result: ProcAbortResult };
  "proc.hil": { args: ProcHilArgs; result: ProcHilResult };
  "proc.history": { args: ProcHistoryArgs; result: ProcHistoryResult };
  "proc.reset": { args: ProcResetArgs; result: ProcResetResult };
  "proc.setidentity": { args: ProcSetIdentityArgs; result: ProcSetIdentityResult };

  // Packages
  "pkg.list": { args: PkgListArgs; result: PkgListResult };
  "pkg.add": { args: PkgAddArgs; result: PkgAddResult };
  "pkg.sync": { args: PkgSyncArgs; result: PkgSyncResult };
  "pkg.checkout": { args: PkgCheckoutArgs; result: PkgCheckoutResult };
  "pkg.install": { args: PkgInstallArgs; result: PkgInstallResult };
  "pkg.review.approve": { args: PkgReviewApproveArgs; result: PkgReviewApproveResult };
  "pkg.remove": { args: PkgRemoveArgs; result: PkgRemoveResult };
  "pkg.repo.refs": { args: PkgRepoRefsArgs; result: PkgRepoRefsResult };
  "pkg.repo.read": { args: PkgRepoReadArgs; result: PkgRepoReadResult };
  "pkg.repo.log": { args: PkgRepoLogArgs; result: PkgRepoLogResult };
  "pkg.repo.search": { args: PkgRepoSearchArgs; result: PkgRepoSearchResult };
  "pkg.repo.diff": { args: PkgRepoDiffArgs; result: PkgRepoDiffResult };
  "pkg.remote.list": { args: PkgRemoteListArgs; result: PkgRemoteListResult };
  "pkg.remote.add": { args: PkgRemoteAddArgs; result: PkgRemoteAddResult };
  "pkg.remote.remove": { args: PkgRemoteRemoveArgs; result: PkgRemoteRemoveResult };
  "pkg.public.list": { args: PkgPublicListArgs; result: PkgPublicListResult };
  "pkg.public.set": { args: PkgPublicSetArgs; result: PkgPublicSetResult };

  // System
  "sys.connect": { args: ConnectArgs; result: ConnectResult };
  "sys.setup.assist": { args: SysSetupAssistArgs; result: SysSetupAssistResult };
  "sys.setup": { args: SysSetupArgs; result: SysSetupResult };
  "sys.bootstrap": { args: SysBootstrapArgs; result: SysBootstrapResult };
  "sys.config.get": { args: SysConfigGetArgs; result: SysConfigGetResult };
  "sys.config.set": { args: SysConfigSetArgs; result: SysConfigSetResult };
  "sys.device.list": { args: SysDeviceListArgs; result: SysDeviceListResult };
  "sys.device.get": { args: SysDeviceGetArgs; result: SysDeviceGetResult };
  "sys.workspace.list": { args: SysWorkspaceListArgs; result: SysWorkspaceListResult };
  "sys.token.create": { args: SysTokenCreateArgs; result: SysTokenCreateResult };
  "sys.token.list": { args: SysTokenListArgs; result: SysTokenListResult };
  "sys.token.revoke": { args: SysTokenRevokeArgs; result: SysTokenRevokeResult };
  "sys.link": { args: SysLinkArgs; result: SysLinkResult };
  "sys.unlink": { args: SysUnlinkArgs; result: SysUnlinkResult };
  "sys.link.list": { args: SysLinkListArgs; result: SysLinkListResult };
  "sys.link.consume": { args: SysLinkConsumeArgs; result: SysLinkConsumeResult };

  // Scheduler (cron)
  "sched.list": { args: SchedulerListArgs; result: SchedulerListResult };
  "sched.add": { args: SchedulerAddArgs; result: { job: CronJob } };
  "sched.update": { args: { id: string; patch: CronJobPatch }; result: { job: CronJob } };
  "sched.remove": { args: { id: string }; result: { removed: boolean } };
  "sched.run": { args: { id?: string; mode?: "due" | "force" }; result: SchedulerRunResult };

  // AI (process bootstrap)
  "ai.tools": { args: AiToolsArgs; result: AiToolsResult };
  "ai.config": { args: AiConfigArgs; result: AiConfigResult };

  // Adapter transport (external connectors)
  "adapter.connect": { args: AdapterConnectArgs; result: AdapterConnectResult };
  "adapter.disconnect": { args: AdapterDisconnectArgs; result: AdapterDisconnectResult };
  "adapter.inbound": { args: AdapterInboundArgs; result: AdapterInboundSyscallResult };
  "adapter.state.update": { args: AdapterStateUpdateArgs; result: AdapterStateUpdateResult };
  "adapter.send": { args: AdapterSendArgs; result: AdapterSendResult };
  "adapter.status": { args: AdapterStatusArgs; result: AdapterStatusResult };

  // Knowledge substrate (home durable knowledge)
  "knowledge.db.list": { args: KnowledgeDbListArgs; result: KnowledgeDbListResult };
  "knowledge.db.init": { args: KnowledgeDbInitArgs; result: KnowledgeDbInitResult };
  "knowledge.db.delete": { args: KnowledgeDbDeleteArgs; result: KnowledgeDbDeleteResult };
  "knowledge.list": { args: KnowledgeListArgs; result: KnowledgeListResult };
  "knowledge.read": { args: KnowledgeReadArgs; result: KnowledgeReadResult };
  "knowledge.write": { args: KnowledgeWriteArgs; result: KnowledgeWriteResult };
  "knowledge.search": { args: KnowledgeSearchArgs; result: KnowledgeSearchResult };
  "knowledge.merge": { args: KnowledgeMergeArgs; result: KnowledgeMergeResult };
  "knowledge.promote": { args: KnowledgePromoteArgs; result: KnowledgePromoteResult };
  "knowledge.query": { args: KnowledgeQueryArgs; result: KnowledgeQueryResult };
  "knowledge.ingest": { args: KnowledgeIngestArgs; result: KnowledgeIngestResult };
  "knowledge.compile": { args: KnowledgeCompileArgs; result: KnowledgeCompileResult };

  // Notifications
  "notification.create": { args: NotificationCreateArgs; result: NotificationCreateResult };
  "notification.list": { args: NotificationListArgs; result: NotificationListResult };
  "notification.mark_read": { args: NotificationMarkReadArgs; result: NotificationMarkReadResult };
  "notification.dismiss": { args: NotificationDismissArgs; result: NotificationDismissResult };

  // Durable signal watches
  "signal.watch": { args: SignalWatchArgs; result: SignalWatchResult };
  "signal.unwatch": { args: SignalUnwatchArgs; result: SignalUnwatchResult };
};

export type SyscallName = keyof SyscallDomains;
export type ArgsOf<S extends SyscallName> = SyscallDomains[S]["args"];
export type ResultOf<S extends SyscallName> = SyscallDomains[S]["result"];

export type SyscallDomain =
  | "fs"
  | "shell"
  | "codemode"
  | "proc"
  | "pkg"
  | "sys"
  | "ai"
  | "sched"
  | "notification"
  | "adapter";

export function domainOf(syscall: SyscallName): SyscallDomain {
  return syscall.split(".")[0] as SyscallDomain;
}

/**
 * Domains that support device routing via the `target` field.
 * `shell` always requires a device target. `fs` can be native (R2) or device.
 * `proc` is kernel-internal (no device routing).
 */
const ROUTABLE_DOMAINS: SyscallDomain[] = ["fs", "shell"];

/**
 * Inject a `target` property into a tool definition so the LLM can choose
 * where to execute the syscall. Only applicable to routable domains (fs, shell).
 *
 * @param tool - The base tool definition (without target)
 * @param devices - List of accessible online device IDs for this user
 */
export function intoSyscallTool(
  tool: ToolDefinition,
  devices: string[],
): ToolDefinition {
  const required = tool.inputSchema.required as string[];
  const properties = tool.inputSchema.properties as Record<string, unknown>;
  if (
    required.includes("target") ||
    Object.keys(properties).includes("target")
  ) {
    throw new Error(
      `Tool ${tool.name} already has 'target' property. Can't turn into syscall tool.`,
    );
  }

  const deviceList = devices.length > 0 ? devices.join(", ") : "none";

  const targetRequired = tool.name !== "Shell";

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        target: {
          type: "string",
          description: `Target device to execute on. Use "gsv" to execute on the cloud or use one of the accessible online devices: ${deviceList}`,
        },
      },
      required: targetRequired ? [...required, "target"] : required,
    },
  };
}

export function isRoutableSyscall(call: SyscallName): boolean {
  return ROUTABLE_DOMAINS.includes(domainOf(call));
}
