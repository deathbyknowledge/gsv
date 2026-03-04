import type { GsvConfig, PendingPair } from "../config";
import type { ChannelAccountStatus } from "../channel-interface";
import type { Gateway } from "../gateway/do";
import type {
  ResetPolicy,
  ResetResult,
  SessionPatchParams,
  SessionSettings,
  SessionStats,
  TokenUsage,
} from "../session";
import {
  ChannelInboundParams,
  ChannelRegistryEntry,
  ChannelId,
} from "./channel";
import type { RequestFrame } from "./frames";
import type { SessionRegistryEntry } from "./session";
import type {
  LogsGetParams,
  LogsGetResult,
  LogsResultParams,
} from "./logs";
import type { SkillsStatusResult, SkillsUpdateResult } from "./skills";
import type {
  ToolDefinition,
  NodeRuntimeInfo,
  NodeExecEventParams,
  ToolRequestParams,
  ToolResultParams,
} from "./tools";
import type {
  TransferMetaParams,
  TransferAcceptParams,
  TransferCompleteParams,
  TransferDoneParams,
} from "./transfer";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRun,
  CronRunResult,
} from "../cron";
import type {
  ConversationBinding,
  GroupMode,
  InviteRecord,
  PrincipalProfile,
  SpaceMember,
} from "../gateway/registry-store";

export const DEFER_RESPONSE = Symbol("defer-response");
export type DeferredResponse = typeof DEFER_RESPONSE;

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: "client" | "node" | "channel";
    channel?: ChannelId;
    accountId?: string;
  };
  tools?: ToolDefinition[];
  nodeRuntime?: NodeRuntimeInfo;
  auth?: {
    token?: string;
  };
};

export type ConnectResult = {
  type: "hello-ok";
  protocol: 1;
  server: {
    version: string;
    connectionId: string;
  };
  features: {
    methods: string[];
    events: string[];
  };
};

export type ToolInvokeParams = {
  tool: string;
  args?: Record<string, unknown>;
};

