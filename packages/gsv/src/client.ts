import type {
  ArgsOf,
  BinaryBody,
  BodySyscallName,
  ConnectArgs,
  ConnectResult,
  ResultOf,
  SyscallName,
} from "./protocol";
import type { JsonValue } from "./protocol/json";
import { jsonValueSchema } from "./protocol/json";
import {
  REQUEST_CANCEL_SIGNAL,
} from "./protocol/request-cancel";
import type { BinaryFrameDescriptor } from "./protocol/binary-frame";
import {
  wireFrameSchemas,
  type FrameEnvelope,
  type FrameError,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ResponseErrEnvelope,
  type ResponseOkEnvelope,
  type SignalEnvelope,
} from "./protocol/frame";
import {
  BinaryBodyChannel,
  type OutgoingBinaryBody,
} from "./protocol/binary-body-channel";
import * as z from "zod/mini";

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

function serializeOutgoingArguments(args: GsvOutgoingArguments): JsonValue {
  const serialized = JSON.stringify(args);
  if (serialized === undefined) {
    throw new Error("Request arguments are not JSON serializable");
  }
  return jsonValueSchema.parse(JSON.parse(serialized));
}

type PendingRequest = {
  resolve: (value: GsvResponse<JsonValue>) => void;
  reject: (error: Error) => void;
  timeoutId: TimerHandle | null;
  call: string;
  bodyAbort?: AbortController;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
};

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

type SyscallArgsTuple<S extends SyscallName> = {} extends ArgsOf<S>
  ? [args?: ArgsOf<S>]
  : [args: ArgsOf<S>];

type NamespaceSyscall = Exclude<
  SyscallName,
  BodySyscallName
>;

type NamespaceEntry<Full extends NamespaceSyscall, Path extends string> = Path extends `${infer Head}.${infer Tail}`
  ? { [Key in Head]: NamespaceEntry<Full, Tail> }
  : { [Key in Path]: GsvSyscallMethod<Full> };

export type GsvSyscallMethod<S extends SyscallName> = (
  ...args: SyscallArgsTuple<S>
) => Promise<ResultOf<S>>;

export type GsvClientNamespaces = UnionToIntersection<{
  [S in NamespaceSyscall]: NamespaceEntry<S, S>;
}[NamespaceSyscall]>;

export type GsvClientCall = {
  <S extends NamespaceSyscall>(call: S, ...args: SyscallArgsTuple<S>): Promise<ResultOf<S>>;
  <T = JsonValue>(call: string, args?: GsvRequestArguments): Promise<T>;
};

export type GsvRequestArguments = {
  readonly [name: string]: JsonValue | undefined;
};

export type GsvPeerInfo = ConnectArgs["peer"];

export type GsvBody = BinaryBody;

export type GsvRequestOptions = {
  body?: GsvBody;
  signal?: AbortSignal;
};

export type GsvResponse<T = JsonValue> = {
  data: T;
  body?: GsvBody;
};

export type GsvBodyOptions = {
  receiveTimeoutMs?: number;
  chunkSize?: number;
};

export type GsvInboundRequestHandler = (
  frame: RequestEnvelope<BinaryFrameDescriptor>,
  body?: GsvBody,
  abortSignal?: AbortSignal,
) => Promise<GsvResponse> | GsvResponse;

export type GsvEndpointPattern = SyscallName | `${string}.*`;

export type GsvEndpointRequest<S extends string = string> = {
  id: string;
  call: S;
  args: S extends SyscallName ? ArgsOf<S> : JsonValue;
  body?: GsvBody;
  raw: RequestEnvelope<BinaryFrameDescriptor, S>;
};

export type GsvEndpointContext = {
  client: GSVClient;
  connection: ConnectResult;
  abortSignal: AbortSignal;
  sendSignal(signal: string, payload?: JsonValue, seq?: number): void;
};

export type GsvEndpointHandler<S extends string = string> = (
  request: GsvEndpointRequest<S>,
  context: GsvEndpointContext,
) => Promise<GsvResponse<S extends SyscallName ? ResultOf<S> : JsonValue>>
  | GsvResponse<S extends SyscallName ? ResultOf<S> : JsonValue>;

type GsvEndpointAcknowledgementOptions = {
  signal?: string;
  timeoutMs?: number;
};

export type GsvEndpointOptions = {
  peerId?: string;
  platform?: string;
  version?: string;
  implements?: GsvEndpointPattern[];
  keepalive?: false | {
    intervalMs?: number;
    signal?: string;
    payload?: (nonce?: string) => JsonValue;
    acknowledgement?: false | GsvEndpointAcknowledgementOptions;
  };
};

export type GsvEndpointConnectOptions = Omit<GsvConnectOptions, "peer"> & {
  peerId?: string;
  platform?: string;
  version?: string;
  implements?: GsvEndpointPattern[];
};

export type GsvConnectOptions = {
  url?: string;
  username?: string;
  password?: string;
  token?: string;
  peer?: Partial<GsvPeerInfo>;
};

export type GsvClientStatus = {
  state: "disconnected" | "connecting" | "connected";
  url: string | null;
  username: string | null;
  connectionId: string | null;
  message: string | null;
};

export type GsvWebSocketConstructor = new (url: string | URL, protocols?: string | string[]) => WebSocket;

export type GsvClientOptions = GsvConnectOptions & {
  WebSocket?: GsvWebSocketConstructor;
  connectTimeoutMs?: number;
  defaultRequestTimeoutMs?: number;
  requestTimeoutsMs?: Record<string, number>;
  body?: GsvBodyOptions;
};

