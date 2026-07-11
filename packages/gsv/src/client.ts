import type {
  ArgsOf,
  ConnectArgs,
  ConnectResult,
  ResultOf,
  SyscallName,
} from "./protocol";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  BINARY_FRAME_ERROR,
  buildBinaryFrame,
  parseBinaryFrame,
  type BinaryFrame,
  type BinaryFrameDescriptor,
} from "./protocol/binary-frame";

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type GsvErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

export type GsvRequestFrame<S extends string = string> = {
  type: "req";
  id: string;
  call: S;
  args?: unknown;
  body?: BinaryFrameDescriptor;
};

export type GsvResponseFrame<T = unknown> =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: T;
      body?: BinaryFrameDescriptor;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: GsvErrorShape;
    };

export type GsvSignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
  seq?: number;
};

export type GsvFrame = GsvRequestFrame | GsvResponseFrame | GsvSignalFrame;

type PendingRequest = {
  resolve: (value: GsvResponse<unknown>) => void;
  reject: (error: Error) => void;
  timeoutId: TimerHandle;
  call: string;
};

type PendingBinaryStream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timeoutId: TimerHandle;
  maxBytes?: number;
  receivedBytes: number;
};

type QueuedBinaryFrame = {
  frame: BinaryFrame;
  size: number;
};

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

type SyscallArgsTuple<S extends SyscallName> = {} extends ArgsOf<S>
  ? [args?: ArgsOf<S>]
  : [args: ArgsOf<S>];

type NamespaceEntry<Full extends SyscallName, Path extends string> = Path extends `${infer Head}.${infer Tail}`
  ? { [Key in Head]: NamespaceEntry<Full, Tail> }
  : { [Key in Path]: GsvSyscallMethod<Full> };

export type GsvSyscallMethod<S extends SyscallName> = (
  ...args: SyscallArgsTuple<S>
) => Promise<ResultOf<S>>;

export type GsvClientNamespaces = UnionToIntersection<{
  [S in SyscallName]: NamespaceEntry<S, S>;
}[SyscallName]>;

export type GsvClientCall = {
  <S extends SyscallName>(call: S, ...args: SyscallArgsTuple<S>): Promise<ResultOf<S>>;
  <T = unknown>(call: string, args?: unknown): Promise<T>;
};

export type GsvClientInfo = ConnectArgs["client"];

export type GsvBinarySendOptions = {
  chunkSize?: number;
};

export type GsvBinaryReceiveOptions = {
  timeoutMs?: number;
  maxBytes?: number;
};

export type GsvBinaryReceive = {
  stream: ReadableStream<Uint8Array>;
  cancel(reason?: string): void;
};

export type GsvBinarySource =
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | ArrayBuffer | ArrayBufferView>;

export type GsvBody = {
  stream: ReadableStream<Uint8Array>;
  length?: number;
};

export type GsvRequestOptions = {
  body?: GsvBody;
};

export type GsvResponse<T = unknown> = {
  data: T;
  body?: GsvBody;
};

export type GsvBinaryTransport = {
  sendFrame(streamId: number, flags: number, payload?: Uint8Array): void;
  sendError(streamId: number, error: string | Error): void;
  sendStream(streamId: number, source: GsvBinarySource, options?: GsvBinarySendOptions): Promise<number>;
  receive(streamId: number, options?: GsvBinaryReceiveOptions): GsvBinaryReceive;
};

export type GsvBinaryClientOptions = {
  defaultReceiveTimeoutMs?: number;
  maxBufferedBytes?: number;
  chunkSize?: number;
};

export type GsvInboundRequestHandler = (
  frame: GsvRequestFrame,
  body?: GsvBody,
) => Promise<GsvResponse> | GsvResponse;

export type GsvDriverPattern = SyscallName | `${string}.*`;

export type GsvDriverRequest<S extends string = string> = {
  id: string;
  call: S;
  args: S extends SyscallName ? ArgsOf<S> : unknown;
  body?: GsvBody;
  raw: GsvRequestFrame<S>;
};

export type GsvDriverContext = {
  client: GSVClient;
  connection: ConnectResult;
  binary: GsvBinaryTransport;
  abortSignal: AbortSignal;
  sendSignal(signal: string, payload?: unknown, seq?: number): void;
};

