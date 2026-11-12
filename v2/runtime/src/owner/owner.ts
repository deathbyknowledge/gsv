import { DurableObject } from "cloudflare:workers";
import { CATALOG, connect, GsvFailure, reqFrameSchema, SUBPROTOCOL, toGsvError, type Args, type OpDef, type ResFrame, type Result } from "@gsv/catalog";
import type { Env } from "../env.ts";
import { migrate, type Migration } from "../schema.ts";
import { sessionSchema, type Session } from "../token.ts";

const MIGRATIONS: Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE link (
      id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('person', 'team')),
      space TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, home TEXT NOT NULL
    );
  `,
}];

/** Close codes for failures at upgrade time, where a browser can't read an HTTP status. */
export const CLOSE = { unauthorized: 4401, moved: 4409, upgrade_required: 4426 } as const;

type Link = { owner: string; kind: "person" | "team"; space: string; generation: number; epoch: number; home: string };
type Attachment = { uid: string; exp: number; connected: boolean };
type InitOwner = Omit<Link, "home">;

/** One person's or team's control state, and the people's client sockets. Holds no file bytes. */
export class Owner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => { migrate(ctx.storage, MIGRATIONS); });
  }

  /** Links the owner to its space and opens its home volume. Idempotent; a lower generation never replaces a higher one. */
  async init(input: InitOwner): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO link (id, owner, kind, space, generation, epoch, home) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET space = excluded.space, generation = excluded.generation, epoch = excluded.epoch
       WHERE excluded.generation > link.generation`,
      input.owner, input.kind, input.space, input.generation, input.epoch, crypto.randomUUID(),
    );
    const link = this.link();
    if (!link) throw new Error("Owner link was not written");
    await this.env.VOLUME.getByName(`${link.owner}/${link.home}`).init({ owner: link.owner, volume: link.home, space: link.space, generation: link.generation });
  }

  /** The edge has verified the token's signature, expiry and host; the owner checks its space link and epoch. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const session = sessionSchema.parse(JSON.parse(request.headers.get("x-gsv-session") ?? "null"));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const link = this.link();
    const refusal = !link || link.owner !== session.uid ? CLOSE.unauthorized
      : link.space !== session.space ? CLOSE.moved
        : link.epoch !== session.epoch ? CLOSE.unauthorized : undefined;
    if (refusal) {
      server.accept();
      server.close(refusal, refusal === CLOSE.moved ? "moved" : "unauthorized");
    } else {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ uid: session.uid, exp: session.exp, connected: false } satisfies Attachment);
    }
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL } });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return ws.close(1003, "Control frames are text");
    const attachment: Attachment = ws.deserializeAttachment();
    if (attachment.exp <= Date.now()) return ws.close(CLOSE.unauthorized, "unauthorized");
    let raw: unknown;
    try { raw = JSON.parse(message); } catch { return ws.close(1007, "Frames are JSON"); }
    const frame = reqFrameSchema.safeParse(raw);
    if (!frame.success) return ws.close(1007, "Unknown frame");
    const { id, op } = frame.data;
    const def = CATALOG.get(op);
    let response: ResFrame;
    try {
      if (!def) throw new GsvFailure("bad_request", `Unknown operation ${op}.`);
      if (!attachment.connected && op !== connect.name) throw new GsvFailure("bad_request", "Send connect first.");
      const args = def.args.safeParse(frame.data.args);
      if (!args.success) throw new GsvFailure("bad_request", `Arguments for ${op} don't match the catalog.`, { details: { issues: args.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } });
      response = { t: "res", id, ok: true, result: await this.dispatch(ws, attachment, def, args.data) };
    } catch (cause) {
      const ref = cause instanceof GsvFailure ? undefined : crypto.randomUUID();
      if (ref) console.error(JSON.stringify({ event: "owner.request.failed", ref, op: def?.name, error: String(cause) }));
      response = { t: "res", id, ok: false, error: toGsvError(cause, def, ref) };
    }
    ws.send(JSON.stringify(response));
  }

  private async dispatch(ws: WebSocket, attachment: Attachment, def: OpDef, args: unknown): Promise<unknown> {
    switch (def.name) {
      case connect.name: return this.connectSocket(ws, attachment, args as Args<"connect">);
      default: throw new GsvFailure("bad_request", `${def.name} is not served here yet.`);
    }
  }

  private connectSocket(ws: WebSocket, attachment: Attachment, args: Args<"connect">): Result<"connect"> {
    ws.serializeAttachment({ ...attachment, connected: true } satisfies Attachment);
    // No event log yet: a client resuming from a cursor refetches.
    return { owner: attachment.uid, person: attachment.uid, resumed: args.since ? "reset" : true, minVersion: {}, deprecations: [] };
  }

  private link(): Link | undefined {
    return this.ctx.storage.sql.exec<Link>("SELECT owner, kind, space, generation, epoch, home FROM link WHERE id = 1").toArray()[0];
  }

  describe(): { class: string; schema: number } {
    return { class: "Owner", schema: MIGRATIONS.length };
  }
}
