import {
  catalogOp, connect as connectOp, frameSchema, parseResult, PROTOCOL, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX,
  type Args, type CatalogName, type Feed, type GsvError, type JsonValue, type ResFrame, type Result,
} from "@gsv/catalog";

/** A failed call. Decide on `code` and `retryable`; `message` is for people. */
export class GsvRequestError extends Error {
  readonly code: GsvError["code"];
  readonly retryable: boolean;
  readonly error: GsvError;
  constructor(error: GsvError) {
    super(error.message);
    this.name = "GsvRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.error = error;
  }
}

export type ConnectOptions = {
  /** The space's hostname, such as `alice.example.com`. */
  host: string;
  /** A session token, or a function that returns a fresh one; the SDK calls it again after `unauthorized`. */
  token: string | (() => Promise<string>);
  client?: { name: string; version: string; platform: string };
  watches?: Feed[];
  /** `ws:` for local development hosts; `wss:` everywhere else. */
  insecure?: boolean;
  WebSocket?: SocketConstructor;
  /** Reconnect waits and the random source for jitter; tests make them deterministic. */
  backoff?: { baseMs?: number; maxMs?: number; random?: () => number };
};

/** What the SDK uses of a WebSocket; the browser's and Node's both fit. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};
export type SocketConstructor = new (url: string, protocols: string[]) => SocketLike;

type Pending = { frame: string; resolve(result: JsonValue): void; reject(error: Error): void };
type TokenSource = () => Promise<string>;
type Deferred = { promise: Promise<void>; settled: boolean; resolve(): void; reject(error: Error): void };

const CLOSE_CODES = new Map<number, GsvError["code"]>([[4401, "unauthorized"], [4409, "moved"], [4426, "upgrade_required"]]);
const PING_MS = 30_000;

/**
 * One control socket to one owner. Calls wait while the socket is down and go out again with their op
 * ids after the next `connect`, so the owner runs an effect at most once.
 */
export class GsvSocket {
  info: Result<"connect"> | undefined;
  private readonly options: ConnectOptions;
  private socket: SocketLike | undefined;
  private readonly pending = new Map<string, Pending>();
  /** Set once the connection ends for good; every later call fails with it. */
  private terminal: Error | undefined;
  private attempt = 0;
  private refreshed = false;
  private ping: ReturnType<typeof setInterval> | undefined;
  private handshakeId: string | undefined;
  /** Settles when the current socket answers `connect`; a new one is armed only after the last settled. */
  private ready: Deferred = deferred();

  constructor(options: ConnectOptions) {
    this.options = options;
  }

  /** Opens the socket and sends `connect`; resolves once the owner answered. */
  async open(): Promise<Result<"connect">> {
    const ready = this.ready.promise;
    this.redial();
    await ready;
    if (!this.info) throw new Error("Connected without a connect result");
    return this.info;
  }

