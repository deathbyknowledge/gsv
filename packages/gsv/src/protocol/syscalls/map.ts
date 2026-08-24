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
import type { NetFetchArgs, NetFetchResult } from "./net";
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
  ProcForkArgs,
  ProcForkResult,
  ProcHistoryCompactArgs,
  ProcHistoryCompactResult,
  ProcHistoryExportArgs,
  ProcHistoryExportResult,
  ProcHistoryImportArgs,
  ProcHistoryImportResult,
  ProcHistoryPolicyGetArgs,
  ProcHistoryPolicyGetResult,
  ProcHistoryPolicySetArgs,
  ProcHistoryPolicySetResult,
  ProcHistorySegmentReadArgs,
  ProcHistorySegmentReadResult,
  ProcHistorySegmentsArgs,
  ProcHistorySegmentsResult,
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
  ProcObserveArgs,
  ProcObserveResult,
  ProcResetArgs,
  ProcResetResult,
  ProcSendArgs,
  ProcSendResult,
  ProcSetIdentityArgs,
  ProcSetIdentityResult,
  ProcSpawnArgs,
  ProcSpawnResult,
  ProcUnobserveArgs,
  ProcUnobserveResult,
} from "./proc";
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
  RepoVisibilitySetArgs,
  RepoVisibilitySetResult,
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
  SysOAuthDevicePollArgs,
  SysOAuthDevicePollResult,
  SysOAuthDeviceStartArgs,
  SysOAuthDeviceStartResult,
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
  ResponsibilityChangesArgs,
  ResponsibilityChangesResult,
  ResponsibilityCreateArgs,
  ResponsibilityCreateResult,
  ResponsibilityGetArgs,
  ResponsibilityGetResult,
  ResponsibilityListArgs,
  ResponsibilityListResult,
  ResponsibilityUpdateArgs,
  ResponsibilityUpdateResult,
} from "./responsibility";
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
  AdapterPairConfirmArgs,
  AdapterPairConfirmResult,
  AdapterPairDisconnectArgs,
  AdapterPairDisconnectResult,
  AdapterPairInfoArgs,
  AdapterPairInfoResult,
  AdapterPairInspectArgs,
  AdapterPairInspectResult,
  AdapterSendArgs,
  AdapterSendResult,
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
  AdapterStatusArgs,
  AdapterStatusResult,
} from "./adapter";
import type {
  SignalUnwatchArgs,
  SignalUnwatchResult,
  SignalWatchArgs,
  SignalWatchResult,
} from "./signal";
import type {
  MailSendArgs,
  MailSendResult,
  MailStatusArgs,
  MailStatusResult,
} from "./mail";
import type {
  ConversationForProcessArgs,
  ConversationForProcessResult,
  ConversationHistoryArgs,
  ConversationHistoryResult,
  ConversationShipArgs,
  ConversationShipResult,
  ConversationListArgs,
  ConversationListResult,
  ConversationMediaReadArgs,
  ConversationMediaReadResult,
  ConversationSendArgs,
  ConversationSendResult,
} from "./conversation";

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

  "net.fetch": { args: NetFetchArgs; result: NetFetchResult };

  "codemode.exec": { args: CodeModeExecArgs; result: CodeModeExecResult };
  "codemode.run": { args: CodeModeRunArgs; result: CodeModeRunResult };

  "mail.send": { args: MailSendArgs; result: MailSendResult };
  "mail.status": { args: MailStatusArgs; result: MailStatusResult };

  "conversation.ship": { args: ConversationShipArgs; result: ConversationShipResult };
  "conversation.forProcess": { args: ConversationForProcessArgs; result: ConversationForProcessResult };
  "conversation.list": { args: ConversationListArgs; result: ConversationListResult };
  "conversation.history": { args: ConversationHistoryArgs; result: ConversationHistoryResult };
  "conversation.send": { args: ConversationSendArgs; result: ConversationSendResult };
  "conversation.media.read": { args: ConversationMediaReadArgs; result: ConversationMediaReadResult };

  "proc.spawn": { args: ProcSpawnArgs; result: ProcSpawnResult };
  "proc.kill": { args: ProcKillArgs; result: ProcKillResult };
  "proc.list": { args: ProcListArgs; result: ProcListResult };
  "proc.observe": { args: ProcObserveArgs; result: ProcObserveResult };
  "proc.unobserve": { args: ProcUnobserveArgs; result: ProcUnobserveResult };
  "proc.send": { args: ProcSendArgs; result: ProcSendResult };
  "proc.ipc.send": { args: ProcIpcSendArgs; result: ProcIpcSendResult };
  "proc.ipc.call": { args: ProcIpcCallArgs; result: ProcIpcCallResult };
  "proc.ipc.deliver": { args: ProcIpcDeliverArgs; result: ProcIpcDeliverResult };
  "proc.abort": { args: ProcAbortArgs; result: ProcAbortResult };
  "proc.hil": { args: ProcHilArgs; result: ProcHilResult };
  "proc.history": { args: ProcHistoryArgs; result: ProcHistoryResult };
  "proc.history.policy.get": { args: ProcHistoryPolicyGetArgs; result: ProcHistoryPolicyGetResult };
  "proc.history.policy.set": { args: ProcHistoryPolicySetArgs; result: ProcHistoryPolicySetResult };
  "proc.history.compact": { args: ProcHistoryCompactArgs; result: ProcHistoryCompactResult };
  "proc.history.export": { args: ProcHistoryExportArgs; result: ProcHistoryExportResult };
  "proc.history.import": { args: ProcHistoryImportArgs; result: ProcHistoryImportResult };
  "proc.history.segment.read": { args: ProcHistorySegmentReadArgs; result: ProcHistorySegmentReadResult };
  "proc.history.segments": { args: ProcHistorySegmentsArgs; result: ProcHistorySegmentsResult };
  "proc.fork": { args: ProcForkArgs; result: ProcForkResult };
  "proc.ai.config.get": { args: ProcAiConfigGetArgs; result: ProcAiConfigGetResult };
  "proc.ai.config.set": { args: ProcAiConfigSetArgs; result: ProcAiConfigSetResult };
  "proc.reset": { args: ProcResetArgs; result: ProcResetResult };
  "proc.setidentity": { args: ProcSetIdentityArgs; result: ProcSetIdentityResult };

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
  "repo.visibility.set": { args: RepoVisibilitySetArgs; result: RepoVisibilitySetResult };

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
  "sys.oauth.device.start": { args: SysOAuthDeviceStartArgs; result: SysOAuthDeviceStartResult };
  "sys.oauth.device.poll": { args: SysOAuthDevicePollArgs; result: SysOAuthDevicePollResult };
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

  "r12y.list": { args: ResponsibilityListArgs; result: ResponsibilityListResult };
  "r12y.get": { args: ResponsibilityGetArgs; result: ResponsibilityGetResult };
  "r12y.create": { args: ResponsibilityCreateArgs; result: ResponsibilityCreateResult };
  "r12y.update": { args: ResponsibilityUpdateArgs; result: ResponsibilityUpdateResult };
  "r12y.changes": { args: ResponsibilityChangesArgs; result: ResponsibilityChangesResult };

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
  "adapter.pair.info": { args: AdapterPairInfoArgs; result: AdapterPairInfoResult };
  "adapter.pair.inspect": { args: AdapterPairInspectArgs; result: AdapterPairInspectResult };
  "adapter.pair.confirm": { args: AdapterPairConfirmArgs; result: AdapterPairConfirmResult };
  "adapter.pair.disconnect": { args: AdapterPairDisconnectArgs; result: AdapterPairDisconnectResult };

  "signal.watch": { args: SignalWatchArgs; result: SignalWatchResult };
  "signal.unwatch": { args: SignalUnwatchArgs; result: SignalUnwatchResult };
};

export type SyscallName = keyof SyscallDomains;
export type ArgsOf<S extends SyscallName> = SyscallDomains[S]["args"];
export type ResultOf<S extends SyscallName> = SyscallDomains[S]["result"];