type GsvRequestTimeoutMap = { [call: string]: number };
type GsvNamespaceContainer = { [name: string]: GsvNamespaceContainer };
type GsvNamespaceTarget = { call: GsvClientCall };
type GsvSocketMessage = string | ArrayBuffer | ArrayBufferView | Blob;
type GsvHeartbeatPayload = { at: number; nonce?: string };
type GsvOutgoingArguments = ArgsOf<SyscallName> | GsvRequestArguments;
type GsvMergedConnectOptions = Omit<GsvConnectOptions, "peer"> & {
  peer: GsvPeerInfo;
};

const shellExecTimeoutArgumentsSchema = z.looseObject({
  timeout: z.optional(z.number().check(z.positive())),
});
const shellExecSessionArgumentsSchema = z.looseObject({
  sessionId: z.string(),
});
const shellExecPollingArgumentsSchema = z.looseObject({
  yieldMs: z.optional(z.number().check(z.positive())),
});
const requestCancelPayloadSchema = z.strictObject({
  id: z.string(),
  reason: z.optional(z.string()),
});
const acknowledgementPayloadSchema = z.looseObject({ nonce: z.string() });

export type GsvAccountNamespace = GsvClientNamespaces["account"];
export type GsvAdapterNamespace = GsvClientNamespaces["adapter"];
export type GsvAiNamespace = GsvClientNamespaces["ai"];
export type GsvCodeModeNamespace = GsvClientNamespaces["codemode"];
export type GsvConversationNamespace = GsvClientNamespaces["conversation"];
export type GsvContactNamespace = GsvClientNamespaces["contact"];
export type GsvFsNamespace = GsvClientNamespaces["fs"];
export type GsvMailNamespace = GsvClientNamespaces["mail"];
export type GsvNetNamespace = never;
export type GsvProcNamespace = GsvClientNamespaces["proc"];
export type GsvR12yNamespace = GsvClientNamespaces["r12y"];
export type GsvRepoNamespace = GsvClientNamespaces["repo"];
export type GsvSchedNamespace = GsvClientNamespaces["sched"];
export type GsvShellNamespace = GsvClientNamespaces["shell"];
export type GsvSignalNamespace = GsvClientNamespaces["signal"];
export type GsvSysNamespace = GsvClientNamespaces["sys"];

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const PROTOCOL_VERSION = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 120_000;
const AI_TEXT_GENERATION_REQUEST_TIMEOUT_MS = 180_000;
const SHELL_EXEC_RESPONSE_GRACE_MS = 10_000;
const DEFAULT_ENDPOINT_KEEPALIVE_MS = 240_000;
const DEFAULT_ENDPOINT_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;

const DEFAULT_REQUEST_TIMEOUTS_MS = {
  "sys.setup": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "sys.setup.assist": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "sys.bootstrap": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "fs.copy": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "fs.transfer.stat": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "fs.transfer.send": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "fs.transfer.receive": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "net.fetch": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.text.generate": AI_TEXT_GENERATION_REQUEST_TIMEOUT_MS,
  "ai.transcription.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.image.read": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.image.generate": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.speech.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
} satisfies GsvRequestTimeoutMap;

const DEFAULT_PEER_INFO: GsvPeerInfo = {
  id: "gsv-js",
  version: "0.0.6",
  platform: "javascript",
};

const SYSCALL_NAMES = [
  "fs.write",
  "fs.edit",
  "fs.delete",
  "fs.search",
  "fs.copy",
  "fs.transfer.stat",
  "shell.exec",
  "codemode.exec",
  "codemode.run",
  "mail.send",
  "mail.status",
  "conversation.ship",
  "conversation.forProcess",
  "conversation.list",
  "conversation.history",
  "conversation.send",
  "contact.identity",
  "contact.invite.create",
  "contact.invite.accept",
  "contact.invite.list",
  "contact.invite.cancel",
  "contact.list",
  "contact.alias.set",
  "contact.revoke",
  "contact.send",
  "contact.delivery.get",
  "contact.request.list",
  "contact.request.create",
  "contact.request.update",
  "proc.spawn",
  "proc.kill",
  "proc.list",
  "proc.observe",
  "proc.unobserve",
  "proc.send",
  "proc.ipc.send",
  "proc.ipc.call",
  "proc.ipc.deliver",
  "proc.abort",
  "proc.hil",
  "proc.history",
  "proc.trace",
  "proc.history.policy.get",
  "proc.history.policy.set",
  "proc.history.compact",
  "proc.history.export",
  "proc.history.import",
  "proc.history.segment.read",
  "proc.history.segments",
  "proc.fork",
  "proc.ai.config.get",
  "proc.ai.config.set",
  "proc.reset",
  "proc.setidentity",
  "repo.list",
  "repo.create",
  "repo.refs",
  "repo.read",
  "repo.search",
  "repo.log",
  "repo.diff",
  "repo.compare",
  "repo.apply",
  "repo.import",
  "repo.delete",
  "repo.visibility.set",
  "sys.connect",
  "sys.setup.assist",
  "sys.setup",
  "sys.bootstrap",
  "sys.config.get",
  "sys.config.set",
  "sys.target.list",
  "sys.target.get",
  "sys.target.update",
  "sys.target.delete",
  "sys.oauth.start",
  "sys.oauth.device.start",
  "sys.oauth.device.poll",
  "sys.oauth.list",
  "sys.oauth.forget",
  "sys.mcp.add",
  "sys.mcp.list",
  "sys.mcp.remove",
  "sys.mcp.refresh",
  "sys.mcp.call",
  "sys.token.create",
  "sys.token.list",
  "sys.token.revoke",
  "sys.link",
  "sys.unlink",
  "sys.link.list",
  "sys.link.consume",
  "account.create",
  "account.list",
  "sched.list",
  "sched.add",
  "sched.update",
  "sched.remove",
  "sched.run",
  "r12y.list",
  "r12y.get",
  "r12y.create",
  "r12y.update",
  "r12y.changes",
  "r12y.source.list",
  "r12y.source.update",
  "ai.tools",
  "ai.context",
  "ai.config",
  "ai.models",
  "ai.text.generate",
  "adapter.connect",
  "adapter.disconnect",
  "adapter.state.update",
  "adapter.status",
  "adapter.list",
  "adapter.pair.info",
  "adapter.pair.inspect",
  "adapter.pair.confirm",
  "adapter.pair.disconnect",
  "signal.watch",
  "signal.unwatch",
] as const satisfies readonly NamespaceSyscall[];

