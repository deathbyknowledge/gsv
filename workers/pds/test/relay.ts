import { decodeFirst } from "@atcute/cbor";
import { CID } from "@atproto/lex-data";
import { def, getAndParseByDef, MemoryBlockstore, MST, readCarWithRoot, verifyCommitSig } from "@atproto/repo";
import { expect } from "vitest";
import { z } from "zod";
import { decode } from "../src/cirrus/cbor-compat";
import type { HostFirehose } from "../src/host/firehose";

const cid = z.object({ $link: z.string() }).transform((link) => CID.parse(link.$link));
const header = z.object({ op: z.number(), t: z.string().optional() });

const commitBody = z.object({
  seq: z.number(),
  repo: z.string(),
  commit: cid,
  rev: z.string(),
  since: z.string().nullable(),
  prevData: cid.nullable(),
  blocks: z.instanceof(Uint8Array),
  ops: z.array(z.object({
    action: z.enum(["create", "update", "delete"]),
    path: z.string(),
    cid: cid.nullable(),
    prev: cid.optional(),
  })),
  rebase: z.boolean(),
  tooBig: z.boolean(),
  blobs: z.array(cid),
  time: z.string(),
});
const syncBody = z.object({ seq: z.number(), did: z.string(), rev: z.string(), blocks: z.instanceof(Uint8Array), time: z.string() });
const identityBody = z.object({ seq: z.number(), did: z.string(), handle: z.string().optional(), time: z.string() });
const accountBody = z.object({
  seq: z.number(),
  did: z.string(),
  active: z.boolean(),
  status: z.string().optional(),
  time: z.string(),
});
const messageBody = z.object({ name: z.string(), message: z.string().optional() });
const errorBody = z.object({ error: z.string(), message: z.string().optional() });

export type CommitFrame = z.output<typeof commitBody>;

/** What a relay needs from a #commit to verify it. */
type CommitClaim = {
  commit: CID;
  rev: string;
  prevData: CID | null;
  blocks: Uint8Array;
  ops: Array<{ action: "create" | "update" | "delete"; path: string; prev?: CID }>;
};

/** A subscribeRepos frame, read as a relay reads it. */
export type Frame =
  | { type: "#commit"; seq: number; did: string; body: CommitFrame }
  | { type: "#sync"; seq: number; did: string; body: z.output<typeof syncBody> }
  | { type: "#identity"; seq: number; did: string; body: z.output<typeof identityBody> }
  | { type: "#account"; seq: number; did: string; body: z.output<typeof accountBody> }
  | { type: "#info"; body: z.output<typeof messageBody> }
  | { type: "error"; body: z.output<typeof errorBody> };

export type Subscription = {
  /** Every frame received so far, in order. */
  frames: Frame[];
  /** Resolves with the close code once the host closes the connection. */
  closed: Promise<number>;
};

/** Opens com.atproto.sync.subscribeRepos on a host firehose, optionally from a cursor. */
export async function subscribe(firehose: DurableObjectStub<HostFirehose>, cursor?: number): Promise<Subscription> {
  const url = new URL("https://pds.test/xrpc/com.atproto.sync.subscribeRepos");
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
  const response = await firehose.fetch(url, { headers: { Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (!ws) throw new Error(`Expected a WebSocket upgrade, got HTTP ${response.status}`);
  const frames: Frame[] = [];
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) frames.push(readFrame(new Uint8Array(event.data)));
  });
  ws.accept();
  return { frames, closed };
}

/** The event frames a subscription received for one repository. */
export function framesFor(subscription: Subscription, did: string): Frame[] {
  return subscription.frames.filter((frame) => "did" in frame && frame.did === did);
}

/** Checks a commit the way a sync 1.1 relay does: from the event's own blocks, without the repository. */
export async function verifyCommit(event: CommitClaim, didKey: string): Promise<void> {
  const { root, blocks } = await readCarWithRoot(event.blocks);
  expect(root.equals(event.commit)).toBe(true);
  const { obj: commit } = await getAndParseByDef(blocks, root, def.commit);
  expect(commit.rev).toBe(event.rev);
  expect(await verifyCommitSig(commit, didKey)).toBe(true);
  let tree = MST.load(new MemoryBlockstore(blocks), commit.data);
  for (const op of event.ops) {
    if (op.action === "create") {
      tree = await tree.delete(op.path);
    } else if (!op.prev) {
      throw new Error(`${op.action} of ${op.path} has no prev`);
    } else {
      tree = op.action === "update" ? await tree.update(op.path, op.prev) : await tree.add(op.path, op.prev);
    }
  }
  expect(event.prevData).not.toBeNull();
  expect((await tree.getPointer()).equals(event.prevData)).toBe(true);
}