export type GsvDriverHandler<S extends string = string> = (
  request: GsvDriverRequest<S>,
  context: GsvDriverContext,
) => Promise<GsvResponse<S extends SyscallName ? ResultOf<S> : unknown>>
  | GsvResponse<S extends SyscallName ? ResultOf<S> : unknown>;

export type GsvDriverOptions = {
  deviceId?: string;
  platform?: string;
  version?: string;
  implements?: GsvDriverPattern[];
  keepalive?: false | {
    intervalMs?: number;
    signal?: string;
    payload?: () => unknown;
  };
};

export type GsvDriverConnectOptions = Omit<GsvConnectOptions, "client" | "driver"> & {
  deviceId?: string;
  platform?: string;
  version?: string;
  implements?: GsvDriverPattern[];
};

export type GsvConnectOptions = {
  url?: string;
  username?: string;
  password?: string;
  token?: string;
  client?: Partial<GsvClientInfo>;
  driver?: ConnectArgs["driver"];
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
  binary?: GsvBinaryClientOptions;
};

export type GsvAccountNamespace = GsvClientNamespaces["account"];
export type GsvAdapterNamespace = GsvClientNamespaces["adapter"];
export type GsvAiNamespace = GsvClientNamespaces["ai"];
export type GsvAppNamespace = GsvClientNamespaces["app"];
export type GsvCodeModeNamespace = GsvClientNamespaces["codemode"];
export type GsvFsNamespace = GsvClientNamespaces["fs"];
export type GsvNetNamespace = GsvClientNamespaces["net"];
export type GsvNotificationNamespace = GsvClientNamespaces["notification"];
export type GsvPkgNamespace = GsvClientNamespaces["pkg"];
export type GsvProcNamespace = GsvClientNamespaces["proc"];
export type GsvRepoNamespace = GsvClientNamespaces["repo"];
export type GsvSchedNamespace = GsvClientNamespaces["sched"];
export type GsvShellNamespace = GsvClientNamespaces["shell"];
export type GsvSignalNamespace = GsvClientNamespaces["signal"];
export type GsvSysNamespace = GsvClientNamespaces["sys"];

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 120_000;
const AI_TEXT_GENERATION_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_BINARY_RECEIVE_TIMEOUT_MS = 120_000;
const DEFAULT_BINARY_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const DEFAULT_BINARY_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_DRIVER_KEEPALIVE_MS = 240_000;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;

const DEFAULT_REQUEST_TIMEOUTS_MS: Record<string, number> = {
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
};

const DEFAULT_CLIENT_INFO: GsvClientInfo = {
  id: "gsv-js",
  version: "0.0.1",
  platform: "javascript",
  role: "user",
};

const SYSCALL_NAMES = [
  "fs.read",
  "fs.write",
  "fs.edit",
  "fs.delete",
  "fs.search",
  "fs.copy",
  "fs.transfer.stat",
  "fs.transfer.send",
  "fs.transfer.receive",
  "shell.exec",
  "net.fetch",
  "app.open",
  "app.attach",
  "app.list",
  "app.detach",
  "app.close",
  "codemode.exec",
  "codemode.run",
  "proc.spawn",
  "proc.kill",
  "proc.list",
  "proc.send",
  "proc.ipc.send",
  "proc.ipc.call",
  "proc.ipc.deliver",
  "proc.abort",
  "proc.hil",
  "proc.history",
  "proc.ai.config.get",
  "proc.ai.config.set",
  "proc.media.read",
  "proc.conversation.open",
  "proc.conversation.list",
  "proc.conversation.get",
  "proc.conversation.close",
  "proc.conversation.reset",
  "proc.conversation.policy.get",
  "proc.conversation.policy.set",
  "proc.conversation.compact",
  "proc.conversation.fork",
  "proc.conversation.segment.read",
  "proc.conversation.segments",
  "proc.conversation.timeline",
  "proc.conversation.generations",
  "proc.conversation.generation.manifest",
  "proc.reset",
  "proc.setidentity",
  "pkg.list",
  "pkg.add",
  "pkg.create",
  "pkg.sync",
  "pkg.checkout",
  "pkg.install",
  "pkg.review.approve",
  "pkg.remove",
  "pkg.remote.list",
  "pkg.remote.add",
  "pkg.remote.remove",
  "pkg.public.list",
  "pkg.public.set",
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
  "sys.device.list",
  "sys.device.get",
  "sys.device.update",
  "sys.device.delete",
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
  "sys.update",
  "account.create",
  "account.list",
  "sched.list",
  "sched.add",
  "sched.update",
  "sched.remove",
  "sched.run",
  "ai.tools",
  "ai.config",
  "ai.text.generate",
  "ai.transcription.create",
  "ai.image.read",
  "ai.image.generate",
  "ai.speech.create",
  "adapter.connect",
  "adapter.disconnect",
  "adapter.inbound",
  "adapter.state.update",
  "adapter.send",
  "adapter.status",
  "adapter.list",
  "notification.create",
  "notification.list",
  "notification.mark_read",
  "notification.dismiss",
  "signal.watch",
  "signal.unwatch",
] as const satisfies readonly SyscallName[];

