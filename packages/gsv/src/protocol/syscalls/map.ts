import type {
  FsCopyArgs,
  FsCopyResult,
  FsDeleteArgs,
  FsDeleteResult,
  FsEditArgs,
  FsEditResult,
  FsReadArgs,
  FsReadResult,
  FsSearchArgs,
  FsSearchResult,
  FsTransferReceiveArgs,
  FsTransferReceiveResult,
  FsTransferSendArgs,
  FsTransferSendResult,
  FsTransferStatArgs,
  FsTransferStatResult,
  FsWriteArgs,
  FsWriteResult,
} from "./fs";
import type { ShellExecArgs, ShellExecResult } from "./shell";
import type {
  AppAttachArgs,
  AppCloseArgs,
  AppCloseResult,
  AppDetachArgs,
  AppDetachResult,
  AppLaunchResult,
  AppListArgs,
  AppListResult,
  AppOpenArgs,
} from "./apps";
import type {
  CodeModeExecArgs,
  CodeModeExecResult,
  CodeModeRunArgs,
  CodeModeRunResult,
} from "./codemode";
import type {
  ProcAbortArgs,
  ProcAbortResult,
  ProcAiConfigGetArgs,
  ProcAiConfigGetResult,
  ProcAiConfigSetArgs,
  ProcAiConfigSetResult,
  ProcConversationCloseArgs,
  ProcConversationCloseResult,
  ProcConversationCompactArgs,
  ProcConversationCompactResult,
  ProcConversationForkArgs,
  ProcConversationForkResult,
  ProcConversationGenerationManifestArgs,
  ProcConversationGenerationManifestResult,
  ProcConversationGenerationsArgs,
  ProcConversationGenerationsResult,
  ProcConversationGetArgs,
  ProcConversationGetResult,
  ProcConversationListArgs,
  ProcConversationListResult,
  ProcConversationOpenArgs,
  ProcConversationOpenResult,
  ProcConversationPolicyGetArgs,
  ProcConversationPolicyGetResult,
  ProcConversationPolicySetArgs,
  ProcConversationPolicySetResult,
  ProcConversationResetArgs,
  ProcConversationResetResult,
  ProcConversationSegmentReadArgs,
  ProcConversationSegmentReadResult,
  ProcConversationSegmentsArgs,
  ProcConversationSegmentsResult,
  ProcConversationTimelineArgs,
  ProcConversationTimelineResult,
  ProcHilArgs,
  ProcHilResult,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcIpcCallArgs,
  ProcIpcCallResult,
  ProcIpcDeliverArgs,
  ProcIpcDeliverResult,
  ProcIpcSendArgs,
  ProcIpcSendResult,
  ProcKillArgs,
  ProcKillResult,
  ProcListArgs,
  ProcListResult,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcResetArgs,
  ProcResetResult,
  ProcSendArgs,
  ProcSendResult,
  ProcSetIdentityArgs,
  ProcSetIdentityResult,
  ProcSpawnArgs,
  ProcSpawnResult,
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
  PkgListArgs,
  PkgListResult,
  PkgPublicListArgs,
  PkgPublicListResult,
  PkgPublicSetArgs,
  PkgPublicSetResult,
  PkgRemoteAddArgs,
  PkgRemoteAddResult,
  PkgRemoteListArgs,
  PkgRemoteListResult,
  PkgRemoteRemoveArgs,
  PkgRemoteRemoveResult,
  PkgRemoveArgs,
  PkgRemoveResult,
  PkgReviewApproveArgs,
  PkgReviewApproveResult,
  PkgSyncArgs,
  PkgSyncResult,
} from "./packages";
import type {
  RepoApplyArgs,
  RepoApplyResult,
  RepoCompareArgs,
  RepoCompareResult,
  RepoCreateArgs,
  RepoCreateResult,
  RepoDeleteArgs,
  RepoDeleteResult,
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
} from "./repositories";
import type {
  AccountCreateArgs,
  AccountCreateResult,
  AccountListArgs,
  AccountListResult,
  ConnectArgs,
  ConnectResult,
  SysBootstrapArgs,
  SysBootstrapResult,
  SysConfigGetArgs,
  SysConfigGetResult,
  SysConfigSetArgs,
  SysConfigSetResult,
  SysDeviceDeleteArgs,
  SysDeviceDeleteResult,
  SysDeviceGetArgs,
  SysDeviceGetResult,
  SysDeviceListArgs,
  SysDeviceListResult,
  SysDeviceUpdateArgs,
  SysDeviceUpdateResult,
  SysLinkArgs,
  SysLinkConsumeArgs,
  SysLinkConsumeResult,
  SysLinkListArgs,
  SysLinkListResult,
  SysLinkResult,
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
  SysOAuthForgetArgs,
  SysOAuthForgetResult,
  SysOAuthListArgs,
  SysOAuthListResult,
  SysOAuthStartArgs,
  SysOAuthStartResult,
  SysSetupArgs,
  SysSetupAssistArgs,
  SysSetupAssistResult,
  SysSetupResult,
  SysTokenCreateArgs,
  SysTokenCreateResult,
  SysTokenListArgs,
  SysTokenListResult,
  SysTokenRevokeArgs,
  SysTokenRevokeResult,
  SysUnlinkArgs,
  SysUnlinkResult,
} from "./system";
import type {
  SchedulerAddArgs,
  SchedulerAddResult,
  SchedulerListArgs,
  SchedulerListResult,
  SchedulerRemoveArgs,
  SchedulerRemoveResult,
  SchedulerRunArgs,
  SchedulerRunResult,
  SchedulerUpdateArgs,
  SchedulerUpdateResult,
} from "./scheduler";
import type {
  AiConfigArgs,
  AiConfigResult,
  AiImageGenerateArgs,
  AiImageGenerateResult,
  AiImageReadArgs,
  AiImageReadResult,
  AiSpeechCreateArgs,
  AiSpeechCreateResult,
  AiTextGenerateArgs,
  AiTextGenerateResult,
  AiToolsArgs,
  AiToolsResult,
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
  AdapterListArgs,
  AdapterListResult,
  AdapterSendArgs,
  AdapterSendResult,
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
  AdapterStatusArgs,
  AdapterStatusResult,
} from "./adapter";
import type {
  NotificationCreateArgs,
  NotificationCreateResult,
  NotificationDismissArgs,
  NotificationDismissResult,
  NotificationListArgs,
  NotificationListResult,
  NotificationMarkReadArgs,
  NotificationMarkReadResult,
} from "./notification";
import type {
  SignalUnwatchArgs,
  SignalUnwatchResult,
  SignalWatchArgs,
  SignalWatchResult,
} from "./signal";

