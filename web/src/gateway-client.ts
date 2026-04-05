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

type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewaySignalFrame;

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

export type UserSessionToken = {
  tokenId: string;
  token: string;
  expiresAt: number | null;
};

export type ProcSendResult =
  | { ok: true; status: "started"; runId: string; queued?: boolean }
  | { ok: false; error: string };

export type ProcSpawnArgs = {
  profile: "init" | "task" | "cron" | "mcp" | "app";
  label?: string;
  prompt?: string;
  parentPid?: string;
  workspace?: {
    mode: "none" | "new" | "inherit" | "attach";
    label?: string;
    kind?: "thread" | "app" | "shared";
    workspaceId?: string;
  };
};

export type ProcSpawnResult =
  | {
      ok: true;
      pid: string;
      label?: string;
      profile: "init" | "task" | "cron" | "mcp" | "app";
      workspaceId: string | null;
      cwd: string;
    }
  | { ok: false; error: string };

export type ProcHistoryResult =
  | {
      ok: true;
      pid: string;
      messages: Array<{
        role: "user" | "assistant" | "system" | "toolResult";
        content: unknown;
        timestamp?: number;
      }>;
      messageCount: number;
      truncated?: boolean;
    }
  | { ok: false; error: string };

export type GatewayClientLike = {
  getStatus: () => GatewayClientStatus;
  isConnected: () => boolean;
  onSignal: (listener: (signal: string, payload: unknown) => void) => () => void;
  onStatus: (listener: (status: GatewayClientStatus) => void) => () => void;
  call: <T = unknown>(call: string, args?: unknown) => Promise<T>;
  spawnProcess: (args: ProcSpawnArgs) => Promise<ProcSpawnResult>;
  sendMessage: (message: string, pid?: string) => Promise<ProcSendResult>;
  getHistory: (limit?: number, pid?: string, offset?: number) => Promise<ProcHistoryResult>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  call: string;
};

const REQUEST_TIMEOUT_MS = 20_000;

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

export class GatewayClient implements GatewayClientLike {
  private socket: WebSocket | null = null;
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

  async connectUser(options: GatewayConnectOptions): Promise<GatewayConnectResult> {
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
    this.setStatus({
      state: "connecting",
      url,
      username,
      connectionId: null,
      message: "Opening WebSocket...",
    });

    const socket = await this.openSocket(url);
    this.socket = socket;
    this.attachSocket(socket);

    let connectResult: GatewayConnectResult;
    try {
      connectResult = (await this.request("sys.connect", {
        protocol: 1,
        client: {
          id: "gsv-ui",
          version: "0.1.0",
          platform: "browser",
          role: "user",
        },
        auth: {
          username,
          ...(token ? { token } : { password }),
        },
      })) as GatewayConnectResult;
    } catch (error) {
      this.disconnect();
      throw error;
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

  async sendMessage(message: string, pid?: string): Promise<ProcSendResult> {
    const result = (await this.call("proc.send", {
      message,
      ...(pid ? { pid } : {}),
    })) as ProcSendResult;
    return result;
  }

  async spawnProcess(args: ProcSpawnArgs): Promise<ProcSpawnResult> {
    const result = (await this.call("proc.spawn", args)) as ProcSpawnResult;
    return result;
  }

  async getHistory(limit = 50, pid?: string, offset?: number): Promise<ProcHistoryResult> {
    const result = (await this.call("proc.history", {
      limit,
      ...(typeof offset === "number" ? { offset } : {}),
      ...(pid ? { pid } : {}),
    })) as ProcHistoryResult;
    return result;
  }

  async createUserSessionToken(expiresAt: number): Promise<UserSessionToken> {
    const raw = (await this.call("sys.token.create", {
      kind: "user",
      label: "gsv-ui-session",
      allowedRole: "user",
      expiresAt,
    })) as {
      token?: {
        tokenId?: unknown;
        token?: unknown;
        expiresAt?: unknown;
      };
    };

    const tokenId = raw.token?.tokenId;
    const token = raw.token?.token;
    const rawExpiresAt = raw.token?.expiresAt;

    if (typeof tokenId !== "string" || typeof token !== "string") {
      throw new Error("sys.token.create returned invalid token payload");
    }

    return {
      tokenId,
      token,
      expiresAt: typeof rawExpiresAt === "number" ? rawExpiresAt : null,
    };
  }

  async revokeToken(tokenId: string, reason = "ui session lock"): Promise<boolean> {
    const raw = (await this.call("sys.token.revoke", {
      tokenId,
      reason,
    })) as { revoked?: unknown };

    return raw.revoked === true;
  }

  async call<T = unknown>(call: string, args: unknown = {}): Promise<T> {
    return (await this.request(call, args)) as T;
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
    const socket = new WebSocket(url);

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

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${call}`));
      }, REQUEST_TIMEOUT_MS);

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

  private handleRawMessage(raw: unknown): void {
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

export function createGatewayClient(): GatewayClient {
  return new GatewayClient();
}