type MissingSyscalls = Exclude<SyscallName, typeof SYSCALL_NAMES[number]>;
const allSyscallsCovered: MissingSyscalls extends never ? true : never = true;
void allSyscallsCovered;

export class GsvClientError extends Error {
  readonly code?: number;
  readonly details?: unknown;
  readonly retryable?: boolean;

  constructor(error: GsvErrorShape) {
    super(error.message);
    this.name = "GsvClientError";
    this.code = error.code;
    this.details = error.details;
    this.retryable = error.retryable;
  }
}

export class GsvRequestError extends Error {
  readonly code: number;
  readonly details?: unknown;
  readonly retryable?: boolean;

  constructor(code: number, message: string, options: { details?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.name = "GsvRequestError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable;
  }
}

export class GSVClient {
  readonly call: GsvClientCall;
  readonly binary: GsvBinaryTransport;

  private readonly WebSocketCtor: GsvWebSocketConstructor | null;
  private readonly connectDefaults: GsvConnectOptions;
  private readonly connectTimeoutMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly requestTimeoutsMs: Record<string, number>;
  private readonly defaultBinaryReceiveTimeoutMs: number;
  private readonly binaryMaxBufferedBytes: number;
  private readonly binaryChunkSize: number;
  private socket: WebSocket | null = null;
  private socketEpoch = 0;
  private pending = new Map<string, PendingRequest>();
  private pendingBinaryStreams = new Map<number, PendingBinaryStream>();
  private queuedBinaryFrames = new Map<number, QueuedBinaryFrame[]>();
  private queuedBinaryBytes = 0;
  private nextBinaryStreamId = 1;
  private inboundRequestHandler: GsvInboundRequestHandler | null = null;
  private signalListeners = new Set<(signal: string, payload: unknown) => void>();
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
      binary,
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
    this.defaultBinaryReceiveTimeoutMs = binary?.defaultReceiveTimeoutMs ?? DEFAULT_BINARY_RECEIVE_TIMEOUT_MS;
    this.binaryMaxBufferedBytes = binary?.maxBufferedBytes ?? DEFAULT_BINARY_MAX_BUFFERED_BYTES;
    this.binaryChunkSize = binary?.chunkSize ?? DEFAULT_BINARY_CHUNK_SIZE;
    this.call = (async (call: string, args: unknown = {}) => {
      const response = await this.request(call, args);
      if (response.body) {
        void response.body.stream.cancel();
        throw new Error(`${call} returned a body; use client.request()`);
      }
      return response.data;
    }) as GsvClientCall;
    this.binary = {
      sendFrame: (streamId, flags, payload) => this.sendBinaryFrame(streamId, flags, payload),
      sendError: (streamId, error) => this.sendBinaryError(streamId, error),
      sendStream: async (streamId, source, sendOptions) => await this.sendBinaryStream(streamId, source, sendOptions),
      receive: (streamId, receiveOptions) => this.receiveBinaryStream(streamId, receiveOptions),
    };

    assignNamespaces(this as unknown as Record<string, unknown>, this.call);
  }

