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
import type {
  ToolDefinition,
  NodeRuntimeInfo,
  ToolRequestParams,
  ToolResultParams,
} from "./tools";

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
    params: { sessionKey: string; message: string; runId?: string };
    result:
      | {
          status: "started";
          runId: string;
          queued?: false;
          directives?: {
            thinkLevel?: string;
            model?: { provider: string; id: string };
          };
        }
      | {
          status: "command";
          command: string;
          response?: string;
          error?: string;
        }
      | {
          status: "directive-only";
          response?: string;
          directives?: {
            thinkLevel?: string;
            model?: { provider: string; id: string };
          };
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

  "session.stats": {
    params: { sessionKey: string };
    result: SessionStats;
  };

  "session.get": {
    params: { sessionKey: string };
    result: {
      sessionId: string;
      sessionKey: string;
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
    params: SessionPatchParams & { sessionKey: string };
    result: { ok: boolean };
  };

  "sessions.list": {
    params: { offset?: number; limit?: number } | undefined;
    result: { sessions: SessionRegistryEntry[]; count: number };
  };

  "session.reset": {
    params: { sessionKey: string };
    result: ResetResult;
  };

  "session.compact": {
    params: { sessionKey: string; keepMessages?: number };
    result: {
      ok: boolean;
      trimmedMessages: number;
      keptMessages: number;
      archivedTo?: string;
    };
  };

  "session.history": {
    params: { sessionKey: string };
    result: {
      sessionKey: string;
      currentSessionId: string;
      previousSessionIds: string[];
    };
  };

  "session.preview": {
    params: { sessionKey: string; limit?: number };
    result: {
      sessionKey: string;
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

  "pair.list": {
    params: undefined;
    result: { pairs: Record<string, PendingPair> };
  };

  "pair.approve": {
    params: { channel: string; senderId: string };
    result: { approved: true; senderId: string; senderName?: string };
  };

  "pair.reject": {
    params: { channel: string; senderId: string };
    result: { rejected: true; senderId: string };
  };

  "tool.request": {
    params: ToolRequestParams;
    result: {
      status: "sent";
    };
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
