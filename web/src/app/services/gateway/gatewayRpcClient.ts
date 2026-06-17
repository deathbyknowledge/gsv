type GatewayErrorShape = {
  code: number;
  message: string;
  details?: unknown;
};

type GatewayRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args: unknown;
};

type GatewayResponseFrame =
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
      error: GatewayErrorShape;
    };

type GatewaySignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
  seq?: number;
};

type GatewayFrame = GatewayResponseFrame | GatewaySignalFrame;

export type GatewayClientStatus = {
  state: "disconnected" | "connecting" | "connected";
  url: string | null;
  username: string | null;
  connectionId: string | null;
  message: string | null;
};

export type GatewayConnectOptions = {
  url: string;
  username: string;
  password?: string;
  token?: string;
};

export type GatewayConnectResult = {
  protocol: number;
  server: {
    version: string;
    connectionId: string;
  };
  identity: unknown;
  syscalls: string[];
  signals: string[];
};

export type GatewayClientIdentity = {
  id: string;
  version: string;
  platform: string;
  role: "user";
};

export type GatewayRpcClientOptions = {
  client?: Partial<GatewayClientIdentity>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  call: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  "sys.setup": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "sys.bootstrap": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.transcription.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.speech.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
};

const DEFAULT_CLIENT_IDENTITY: GatewayClientIdentity = {
  id: "gsv-ui",
  version: "0.2.6",
  platform: "browser",
  role: "user",
};

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeMessage(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return "Gateway request failed";
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

function requestTimeoutMs(call: string): number {
  return REQUEST_TIMEOUTS_MS[call] ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

export class GatewayRpcClient {
  private readonly clientIdentity: GatewayClientIdentity;
  private socket: WebSocket | null = null;
  private socketEpoch = 0;
  private pending = new Map<string, PendingRequest>();
  private signalListeners = new Set<(signal: string, payload: unknown) => void>();
  private statusListeners = new Set<(status: GatewayClientStatus) => void>();
  private status: GatewayClientStatus = {
    state: "disconnected",
    url: null,
    username: null,
    connectionId: null,
    message: null,
  };

  constructor(options: GatewayRpcClientOptions = {}) {
    this.clientIdentity = {
      ...DEFAULT_CLIENT_IDENTITY,
      ...options.client,
    };
  }

  getStatus(): GatewayClientStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status.state === "connected" && this.socket?.readyState === WebSocket.OPEN;
  }

  onSignal(listener: (signal: string, payload: unknown) => void): () => void {
    this.signalListeners.add(listener);
    return () => {
      this.signalListeners.delete(listener);
    };
  }

  onStatus(listener: (status: GatewayClientStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  async connect(options: GatewayConnectOptions): Promise<GatewayConnectResult> {
    const url = options.url.trim();
    const username = options.username.trim();
    const password = options.password?.trim() ?? "";
    const token = options.token?.trim() ?? "";

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
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "connection cancelled");
      }
      throw new Error("Connection cancelled");
    }

    this.socket = socket;
    this.attachSocket(socket);

    let connectResult: GatewayConnectResult;
    try {
      connectResult = (await this.request("sys.connect", {
        protocol: 1,
        client: this.clientIdentity,
        auth: {
          username,
          ...(token ? { token } : { password }),
        },
      })) as GatewayConnectResult;
    } catch (error) {
      if (this.socketEpoch === socketEpoch) {
        this.disconnect();
      }
      throw error;
    }

    if (this.socketEpoch !== socketEpoch || this.socket !== socket) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "connection cancelled");
      }
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

  async connectUser(options: GatewayConnectOptions): Promise<GatewayConnectResult> {
    return await this.connect(options);
  }

  disconnect(): void {
    this.socketEpoch += 1;
    const socket = this.socket;
    this.socket = null;

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "client disconnect");
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

  async call<T = unknown>(call: string, args: unknown = {}): Promise<T> {
    return (await this.request(call, args)) as T;
  }

  protected async callWithoutConnect<T>(url: string, call: string, args: unknown): Promise<T> {
    const socket = await this.openSocket(url);
    try {
      return await this.requestOverSocket<T>(socket, call, args);
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "request complete");
      }
    }
  }

  private setStatus(next: GatewayClientStatus): void {
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
      void this.handleRawMessage(event.data);
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
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("WebSocket connect timed out"));
      }, 8_000);

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
        window.clearTimeout(timeoutId);
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
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = makeId();
    const frame: GatewayRequestFrame = { type: "req", id, call, args };
    const timeoutMs = requestTimeoutMs(call);

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
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
        window.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error("Failed to send request"));
      }
    });
  }

  private requestOverSocket<T>(socket: WebSocket, call: string, args: unknown): Promise<T> {
    const id = makeId();
    const frame: GatewayRequestFrame = { type: "req", id, call, args };
    const timeoutMs = requestTimeoutMs(call);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${call}`));
      }, timeoutMs);

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
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

        let parsed: GatewayFrame;
        try {
          parsed = JSON.parse(event.data) as GatewayFrame;
        } catch {
          return;
        }

        if (parsed.type !== "res" || parsed.id !== id) {
          return;
        }

        cleanup();

        if (parsed.ok) {
          resolve((parsed.data ?? {}) as T);
          return;
        }

        const message = normalizeMessage(parsed.error?.message);
        const error = new Error(message);
        (error as Error & { code?: number; details?: unknown }).code = parsed.error?.code;
        (error as Error & { code?: number; details?: unknown }).details = parsed.error?.details;
        reject(error);
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
    if (typeof raw !== "string") {
      return;
    }

    let parsed: GatewayFrame;
    try {
      parsed = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    if (parsed.type === "sig") {
      for (const listener of this.signalListeners) {
        listener(parsed.signal, parsed.payload);
      }
      return;
    }

    if (parsed.type !== "res") {
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    this.pending.delete(parsed.id);
    window.clearTimeout(pending.timeoutId);

    if (parsed.ok) {
      pending.resolve(parsed.data);
      return;
    }

    const message = normalizeMessage(parsed.error?.message);
    const error = new Error(message);
    (error as Error & { code?: number; details?: unknown }).code = parsed.error?.code;
    (error as Error & { code?: number; details?: unknown }).details = parsed.error?.details;
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createGatewayRpcClient(options?: GatewayRpcClientOptions): GatewayRpcClient {
  return new GatewayRpcClient(options);
}