  getStatus(): GsvClientStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status.state === "connected" && this.socket?.readyState === WEBSOCKET_OPEN;
  }

  onSignal(listener: (signal: string, payload: unknown) => void): () => void {
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

  driver(options: GsvDriverOptions = {}): GSVDriver {
    return new GSVDriver(this, options);
  }

  sendSignal(signal: string, payload?: unknown, seq?: number): void {
    const frame: GsvSignalFrame = {
      type: "sig",
      signal,
      ...(payload === undefined ? {} : { payload }),
      ...(seq === undefined ? {} : { seq }),
    };
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
      socket = await this.openSocket(url);
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
      connectResult = (await this.request("sys.connect", {
        protocol: 1,
        client: merged.client,
        ...(merged.driver ? { driver: merged.driver } : {}),
        auth: {
          username,
          ...(token ? { token } : { password }),
        },
      })).data as ConnectResult;
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
    const socket = this.socket;
    this.socket = null;

    if (socket) {
      closeSocket(socket, 1000, reason);
    }

    this.rejectAllPending(new Error("Disconnected"));
    this.rejectAllBinaryStreams(new Error("Disconnected"));
    this.clearQueuedBinaryFrames();
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
  async request<T = unknown>(
    call: string,
    args?: unknown,
    options?: GsvRequestOptions,
  ): Promise<GsvResponse<T>>;
  async request<T = unknown>(
    call: string,
    args: unknown = {},
    options: GsvRequestOptions = {},
  ): Promise<GsvResponse<T>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("Not connected");
    }
    return await this.requestFrame(socket, call, args, options) as GsvResponse<T>;
  }

  async requestOnce<S extends SyscallName>(
    url: string,
    call: S,
    ...args: SyscallArgsTuple<S>
  ): Promise<ResultOf<S>>;
  async requestOnce<T = unknown>(url: string, call: string, args?: unknown): Promise<T>;
  async requestOnce<T = unknown>(url: string, call: string, args: unknown = {}): Promise<T> {
    const socket = await this.openSocket(url);
    try {
      return await this.requestOverSocket<T>(socket, call, args);
    } finally {
      closeSocket(socket, 1000, "request complete");
    }
  }

  private mergeConnectOptions(options: GsvConnectOptions): Required<Pick<GsvConnectOptions, "client">> &
    Omit<GsvConnectOptions, "client"> {
    return {
      ...this.connectDefaults,
      ...options,
      client: {
        ...DEFAULT_CLIENT_INFO,
        ...this.connectDefaults.client,
        ...options.client,
      },
      driver: options.driver ?? this.connectDefaults.driver,
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
      this.rejectAllPending(new Error("Connection closed"));
      this.rejectAllBinaryStreams(new Error("Connection closed"));
      this.clearQueuedBinaryFrames();
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

      if (this.status.state === "connecting") {
        this.setStatus({
          ...this.status,
          message: "WebSocket error while connecting",
        });
      }
    });
  }

  private async openSocket(url: string): Promise<WebSocket> {
    const WebSocketCtor = this.WebSocketCtor ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket is not available; pass a WebSocket constructor to GSVClient");
    }

    const socket = new WebSocketCtor(url);
    socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
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

    return socket;
  }

  private requestFrame(
    socket: WebSocket,
    call: string,
    args: unknown,
    options: GsvRequestOptions = {},
  ): Promise<GsvResponse<unknown>> {
    const id = makeId();
    const body = options.body;
    assertBodyLength(body?.length);
    const streamId = body ? this.allocateBinaryStreamId() : undefined;
    const frame: GsvRequestFrame = {
      type: "req",
      id,
      call,
      args,
      ...(body && streamId
        ? { body: { streamId, ...(body.length === undefined ? {} : { length: body.length }) } }
        : {}),
    };
    const timeoutMs = this.requestTimeoutMs(call);

    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${call}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeoutId,
        call,
      });

      try {
        socket.send(JSON.stringify(frame));
        if (body && streamId) {
          void this.sendBinaryStream(streamId, body.stream).catch((error) => {
            const pending = this.pending.get(id);
            if (!pending) {
              return;
            }
            this.pending.delete(id);
            globalThis.clearTimeout(pending.timeoutId);
            pending.reject(error instanceof Error ? error : new Error("Failed to send request body"));
          });
        }
      } catch (error) {
        this.pending.delete(id);
        globalThis.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error("Failed to send request"));
      }
    });
  }

  private requestOverSocket<T>(socket: WebSocket, call: string, args: unknown): Promise<T> {
    const id = makeId();
    const frame: GsvRequestFrame = { type: "req", id, call, args };
    const timeoutMs = this.requestTimeoutMs(call);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${call}`));
      }, timeoutMs);

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeoutId);
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
        if (typeof event.data !== "string") {
          return;
        }

        const parsed = parseFrame(event.data);
        if (!parsed || parsed.type !== "res" || parsed.id !== id) {
          return;
        }

        cleanup();

        if (parsed.ok) {
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

  private async handleRawMessage(raw: unknown): Promise<void> {
    const binary = await normalizeBinaryMessage(raw);
    if (binary) {
      this.handleBinaryMessage(binary);
      return;
    }

    if (typeof raw !== "string") {
      return;
    }

    const parsed = parseFrame(raw);
    if (!parsed) {
      return;
    }

    if (parsed.type === "sig") {
      for (const listener of this.signalListeners) {
        listener(parsed.signal, parsed.payload);
      }
      return;
    }

    if (parsed.type === "req") {
      await this.handleInboundRequest(parsed);
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    this.pending.delete(parsed.id);
    globalThis.clearTimeout(pending.timeoutId);

    if (parsed.ok) {
      try {
        pending.resolve({
          data: parsed.data ?? {},
          ...(parsed.body ? { body: this.receiveFrameBody(parsed.body) } : {}),
        });
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("Invalid response body"));
      }
      return;
    }

    pending.reject(new GsvClientError(parsed.error));
  }

  private async handleInboundRequest(frame: GsvRequestFrame): Promise<void> {
    const handler = this.inboundRequestHandler;
    let body: GsvBody | undefined;
    try {
      body = frame.body ? this.receiveFrameBody(frame.body) : undefined;
    } catch (error) {
      this.sendJson(errorFrame(frame.id, 400, errorMessage(error, "Invalid request body")));
      return;
    }
    if (!handler) {
      void body?.stream.cancel();
      this.sendJson(errorFrame(frame.id, 503, "No GSV request handler registered"));
      return;
    }

    let responseStarted = false;
    try {
      const response = await handler(frame, body);
      assertBodyLength(response.body?.length);
      const streamId = response.body ? this.allocateBinaryStreamId() : undefined;
      this.sendJson({
        type: "res",
        id: frame.id,
        ok: true,
        data: response.data,
        ...(response.body && streamId
          ? {
              body: {
                streamId,
                ...(response.body.length === undefined ? {} : { length: response.body.length }),
              },
            }
          : {}),
      });
      responseStarted = true;
      if (response.body && streamId) {
        await this.sendBinaryStream(streamId, response.body.stream);
      }
    } catch (error) {
      void body?.stream.cancel();
      if (responseStarted) {
        return;
      }
      this.sendJson(errorFrame(
        frame.id,
        errorCode(error),
        errorMessage(error, "Request failed"),
        errorDetails(error),
        errorRetryable(error),
      ));
    }
  }

  private sendBinaryFrame(streamId: number, flags: number, payload?: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("Not connected");
    }
    socket.send(buildBinaryFrame(streamId, flags, payload));
  }

  private sendBinaryError(streamId: number, error: string | Error): void {
    this.sendBinaryFrame(
      streamId,
      BINARY_FRAME_ERROR | BINARY_FRAME_END,
      new TextEncoder().encode(error instanceof Error ? error.message : error),
    );
  }

  private async sendBinaryStream(
    streamId: number,
    source: GsvBinarySource,
    options: GsvBinarySendOptions = {},
  ): Promise<number> {
    const chunkSize = options.chunkSize ?? this.binaryChunkSize;
    let bytesSent = 0;
    try {
      for await (const value of binaryChunks(source, chunkSize)) {
        if (value.byteLength === 0) {
          continue;
        }
        this.sendBinaryFrame(streamId, BINARY_FRAME_DATA, value);
        bytesSent += value.byteLength;
      }
      this.sendBinaryFrame(streamId, BINARY_FRAME_END);
      return bytesSent;
    } catch (error) {
      try {
        this.sendBinaryError(streamId, error instanceof Error ? error : String(error));
      } catch {
        // Preserve the original transfer failure.
      }
      throw error;
    }
  }

  private receiveBinaryStream(
    streamId: number,
    options: GsvBinaryReceiveOptions = {},
  ): GsvBinaryReceive {
    assertBinaryStreamId(streamId);
    if (this.pendingBinaryStreams.has(streamId)) {
      throw new Error(`Binary stream already pending: ${streamId}`);
    }

    const timeoutMs = options.timeoutMs ?? this.defaultBinaryReceiveTimeoutMs;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timeoutId = globalThis.setTimeout(() => {
          this.rejectBinaryStream(streamId, new Error(`Binary transfer timed out: ${streamId}`));
        }, timeoutMs);
        this.pendingBinaryStreams.set(streamId, {
          controller,
          timeoutId,
          maxBytes: options.maxBytes,
          receivedBytes: 0,
        });
        this.flushQueuedBinaryFrames(streamId);
      },
      cancel: () => {
        this.clearBinaryStream(streamId);
      },
    });

    return {
      stream,
      cancel: (reason?: string) => {
        this.rejectBinaryStream(streamId, new Error(reason ?? "Binary transfer cancelled"));
      },
    };
  }

  private receiveFrameBody(descriptor: BinaryFrameDescriptor): GsvBody {
    assertBinaryStreamId(descriptor.streamId);
    assertBodyLength(descriptor.length);
    return {
      stream: this.receiveBinaryStream(descriptor.streamId, {
        maxBytes: descriptor.length,
      }).stream,
      ...(descriptor.length === undefined ? {} : { length: descriptor.length }),
    };
  }

  private allocateBinaryStreamId(): number {
    const streamId = this.nextBinaryStreamId;
    this.nextBinaryStreamId = streamId === 0xffffffff ? 1 : streamId + 1;
    return streamId;
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    const frame = parseBinaryFrame(data);
    if (!frame) {
      return;
    }
    if (!this.pendingBinaryStreams.has(frame.streamId)) {
      this.queueBinaryFrame(frame);
      return;
    }
    this.deliverBinaryFrame(frame);
  }

  private deliverBinaryFrame(frame: BinaryFrame): void {
    const pending = this.pendingBinaryStreams.get(frame.streamId);
    if (!pending) {
      return;
    }

    if ((frame.flags & BINARY_FRAME_ERROR) !== 0) {
      const message = new TextDecoder().decode(frame.payload) || "Binary transfer failed";
      this.rejectBinaryStream(frame.streamId, new Error(message));
      return;
    }

    if ((frame.flags & BINARY_FRAME_DATA) !== 0 && frame.payload.byteLength > 0) {
      pending.receivedBytes += frame.payload.byteLength;
      if (pending.maxBytes !== undefined && pending.receivedBytes > pending.maxBytes) {
        this.rejectBinaryStream(
          frame.streamId,
          new Error(`Binary transfer exceeded ${pending.maxBytes} bytes`),
        );
        return;
      }
      pending.controller.enqueue(frame.payload);
    }

    if ((frame.flags & BINARY_FRAME_END) !== 0) {
      const stream = this.clearBinaryStream(frame.streamId);
      stream?.controller.close();
    }
  }

  private queueBinaryFrame(frame: BinaryFrame): void {
    const size = frame.payload.byteLength;
    const queue = this.queuedBinaryFrames.get(frame.streamId) ?? [];
    queue.push({ frame, size });
    this.queuedBinaryFrames.set(frame.streamId, queue);
    this.queuedBinaryBytes += size;
    this.trimQueuedBinaryFrames();
  }

  private flushQueuedBinaryFrames(streamId: number): void {
    const queue = this.queuedBinaryFrames.get(streamId);
    if (!queue) {
      return;
    }
    this.queuedBinaryFrames.delete(streamId);
    for (const queued of queue) {
      this.queuedBinaryBytes -= queued.size;
      this.deliverBinaryFrame(queued.frame);
      if (!this.pendingBinaryStreams.has(streamId)) {
        break;
      }
    }
  }

  private trimQueuedBinaryFrames(): void {
    while (this.queuedBinaryBytes > this.binaryMaxBufferedBytes) {
      const oldest = this.queuedBinaryFrames.entries().next();
      if (oldest.done) {
        this.queuedBinaryBytes = 0;
        return;
      }
      const [streamId, queue] = oldest.value;
      const dropped = queue.shift();
      if (dropped) {
        this.queuedBinaryBytes -= dropped.size;
      }
      if (queue.length === 0) {
        this.queuedBinaryFrames.delete(streamId);
      }
    }
  }

  private clearQueuedBinaryFrames(): void {
    this.queuedBinaryFrames.clear();
    this.queuedBinaryBytes = 0;
  }

  private clearBinaryStream(streamId: number): PendingBinaryStream | null {
    const pending = this.pendingBinaryStreams.get(streamId);
    if (!pending) {
      return null;
    }
    this.pendingBinaryStreams.delete(streamId);
    globalThis.clearTimeout(pending.timeoutId);
    return pending;
  }

  private rejectBinaryStream(streamId: number, error: Error): void {
    const pending = this.clearBinaryStream(streamId);
    pending?.controller.error(error);
  }

  private sendJson(frame: GsvResponseFrame | GsvSignalFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("Not connected");
    }
    socket.send(JSON.stringify(frame));
  }

  private requestTimeoutMs(call: string): number {
    return this.requestTimeoutsMs[call] ?? this.defaultRequestTimeoutMs;
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectAllBinaryStreams(error: Error): void {
    for (const pending of this.pendingBinaryStreams.values()) {
      globalThis.clearTimeout(pending.timeoutId);
      pending.controller.error(error);
    }
    this.pendingBinaryStreams.clear();
  }
}

export class GSVDriver {
  readonly client: GSVClient;

  private readonly options: GsvDriverOptions;
  private readonly handlers = new Map<GsvDriverPattern, GsvDriverHandler>();
  private unregisterRequestHandler: (() => void) | null = null;
  private unregisterStatusHandler: (() => void) | null = null;
  private keepaliveTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private connection: ConnectResult | null = null;
  private abortController = new AbortController();
  private locked = false;

  constructor(client: GSVClient, options: GsvDriverOptions = {}) {
    this.client = client;
    this.options = options;
  }

  implement<S extends SyscallName>(pattern: S, handler: GsvDriverHandler<S>): this;
  implement(pattern: GsvDriverPattern, handler: GsvDriverHandler): this;
  implement(pattern: GsvDriverPattern, handler: GsvDriverHandler): this {
    if (this.locked) {
      throw new Error("Cannot add driver implementations after connect");
    }
    this.handlers.set(pattern, handler);
    return this;
  }

  async connect(options: GsvDriverConnectOptions = {}): Promise<ConnectResult> {
    const deviceId = options.deviceId ?? this.options.deviceId;
    if (!deviceId?.trim()) {
      throw new Error("Driver deviceId is required");
    }

    const implementsList = this.resolveImplements(options.implements);
    if (implementsList.length === 0) {
      throw new Error("Driver requires at least one implementation");
    }

    this.ensureClientHandlers();
    this.stopKeepalive();
    this.connection = null;
    this.abortController.abort();

    const {
      deviceId: _deviceId,
      platform,
      version,
      implements: _implements,
      ...connectOptions
    } = options;
    void _deviceId;
    void _implements;

    const result = await this.client.connect({
      ...connectOptions,
      client: {
        id: deviceId.trim(),
        role: "driver",
        ...(platform ?? this.options.platform ? { platform: platform ?? this.options.platform } : {}),
        ...(version ?? this.options.version ? { version: version ?? this.options.version } : {}),
      },
      driver: {
        implements: implementsList,
      },
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
  }

  private resolveImplements(connectImplements?: GsvDriverPattern[]): string[] {
    const source = connectImplements ?? this.options.implements ?? Array.from(this.handlers.keys());
    return Array.from(new Set(source.map((pattern) => pattern.trim()).filter(Boolean)));
  }

  private ensureClientHandlers(): void {
    if (!this.unregisterRequestHandler) {
      this.unregisterRequestHandler = this.client.onRequest(
        async (frame, body) => await this.handleRequest(frame, body),
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
  }

  private async handleRequest(frame: GsvRequestFrame, body?: GsvBody): Promise<GsvResponse> {
    const handler = this.findHandler(frame.call);
    if (!handler) {
      throw new GsvRequestError(404, `Driver does not implement ${frame.call}`);
    }
    const connection = this.connection;
    if (!connection) {
      throw new GsvRequestError(503, "Driver is not connected");
    }

    const context: GsvDriverContext = {
      client: this.client,
      connection,
      binary: this.client.binary,
      abortSignal: this.abortController.signal,
      sendSignal: (signal, payload, seq) => this.client.sendSignal(signal, payload, seq),
    };

    return await handler({
      id: frame.id,
      call: frame.call,
      args: (frame.args ?? {}) as never,
      body,
      raw: frame,
    }, context);
  }

  private findHandler(call: string): GsvDriverHandler | null {
    const exact = this.handlers.get(call as GsvDriverPattern);
    if (exact) {
      return exact;
    }
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
    const intervalMs = keepalive.intervalMs ?? DEFAULT_DRIVER_KEEPALIVE_MS;
    const signal = keepalive.signal ?? "device.ping";
    const payload = keepalive.payload ?? (() => ({ at: Date.now() }));
    this.keepaliveTimer = globalThis.setInterval(() => {
      if (!this.client.isConnected()) {
        return;
      }
      try {
        this.client.sendSignal(signal, payload());
      } catch {
        // The status listener will handle socket teardown.
      }
    }, intervalMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      globalThis.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

export interface GSVClient extends GsvClientNamespaces {}

export type GsvClient = GSVClient;

export function createGsvClient(options?: GsvClientOptions): GSVClient {
  return new GSVClient(options);
}

export { GSVClient as GSV };

function assignNamespaces(target: Record<string, unknown>, call: GsvClientCall): void {
  for (const syscall of SYSCALL_NAMES) {
    const parts = syscall.split(".");
    let cursor = target;

    for (const part of parts.slice(0, -1)) {
      const existing = cursor[part];
      if (!existing || typeof existing !== "object") {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }

    const method = parts[parts.length - 1];
    cursor[method] = ((args: unknown = {}) => call(syscall, args as never)) as GsvSyscallMethod<typeof syscall>;
  }
}

function makeId(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseFrame(raw: string): GsvFrame | null {
  try {
    const parsed = JSON.parse(raw) as Partial<GsvFrame>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.type === "sig" && typeof parsed.signal === "string") {
      return parsed as GsvSignalFrame;
    }
    if (parsed.type === "res" && typeof parsed.id === "string" && typeof parsed.ok === "boolean") {
      return parsed as GsvResponseFrame;
    }
    if (parsed.type === "req" && typeof parsed.id === "string" && typeof parsed.call === "string") {
      return parsed as GsvRequestFrame;
    }
    return null;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WEBSOCKET_OPEN || socket.readyState === WEBSOCKET_CONNECTING) {
    socket.close(code, reason);
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return fallback;
}

function errorCode(value: unknown): number {
  if (value instanceof GsvRequestError || value instanceof GsvClientError) {
    return value.code ?? 500;
  }
  return 500;
}

function errorDetails(value: unknown): unknown {
  if (value instanceof GsvRequestError || value instanceof GsvClientError) {
    return value.details;
  }
  return undefined;
}

function errorRetryable(value: unknown): boolean | undefined {
  if (value instanceof GsvRequestError || value instanceof GsvClientError) {
    return value.retryable;
  }
  return undefined;
}

function errorFrame(
  id: string,
  code: number,
  message: string,
  details?: unknown,
  retryable?: boolean,
): GsvResponseFrame {
  return {
    type: "res",
    id,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(retryable === undefined ? {} : { retryable }),
    },
  };
}

async function normalizeBinaryMessage(raw: unknown): Promise<ArrayBuffer | null> {
  if (raw instanceof ArrayBuffer) {
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    return await raw.arrayBuffer();
  }
  return null;
}

async function* binaryChunks(source: GsvBinarySource, chunkSize: number): AsyncIterable<Uint8Array> {
  assertPositiveInteger(chunkSize, "chunkSize");
  if (isBinaryBuffer(source)) {
    yield* chunkBuffer(toUint8Array(source), chunkSize);
    return;
  }

  if (isReadableStream(source)) {
    const reader = source.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          yield* chunkBuffer(value, chunkSize);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  for await (const chunk of source) {
    yield* chunkBuffer(toUint8Array(chunk), chunkSize);
  }
}

function* chunkBuffer(bytes: Uint8Array, chunkSize: number): Iterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}

function isBinaryBuffer(value: unknown): value is Uint8Array | ArrayBuffer | ArrayBufferView {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof value === "object" && "getReader" in value);
}

function toUint8Array(value: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function assertBinaryStreamId(streamId: number): void {
  if (!Number.isSafeInteger(streamId) || streamId <= 0 || streamId > 0xffffffff) {
    throw new Error(`Invalid binary stream id: ${streamId}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertBodyLength(length: number | undefined): void {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
    throw new Error(`Invalid body length: ${length}`);
  }
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
