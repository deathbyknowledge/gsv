import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import { signShipCall } from "../atproto";
import type { KernelContext } from "../context";
import { FederationActorBlockedError } from "../federation-store";
import { PublicFederationError } from "../federation/errors";
import { fetchFederation, MAX_PUBLIC_JSON_BYTES, readFederationBody, readFederationJson } from "../federation/http";
import { authenticateShipCall, SHIP_SERVICE_FRAGMENT } from "./auth";
import { resolveDid } from "./did-directory";
import { ShipCallError, ShipXrpcError } from "./errors";

/** Ship-to-Ship methods are Ship's own lexicons. */
export const SHIP_METHOD_PREFIX = "space.ship.";
const XRPC_PREFIX = "/xrpc/";
/** How soon a caller tries again while this Ship moves its contacts to DIDs. */
const MOVE_RETRY_MS = 5 * 60_000;
/** The XRPC error a shared contact limit or check names by its status. */
const ERRORS_BY_STATUS = new Map([
  [400, "InvalidRequest"],
  [401, "AuthenticationRequired"],
  [404, "NotFound"],
  [409, "Conflict"],
  [410, "Gone"],
  [413, "PayloadTooLarge"],
  [429, "RateLimitExceeded"],
]);

/** One authenticated call to a Ship method. */
export type ShipCall = {
  /** The DID whose service-auth token the call carried. */
  caller: string;
  /** A procedure's JSON input. */
  input: JsonValue | undefined;
  params: URLSearchParams;
};

/** A procedure answers JSON; a query may stream bytes. */
export type ShipMethod = {
  type: "procedure" | "query";
  handle(call: ShipCall, ctx: KernelContext): Promise<JsonValue | Response>;
};

export type ShipMethods = ReadonlyMap<string, ShipMethod>;

export function isShipXrpcPath(pathname: string): boolean {
  return pathname.startsWith(`${XRPC_PREFIX}${SHIP_METHOD_PREFIX}`);
}