type MissingSyscalls = Exclude<NamespaceSyscall, typeof SYSCALL_NAMES[number]>;
const allSyscallsCovered: MissingSyscalls extends never ? true : never = true;
void allSyscallsCovered;

export class GsvClientError extends Error {
  readonly code?: number;
  readonly details?: JsonValue;
  readonly retryable?: boolean;

  constructor(error: FrameError) {
    super(error.message);
    this.name = "GsvClientError";
    this.code = error.code;
    this.details = error.details;
    this.retryable = error.retryable;
  }
}

export class GsvRequestError extends Error {
  readonly code: number;
  readonly details?: JsonValue;
  readonly retryable?: boolean;

  constructor(code: number, message: string, options: { details?: JsonValue; retryable?: boolean } = {}) {
    super(message);
    this.name = "GsvRequestError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable;
  }
}

export class GSVClient {
  declare readonly account: GsvAccountNamespace;
  declare readonly adapter: GsvAdapterNamespace;
  declare readonly ai: GsvAiNamespace;
  declare readonly codemode: GsvCodeModeNamespace;
  declare readonly conversation: GsvConversationNamespace;
  declare readonly contact: GsvContactNamespace;
  declare readonly fs: GsvFsNamespace;
  declare readonly mail: GsvMailNamespace;
  declare readonly proc: GsvProcNamespace;
  declare readonly r12y: GsvR12yNamespace;
  declare readonly repo: GsvRepoNamespace;
  declare readonly sched: GsvSchedNamespace;
  declare readonly shell: GsvShellNamespace;
  declare readonly signal: GsvSignalNamespace;
  declare readonly sys: GsvSysNamespace;
  readonly call: GsvClientCall;

  private readonly WebSocketCtor: GsvWebSocketConstructor | null;
  private readonly connectDefaults: GsvConnectOptions;
  private readonly connectTimeoutMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly requestTimeoutsMs: GsvRequestTimeoutMap;
  private readonly bodyChannel: BinaryBodyChannel;
  private socket: WebSocket | null = null;
  private connectingSocket: WebSocket | null = null;
  private socketEpoch = 0;
  private pending = new Map<string, PendingRequest>();
  private inboundRequests = new Map<string, AbortController>();
  private inboundRequestHandler: GsvInboundRequestHandler | null = null;
  private signalListeners = new Set<(signal: string, payload: JsonValue | undefined) => void>();
  private statusListeners = new Set<(status: GsvClientStatus) => void>();
  private status: GsvClientStatus = {
    state: "disconnected",
    url: null,
    username: null,
    connectionId: null,
    message: null,
  };

