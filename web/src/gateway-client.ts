import type {
  SysSetupAssistArgs,
  SysSetupAssistResult,
  SysBootstrapArgs,
  SysBootstrapResult,
  SysSetupArgs,
  SysSetupResult,
} from "@gsv/protocol/syscalls/system";
import type { ProcMediaInput } from "@gsv/protocol/syscalls/proc";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  BINARY_FRAME_ERROR,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@gsv/protocol/binary-frame";

type GatewayErrorShape = {
  code: number;
  message: string;
  details?: unknown;
};

export type GatewayRequestFrame = {
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
  /** Account to run as: username, uid, or `package#agent`. Defaults to the caller's personal agent. */
  runAs?: string;
  label?: string;
  prompt?: string;
  parentPid?: string;
  cwd?: string;
};

export type ProcSpawnResult =
  | {
      ok: true;
      pid: string;
      label?: string;
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
  onRequest: (call: string, handler: GatewayRequestHandler) => () => void;
  call: <T = unknown>(call: string, args?: unknown) => Promise<T>;
  allocateBinaryStreamId: () => number;
  openBinaryStream: (streamId: number, timeoutMs?: number) => {
    stream: ReadableStream<Uint8Array>;
    cancel: (reason?: string) => void;
  };
  sendBinaryFrame: (streamId: number, flags: number, payload?: Uint8Array) => void;
  spawnProcess: (args: ProcSpawnArgs) => Promise<ProcSpawnResult>;
  sendMessage: (message: string, pid?: string, media?: ProcMediaInput[]) => Promise<ProcSendResult>;
  getHistory: (limit?: number, pid?: string, offset?: number) => Promise<ProcHistoryResult>;
  probeSetupMode: (url: string) => Promise<boolean>;
  setupSystem: (url: string, args: SysSetupArgs) => Promise<SysSetupResult>;
  bootstrapSystem: (args?: SysBootstrapArgs) => Promise<SysBootstrapResult>;
};

export type GatewayRequestHandler = (frame: GatewayRequestFrame) => Promise<unknown> | unknown;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  call: string;
};

type PendingBinaryStream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timeoutId: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_BINARY_TIMEOUT_MS = 20_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  "sys.setup": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "sys.bootstrap": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "fs.copy": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "fs.transfer.send": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "fs.transfer.receive": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.transcription.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
  "ai.speech.create": LONG_RUNNING_REQUEST_TIMEOUT_MS,
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

function requestTimeoutMs(call: string): number {
  return REQUEST_TIMEOUTS_MS[call] ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

async function normalizeBinaryMessage(raw: unknown): Promise<ArrayBuffer | ArrayBufferView | null> {
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return raw;
  }
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    return await raw.arrayBuffer();
  }
  return null;
}

export class GatewayClient implements GatewayClientLike {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private pendingBinaryStreams = new Map<number, PendingBinaryStream>();
  private signalListeners = new Set<(signal: string, payload: unknown) => void>();
  private statusListeners = new Set<(status: GatewayClientStatus) => void>();
  private requestHandlers = new Map<string, Set<GatewayRequestHandler>>();
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