  /** Calls one operation, retrying what the server marks retryable within the operation's timeout. */
  async call<N extends CatalogName>(op: N, args: Args<N>, opts: { opId?: string } = {}): Promise<Result<N>> {
    const deadline = Date.now() + catalogOp(op).timeoutMs;
    const id = opts.opId ?? crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        return parseResult(op, await this.send(id, op, args));
      } catch (cause) {
        if (!(cause instanceof GsvRequestError) || !cause.retryable || this.terminal) throw cause;
        const wait = cause.error.retryAfterMs ?? this.delay(attempt);
        if (Date.now() + wait >= deadline) throw cause;
        await sleep(wait);
      }
    }
  }

  close(): void {
    this.end(new GsvRequestError({ code: "cancelled", message: "The connection was closed.", retryable: false }));
    this.socket?.close(1000, "Closed by the client");
  }

  private send(id: string, op: CatalogName, args: Args<CatalogName>): Promise<JsonValue> {
    if (this.terminal) return Promise.reject(this.terminal);
    return new Promise((resolve, reject) => {
      const frame = JSON.stringify({ t: "req", id, op, args });
      this.pending.set(id, { frame, resolve, reject });
      if (this.info && this.socket?.readyState === 1) this.socket.send(frame);
    });
  }

  private redial(): void {
    this.dial().catch((cause: unknown) => this.end(cause instanceof Error ? cause : new Error(String(cause))));
  }

  private async dial(): Promise<void> {
    const token = isTokenSource(this.options.token) ? await this.options.token() : this.options.token;
    if (this.terminal) return;
    const Socket: SocketConstructor = this.options.WebSocket ?? globalThis.WebSocket;
    const socket = new Socket(`${this.options.insecure ? "ws" : "wss"}://${this.options.host}/_gsv/socket`, [SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${token}`]);
    this.socket = socket;
    this.info = undefined;
    socket.onopen = () => { void this.handshake(socket); };
    socket.onmessage = event => this.receive(String(event.data));
    socket.onclose = event => this.lost(socket, event.code);
  }

  private async handshake(socket: SocketLike): Promise<void> {
    const id = crypto.randomUUID();
    this.handshakeId = id;
    const args: Args<"connect"> = { protocol: PROTOCOL, client: this.options.client ?? { name: "gsv-sdk", version: "0", platform: "js" } };
    if (this.options.watches) args.watches = this.options.watches;
    const frame = JSON.stringify({ t: "req", id, op: connectOp.name, args });
    const answered = new Promise<JsonValue>((resolve, reject) => this.pending.set(id, { frame, resolve, reject }));
    socket.send(frame);
    let info: Result<"connect">;
    try { info = connectOp.result.parse(await answered); } catch { return; }
    if (socket !== this.socket) return;
    this.info = info;
    this.attempt = 0;
    this.refreshed = false;
    clearInterval(this.ping);
    this.ping = setInterval(() => { if (socket.readyState === 1) socket.send("ping"); }, PING_MS);
    // Calls made while the socket was down, or lost with the last one, go out again with their op ids.
    for (const pending of this.pending.values()) socket.send(pending.frame);
    this.ready.resolve();
  }

  private receive(data: string): void {
    if (data === "pong") return;
    let raw: JsonValue;
    try { raw = JSON.parse(data); } catch { return; }
    const parsed = frameSchema.safeParse(raw);
    if (!parsed.success || parsed.data.t !== "res") return;
    const frame: ResFrame = parsed.data;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new GsvRequestError(frame.error));
  }

  private lost(socket: SocketLike, code: number): void {
    if (socket !== this.socket || this.terminal) return;
    clearInterval(this.ping);
    if (this.handshakeId) this.pending.delete(this.handshakeId);
    this.info = undefined;
    const refused = CLOSE_CODES.get(code);
    // One fresh token is worth a try; anything else the owner refused ends the connection.
    const refresh = refused === "unauthorized" && isTokenSource(this.options.token) && !this.refreshed;
    if (refused && !refresh) {
      this.end(new GsvRequestError({ code: refused, message: `The connection was refused: ${refused}.`, retryable: false }));
      return;
    }
    if (refresh) this.refreshed = true;
    if (this.ready.settled) this.ready = deferred();
    setTimeout(() => { if (!this.terminal) this.redial(); }, refresh ? 0 : this.delay(this.attempt++));
  }

  private end(error: Error): void {
    if (this.terminal) return;
    this.terminal = error;
    clearInterval(this.ping);
    this.ready.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** Full jitter: a random wait up to an exponentially growing cap. */
  private delay(attempt: number): number {
    const { baseMs = 250, maxMs = 30_000, random = Math.random } = this.options.backoff ?? {};
    return Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
  }
}

function deferred(): Deferred {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  promise.catch(() => {});
  const result: Deferred = {
    promise,
    settled: false,
    resolve: () => { result.settled = true; resolve(); },
    reject: error => { result.settled = true; reject(error); },
  };
  return result;
}

function isTokenSource(token: string | TokenSource): token is TokenSource {
  return typeof token === "function";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