  constructor(options: GsvClientOptions = {}) {
    const {
      WebSocket: WebSocketCtor,
      connectTimeoutMs,
      defaultRequestTimeoutMs,
      requestTimeoutsMs,
      body,
      ...connectDefaults
    } = options;

    this.WebSocketCtor = WebSocketCtor ?? null;
    this.connectDefaults = connectDefaults;
    this.connectTimeoutMs = connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.defaultRequestTimeoutMs = defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.requestTimeoutsMs = {
      ...DEFAULT_REQUEST_TIMEOUTS_MS,
      ...requestTimeoutsMs,
    };
    this.bodyChannel = new BinaryBodyChannel({
      chunkBytes: body?.chunkSize,
      idleTimeoutMs: body?.receiveTimeoutMs,
      sendFrame: (frame) => {
        const socket = this.socket;
        if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
          throw new Error("Not connected");
        }
        socket.send(frame);
      },
    });
    // SAFETY: the implementation forwards the exact syscall name and returns
    // the protocol-declared result selected by the public overload.
    this.call = (async (call: string, args: GsvRequestArguments = {}) => {
      const response = await this.request(call, args);
      if (response.body) {
        await response.body.stream.cancel().catch(() => {});
        throw new Error(`${call} returned a body; use client.request()`);
      }
      return response.data;
    }) as GsvClientCall;
    assignNamespaces(this, this.call);
  }

  getStatus(): GsvClientStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status.state === "connected" && this.socket?.readyState === WEBSOCKET_OPEN;
  }

  onSignal(listener: (signal: string, payload: JsonValue | undefined) => void): () => void {
    this.signalListeners.add(listener);
    return () => {
      this.signalListeners.delete(listener);
    };
  }

  onStatus(listener: (status: GsvClientStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onRequest(handler: GsvInboundRequestHandler): () => void {
    if (this.inboundRequestHandler) {
      throw new Error("A GSV request handler is already registered");
    }
    this.inboundRequestHandler = handler;
    return () => {
      if (this.inboundRequestHandler === handler) {
        this.inboundRequestHandler = null;
      }
    };
  }

  endpoint(options: GsvEndpointOptions = {}): GSVEndpoint {
    return new GSVEndpoint(this, options);
  }

  sendSignal(signal: string, payload?: JsonValue, seq?: number): void {
    const frame: SignalEnvelope = {
      type: "sig",
      signal,
    };
    if (payload !== undefined) frame.payload = payload;
    if (seq !== undefined) frame.seq = seq;
    this.sendJson(frame);
  }

  async connect(options: GsvConnectOptions = {}): Promise<ConnectResult> {
    const merged = this.mergeConnectOptions(options);
    const url = merged.url?.trim() ?? "";
    const username = merged.username?.trim() ?? "";
    const password = merged.password?.trim() ?? "";
    const token = merged.token?.trim() ?? "";

    if (!url) {
      throw new Error("Gateway URL is required");
    }
    if (!username) {
      throw new Error("Username is required");
    }
    if (!password && !token) {
      throw new Error("Password or token is required");
    }
    if (password && token) {
      throw new Error("Use either password or token");
    }

    this.disconnect();
    const socketEpoch = ++this.socketEpoch;
    this.setStatus({
      state: "connecting",
      url,
      username,
      connectionId: null,
      message: "Opening WebSocket...",
    });

    let socket: WebSocket;
    try {
      socket = await this.openSocket(url, true);
    } catch (error) {
      if (this.socketEpoch === socketEpoch) {
        this.setStatus({
          state: "disconnected",
          url,
          username,
          connectionId: null,
          message: errorMessage(error, "WebSocket connection failed"),
        });
      }
      throw error;
    }

    if (this.socketEpoch !== socketEpoch) {
      closeSocket(socket, 1000, "connection cancelled");
      throw new Error("Connection cancelled");
    }

    this.socket = socket;
    this.attachSocket(socket);

    let connectResult: ConnectResult;
    try {
      const connectArgs: ConnectArgs = {
        protocol: PROTOCOL_VERSION,
        peer: merged.peer,
        auth: {
          username,
          ...(token ? { token } : { password }),
        },
      };
      connectResult = (await this.request("sys.connect", connectArgs)).data;
      if (connectResult.protocol !== PROTOCOL_VERSION) {
        throw new Error(
          `Gateway selected protocol ${connectResult.protocol}, expected ${PROTOCOL_VERSION}`,
        );
      }
    } catch (error) {
      if (this.socketEpoch === socketEpoch) {
        this.disconnect();
      }
      throw error;
    }

    if (this.socketEpoch !== socketEpoch || this.socket !== socket) {
      closeSocket(socket, 1000, "connection cancelled");
      throw new Error("Connection cancelled");
    }

    this.setStatus({
      state: "connected",
      url,
      username,
      connectionId: connectResult.server.connectionId,
      message: null,
    });

    return connectResult;
  }

  disconnect(reason = "client disconnect"): void {
    this.socketEpoch += 1;
    const connectingSocket = this.connectingSocket;
    this.connectingSocket = null;
    const socket = this.socket;
    this.socket = null;

    if (connectingSocket) {
      closeSocket(connectingSocket, 1000, reason);
    }
    if (socket) {
      closeSocket(socket, 1000, reason);
    }

    const error = new Error("Disconnected");
    this.rejectAllPending(error);
    this.abortAllInbound(error);
    this.bodyChannel.close(error);
    this.setStatus({
      state: "disconnected",
      url: null,
      username: null,
      connectionId: null,
      message: reason === "client disconnect" ? null : reason,
    });
  }

  close(): void {
    this.disconnect();
  }

  async request<S extends SyscallName>(
    call: S,
    args: ArgsOf<S>,
    options?: GsvRequestOptions,
  ): Promise<GsvResponse<ResultOf<S>>>;
  async request<T = JsonValue>(
    call: string,
    args?: GsvRequestArguments,
    options?: GsvRequestOptions,
  ): Promise<GsvResponse<T>>;
  async request<T = JsonValue>(
    call: string,
    args: GsvOutgoingArguments = {},
    options: GsvRequestOptions = {},
  ): Promise<GsvResponse<T>> {
    if (options.signal?.aborted) {
      const error = requestAbortError(options.signal);
      void options.body?.stream.cancel(error).catch(() => {});
      throw error;
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("Not connected");
    }
    const response = await this.requestFrame(socket, call, args, options);
    // SAFETY: the call overload binds T to the caller's protocol contract;
    // requestFrame has already validated the JSON response envelope.
    return response as GsvResponse<T>;
  }

  async requestOnce<S extends NamespaceSyscall>(
    url: string,
    call: S,
    ...args: SyscallArgsTuple<S>
  ): Promise<ResultOf<S>>;
  async requestOnce<T = JsonValue>(
    url: string,
    call: string,
    args?: GsvRequestArguments,
  ): Promise<T>;
  async requestOnce<T = JsonValue>(
    url: string,
    call: string,
    args: GsvOutgoingArguments = {},
  ): Promise<T> {
    const socket = await this.openSocket(url);
    try {
      return await this.requestOverSocket<T>(socket, call, args);
    } finally {
      closeSocket(socket, 1000, "request complete");
    }
  }

  private mergeConnectOptions(options: GsvConnectOptions): GsvMergedConnectOptions {
    const defaults = this.connectDefaults.peer;
    const override = options.peer;
    const peer: GsvPeerInfo = {
      id: override?.id ?? defaults?.id ?? DEFAULT_PEER_INFO.id,
      version: override?.version ?? defaults?.version ?? DEFAULT_PEER_INFO.version,
      platform: override?.platform ?? defaults?.platform ?? DEFAULT_PEER_INFO.platform,
    };
    const implementsList = override?.implements ?? defaults?.implements;
    if (implementsList !== undefined) peer.implements = implementsList;
    return {
      ...this.connectDefaults,
      ...options,
      peer,
    };
  }

  private setStatus(next: GsvClientStatus): void {
    this.status = next;
    for (const listener of this.statusListeners) {
      listener(next);
    }
  }

  private attachSocket(socket: WebSocket): void {
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) {
        return;
      }
      void this.handleRawMessage(event.data).catch(() => {});
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      const error = new Error("Connection closed");
      this.rejectAllPending(error);
      this.abortAllInbound(error);
      this.bodyChannel.close(error);
      this.setStatus({
        state: "disconnected",
        url: this.status.url,
        username: this.status.username,
        connectionId: null,
        message: "Connection closed",
      });
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      closeSocket(socket, 1000, "WebSocket error");
      const error = new Error("WebSocket error");
      this.rejectAllPending(error);
      this.abortAllInbound(error);
      this.bodyChannel.close(error);
      this.setStatus({
        state: "disconnected",
        url: this.status.url,
        username: this.status.username,
        connectionId: null,
        message: error.message,
      });
    });
  }

  private async openSocket(url: string, trackConnection = false): Promise<WebSocket> {
    const WebSocketCtor = this.WebSocketCtor ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket is not available; pass a WebSocket constructor to GSVClient");
    }

    const socket = new WebSocketCtor(url);
    socket.binaryType = "arraybuffer";
    if (trackConnection) {
      this.connectingSocket = socket;
    }

    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error("WebSocket connect timed out"));
      }, this.connectTimeoutMs);

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("WebSocket connection failed"));
      };

      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("WebSocket closed during connect"));
      };

      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
    try {
      await opened;
    } catch (error) {
      closeSocket(socket, 1000, "connection failed");
      throw error;
    } finally {
      if (this.connectingSocket === socket) {
        this.connectingSocket = null;
      }
    }

    return socket;
  }

  private requestFrame(
    socket: WebSocket,
    call: string,
    args: GsvOutgoingArguments,
    options: GsvRequestOptions = {},
  ): Promise<GsvResponse<JsonValue>> {
    const id = makeId();
    const body = options.body;
    const signal = options.signal;
    const wireArgs = serializeOutgoingArguments(args);
    const outgoing = body ? this.bodyChannel.prepare(body) : undefined;
    const frame: RequestEnvelope<BinaryFrameDescriptor> = {
      type: "req",
      id,
      call,
      args: wireArgs,
    };
    if (outgoing) frame.body = outgoing.descriptor;
    const timeoutMs = this.requestTimeoutMs(call, wireArgs);
    const bodyAbort = body ? new AbortController() : undefined;

    return new Promise((resolve, reject) => {
      const cancelPending = (error: Error): void => {
        const pending = this.takePending(id);
        if (!pending) {
          return;
        }
        try {
          socket.send(JSON.stringify({
            type: "sig",
            signal: REQUEST_CANCEL_SIGNAL,
            payload: { id, reason: error.message },
          } satisfies SignalEnvelope));
        } catch {}
        pending.bodyAbort?.abort(error);
        void outgoing?.cancel(error);
        pending.reject(error);
      };
      const timeoutId = timeoutMs === null
        ? null
        : globalThis.setTimeout(() => {
          const error = new Error(`Request timed out after ${timeoutMs}ms: ${call}`);
          cancelPending(error);
        }, timeoutMs);

      const pending: PendingRequest = {
        resolve,
        reject,
        timeoutId,
        call,
        bodyAbort,
        abortSignal: signal,
      };
      this.pending.set(id, pending);
      if (signal) {
        const abortListener = () => cancelPending(requestAbortError(signal));
        pending.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          return;
        }
      }

      try {
        socket.send(JSON.stringify(frame));
        if (!this.pending.has(id)) {
          return;
        }
        if (outgoing) {
          void outgoing.send(bodyAbort?.signal).catch((error) => {
            const pending = this.takePending(id);
            if (!pending) {
              return;
            }
            pending.bodyAbort?.abort(error);
            pending.reject(error instanceof Error ? error : new Error("Failed to send request body"));
          });
        }
      } catch (error) {
        const pending = this.takePending(id);
        pending?.bodyAbort?.abort(error);
        void outgoing?.cancel(error);
        pending?.reject(error instanceof Error ? error : new Error("Failed to send request"));
      }
    });
  }

  private requestOverSocket<T>(
    socket: WebSocket,
    call: string,
    args: GsvOutgoingArguments,
  ): Promise<T> {
    const id = makeId();
    const wireArgs = serializeOutgoingArguments(args);
    const frame: RequestEnvelope<BinaryFrameDescriptor> = {
      type: "req",
      id,
      call,
      args: wireArgs,
    };
    const timeoutMs = this.requestTimeoutMs(call, wireArgs);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = timeoutMs === null
        ? null
        : globalThis.setTimeout(() => {
          cleanup();
          reject(new Error(`Request timed out after ${timeoutMs}ms: ${call}`));
        }, timeoutMs);

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId !== null) {
          globalThis.clearTimeout(timeoutId);
        }
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error("Connection closed"));
      };

      const onError = (): void => {
        cleanup();
        reject(new Error("WebSocket request failed"));
      };

      const onMessage = (event: MessageEvent): void => {
        const text = z.string().safeParse(event.data);
        if (!text.success) return;
        const parsed = parseFrame(text.data);
        if (!parsed || parsed.type !== "res" || parsed.id !== id) {
          return;
        }

        cleanup();

        if (parsed.ok) {
          if (parsed.body !== undefined) {
            reject(new Error(`${call} returned a body; requestOnce() only supports JSON responses`));
            return;
          }
          // SAFETY: requestOnce binds T to the named call at its public
          // overload; the frame parser has validated the JSON envelope.
          resolve((parsed.data ?? {}) as T);
          return;
        }

        reject(new GsvClientError(parsed.error));
      };

      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);

      try {
        socket.send(JSON.stringify(frame));
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Failed to send request"));
      }
    });
  }

  private async handleRawMessage(raw: GsvSocketMessage): Promise<void> {
    const binary = await normalizeBinaryMessage(raw);
    if (binary) {
      this.bodyChannel.handleFrame(binary);
      return;
    }

    const text = z.string().safeParse(raw);
    if (!text.success) return;
    const parsed = parseFrame(text.data);
    if (!parsed) {
      return;
    }

    if (parsed.type === "sig") {
      if (parsed.signal === REQUEST_CANCEL_SIGNAL) {
        const payload = requestCancelPayloadSchema.safeParse(parsed.payload);
        if (payload.success) {
          const controller = this.inboundRequests.get(payload.data.id);
          if (controller) {
            this.inboundRequests.delete(payload.data.id);
            const reason = payload.data.reason?.trim() ?? "";
            controller.abort(new Error(reason || "Request cancelled"));
          }
        }
        return;
      }
      for (const listener of this.signalListeners) {
        listener(parsed.signal, parsed.payload);
      }
      return;
    }

    if (parsed.type === "req") {
      await this.handleInboundRequest(parsed);
      return;
    }

    const pending = this.takePending(parsed.id);
    if (!pending) {
      if (parsed.ok && parsed.body !== undefined) {
        try {
          await this.bodyChannel.receive(parsed.body).stream.cancel("Response is no longer pending");
        } catch {}
      }
      return;
    }

    pending.bodyAbort?.abort(new Error(`Request completed: ${pending.call}`));

    if (parsed.ok) {
      try {
        const response: GsvResponse<JsonValue> = { data: parsed.data ?? {} };
        if (parsed.body !== undefined) {
          response.body = this.bodyChannel.receive(parsed.body);
        }
        pending.resolve(response);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("Invalid response body"));
      }
      return;
    }

    pending.reject(new GsvClientError(parsed.error));
  }

  private async handleInboundRequest(frame: RequestEnvelope<BinaryFrameDescriptor>): Promise<void> {
    const handler = this.inboundRequestHandler;
    const abortController = new AbortController();
    this.inboundRequests.set(frame.id, abortController);
    let body: GsvBody | undefined;
    try {
      body = frame.body !== undefined
        ? this.bodyChannel.receive(frame.body, abortController.signal)
        : undefined;
    } catch (error) {
      this.inboundRequests.delete(frame.id);
      this.sendJson(errorFrame(frame.id, 400, errorMessage(error, "Invalid request body")));
      return;
    }
    try {
      if (!handler) {
        this.sendJson(errorFrame(frame.id, 503, "No GSV request handler registered"));
        return;
      }

      let responseStarted = false;
      let outgoing: OutgoingBinaryBody | undefined;
      try {
        const response = await handler(frame, body, abortController.signal);
        abortController.signal.throwIfAborted();
        outgoing = response.body ? this.bodyChannel.prepare(response.body) : undefined;
        const responseFrame: ResponseOkEnvelope<BinaryFrameDescriptor> = {
          type: "res",
          id: frame.id,
          ok: true,
          data: response.data,
        };
        if (outgoing) responseFrame.body = outgoing.descriptor;
        this.sendJson(responseFrame);
        responseStarted = true;
        if (outgoing) {
          await outgoing.send(abortController.signal);
        }
      } catch (error) {
        if (responseStarted || abortController.signal.aborted) {
          return;
        }
        await outgoing?.cancel(error);
        this.sendJson(errorFrame(
          frame.id,
          errorCode(error),
          errorMessage(error, "Request failed"),
          errorDetails(error),
          errorRetryable(error),
        ));
      }
    } finally {
      if (body && !body.stream.locked) {
        await body.stream.cancel("Inbound request completed").catch(() => {});
      }
      if (this.inboundRequests.get(frame.id) === abortController) {
        this.inboundRequests.delete(frame.id);
      }
    }
  }

  private sendJson(frame: ResponseEnvelope<BinaryFrameDescriptor> | SignalEnvelope): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("Not connected");
    }
    socket.send(JSON.stringify(frame));
  }

  private requestTimeoutMs(call: string, args: JsonValue): number | null {
    const configuredTimeout = this.requestTimeoutsMs[call];
    if (configuredTimeout !== undefined) {
      return configuredTimeout;
    }
    if (call === "shell.exec") {
      const session = shellExecSessionArgumentsSchema.safeParse(args);
      if (session.success && session.data.sessionId.trim()) {
        const polling = shellExecPollingArgumentsSchema.safeParse(args);
        const pollingWait = polling.success
          ? polling.data.yieldMs ?? this.defaultRequestTimeoutMs
          : this.defaultRequestTimeoutMs;
        return pollingWait + SHELL_EXEC_RESPONSE_GRACE_MS;
      }
      const parsed = shellExecTimeoutArgumentsSchema.safeParse(args);
      return parsed.success && parsed.data.timeout !== undefined
        ? parsed.data.timeout + SHELL_EXEC_RESPONSE_GRACE_MS
        : null;
    }
    return this.defaultRequestTimeoutMs;
  }

  private takePending(id: string): PendingRequest | null {
    const pending = this.pending.get(id) ?? null;
    if (!pending) {
      return null;
    }
    this.pending.delete(id);
    if (pending.timeoutId !== null) {
      globalThis.clearTimeout(pending.timeoutId);
    }
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private rejectAllPending(error: Error): void {
    for (const id of this.pending.keys()) {
      const pending = this.takePending(id);
      if (!pending) continue;
      pending.bodyAbort?.abort(error);
      pending.reject(error);
    }
  }

  private abortAllInbound(error: Error): void {
    for (const controller of this.inboundRequests.values()) {
      controller.abort(error);
    }
    this.inboundRequests.clear();
  }

}