/** Serves one call to a Ship method once its service auth checks out. */
export async function handleShipXrpc(request: Request, ctx: KernelContext, methods: ShipMethods): Promise<Response> {
  try {
    const url = new URL(request.url);
    const nsid = url.pathname.slice(XRPC_PREFIX.length);
    const method = methods.get(nsid);
    if (!method) throw new ShipXrpcError(501, "MethodNotImplemented", `This Ship doesn't serve ${nsid}`);
    const verb = method.type === "procedure" ? "POST" : "GET";
    if (request.method !== verb) throw new ShipXrpcError(405, "InvalidRequest", `${nsid} takes ${verb}`);
    // A caller can't be matched to its contact until the move names every contact's DID.
    if (ctx.federation.awaitingMove()) {
      throw new ShipXrpcError(503, "TemporarilyUnavailable", "This Ship is moving its contacts to the open network", MOVE_RETRY_MS);
    }
    const caller = await authenticateShipCall(request, nsid, ctx);
    const input = method.type === "procedure" ? await procedureInput(request) : undefined;
    const output = await method.handle({ caller, input, params: url.searchParams }, { ...ctx, requestSignal: request.signal });
    return output instanceof Response ? output : Response.json(output);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Calls another Ship's method with a fresh service-auth token; a procedure has
 * `input`. The timeout covers reading the answer's body too.
 */
export async function callShip(
  did: string,
  nsid: string,
  request: { input?: JsonValue; params?: Record<string, string>; timeoutMs?: number },
  ctx: KernelContext,
): Promise<Response> {
  const { shipEndpoint } = await resolveDid(did, ctx);
  if (!shipEndpoint) throw new ShipCallError(404, "NotAShip", `${did} isn't a Ship`);
  const token = await signShipCall(ctx, { aud: `${did}${SHIP_SERVICE_FRAGMENT}`, lxm: nsid });
  const url = new URL(`${XRPC_PREFIX}${nsid}`, shipEndpoint);
  for (const [name, value] of Object.entries(request.params ?? {})) url.searchParams.set(name, value);
  const authorization = `Bearer ${token}`;
  if (request.input === undefined) {
    return await fetchFederation(url.href, { method: "GET", headers: { authorization }, signal: ctx.requestSignal }, ctx, request.timeoutMs);
  }
  return await fetchFederation(url.href, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(request.input),
    signal: ctx.requestSignal,
  }, ctx, request.timeoutMs);
}

/** Calls another Ship's procedure and reads its output; its XRPC error becomes a ShipCallError. */
export async function callShipProcedure(did: string, nsid: string, input: JsonValue, ctx: KernelContext): Promise<JsonValue> {
  const response = await callShip(did, nsid, { input }, ctx);
  if (!response.ok) throw await shipCallError(response, ctx);
  return await readFederationJson(response, ctx.requestSignal);
}

/** Reads the XRPC error another Ship answered with. */
export async function shipCallError(response: Response, ctx: KernelContext): Promise<ShipCallError> {
  const body = await xrpcErrorBody(response, ctx);
  return new ShipCallError(response.status, body?.error, body?.message ?? `The other Ship refused the call (${response.status})`);
}

const xrpcErrorSchema = z.object({
  error: z.optional(z.string().check(z.maxLength(128))),
  message: z.optional(z.string().check(z.maxLength(1_024))),
});

/** An XRPC error body, when the answer carries a readable one. */
async function xrpcErrorBody(response: Response, ctx: KernelContext): Promise<z.infer<typeof xrpcErrorSchema> | null> {
  try {
    return xrpcErrorSchema.parse(JSON.parse(new TextDecoder().decode(
      await readFederationBody({ stream: response.body ?? new ReadableStream() }, 4_096, ctx.requestSignal),
    )));
  } catch {
    await response.body?.cancel().catch(() => {});
    return null;
  }
}

async function procedureInput(request: Request): Promise<JsonValue | undefined> {
  if (!request.body) return undefined;
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new ShipXrpcError(400, "InvalidRequest", "Ship methods take JSON input");
  const length = request.headers.get("content-length");
  let text: string;
  try {
    text = new TextDecoder().decode(await readFederationBody({
      stream: request.body,
      length: length ? Number(length) : undefined,
    }, MAX_PUBLIC_JSON_BYTES, request.signal));
  } catch {
    throw new ShipXrpcError(413, "InvalidRequest", `Ship method input is limited to ${MAX_PUBLIC_JSON_BYTES / 1024} KiB`);
  }
  try {
    return jsonValueSchema.parse(JSON.parse(text));
  } catch {
    throw new ShipXrpcError(400, "InvalidRequest", "The input isn't JSON");
  }
}

function failure(cause: unknown): Response {
  if (cause instanceof ShipXrpcError) return errorResponse(cause);
  if (cause instanceof PublicFederationError && ERRORS_BY_STATUS.has(cause.status)) {
    return errorResponse(new ShipXrpcError(cause.status, ERRORS_BY_STATUS.get(cause.status) ?? "InvalidRequest", cause.message, cause.retryAfterMs));
  }
  // A blocked caller learns nothing it couldn't learn from a missing record.
  if (cause instanceof FederationActorBlockedError) return errorResponse(new ShipXrpcError(404, "NotFound", "Not found"));
  // Method input schemas come from the SDK's zod/mini build, which shares the core error trait.
  if (cause instanceof z.core.$ZodError) {
    return Response.json({ error: "InvalidRequest", message: z.prettifyError(cause) }, { status: 400 });
  }
  console.warn("[Kernel] Ship method failed:", cause instanceof Error ? cause.message : String(cause));
  return Response.json({ error: "InternalServerError", message: "This Ship couldn't handle the call" }, { status: 500 });
}

function errorResponse(error: ShipXrpcError): Response {
  return Response.json({ error: error.error, message: error.message }, {
    status: error.status,
    headers: error.retryAfterMs === undefined ? undefined : { "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) },
  });
}