  onRequest(call: string, handler: GatewayRequestHandler): () => void {
    const key = call.trim();
    if (!key) {
      throw new Error("Request handler call is required");
    }
    const handlers = this.requestHandlers.get(key) ?? new Set<GatewayRequestHandler>();
    handlers.add(handler);
    this.requestHandlers.set(key, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.requestHandlers.delete(key);
      }
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
          version: "0.2.4",
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

  async sendMessage(message: string, pid?: string, media?: ProcMediaInput[]): Promise<ProcSendResult> {
    const result = (await this.call("proc.send", {
      message,
      ...(pid ? { pid } : {}),
      ...(media && media.length > 0 ? { media } : {}),
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

  async probeSetupMode(url: string): Promise<boolean> {
    try {
      await this.callWithoutConnect(url, "sys.connect", {
        protocol: 1,
        client: {
          id: "gsv-ui-setup-probe",
          version: "0.2.4",
          platform: "browser",
          role: "user",
        },
      });
      return false;
    } catch (error) {
      const rpcError = error as Error & { code?: number; details?: unknown };
      if (rpcError.code === 425) {
        return true;
      }
      if (
        rpcError.details &&
        typeof rpcError.details === "object" &&
        (rpcError.details as { setupMode?: unknown }).setupMode === true
      ) {
        return true;
      }
      return false;
    }
  }

  async setupSystem(url: string, args: SysSetupArgs): Promise<SysSetupResult> {
    return await this.callWithoutConnect<SysSetupResult>(url, "sys.setup", args);
  }

  async setupAssist(url: string, args: SysSetupAssistArgs): Promise<SysSetupAssistResult> {
    return await this.callWithoutConnect<SysSetupAssistResult>(url, "sys.setup.assist", args);
  }

  async bootstrapSystem(args: SysBootstrapArgs = {}): Promise<SysBootstrapResult> {
    return await this.call<SysBootstrapResult>("sys.bootstrap", args);
  }

  async call<T = unknown>(call: string, args: unknown = {}): Promise<T> {
    return (await this.request(call, args)) as T;
  }

  allocateBinaryStreamId(): number {
    const values = new Uint32Array(1);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      crypto.getRandomValues(values);
      const streamId = values[0];
      if (streamId > 0 && !this.pendingBinaryStreams.has(streamId)) {
        return streamId;
      }
    }
    throw new Error("Unable to allocate binary stream id");
  }

  openBinaryStream(streamId: number, timeoutMs = DEFAULT_BINARY_TIMEOUT_MS): {
    stream: ReadableStream<Uint8Array>;
    cancel: (reason?: string) => void;
  } {
    if (!Number.isSafeInteger(streamId) || streamId <= 0 || streamId > 0xffffffff) {
      throw new Error(`Invalid binary stream id: ${streamId}`);
    }
    if (this.pendingBinaryStreams.has(streamId)) {
      throw new Error(`Binary stream already pending: ${streamId}`);
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timeoutId = window.setTimeout(() => {
          this.rejectBinaryStream(streamId, `Binary transfer timed out: ${streamId}`);
        }, timeoutMs);
        this.pendingBinaryStreams.set(streamId, { controller, timeoutId });
      },
      cancel: () => {
        this.clearBinaryStream(streamId);
      },
    });

    return {
      stream,
      cancel: (reason = "Binary transfer cancelled") => {
        this.rejectBinaryStream(streamId, reason);
      },
    };
  }

  sendBinaryFrame(streamId: number, flags: number, payload: Uint8Array = new Uint8Array()): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    socket.send(buildBinaryFrame(streamId, flags, payload));
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

  private async callWithoutConnect<T>(url: string, call: string, args: unknown): Promise<T> {
    const socket = await this.openSocket(url);
    try {
      return await this.requestOverSocket<T>(socket, call, args);
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "ephemeral request complete");
      }
    }
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
      await this.handleBinaryMessage(raw);
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

    if (parsed.type === "req") {
      void this.handleIncomingRequest(parsed);
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

  private async handleBinaryMessage(raw: unknown): Promise<void> {
    const data = await normalizeBinaryMessage(raw);
    if (!data) {
      return;
    }
    const frame = parseBinaryFrame(data);
    if (!frame) {
      return;
    }

    const pendingStream = this.pendingBinaryStreams.get(frame.streamId);
    if (pendingStream) {
      if ((frame.flags & BINARY_FRAME_ERROR) !== 0) {
        const message = new TextDecoder().decode(frame.payload) || "Binary transfer failed";
        this.rejectBinaryStream(frame.streamId, message);
        return;
      }
      if ((frame.flags & BINARY_FRAME_DATA) !== 0 && frame.payload.byteLength > 0) {
        pendingStream.controller.enqueue(frame.payload);
      }
      if ((frame.flags & BINARY_FRAME_END) !== 0) {
        this.closeBinaryStream(frame.streamId);
      }
      return;
    }
  }

  private clearBinaryStream(streamId: number): PendingBinaryStream | null {
    const pending = this.pendingBinaryStreams.get(streamId);
    if (!pending) {
      return null;
    }
    this.pendingBinaryStreams.delete(streamId);
    window.clearTimeout(pending.timeoutId);
    return pending;
  }

  private closeBinaryStream(streamId: number): void {
    const pending = this.clearBinaryStream(streamId);
    pending?.controller.close();
  }

  private rejectBinaryStream(streamId: number, reason: string): void {
    const pending = this.clearBinaryStream(streamId);
    pending?.controller.error(new Error(reason));
  }

  private async handleIncomingRequest(frame: GatewayRequestFrame): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const handlers = this.requestHandlers.get(frame.call);
    const handler = handlers?.values().next().value;
    if (!handler) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: 404, message: `No browser handler for ${frame.call}` },
      });
      return;
    }

    try {
      const data = await handler(frame);
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        data,
      });
    } catch (error) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: 500,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private sendResponse(socket: WebSocket, frame: GatewayResponseFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The route will timeout on the gateway if the browser cannot respond.
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingBinaryStreams.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.controller.error(error);
    }
    this.pendingBinaryStreams.clear();
  }
}

export function createGatewayClient(): GatewayClient {
  return new GatewayClient();
}