export type SyscallDomains = {
  "fs.read": { args: FsReadArgs; result: FsReadResult };
  "fs.write": { args: FsWriteArgs; result: FsWriteResult };
  "fs.edit": { args: FsEditArgs; result: FsEditResult };
  "fs.delete": { args: FsDeleteArgs; result: FsDeleteResult };
  "fs.search": { args: FsSearchArgs; result: FsSearchResult };
  "fs.copy": { args: FsCopyArgs; result: FsCopyResult };
  "fs.transfer.stat": { args: FsTransferStatArgs; result: FsTransferStatResult };
  "fs.transfer.send": { args: FsTransferSendArgs; result: FsTransferSendResult };
  "fs.transfer.receive": { args: FsTransferReceiveArgs; result: FsTransferReceiveResult };

  "shell.exec": { args: ShellExecArgs; result: ShellExecResult };

  "app.open": { args: AppOpenArgs; result: AppLaunchResult };
  "app.attach": { args: AppAttachArgs; result: AppLaunchResult };
  "app.list": { args: AppListArgs; result: AppListResult };
  "app.detach": { args: AppDetachArgs; result: AppDetachResult };
  "app.close": { args: AppCloseArgs; result: AppCloseResult };

  "codemode.exec": { args: CodeModeExecArgs; result: CodeModeExecResult };
  "codemode.run": { args: CodeModeRunArgs; result: CodeModeRunResult };

  "proc.spawn": { args: ProcSpawnArgs; result: ProcSpawnResult };
  "proc.kill": { args: ProcKillArgs; result: ProcKillResult };
  "proc.list": { args: ProcListArgs; result: ProcListResult };
  "proc.send": { args: ProcSendArgs; result: ProcSendResult };
  "proc.ipc.send": { args: ProcIpcSendArgs; result: ProcIpcSendResult };
  "proc.ipc.call": { args: ProcIpcCallArgs; result: ProcIpcCallResult };
  "proc.ipc.deliver": { args: ProcIpcDeliverArgs; result: ProcIpcDeliverResult };
  "proc.abort": { args: ProcAbortArgs; result: ProcAbortResult };
  "proc.hil": { args: ProcHilArgs; result: ProcHilResult };
  "proc.history": { args: ProcHistoryArgs; result: ProcHistoryResult };
  "proc.ai.config.get": { args: ProcAiConfigGetArgs; result: ProcAiConfigGetResult };
  "proc.ai.config.set": { args: ProcAiConfigSetArgs; result: ProcAiConfigSetResult };
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
  "proc.conversation.timeline": { args: ProcConversationTimelineArgs; result: ProcConversationTimelineResult };
  "proc.conversation.generations": { args: ProcConversationGenerationsArgs; result: ProcConversationGenerationsResult };
  "proc.conversation.generation.manifest": {
    args: ProcConversationGenerationManifestArgs;
    result: ProcConversationGenerationManifestResult;
  };
  "proc.reset": { args: ProcResetArgs; result: ProcResetResult };
  "proc.setidentity": { args: ProcSetIdentityArgs; result: ProcSetIdentityResult };

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
  "repo.delete": { args: RepoDeleteArgs; result: RepoDeleteResult };

  "sys.connect": { args: ConnectArgs; result: ConnectResult };
  "sys.setup.assist": { args: SysSetupAssistArgs; result: SysSetupAssistResult };
  "sys.setup": { args: SysSetupArgs; result: SysSetupResult };
  "sys.bootstrap": { args: SysBootstrapArgs; result: SysBootstrapResult };
  "sys.config.get": { args: SysConfigGetArgs; result: SysConfigGetResult };
  "sys.config.set": { args: SysConfigSetArgs; result: SysConfigSetResult };
  "sys.device.list": { args: SysDeviceListArgs; result: SysDeviceListResult };
  "sys.device.get": { args: SysDeviceGetArgs; result: SysDeviceGetResult };
  "sys.device.update": { args: SysDeviceUpdateArgs; result: SysDeviceUpdateResult };
  "sys.device.delete": { args: SysDeviceDeleteArgs; result: SysDeviceDeleteResult };
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

  "account.create": { args: AccountCreateArgs; result: AccountCreateResult };
  "account.list": { args: AccountListArgs; result: AccountListResult };

  "sched.list": { args: SchedulerListArgs; result: SchedulerListResult };
  "sched.add": { args: SchedulerAddArgs; result: SchedulerAddResult };
  "sched.update": { args: SchedulerUpdateArgs; result: SchedulerUpdateResult };
  "sched.remove": { args: SchedulerRemoveArgs; result: SchedulerRemoveResult };
  "sched.run": { args: SchedulerRunArgs; result: SchedulerRunResult };

  "ai.tools": { args: AiToolsArgs; result: AiToolsResult };
  "ai.config": { args: AiConfigArgs; result: AiConfigResult };
  "ai.text.generate": { args: AiTextGenerateArgs; result: AiTextGenerateResult };
  "ai.transcription.create": { args: AiTranscriptionCreateArgs; result: AiTranscriptionCreateResult };
  "ai.image.read": { args: AiImageReadArgs; result: AiImageReadResult };
  "ai.image.generate": { args: AiImageGenerateArgs; result: AiImageGenerateResult };
  "ai.speech.create": { args: AiSpeechCreateArgs; result: AiSpeechCreateResult };

  "adapter.connect": { args: AdapterConnectArgs; result: AdapterConnectResult };
  "adapter.disconnect": { args: AdapterDisconnectArgs; result: AdapterDisconnectResult };
  "adapter.inbound": { args: AdapterInboundArgs; result: AdapterInboundSyscallResult };
  "adapter.state.update": { args: AdapterStateUpdateArgs; result: AdapterStateUpdateResult };
  "adapter.send": { args: AdapterSendArgs; result: AdapterSendResult };
  "adapter.status": { args: AdapterStatusArgs; result: AdapterStatusResult };
  "adapter.list": { args: AdapterListArgs; result: AdapterListResult };

  "notification.create": { args: NotificationCreateArgs; result: NotificationCreateResult };
  "notification.list": { args: NotificationListArgs; result: NotificationListResult };
  "notification.mark_read": { args: NotificationMarkReadArgs; result: NotificationMarkReadResult };
  "notification.dismiss": { args: NotificationDismissArgs; result: NotificationDismissResult };

  "signal.watch": { args: SignalWatchArgs; result: SignalWatchResult };
  "signal.unwatch": { args: SignalUnwatchArgs; result: SignalUnwatchResult };
};

export type SyscallName = keyof SyscallDomains;
export type ArgsOf<S extends SyscallName> = SyscallDomains[S]["args"];
export type ResultOf<S extends SyscallName> = SyscallDomains[S]["result"];
