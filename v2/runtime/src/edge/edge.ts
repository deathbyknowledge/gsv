import { GsvFailure, TOKEN_SUBPROTOCOL_PREFIX, toGsvError, type ErrorCode, type GsvError } from "@gsv/catalog";
import { z } from "zod";
import type { NameEntry, SetupResult } from "../directory/directory.ts";
import type { Env } from "../env.ts";
import { CLOSE } from "../owner/owner.ts";
import { verifySession } from "../token.ts";

const NAME_TTL_MS = 60_000;
const MISS_TTL_MS = 10_000;
const names = new Map<string, { entry: NameEntry | null; until: number }>();

const setupSchema = z.object({ code: z.string().min(16).max(128), name: z.string().trim().min(1).max(80) });

const STATUS = new Map<ErrorCode, number>([["bad_request", 400], ["unauthorized", 401], ["forbidden", 403], ["not_found", 404], ["conflict", 409], ["unavailable", 503]]);

/**
 * Signed-in traffic routes by the session token alone and never asks the directory. Only first contact
 * by name resolves a hostname, cached for a minute. A hostname nobody claimed is a 404 and creates no state.
 */
export async function edge(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const domain = env.GSV_DOMAIN.toLowerCase();
  const label = host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : undefined;
  if (host !== domain && (!label || label.includes("."))) return notFound();
  const headers = new Headers(request.headers);
  // A copy of the names: deleting while iterating a Headers object skips entries.
  for (const name of Array.from(headers.keys())) if (name.startsWith("x-gsv-")) headers.delete(name);

  if (url.pathname === "/_gsv/socket") return socket(new Request(request, { headers }), env, host);
  // The deployment claims its operator host, so it serves the setup page before the directory knows it.
  const operatorHost = label === env.GSV_OPERATOR_SPACE;
  if (url.pathname === "/_gsv/setup" && operatorHost) return setup(request, env);
  if (label && !operatorHost) {
    let entry: NameEntry | null;
    try { entry = await resolve(env, label); } catch { return json({ error: toGsvError(new GsvFailure("unavailable", "Try again in a moment."), undefined) }, 503); }
    if (!entry) return notFound();
  }
  return ui(new Request(request, { headers }), env);
}

async function socket(request: Request, env: Env, host: string): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map(part => part.trim());
  const token = offered.find(part => part.startsWith(TOKEN_SUBPROTOCOL_PREFIX))?.slice(TOKEN_SUBPROTOCOL_PREFIX.length);
  const session = token ? await verifySession(env.GSV_SECRET, token, host) : null;
  if (!session) {
    // Accept and close with a code: a browser can't read the status of a refused upgrade.
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(CLOSE.unauthorized, "unauthorized");
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  const headers = new Headers(request.headers);
  headers.set("x-gsv-session", JSON.stringify(session));
  return env.OWNER.getByName(session.uid).fetch(new Request(request, { headers }));
}

async function setup(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  try {
    const input = setupSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new GsvFailure("bad_request", "Setup needs the code from the link and your name.");
    return json(await env.DIRECTORY.getByName("directory").setup(input.data.code, input.data.name), 200);
  } catch (cause) {
    const ref = GsvFailure.revive(cause) ? undefined : crypto.randomUUID();
    if (ref) console.error(JSON.stringify({ event: "edge.setup.failed", ref, error: String(cause) }));
    const error = toGsvError(cause, undefined, ref);
    return json({ error }, STATUS.get(error.code) ?? 500);
  }
}

async function resolve(env: Env, name: string): Promise<NameEntry | null> {
  const cached = names.get(name);
  if (cached && cached.until > Date.now()) return cached.entry;
  const entry = await env.DIRECTORY.getByName("directory").resolve(name);
  names.set(name, { entry, until: Date.now() + (entry ? NAME_TTL_MS : MISS_TTL_MS) });
  return entry;
}

/** Serves the UI's assets; a path without a file is the single-page app. */
async function ui(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404 || request.method !== "GET" || /\.[a-z0-9]+$/i.test(new URL(request.url).pathname)) return response;
  return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
}

function json(body: { error: GsvError } | SetupResult, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
