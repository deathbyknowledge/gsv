import type { FsReadArgs, FsReadResult } from "./read";
import type { FsWriteArgs, FsWriteResult } from "./write";
import type { FsEditArgs, FsEditResult } from "./edit";
import type { FsDeleteArgs, FsDeleteResult } from "./delete";
import type { FsSearchArgs, FsSearchResult } from "./search";
import type { FsCopyArgs, FsCopyResult } from "./copy";
import type {
  FsTransferReceiveArgs,
  FsTransferReceiveResult,
  FsTransferSendArgs,
  FsTransferSendResult,
  FsTransferStatArgs,
  FsTransferStatResult,
} from "./transfer";
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
  ProcIpcDeliverArgs,
  ProcIpcDeliverResult,
  ProcIpcCallArgs,
  ProcIpcCallResult,
  ProcIpcSendArgs,
  ProcIpcSendResult,
  ProcAbortArgs,
  ProcAbortResult,
  ProcHilArgs,
  ProcHilResult,
  ProcSendResult,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcConversationOpenArgs,
  ProcConversationOpenResult,
  ProcConversationListArgs,
  ProcConversationListResult,
  ProcConversationGetArgs,
  ProcConversationGetResult,
  ProcConversationCloseArgs,
  ProcConversationCloseResult,
  ProcConversationResetArgs,
  ProcConversationResetResult,
  ProcConversationPolicyGetArgs,
  ProcConversationPolicyGetResult,
  ProcConversationPolicySetArgs,
  ProcConversationPolicySetResult,
  ProcConversationCompactArgs,
  ProcConversationCompactResult,
  ProcConversationForkArgs,
  ProcConversationForkResult,
  ProcConversationSegmentReadArgs,
  ProcConversationSegmentReadResult,
  ProcConversationSegmentsArgs,
  ProcConversationSegmentsResult,
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
  PkgCreateArgs,
  PkgCreateResult,
  PkgInstallArgs,
  PkgInstallResult,
  PkgReviewApproveArgs,
  PkgReviewApproveResult,
  PkgListArgs,
  PkgListResult,
  PkgSyncArgs,
  PkgSyncResult,
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
  RepoApplyArgs,
  RepoApplyResult,
  RepoCompareArgs,
  RepoCompareResult,
  RepoCreateArgs,
  RepoCreateResult,
  RepoDiffArgs,
  RepoDiffResult,
  RepoImportArgs,
  RepoImportResult,
  RepoListArgs,
  RepoListResult,
  RepoLogArgs,
  RepoLogResult,
  RepoReadArgs,
  RepoReadResult,
  RepoRefsArgs,
  RepoRefsResult,
  RepoSearchArgs,
  RepoSearchResult,
} from "@gsv/protocol/syscalls/repositories";
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
  SysDeviceUpdateArgs,
  SysDeviceUpdateResult,
  SysTargetRegisterArgs,
  SysTargetRegisterResult,
  SysOAuthStartArgs,
  SysOAuthStartResult,
  SysOAuthListArgs,
  SysOAuthListResult,
  SysOAuthForgetArgs,
  SysOAuthForgetResult,
  SysMcpAddArgs,
  SysMcpAddResult,
  SysMcpCallArgs,
  SysMcpCallResult,
  SysMcpListArgs,
  SysMcpListResult,
  SysMcpRefreshArgs,
  SysMcpRefreshResult,
  SysMcpRemoveArgs,
  SysMcpRemoveResult,
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
  SchedulerAddResult,
  SchedulerUpdateArgs,
  SchedulerUpdateResult,
  SchedulerRemoveArgs,
  SchedulerRemoveResult,
  SchedulerRunArgs,
  SchedulerRunResult,
} from "./scheduler";
import type {
  AiToolsArgs,
  AiToolsResult,
  AiConfigArgs,
  AiConfigResult,
  AiSpeechCreateArgs,
  AiSpeechCreateResult,
  AiTranscriptionCreateArgs,
  AiTranscriptionCreateResult,
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
  "fs.copy": { args: FsCopyArgs; result: FsCopyResult };
  "fs.transfer.stat": { args: FsTransferStatArgs; result: FsTransferStatResult };
  "fs.transfer.send": { args: FsTransferSendArgs; result: FsTransferSendResult };
  "fs.transfer.receive": { args: FsTransferReceiveArgs; result: FsTransferReceiveResult };

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
  "proc.ipc.send": { args: ProcIpcSendArgs; result: ProcIpcSendResult };
  "proc.ipc.call": { args: ProcIpcCallArgs; result: ProcIpcCallResult };
  "proc.ipc.deliver": { args: ProcIpcDeliverArgs; result: ProcIpcDeliverResult };
  "proc.abort": { args: ProcAbortArgs; result: ProcAbortResult };
  "proc.hil": { args: ProcHilArgs; result: ProcHilResult };
  "proc.history": { args: ProcHistoryArgs; result: ProcHistoryResult };
  "proc.media.read": { args: ProcMediaReadArgs; result: ProcMediaReadResult };
  "proc.conversation.open": { args: ProcConversationOpenArgs; result: ProcConversationOpenResult };
  "proc.conversation.list": { args: ProcConversationListArgs; result: ProcConversationListResult };
  "proc.conversation.get": { args: ProcConversationGetArgs; result: ProcConversationGetResult };
  "proc.conversation.close": { args: ProcConversationCloseArgs; result: ProcConversationCloseResult };
  "proc.conversation.reset": { args: ProcConversationResetArgs; result: ProcConversationResetResult };
  "proc.conversation.policy.get": { args: ProcConversationPolicyGetArgs; result: ProcConversationPolicyGetResult };
  "proc.conversation.policy.set": { args: ProcConversationPolicySetArgs; result: ProcConversationPolicySetResult };
  "proc.conversation.compact": { args: ProcConversationCompactArgs; result: ProcConversationCompactResult };
  "proc.conversation.fork": { args: ProcConversationForkArgs; result: ProcConversationForkResult };
  "proc.conversation.segment.read": { args: ProcConversationSegmentReadArgs; result: ProcConversationSegmentReadResult };
  "proc.conversation.segments": { args: ProcConversationSegmentsArgs; result: ProcConversationSegmentsResult };
  "proc.reset": { args: ProcResetArgs; result: ProcResetResult };
  "proc.setidentity": { args: ProcSetIdentityArgs; result: ProcSetIdentityResult };

  // Packages
  "pkg.list": { args: PkgListArgs; result: PkgListResult };
  "pkg.add": { args: PkgAddArgs; result: PkgAddResult };
  "pkg.create": { args: PkgCreateArgs; result: PkgCreateResult };
  "pkg.sync": { args: PkgSyncArgs; result: PkgSyncResult };
  "pkg.checkout": { args: PkgCheckoutArgs; result: PkgCheckoutResult };
  "pkg.install": { args: PkgInstallArgs; result: PkgInstallResult };
  "pkg.review.approve": { args: PkgReviewApproveArgs; result: PkgReviewApproveResult };
  "pkg.remove": { args: PkgRemoveArgs; result: PkgRemoveResult };
  "pkg.remote.list": { args: PkgRemoteListArgs; result: PkgRemoteListResult };
  "pkg.remote.add": { args: PkgRemoteAddArgs; result: PkgRemoteAddResult };
  "pkg.remote.remove": { args: PkgRemoteRemoveArgs; result: PkgRemoteRemoveResult };
  "pkg.public.list": { args: PkgPublicListArgs; result: PkgPublicListResult };
  "pkg.public.set": { args: PkgPublicSetArgs; result: PkgPublicSetResult };

  // Repositories
  "repo.list": { args: RepoListArgs; result: RepoListResult };
  "repo.create": { args: RepoCreateArgs; result: RepoCreateResult };
  "repo.refs": { args: RepoRefsArgs; result: RepoRefsResult };
  "repo.read": { args: RepoReadArgs; result: RepoReadResult };
  "repo.search": { args: RepoSearchArgs; result: RepoSearchResult };
  "repo.log": { args: RepoLogArgs; result: RepoLogResult };
  "repo.diff": { args: RepoDiffArgs; result: RepoDiffResult };
  "repo.compare": { args: RepoCompareArgs; result: RepoCompareResult };
  "repo.apply": { args: RepoApplyArgs; result: RepoApplyResult };
  "repo.import": { args: RepoImportArgs; result: RepoImportResult };

  // System
  "sys.connect": { args: ConnectArgs; result: ConnectResult };
  "sys.setup.assist": { args: SysSetupAssistArgs; result: SysSetupAssistResult };
  "sys.setup": { args: SysSetupArgs; result: SysSetupResult };
  "sys.bootstrap": { args: SysBootstrapArgs; result: SysBootstrapResult };
  "sys.config.get": { args: SysConfigGetArgs; result: SysConfigGetResult };
  "sys.config.set": { args: SysConfigSetArgs; result: SysConfigSetResult };
  "sys.device.list": { args: SysDeviceListArgs; result: SysDeviceListResult };
  "sys.device.get": { args: SysDeviceGetArgs; result: SysDeviceGetResult };
  "sys.device.update": { args: SysDeviceUpdateArgs; result: SysDeviceUpdateResult };
  "sys.target.register": { args: SysTargetRegisterArgs; result: SysTargetRegisterResult };
  "sys.oauth.start": { args: SysOAuthStartArgs; result: SysOAuthStartResult };
  "sys.oauth.list": { args: SysOAuthListArgs; result: SysOAuthListResult };
  "sys.oauth.forget": { args: SysOAuthForgetArgs; result: SysOAuthForgetResult };
  "sys.mcp.add": { args: SysMcpAddArgs; result: SysMcpAddResult };
  "sys.mcp.list": { args: SysMcpListArgs; result: SysMcpListResult };
  "sys.mcp.remove": { args: SysMcpRemoveArgs; result: SysMcpRemoveResult };
  "sys.mcp.refresh": { args: SysMcpRefreshArgs; result: SysMcpRefreshResult };
  "sys.mcp.call": { args: SysMcpCallArgs; result: SysMcpCallResult };
  "sys.token.create": { args: SysTokenCreateArgs; result: SysTokenCreateResult };
  "sys.token.list": { args: SysTokenListArgs; result: SysTokenListResult };
  "sys.token.revoke": { args: SysTokenRevokeArgs; result: SysTokenRevokeResult };
  "sys.link": { args: SysLinkArgs; result: SysLinkResult };
  "sys.unlink": { args: SysUnlinkArgs; result: SysUnlinkResult };
  "sys.link.list": { args: SysLinkListArgs; result: SysLinkListResult };
  "sys.link.consume": { args: SysLinkConsumeArgs; result: SysLinkConsumeResult };

  // Scheduler (cron)
  "sched.list": { args: SchedulerListArgs; result: SchedulerListResult };
  "sched.add": { args: SchedulerAddArgs; result: SchedulerAddResult };
  "sched.update": { args: SchedulerUpdateArgs; result: SchedulerUpdateResult };
  "sched.remove": { args: SchedulerRemoveArgs; result: SchedulerRemoveResult };
  "sched.run": { args: SchedulerRunArgs; result: SchedulerRunResult };

  // AI (process bootstrap)
  "ai.tools": { args: AiToolsArgs; result: AiToolsResult };
  "ai.config": { args: AiConfigArgs; result: AiConfigResult };
  "ai.transcription.create": { args: AiTranscriptionCreateArgs; result: AiTranscriptionCreateResult };
  "ai.speech.create": { args: AiSpeechCreateArgs; result: AiSpeechCreateResult };

  // Adapter transport (external connectors)
  "adapter.connect": { args: AdapterConnectArgs; result: AdapterConnectResult };
  "adapter.disconnect": { args: AdapterDisconnectArgs; result: AdapterDisconnectResult };
  "adapter.inbound": { args: AdapterInboundArgs; result: AdapterInboundSyscallResult };
  "adapter.state.update": { args: AdapterStateUpdateArgs; result: AdapterStateUpdateResult };
  "adapter.send": { args: AdapterSendArgs; result: AdapterSendResult };
  "adapter.status": { args: AdapterStatusArgs; result: AdapterStatusResult };

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

type SyscallDomain =
  | "fs"
  | "shell"
  | "codemode"
  | "proc"
  | "pkg"
  | "repo"
  | "sys"
  | "ai"
  | "sched"
  | "notification"
  | "adapter"
  | "signal";

function domainOf(syscall: SyscallName): SyscallDomain {
  return syscall.split(".")[0] as SyscallDomain;
}

/**
 * Domains that support device routing via the `target` field.
 * `shell` always requires a device target. `fs` can be native (R2) or device.
 * `proc` is kernel-internal (no device routing).
 */
const ROUTABLE_DOMAINS: SyscallDomain[] = ["fs", "shell"];
const TARGET_SCHEMA_INLINE_LIMIT = 10;

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
          description: formatTargetSchemaDescription(devices),
        },
      },
      required: targetRequired ? [...required, "target"] : required,
    },
  };
}

function formatTargetSchemaDescription(devices: string[]): string {
  if (devices.length === 0) {
    return "Target to execute on. Use \"gsv\" for the native cloud target. Run `targets list` in Shell to discover connected targets.";
  }
  const listed = devices.slice(0, TARGET_SCHEMA_INLINE_LIMIT);
  const suffix = devices.length > listed.length
    ? `, and ${devices.length - listed.length} more`
    : "";
  return `Target to execute on. Use "gsv" for the native cloud target, or one of: ${listed.join(", ")}${suffix}. Run \`targets list\` in Shell for details.`;
}

export function isRoutableSyscall(call: SyscallName): boolean {
  return ROUTABLE_DOMAINS.includes(domainOf(call));
}
