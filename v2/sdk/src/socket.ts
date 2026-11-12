import {
  CATALOG, connect as connectOp, frameSchema, PROTOCOL, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX,
  type Args, type CatalogName, type Feed, type GsvError, type ResFrame, type Result,
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
  WebSocket?: typeof WebSocket;
  /** Reconnect waits and the random source for jitter; tests make them deterministic. */
  backoff?: { baseMs?: number; maxMs?: number; random?: () => number };
};

type Pending = { frame: string; resolve(result: unknown): void; reject(error: Error): void };
type Deferred = { promise: Promise<void>; settled: boolean; resolve(): void; reject(error: Error): void };

const CLOSE_CODES: Record<number, GsvError["code"]> = { 4401: "unauthorized", 4409: "moved", 4426: "upgrade_required" };
const PING_MS = 30_000;

/**
 * One control socket to one owner. Calls wait while the socket is down and go out again with their op
 * ids after the next `connect`, so the owner runs an effect at most once.
 */
export class GsvSocket {
  info: Result<"connect"> | undefined;
  private readonly options: ConnectOptions;
  private socket: WebSocket | undefined;
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
    const deadline = Date.now() + (CATALOG.get(op)?.timeoutMs ?? 30_000);
    const id = opts.opId ?? crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(id, op, args) as Result<N>;
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

  private send(id: string, op: string, args: unknown): Promise<unknown> {
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
    const token = typeof this.options.token === "string" ? this.options.token : await this.options.token();
    if (this.terminal) return;
    const Socket = this.options.WebSocket ?? globalThis.WebSocket;
    const socket = new Socket(`${this.options.insecure ? "ws" : "wss"}://${this.options.host}/_gsv/socket`, [SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${token}`]);
    this.socket = socket;
    this.info = undefined;
    socket.addEventListener("open", () => { void this.handshake(socket); });
    socket.addEventListener("message", event => this.receive(event.data));
    socket.addEventListener("close", event => this.lost(socket, event.code));
  }

  private async handshake(socket: WebSocket): Promise<void> {
    const id = crypto.randomUUID();
    this.handshakeId = id;
    const args: Args<"connect"> = {
      protocol: PROTOCOL,
      client: this.options.client ?? { name: "gsv-sdk", version: "0", platform: "js" },
      ...(this.options.watches ? { watches: this.options.watches } : {}),
    };
    const frame = JSON.stringify({ t: "req", id, op: connectOp.name, args });
    const answered = new Promise<unknown>((resolve, reject) => this.pending.set(id, { frame, resolve, reject }));
    socket.send(frame);
    let info: Result<"connect">;
    try { info = await answered as Result<"connect">; } catch { return; }
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

  private receive(data: unknown): void {
    if (data === "pong" || typeof data !== "string") return;
    const parsed = frameSchema.safeParse(JSON.parse(data));
    if (!parsed.success || parsed.data.t !== "res") return;
    const frame: ResFrame = parsed.data;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new GsvRequestError(frame.error));
  }

  private lost(socket: WebSocket, code: number): void {
    if (socket !== this.socket || this.terminal) return;
    clearInterval(this.ping);
    if (this.handshakeId) this.pending.delete(this.handshakeId);
    this.info = undefined;
    const refused = CLOSE_CODES[code];
    // One fresh token is worth a try; anything else the owner refused ends the connection.
    const refresh = refused === "unauthorized" && typeof this.options.token === "function" && !this.refreshed;
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
  let settle!: { resolve(): void; reject(error: Error): void };
  const promise = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  promise.catch(() => {});
  const result = {
    promise,
    settled: false,
    resolve: () => { result.settled = true; settle.resolve(); },
    reject: (error: Error) => { result.settled = true; settle.reject(error); },
  };
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