export class GSVEndpoint {
  readonly client: GSVClient;

  private readonly options: GsvEndpointOptions;
  private readonly handlers = new Map<GsvEndpointPattern, GsvEndpointHandler>();
  private unregisterRequestHandler: (() => void) | null = null;
  private unregisterStatusHandler: (() => void) | null = null;
  private unregisterSignalHandler: (() => void) | null = null;
  private keepaliveTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private acknowledgementTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingAcknowledgement: string | null = null;
  private connection: ConnectResult | null = null;
  private abortController = new AbortController();
  private locked = false;

  constructor(client: GSVClient, options: GsvEndpointOptions = {}) {
    this.client = client;
    this.options = options;
  }

  implement<S extends SyscallName>(pattern: S, handler: GsvEndpointHandler<S>): this;
  implement(pattern: GsvEndpointPattern, handler: GsvEndpointHandler): this;
  implement(pattern: GsvEndpointPattern, handler: GsvEndpointHandler): this {
    if (this.locked) {
      throw new Error("Cannot add endpoint implementations after connect");
    }
    this.handlers.set(pattern, handler);
    return this;
  }

  async connect(options: GsvEndpointConnectOptions = {}): Promise<ConnectResult> {
    const peerId = options.peerId ?? this.options.peerId;
    if (!peerId?.trim()) {
      throw new Error("Endpoint id is required");
    }

    const implementsList = this.resolveImplements(options.implements);
    if (implementsList.length === 0) {
      throw new Error("Endpoint requires at least one implementation");
    }

    this.ensureClientHandlers();
    this.stopKeepalive();
    this.connection = null;
    this.abortController.abort();

    const {
      peerId: _peerId,
      platform,
      version,
      implements: _implements,
      ...connectOptions
    } = options;
    void _peerId;
    void _implements;

    const result = await this.client.connect({
      ...connectOptions,
      peer: buildEndpointPeerInfo(
        peerId.trim(),
        platform ?? this.options.platform,
        version ?? this.options.version,
        implementsList,
      ),
    });

    this.abortController = new AbortController();
    this.connection = result;
    this.locked = true;
    this.startKeepalive();
    return result;
  }

