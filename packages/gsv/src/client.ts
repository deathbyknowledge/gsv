import type {
  ArgsOf,
  BinaryBody,
  BodySyscallName,
  ConnectArgs,
  ConnectResult,
  ResultOf,
  SyscallName,
} from "./protocol";
import {
  REQUEST_CANCEL_SIGNAL,
  type RequestCancelPayload,
} from "./protocol/request-cancel";
import type { BinaryFrameDescriptor } from "./protocol/binary-frame";
import {
  BinaryBodyChannel,
  type OutgoingBinaryBody,
} from "./protocol/binary-body-channel";

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
  bodyAbort?: AbortController;
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
  <T = unknown>(call: string, args?: unknown): Promise<T>;
};

export type GsvClientInfo = ConnectArgs["client"];

export type GsvBody = BinaryBody;

export type GsvRequestOptions = {
  body?: GsvBody;
};

export type GsvResponse<T = unknown> = {
  data: T;
  body?: GsvBody;
};

export type GsvBodyOptions = {
  receiveTimeoutMs?: number;
  chunkSize?: number;
};

export type GsvInboundRequestHandler = (
  frame: GsvRequestFrame,
  body?: GsvBody,
  abortSignal?: AbortSignal,
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
  body?: GsvBodyOptions;
};

export type GsvAccountNamespace = GsvClientNamespaces["account"];
export type GsvAdapterNamespace = GsvClientNamespaces["adapter"];
export type GsvAiNamespace = GsvClientNamespaces["ai"];
export type GsvAppNamespace = GsvClientNamespaces["app"];
export type GsvCodeModeNamespace = GsvClientNamespaces["codemode"];
export type GsvFsNamespace = GsvClientNamespaces["fs"];
export type GsvNetNamespace = never;
export type GsvNotificationNamespace = GsvClientNamespaces["notification"];
export type GsvPkgNamespace = GsvClientNamespaces["pkg"];
export type GsvProcNamespace = GsvClientNamespaces["proc"];
export type GsvRepoNamespace = GsvClientNamespaces["repo"];
export type GsvSchedNamespace = GsvClientNamespaces["sched"];
export type GsvShellNamespace = GsvClientNamespaces["shell"];
export type GsvSignalNamespace = GsvClientNamespaces["signal"];
export type GsvSysNamespace = GsvClientNamespaces["sys"];

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const PROTOCOL_VERSION = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 120_000;
const AI_TEXT_GENERATION_REQUEST_TIMEOUT_MS = 180_000;
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
  "proc.media.write": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.text.generate": AI_TEXT_GENERATION_REQUEST_TIMEOUT_MS,
  "ai.transcription.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.image.read": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.image.generate": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.speech.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
};

const DEFAULT_CLIENT_INFO: GsvClientInfo = {
  id: "gsv-js",
  version: "0.0.6",
  platform: "javascript",
  role: "user",
};

const SYSCALL_NAMES = [
  "fs.write",
  "fs.edit",
  "fs.delete",
  "fs.search",
  "fs.copy",
  "fs.transfer.stat",
  "shell.exec",
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
  "proc.media.delete",
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
] as const satisfies readonly NamespaceSyscall[];