export type RpcMethods = {
  "connect": {
    params: ConnectParams;
    result: ConnectResult;
  };

  "tool.invoke": {
    params: ToolInvokeParams;
    result: never;
  };

  "tool.result": {
    params: ToolResultParams;
    result: { ok: true; dropped?: true };
  };

  "node.exec.event": {
    params: NodeExecEventParams;
    result: { ok: true; dropped?: true };
  };

  "logs.get": {
    params: LogsGetParams | undefined;
    result: LogsGetResult;
  };

  "logs.result": {
    params: LogsResultParams;
    result: { ok: true; dropped?: true };
  };

  "tools.list": {
    params: undefined;
    result: {
      tools: ToolDefinition[];
    };
  };

  "chat.send": {
    params: {
      sessionKey?: string;
      threadRef?: string;
      message: string;
      runId?: string;
    };
    result:
      | {
          status: "started";
          sessionKey: string;
          threadId?: string;
          stateId?: string;
          runId: string;
          queued?: false;
          directives?: {
            thinkLevel?: string;
            model?: { provider: string; id: string };
          };
        }
      | {
          status: "command";
          sessionKey: string;
          threadId?: string;
          stateId?: string;
          command: string;
          response?: string;
          error?: string;
        }
      | {
          status: "directive-only";
          sessionKey: string;
          threadId?: string;
          stateId?: string;
          response?: string;
          directives?: {
            thinkLevel?: string;
            model?: { provider: string; id: string };
          };
        }
      | {
          status: "paused";
          sessionKey: string;
          threadId?: string;
          stateId?: string;
          runId: string;
          response: string;
          approvalId?: string;
        };
  };

  "config.get": {
    params: { path?: string } | undefined;
    result: {
      path?: string;
      value?: unknown;
      config?: GsvConfig;
    };
  };

  "config.set": {
    params: { path: string; value: unknown };
    result: { ok: true; path: string };
  };

  "skills.status": {
    params: { agentId?: string } | undefined;
    result: SkillsStatusResult;
  };

  "skills.update": {
    params: { agentId?: string } | undefined;
    result: SkillsUpdateResult;
  };

  "session.stats": {
    params: { sessionKey?: string; threadRef?: string };
    result: SessionStats & { threadId?: string; stateId?: string };
  };

  "session.get": {
    params: { sessionKey?: string; threadRef?: string };
    result: {
      sessionId: string;
      sessionKey: string;
      threadId?: string;
      stateId?: string;
      createdAt: number;
      updatedAt: number;
      messageCount: number;
      tokens: TokenUsage;
      settings: SessionSettings;
      resetPolicy?: ResetPolicy;
      lastResetAt?: number;
      previousSessionIds: string[];
      label?: string;
    };
  };

  "session.patch": {
    params: SessionPatchParams & { sessionKey?: string; threadRef?: string };
    result: { ok: boolean };
  };

  "sessions.list": {
    params: { offset?: number; limit?: number } | undefined;
    result: { sessions: SessionRegistryEntry[]; count: number };
  };

  "session.reset": {
    params: { sessionKey?: string; threadRef?: string };
    result: ResetResult & { threadId?: string; stateId?: string };
  };

  "session.compact": {
    params: { sessionKey?: string; threadRef?: string; keepMessages?: number };
    result: {
      ok: boolean;
      sessionKey: string;
      threadId?: string;
      stateId?: string;
      trimmedMessages: number;
      keptMessages: number;
      archivedTo?: string;
    };
  };

  "session.history": {
    params: { sessionKey?: string; threadRef?: string };
    result: {
      sessionKey: string;
      threadId?: string;
      stateId?: string;
      currentSessionId: string;
      previousSessionIds: string[];
    };
  };

  "session.preview": {
    params: { sessionKey?: string; threadRef?: string; limit?: number };
    result: {
      sessionKey: string;
      threadId?: string;
      stateId?: string;
      sessionId: string;
      messageCount: number;
      messages: unknown[]; // TS2589
    };
  };

  "channels.list": {
    params: undefined;
    result: { channels: ChannelRegistryEntry[]; count: number };
  };

  "channel.inbound": {
    params: ChannelInboundParams;
    result: {
      status: string;
      sessionKey?: string;
      [key: string]: unknown;
    };
  };

  "channel.start": {
    params: {
      channel: string;
      accountId?: string;
      config?: Record<string, unknown>;
    };
    result: { ok: true; channel: ChannelId; accountId: string };
  };

  "channel.stop": {
    params: { channel: string; accountId?: string };
    result: { ok: true; channel: ChannelId; accountId: string };
  };

  "channel.status": {
    params: { channel: string; accountId?: string };
    result: { channel: ChannelId; accounts: ChannelAccountStatus[] };
  };

  "channel.login": {
    params: { channel: string; accountId?: string; force?: boolean };
    result: {
      ok: true;
      channel: ChannelId;
      accountId: string;
      qrDataUrl?: string;
      message: string;
    };
  };

  "channel.logout": {
    params: { channel: string; accountId?: string };
    result: { ok: true; channel: ChannelId; accountId: string };
  };

  "heartbeat.status": {
    params: undefined;
    result: { agents: Record<string, unknown> };
  };

  "heartbeat.start": {
    params: undefined;
    result: { message: string; agents: Record<string, unknown> };
  };

  "heartbeat.trigger": {
    params: { agentId?: string } | undefined;
    result: {
      ok: boolean;
      message: string;
      skipped?: boolean;
      skipReason?: string;
    };
  };

  "cron.status": {
    params: undefined;
    result: {
      enabled: boolean;
      count: number;
      dueCount: number;
      runningCount: number;
      nextRunAtMs?: number;
      maxJobs: number;
      maxConcurrentRuns: number;
    };
  };

  "cron.list": {
    params:
      | {
          agentId?: string;
          includeDisabled?: boolean;
          limit?: number;
          offset?: number;
        }
      | undefined;
    result: { jobs: CronJob[]; count: number };
  };

  "cron.add": {
    params: CronJobCreate;
    result: { ok: true; job: CronJob };
  };

  "cron.update": {
    params: { id: string; patch: CronJobPatch };
    result: { ok: true; job: CronJob };
  };

  "cron.remove": {
    params: { id: string };
    result: { ok: true; removed: boolean };
  };

  "cron.run": {
    params:
      | {
          id?: string;
          mode?: "due" | "force";
        }
      | undefined;
    result: { ok: true; ran: number; results: CronRunResult[] };
  };

  "cron.runs": {
    params:
      | {
          jobId?: string;
          limit?: number;
          offset?: number;
        }
      | undefined;
    result: { runs: CronRun[]; count: number };
  };

  "pair.list": {
    params: undefined;
    result: { pairs: Record<string, PendingPair> };
  };

  "pair.approve": {
    params: { channel: string; senderId: string };
    result: {
      approved: true;
      senderId: string;
      senderName?: string;
      requiresBinding?: boolean;
    };
  };

  "pair.reject": {
    params: { channel: string; senderId: string };
    result: { rejected: true; senderId: string };
  };

  "principal.profile.get": {
    params: { principalId: string };
    result: { principalId: string; profile?: PrincipalProfile };
  };

  "principal.profile.list": {
    params: { offset?: number; limit?: number } | undefined;
    result: {
      profiles: Array<{ principalId: string; profile: PrincipalProfile }>;
      count: number;
    };
  };

  "principal.profile.put": {
    params: {
      principalId: string;
      homeSpaceId: string;
      homeAgentId?: string;
      status?: "bound" | "allowed_unbound";
    };
    result: {
      ok: true;
      principalId: string;
      profile: PrincipalProfile;
    };
  };

  "principal.profile.delete": {
    params: { principalId: string };
    result: { ok: true; principalId: string; removed: boolean };
  };

  "space.members.list": {
    params: { spaceId?: string; offset?: number; limit?: number } | undefined;
    result: {
      members: Array<{ spaceId: string; principalId: string; member: SpaceMember }>;
      count: number;
    };
  };

  "space.member.put": {
    params: { spaceId: string; principalId: string; role: string };
    result: {
      ok: true;
      spaceId: string;
      principalId: string;
      member: SpaceMember;
    };
  };

  "space.member.remove": {
    params: { spaceId: string; principalId: string };
    result: { ok: true; spaceId: string; principalId: string; removed: boolean };
  };

  "conversation.bindings.list": {
    params: { offset?: number; limit?: number } | undefined;
    result: {
      bindings: Array<{ surfaceId: string; binding: ConversationBinding }>;
      count: number;
    };
  };

  "conversation.binding.put": {
    params: {
      surfaceId: string;
      spaceId: string;
      agentId?: string;
      groupMode?: GroupMode;
    };
    result: {
      ok: true;
      surfaceId: string;
      binding: ConversationBinding;
    };
  };

  "conversation.binding.remove": {
    params: { surfaceId: string };
    result: { ok: true; surfaceId: string; removed: boolean };
  };

  "invite.create": {
    params: {
      code?: string;
      homeSpaceId: string;
      homeAgentId?: string;
      role?: string;
      principalId?: string;
      ttlMinutes?: number;
    };
    result: {
      ok: true;
      invite: InviteRecord;
    };
  };

  "invite.list": {
    params:
      | {
          offset?: number;
          limit?: number;
          includeInactive?: boolean;
        }
      | undefined;
    result: {
      invites: Array<{ inviteId: string; invite: InviteRecord }>;
      count: number;
    };
  };

  "invite.revoke": {
    params: { inviteId: string };
    result: {
      ok: true;
      inviteId: string;
      revoked: boolean;
      invite?: InviteRecord;
    };
  };

  "invite.claim": {
    params: {
      code: string;
      principalId?: string;
      channel?: string;
      accountId?: string;
      senderId?: string;
    };
    result: {
      ok: true;
      inviteId: string;
      code: string;
      principalId: string;
      homeSpaceId: string;
      homeAgentId?: string;
      role: string;
    };
  };

  "pending.bindings.list": {
    params: undefined;
    result: {
      pending: Array<{ key: string; pair: PendingPair }>;
      count: number;
    };
  };

  "pending.binding.resolve": {
    params: {
      channel: string;
      senderId: string;
      action: "approve" | "reject";
      accountId?: string;
      principalId?: string;
      homeSpaceId?: string;
      homeAgentId?: string;
      role?: string;
    };
    result: {
      ok: true;
      action: "approve" | "reject";
      senderId: string;
      accountId?: string;
      principalId?: string;
      homeSpaceId?: string;
      role?: string;
    };
  };

  "registry.backfill": {
    params:
      | {
          dryRun?: boolean;
          limit?: number;
        }
      | undefined;
    result: {
      ok: true;
      dryRun: boolean;
      scanned: number;
      migrated: number;
      createdThreadMeta: number;
      updatedSessions: number;
      addedLegacyIndex: number;
      skipped: number;
    };
  };

  "registry.repair": {
    params:
      | {
          dryRun?: boolean;
          pruneDanglingRoutes?: boolean;
          pruneDanglingLegacyIndex?: boolean;
        }
      | undefined;
    result: {
      ok: true;
      dryRun: boolean;
      scannedSessions: number;
      scannedThreadRoutes: number;
      scannedLegacyIndex: number;
      createdThreadMeta: number;
      updatedSessions: number;
      addedLegacyIndex: number;
      removedDanglingRoutes: number;
      removedDanglingLegacyIndex: number;
    };
  };

  "workspace.list": {
    params: { path?: string; agentId?: string; spaceId?: string };
    result: {
      path: string;
      files: string[];
      directories: string[];
    };
  };

  "workspace.read": {
    params: { path: string; agentId?: string; spaceId?: string };
    result: {
      path: string;
      content: string;
      size: number;
      lastModified?: string;
    };
  };

  "workspace.write": {
    params: { path: string; content: string; agentId?: string; spaceId?: string };
    result: {
      path: string;
      size: number;
      written: true;
    };
  };

  "workspace.delete": {
    params: { path: string; agentId?: string; spaceId?: string };
    result: {
      path: string;
      deleted: true;
    };
  };

  "tool.request": {
    params: ToolRequestParams;
    result: {
      status: "sent";
    };
  };

  "node.forget": {
    params: { nodeId: string; force?: boolean };
    result: { ok: true; nodeId: string; removed: boolean; disconnected: boolean };
  };

  "transfer.meta": {
    params: TransferMetaParams;
    result: { ok: true };
  };

  "transfer.accept": {
    params: TransferAcceptParams;
    result: { ok: true };
  };

  "transfer.complete": {
    params: TransferCompleteParams;
    result: { ok: true };
  };

  "transfer.done": {
    params: TransferDoneParams;
    result: { ok: true };
  };
};

export type RpcMethod = keyof RpcMethods;
export type DeferrableMethod = "tool.invoke" | "logs.get";
export type ParamsOf<M extends RpcMethod> = RpcMethods[M]["params"];
export type ResultOf<M extends RpcMethod> = RpcMethods[M]["result"];
export type HandlerResult<M extends RpcMethod> =
  | ResultOf<M>
  | (M extends DeferrableMethod ? DeferredResponse : never);
export type HandlerContext<M extends RpcMethod> = {
  gw: Gateway;
  ws: WebSocket;
  frame: RequestFrame<M, ParamsOf<M>>;
  params: ParamsOf<M>;
};

export type Handler<M extends RpcMethod> = (
  ctx: HandlerContext<M>,
) => Promise<HandlerResult<M>> | HandlerResult<M>;