  disconnect(reason?: string): void {
    this.stopKeepalive();
    this.connection = null;
    this.abortController.abort();
    this.client.disconnect(reason);
  }

  close(): void {
    this.disconnect();
    this.unregisterRequestHandler?.();
    this.unregisterRequestHandler = null;
    this.unregisterStatusHandler?.();
    this.unregisterStatusHandler = null;
    this.unregisterSignalHandler?.();
    this.unregisterSignalHandler = null;
  }

  private resolveImplements(connectImplements?: GsvEndpointPattern[]): GsvEndpointPattern[] {
    const source = connectImplements ?? this.options.implements ?? Array.from(this.handlers.keys());
    return Array.from(new Set(
      source
        .map((pattern) => pattern.trim())
        .filter((pattern): pattern is GsvEndpointPattern => pattern.length > 0),
    ));
  }

  private ensureClientHandlers(): void {
    if (!this.unregisterRequestHandler) {
      this.unregisterRequestHandler = this.client.onRequest(
        async (frame, body, signal) => await this.handleRequest(frame, body, signal),
      );
    }
    if (!this.unregisterStatusHandler) {
      this.unregisterStatusHandler = this.client.onStatus((status) => {
        if (!this.connection || status.state === "connected") {
          return;
        }
        this.connection = null;
        this.stopKeepalive();
        this.abortController.abort();
      });
    }
    if (!this.unregisterSignalHandler) {
      this.unregisterSignalHandler = this.client.onSignal((signal, payload) => {
        const acknowledgement = this.keepaliveAcknowledgement();
        if (!acknowledgement || signal !== (acknowledgement.signal ?? "peer.pong")) {
          return;
        }
        const nonce = acknowledgementNonce(payload);
        if (!nonce || nonce !== this.pendingAcknowledgement) {
          return;
        }
        this.pendingAcknowledgement = null;
        this.clearAcknowledgementTimer();
      });
    }
  }