/** The CID of the signed commit a #sync's CAR holds, which a relay takes as the repository's head at the event's revision. */
export async function syncedCommit(event: { rev: string; blocks: Uint8Array }): Promise<string> {
  const { root, blocks } = await readCarWithRoot(event.blocks);
  const { obj: commit } = await getAndParseByDef(blocks, root, def.commit);
  expect(commit.rev).toBe(event.rev);
  return root.toString();
}

/** The hostnames the reference relay takes in requestCrawl: a DNS name, without a scheme, port or path. */
const RELAY_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const crawlRequest = z.object({ hostname: z.string() });
const serverDescription = z.object({ did: z.string(), availableUserDomains: z.array(z.string()) });

/**
 * A relay as the reference relay meets a host. A host asks it to crawl with
 * com.atproto.sync.requestCrawl, naming its hostname; the relay checks that the
 * host answers describeServer before it accepts, and then follows the host's
 * firehose from its live end.
 */
export class FakeRelay {
  /** Each hostname the relay was asked to crawl, in order. */
  readonly requests: string[] = [];
  /** The XRPC error the relay answers with instead of accepting, if any. */
  refusal: { status: number; error: string } | null = null;

  constructor(
    readonly origin: string,
    /** Answers a GET of the host's XRPC methods, as the network reaches them by URL. */
    private readonly host: (url: string) => Promise<Response>,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/xrpc/com.atproto.sync.requestCrawl") {
      return Response.json({ error: "MethodNotImplemented" }, { status: 501 });
    }
    // The relay binds a JSON body only when the request says it is JSON.
    const body = request.headers.get("Content-Type") === "application/json" ? crawlRequest.safeParse(await request.json()) : null;
    if (!body?.success) return relayError(400, "BadRequest", "invalid body");
    const { hostname } = body.data;
    this.requests.push(hostname);
    if (this.refusal) return relayError(this.refusal.status, this.refusal.error, "Refused");
    if (!RELAY_HOSTNAME.test(hostname)) return relayError(400, "BadRequest", "hostname field empty or invalid");
    const described = await this.host(`https://${hostname}/xrpc/com.atproto.server.describeServer`);
    if (!described.ok || !serverDescription.safeParse(await described.json()).success) {
      return relayError(400, "HostNotFound", "host server unreachable");
    }
    return new Response(null);
  }
}

/** An XRPC error as the relay's server sends it, with the length a small body arrives with. */
function relayError(status: number, error: string, message: string): Response {
  const body = new TextEncoder().encode(JSON.stringify({ error, message }));
  return new Response(body, { status, headers: { "Content-Type": "application/json", "Content-Length": String(body.byteLength) } });
}

function readFrame(bytes: Uint8Array): Frame {
  const [rawHeader, rest] = decodeFirst(bytes);
  const { op, t } = header.parse(rawHeader);
  const body = decode(rest);
  if (op === -1) return { type: "error", body: errorBody.parse(body) };
  switch (t) {
    case "#commit": {
      const commit = commitBody.parse(body);
      return { type: t, seq: commit.seq, did: commit.repo, body: commit };
    }
    case "#sync": {
      const sync = syncBody.parse(body);
      return { type: t, seq: sync.seq, did: sync.did, body: sync };
    }
    case "#identity": {
      const identity = identityBody.parse(body);
      return { type: t, seq: identity.seq, did: identity.did, body: identity };
    }
    case "#account": {
      const account = accountBody.parse(body);
      return { type: t, seq: account.seq, did: account.did, body: account };
    }
    case "#info":
      return { type: t, body: messageBody.parse(body) };
    default:
      throw new Error(`Unexpected frame type ${t ?? "(none)"}`);
  }
}