type MissingSyscalls = Exclude<NamespaceSyscall, typeof SYSCALL_NAMES[number]>;
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

  private readonly WebSocketCtor: GsvWebSocketConstructor | null;
  private readonly connectDefaults: GsvConnectOptions;
  private readonly connectTimeoutMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly requestTimeoutsMs: Record<string, number>;
  private readonly bodyChannel: BinaryBodyChannel;
  private socket: WebSocket | null = null;
  private socketEpoch = 0;
  private pending = new Map<string, PendingRequest>();
  private inboundRequests = new Map<string, AbortController>();
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
    this.call = (async (call: string, args: unknown = {}) => {
      const response = await this.request(call, args);
      if (response.body) {
        await response.body.stream.cancel().catch(() => {});
        throw new Error(`${call} returned a body; use client.request()`);
      }
      return response.data;
    }) as GsvClientCall;
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
        protocol: PROTOCOL_VERSION,
        client: merged.client,
        ...(merged.driver ? { driver: merged.driver } : {}),
        auth: {
          username,
          ...(token ? { token } : { password }),
        },
      })).data as ConnectResult;
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
    const socket = this.socket;
    this.socket = null;

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

  async requestOnce<S extends NamespaceSyscall>(
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
    const outgoing = body ? this.bodyChannel.prepare(body) : undefined;
    const frame: GsvRequestFrame = {
      type: "req",
      id,
      call,
      args,
      ...(outgoing ? { body: outgoing.descriptor } : {}),
    };
    const timeoutMs = this.requestTimeoutMs(call);
    const bodyAbort = body ? new AbortController() : undefined;

    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        const error = new Error(`Request timed out after ${timeoutMs}ms: ${call}`);
        try {
          socket.send(JSON.stringify({
            type: "sig",
            signal: REQUEST_CANCEL_SIGNAL,
            payload: { id, reason: error.message },
          } satisfies GsvSignalFrame));
        } catch {}
        bodyAbort?.abort(error);
        reject(error);
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeoutId,
        call,
        bodyAbort,
      });

      try {
        socket.send(JSON.stringify(frame));
        if (outgoing) {
          void outgoing.send(bodyAbort?.signal).catch((error) => {
            const pending = this.pending.get(id);
            if (!pending) {
              return;
            }
            this.pending.delete(id);
            globalThis.clearTimeout(pending.timeoutId);
            pending.bodyAbort?.abort(error);
            pending.reject(error instanceof Error ? error : new Error("Failed to send request body"));
          });
        }
      } catch (error) {
        this.pending.delete(id);
        globalThis.clearTimeout(timeoutId);
        bodyAbort?.abort(error);
        void outgoing?.cancel(error);
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
          if (parsed.body !== undefined) {
            reject(new Error(`${call} returned a body; requestOnce() only supports JSON responses`));
            return;
          }
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
      this.bodyChannel.handleFrame(binary);
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
      if (parsed.signal === REQUEST_CANCEL_SIGNAL) {
        const payload = parsed.payload as Partial<RequestCancelPayload> | null;
        if (payload && typeof payload === "object" && typeof payload.id === "string") {
          const controller = this.inboundRequests.get(payload.id);
          if (controller) {
            this.inboundRequests.delete(payload.id);
            const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
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

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      if (parsed.ok && parsed.body !== undefined) {
        try {
          await this.bodyChannel.receive(parsed.body).stream.cancel("Response is no longer pending");
        } catch {}
      }
      return;
    }

    this.pending.delete(parsed.id);
    globalThis.clearTimeout(pending.timeoutId);
    pending.bodyAbort?.abort(new Error(`Request completed: ${pending.call}`));

    if (parsed.ok) {
      try {
        pending.resolve({
          data: parsed.data ?? {},
          ...(parsed.body !== undefined ? { body: this.bodyChannel.receive(parsed.body) } : {}),
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
        this.sendJson({
          type: "res",
          id: frame.id,
          ok: true,
          data: response.data,
          ...(outgoing ? { body: outgoing.descriptor } : {}),
        });
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
      pending.bodyAbort?.abort(error);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private abortAllInbound(error: Error): void {
    for (const controller of this.inboundRequests.values()) {
      controller.abort(error);
    }
    this.inboundRequests.clear();
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
  }

  private async handleRequest(
    frame: GsvRequestFrame,
    body?: GsvBody,
    signal?: AbortSignal,
  ): Promise<GsvResponse> {
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
      abortSignal: signal
        ? AbortSignal.any([this.abortController.signal, signal])
        : this.abortController.signal,
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

function patternMatches(pattern: string, call: string): boolean {
  if (pattern === call) {
    return true;
  }
  if (!pattern.endsWith(".*")) {
    return false;
  }
  return call.startsWith(pattern.slice(0, -1));
}
