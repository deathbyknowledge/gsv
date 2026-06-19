import type {
  ArgsOf,
  ConnectArgs,
  ConnectResult,
  ResultOf,
  SyscallName,
} from "./protocol";

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

type RequestFrame = {
  type: "req";
  id: string;
  call: string;
  args: unknown;
};

type ResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: unknown;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: ErrorShape;
    };

type SignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
  seq?: number;
};

type Frame = ResponseFrame | SignalFrame;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: TimerHandle;
  call: string;
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
};

export type GsvAccountNamespace = GsvClientNamespaces["account"];
export type GsvAdapterNamespace = GsvClientNamespaces["adapter"];
export type GsvAiNamespace = GsvClientNamespaces["ai"];
export type GsvAppNamespace = GsvClientNamespaces["app"];
export type GsvCodeModeNamespace = GsvClientNamespaces["codemode"];
export type GsvFsNamespace = GsvClientNamespaces["fs"];
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
  "ai.transcription.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
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
  "sys.connect",
  "sys.setup.assist",
  "sys.setup",
  "sys.bootstrap",
  "sys.config.get",
  "sys.config.set",
  "sys.device.list",
  "sys.device.get",
  "sys.device.update",
  "sys.oauth.start",
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
  "ai.transcription.create",
  "ai.speech.create",
  "adapter.connect",
  "adapter.disconnect",
  "adapter.inbound",
  "adapter.state.update",
  "adapter.send",
  "adapter.status",
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

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "GsvClientError";
    this.code = error.code;
    this.details = error.details;
    this.retryable = error.retryable;
  }
}

export class GSVClient {
  readonly call: GsvClientCall;

  private readonly WebSocketCtor: GsvWebSocketConstructor | null;
  private readonly connectDefaults: GsvConnectOptions;
  private readonly connectTimeoutMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly requestTimeoutsMs: Record<string, number>;
  private socket: WebSocket | null = null;
  private socketEpoch = 0;
  private pending = new Map<string, PendingRequest>();
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
    this.call = (async (call: string, args: unknown = {}) => {
      return await this.request(call, args);
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
      connectResult = await this.request("sys.connect", {
        protocol: 1,
        client: merged.client,
        ...(merged.driver ? { driver: merged.driver } : {}),
        auth: {
          username,
          ...(token ? { token } : { password }),
        },
      }) as ConnectResult;
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

  disconnect(): void {
    this.socketEpoch += 1;
    const socket = this.socket;
    this.socket = null;

    if (socket) {
      closeSocket(socket, 1000, "client disconnect");
    }

    this.rejectAllPending(new Error("Disconnected"));
    this.setStatus({
      state: "disconnected",
      url: null,
      username: null,
      connectionId: null,
      message: null,
    });
  }

  close(): void {
    this.disconnect();
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
      this.handleRawMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.rejectAllPending(new Error("Connection closed"));
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

  private request(call: string, args: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("Not connected");
    }

    const id = makeId();
    const frame: RequestFrame = { type: "req", id, call, args };
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
      } catch (error) {
        this.pending.delete(id);
        globalThis.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error("Failed to send request"));
      }
    });
  }

  private requestOverSocket<T>(socket: WebSocket, call: string, args: unknown): Promise<T> {
    const id = makeId();
    const frame: RequestFrame = { type: "req", id, call, args };
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

  private handleRawMessage(raw: unknown): void {
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

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    this.pending.delete(parsed.id);
    globalThis.clearTimeout(pending.timeoutId);

    if (parsed.ok) {
      pending.resolve(parsed.data ?? {});
      return;
    }

    pending.reject(new GsvClientError(parsed.error));
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

function parseFrame(raw: string): Frame | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Frame>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.type === "sig" && typeof parsed.signal === "string") {
      return parsed as SignalFrame;
    }
    if (parsed.type === "res" && typeof parsed.id === "string" && typeof parsed.ok === "boolean") {
      return parsed as ResponseFrame;
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