  private async handleRequest(
    frame: RequestEnvelope<BinaryFrameDescriptor>,
    body?: GsvBody,
    signal?: AbortSignal,
  ): Promise<GsvResponse> {
    const handler = this.findHandler(frame.call);
    if (!handler) {
      throw new GsvRequestError(404, `Endpoint does not implement ${frame.call}`);
    }
    const connection = this.connection;
    if (!connection) {
      throw new GsvRequestError(503, "Endpoint is not connected");
    }

    const context: GsvEndpointContext = {
      client: this.client,
      connection,
      abortSignal: signal
        ? AbortSignal.any([this.abortController.signal, signal])
        : this.abortController.signal,
      sendSignal: (signal, payload, seq) => this.client.sendSignal(signal, payload, seq),
    };

    return await handler({
      id: frame.id,
      call: frame.call,
      args: frame.args,
      body,
      raw: frame,
    }, context);
  }

  private findHandler(call: string): GsvEndpointHandler | null {
    for (const [pattern, handler] of this.handlers) {
      if (patternMatches(pattern, call)) {
        return handler;
      }
    }
    return null;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    if (this.options.keepalive === false) {
      return;
    }
    const keepalive = this.options.keepalive ?? {};
    const intervalMs = keepalive.intervalMs ?? DEFAULT_ENDPOINT_KEEPALIVE_MS;
    const signal = keepalive.signal ?? "peer.ping";
    const payload = keepalive.payload ?? ((nonce?: string) => {
      const heartbeat: GsvHeartbeatPayload = { at: Date.now() };
      if (nonce) heartbeat.nonce = nonce;
      return heartbeat;
    });
    const sendKeepalive = () => {
      if (!this.client.isConnected()) {
        return;
      }
      try {
        const acknowledgement = this.keepaliveAcknowledgement();
        if (acknowledgement && this.pendingAcknowledgement) {
          return;
        }
        const nonce = acknowledgement ? makeId() : undefined;
        this.client.sendSignal(signal, payload(nonce));
        if (acknowledgement && nonce) {
          this.pendingAcknowledgement = nonce;
          this.clearAcknowledgementTimer();
          this.acknowledgementTimer = globalThis.setTimeout(() => {
            if (this.pendingAcknowledgement !== nonce) {
              return;
            }
            this.disconnect("peer heartbeat timed out");
          }, acknowledgement.timeoutMs ?? DEFAULT_ENDPOINT_ACKNOWLEDGEMENT_TIMEOUT_MS);
        }
      } catch {
        this.disconnect("peer heartbeat send failed");
      }
    };
    if (this.keepaliveAcknowledgement()) {
      sendKeepalive();
      if (!this.client.isConnected()) {
        return;
      }
    }
    this.keepaliveTimer = globalThis.setInterval(sendKeepalive, intervalMs);
  }
  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      globalThis.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.pendingAcknowledgement = null;
    this.clearAcknowledgementTimer();
  }

  private keepaliveAcknowledgement(): GsvEndpointAcknowledgementOptions | false {
    if (this.options.keepalive === false) {
      return false;
    }
    const acknowledgement = this.options.keepalive?.acknowledgement;
    if (!acknowledgement) {
      return false;
    }
    const signal = acknowledgement.signal ?? "peer.pong";
    return this.connection?.peer.grant.signals.includes(signal) ? acknowledgement : false;
  }

  private clearAcknowledgementTimer(): void {
    if (this.acknowledgementTimer) {
      globalThis.clearTimeout(this.acknowledgementTimer);
      this.acknowledgementTimer = null;
    }
  }
}

export type GsvClient = GSVClient;

export function createGsvClient(options?: GsvClientOptions): GSVClient {
  return new GSVClient(options);
}

export { GSVClient as GSV };

function buildEndpointPeerInfo(
  id: string,
  platform: string | undefined,
  version: string | undefined,
  implementsList: GsvEndpointPattern[],
): Partial<GsvPeerInfo> {
  const peer: Partial<GsvPeerInfo> = { id, implements: implementsList };
  if (platform !== undefined) peer.platform = platform;
  if (version !== undefined) peer.version = version;
  return peer;
}

function assignNamespaces(target: GsvNamespaceTarget, call: GsvClientCall): void {
  const root: GsvNamespaceContainer = {};
  for (const syscall of SYSCALL_NAMES) {
    const parts = syscall.split(".");
    let cursor = root;

    for (const part of parts.slice(0, -1)) {
      const child = cursor[part] ?? {};
      cursor[part] = child;
      cursor = child;
    }

    const methodName = parts[parts.length - 1];
    const existing = cursor[methodName] ?? {};
    // SAFETY: SYSCALL_NAMES is checked against NamespaceSyscall above, so the
    // selected method has the ArgsOf/ResultOf pair declared for this syscall.
    const invoke = ((args: GsvRequestArguments = {}) => call(syscall, args)) as GsvSyscallMethod<typeof syscall>;
    const method = Object.assign(invoke, existing);
    cursor[methodName] = method;
  }
  Object.assign(target, root);
}

function makeId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function acknowledgementNonce(payload: JsonValue | undefined): string | null {
  const parsed = acknowledgementPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.nonce : null;
}

function parseFrame(raw: string): FrameEnvelope<BinaryFrameDescriptor> | null {
  try {
    const parsed = wireFrameSchemas.frame.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WEBSOCKET_OPEN || socket.readyState === WEBSOCKET_CONNECTING) {
    socket.close(code, reason);
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  const text = z.string().safeParse(cause);
  if (text.success && text.data.trim().length > 0) {
    return text.data;
  }
  return fallback;
}

function requestAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new Error(errorMessage(signal.reason, "Request cancelled"));
}

function errorCode(cause: unknown): number {
  if (cause instanceof GsvRequestError || cause instanceof GsvClientError) {
    return cause.code ?? 500;
  }
  return 500;
}

function errorDetails(cause: unknown): JsonValue | undefined {
  if (cause instanceof GsvRequestError || cause instanceof GsvClientError) {
    return cause.details;
  }
  return undefined;
}

function errorRetryable(cause: unknown): boolean | undefined {
  if (cause instanceof GsvRequestError || cause instanceof GsvClientError) {
    return cause.retryable;
  }
  return undefined;
}

function errorFrame(
  id: string,
  code: number,
  message: string,
  details?: JsonValue,
  retryable?: boolean,
): ResponseErrEnvelope {
  const frame: ResponseErrEnvelope = {
    type: "res",
    id,
    ok: false,
    error: {
      code,
      message,
    },
  };
  if (details !== undefined) frame.error.details = details;
  if (retryable !== undefined) frame.error.retryable = retryable;
  return frame;
}

async function normalizeBinaryMessage(raw: GsvSocketMessage): Promise<ArrayBuffer | null> {
  if (raw instanceof ArrayBuffer) {
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    const copy = new Uint8Array(raw.byteLength);
    copy.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    return copy.buffer;
  }
  if (globalThis.Blob && raw instanceof globalThis.Blob) {
    return await raw.arrayBuffer();
  }
  return null;
}

function patternMatches(pattern: string, call: string): boolean {
  if (pattern === call) {
    return true;
  }
  if (!pattern.endsWith(".*")) {
    return false;
  }
  return call.startsWith(pattern.slice(0, -1));
}
